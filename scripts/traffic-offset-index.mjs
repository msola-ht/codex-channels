import { createHash, randomUUID } from "node:crypto";

// Process-wide limits include all WebUI instances. Buffers held by the scanner are
// separately bounded by two builders, a 64 KiB block and a 16 MiB line each.
const maximumBytes = 128 * 1_048_576;
const maximumEntries = 256;
const rowWidth = 10;
const chunkRows = 4096;
const entryBytes = 8192;
const entries = new Set();
let allocatedBytes = 0;
let builders = 0;

function reserve(bytes, owner) {
  while (allocatedBytes + bytes > maximumBytes || !entries.has(owner) && entries.size >= maximumEntries) {
    let oldest;
    for (const entry of entries) {
      if (entry !== owner && entry.pins === 0 && !entry.job && (!oldest || entry.used < oldest.used)) oldest = entry;
    }
    if (!oldest) throw owner.error("traffic_index_limit", "调用索引超过内存上限，请选择较小的批次范围");
    oldest.dispose();
  }
  allocatedBytes += bytes;
  owner.bytes += bytes;
}

function allocate(Type, length, owner) {
  const bytes = length * Type.BYTES_PER_ELEMENT;
  reserve(bytes, owner);
  try { return new Type(length); }
  catch (error) { release(bytes, owner); throw error; }
}

function release(bytes, owner) { allocatedBytes -= bytes; owner.bytes -= bytes; }
function hashId(id) { return Math.imul((id >>> 0) ^ Math.floor(id / 0x100000000), 0x9e3779b1) >>> 0; }

class Offsets {
  constructor(owner) { this.owner = owner; this.chunks = []; this.hashes = []; this.count = 0; this.slots = undefined; this.order = undefined; }
  get(slot, field) { return this.chunks[Math.floor(slot / chunkRows)][slot % chunkRows * rowWidth + field]; }
  set(slot, field, value) { this.chunks[Math.floor(slot / chunkRows)][slot % chunkRows * rowWidth + field] = value; }
  lookup(id) {
    if (!this.slots) return -1;
    let position = hashId(id) & (this.slots.length - 1);
    while (this.slots[position] !== 0) {
      const slot = this.slots[position] - 1;
      if (this.get(slot, 0) === id) return slot;
      position = (position + 1) & (this.slots.length - 1);
    }
    return -1;
  }
  insertHash(slot, slots = this.slots) {
    let position = hashId(this.get(slot, 0)) & (slots.length - 1);
    while (slots[position] !== 0) position = (position + 1) & (slots.length - 1);
    slots[position] = slot + 1;
  }
  async add(record, offset, length, context, checksum) {
    if (record.kind !== "request" && record.kind !== "response") return;
    if (!Number.isSafeInteger(record.id) || record.id < 1) return;
    if (record.kind === "request" && !Number.isFinite(record.startedAtMs)) throw this.owner.error("traffic_unavailable", "调用索引缺少有效请求时间");
    let slot = this.lookup(record.id);
    if (slot < 0) {
      if (!this.slots || (this.count + 1) * 2 > this.slots.length) {
        const slots = allocate(Uint32Array, this.slots ? this.slots.length * 2 : 8192, this.owner);
        try {
          for (let index = 0; index < this.count; index++) {
            this.insertHash(index, slots);
            if (index % 4096 === 0) await context.checkpoint();
          }
        } catch (error) { release(slots.byteLength, this.owner); throw error; }
        if (this.slots) release(this.slots.byteLength, this.owner);
        this.slots = slots;
      }
      if (this.count % chunkRows === 0) {
        this.chunks.push(allocate(Float64Array, chunkRows * rowWidth, this.owner));
        this.hashes.push(allocate(Uint32Array, chunkRows * 8, this.owner));
      }
      slot = this.count++;
      this.set(slot, 0, record.id);
      this.insertHash(slot);
    }
    const field = record.kind === "request" ? 1 : 3;
    this.set(slot, field, offset + 1);
    this.set(slot, field + 1, length);
    this.hashes[Math.floor(slot / chunkRows)].set(checksum, slot % chunkRows * 8 + (record.kind === "request" ? 0 : 4));
    if (record.kind === "request") this.set(slot, 5, record.startedAtMs);
    if (record.kind === "request") {
      const key = continuationKey(record);
      for (let field = 0; field < 4; field++) this.set(slot, 6 + field, key?.[field] ?? 0);
    }
  }
  matches(slot, kind, bytes) {
    return matchesChecksum(this.hashes[Math.floor(slot / chunkRows)], slot % chunkRows * 8 + (kind === "request" ? 0 : 4), bytes);
  }
  async sort(context) {
    if (this.order) { release(this.order.byteLength, this.owner); this.order = undefined; }
    let count = 0;
    for (let slot = 0; slot < this.count; slot++) if (this.get(slot, 1) !== 0) count++;
    const order = allocate(Uint32Array, count, this.owner);
    let cursor = 0;
    for (let slot = 0; slot < this.count; slot++) {
      if (this.get(slot, 1) !== 0) order[cursor++] = slot;
      if (slot % 4096 === 0) await context.checkpoint();
    }
    this.order = order;
    const scratch = allocate(Uint32Array, count, this.owner);
    const compare = (left, right) => this.get(right, 5) - this.get(left, 5) || this.get(right, 0) - this.get(left, 0);
    try {
      let source = order;
      let target = scratch;
      for (let width = 1; width < count; width *= 2) {
        for (let start = 0; start < count; start += width * 2) {
          let left = start;
          const middle = Math.min(start + width, count);
          let right = middle;
          const end = Math.min(start + width * 2, count);
          for (let out = start; out < end; out++) {
            target[out] = right >= end || left < middle && compare(source[left], source[right]) <= 0 ? source[left++] : source[right++];
            if (out % 16384 === 0) await context.checkpoint();
          }
        }
        [source, target] = [target, source];
      }
      if (source !== order) order.set(source);
    } finally { release(scratch.byteLength, this.owner); }
    if (this.idOrder) release(this.idOrder.byteLength, this.owner);
    this.idOrder = await orderedSlots(count, this.owner, context, index => order[index],
      (left, right) => this.get(left, 0) - this.get(right, 0));
    if (this.requestOrder) release(this.requestOrder.byteLength, this.owner);
    this.requestOrder = await orderedSlots(count, this.owner, context, index => order[index],
      (left, right) => this.get(left, 1) - this.get(right, 1));
    if (this.continuations) release(this.continuations.byteLength, this.owner);
    let related = 0;
    for (const slot of order) if (this.get(slot, 6) !== 0) related++;
    let position = 0;
    this.continuations = await orderedSlots(related, this.owner, context, () => {
      while (this.get(order[position], 6) === 0) position++;
      return order[position++];
    }, (left, right) => this.compareKey(left, right) || this.get(left, 0) - this.get(right, 0));
  }
  compareKey(left, right) {
    for (let field = 6; field < 10; field++) {
      const difference = this.get(left, field) - this.get(right, field);
      if (difference !== 0) return difference;
    }
    return 0;
  }
  continuationRange(request) {
    const key = continuationKey(request);
    if (!key) return [0, 0];
    return equalRange(this.continuations, slot => {
      for (let field = 0; field < 4; field++) {
        const difference = this.get(slot, field + 6) - key[field];
        if (difference !== 0) return difference;
      }
      return 0;
    });
  }
}

function continuationKey(request) {
  const valid = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/u.test(value);
  if (request.transport !== "websocket" || request.requestKind !== "turn"
    || !valid(request.threadId) || !valid(request.turnId)) return undefined;
  const hash = createHash("sha256").update(JSON.stringify([
    request.threadId, request.turnId, request.account, request.url,
  ])).digest();
  // Zero in the first field means ineligible; hashes only select candidates.
  return [hash.readUInt32BE(0) + 1, hash.readUInt32BE(4), hash.readUInt32BE(8), hash.readUInt32BE(12)];
}

class TraceOffsets {
  constructor(owner) { this.owner = owner; this.chunks = []; this.hashes = []; this.count = 0; }
  get(slot, field) { return this.chunks[Math.floor(slot / chunkRows)][slot % chunkRows * 3 + field]; }
  async add(record, offset, length, _context, checksum) {
    const keys = [];
    if (Number.isSafeInteger(record?.interaction) && record.interaction > 0) keys.push(record.interaction);
    if (record?.kind === "websocket_close" && Number.isSafeInteger(record.connection) && record.connection > 0) keys.push(-record.connection);
    for (const key of keys) {
      if (this.count % chunkRows === 0) {
        this.chunks.push(allocate(Float64Array, chunkRows * 3, this.owner));
        this.hashes.push(allocate(Uint32Array, chunkRows * 4, this.owner));
      }
      const row = this.chunks[Math.floor(this.count / chunkRows)];
      row.set([key, offset, length], this.count % chunkRows * 3);
      this.hashes[Math.floor(this.count / chunkRows)].set(checksum, this.count % chunkRows * 4);
      this.count++;
    }
  }
  matches(slot, bytes) { return matchesChecksum(this.hashes[Math.floor(slot / chunkRows)], slot % chunkRows * 4, bytes); }
  async sort(context) {
    if (this.order) release(this.order.byteLength, this.owner);
    this.order = await orderedSlots(this.count, this.owner, context, index => index,
      (left, right) => this.get(left, 0) - this.get(right, 0) || this.get(left, 1) - this.get(right, 1));
  }
  range(key) { return equalRange(this.order, slot => this.get(slot, 0) - key); }
}

function rowChecksum(bytes) {
  const hash = createHash("sha256").update(bytes).digest();
  return [hash.readUInt32BE(0), hash.readUInt32BE(4), hash.readUInt32BE(8), hash.readUInt32BE(12)];
}

function matchesChecksum(hashes, offset, bytes) {
  return rowChecksum(bytes).every((value, index) => hashes[offset + index] === value);
}

function equalRange(order, compare) {
  let low = 0;
  let high = order.length;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (compare(order[middle]) < 0) low = middle + 1; else high = middle; }
  const start = low;
  high = order.length;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (compare(order[middle]) <= 0) low = middle + 1; else high = middle; }
  return [start, low];
}

async function orderedSlots(count, owner, context, value, compare) {
  const order = allocate(Uint32Array, count, owner);
  const scratch = allocate(Uint32Array, count, owner);
  try {
    for (let index = 0; index < count; index++) { order[index] = value(index); if (index % 4096 === 0) await context.checkpoint(); }
    let source = order;
    let target = scratch;
    for (let width = 1; width < count; width *= 2) {
      for (let start = 0; start < count; start += width * 2) {
        let left = start;
        const middle = Math.min(start + width, count);
        let right = middle;
        const end = Math.min(start + width * 2, count);
        for (let out = start; out < end; out++) {
          target[out] = right >= end || left < middle && compare(source[left], source[right]) <= 0 ? source[left++] : source[right++];
          if (out % 16384 === 0) await context.checkpoint();
        }
      }
      [source, target] = [target, source];
    }
    if (source !== order) order.set(source);
    return order;
  } catch (error) { release(order.byteLength, owner); throw error; }
  finally { release(scratch.byteLength, owner); }
}

/** The reader supplies secure file opening and manifest/root identity checks. */
export function createTrafficOffsetStore({ signal, openSource, createContext, error, trace = false }) {
  const sessions = new Map();
  const jobs = new Set();
  const controller = new AbortController();
  const stop = () => controller.abort(error("traffic_read_cancelled", "调用索引构建已取消"));
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  let closed = false;
  function remove(entry) {
    sessions.delete(entry.directory);
    entries.delete(entry);
    allocatedBytes -= entry.bytes;
    entry.bytes = 0;
    entry.index = undefined;
  }
  async function build(entry, sourceContext) {
    const context = createContext(globalThis.AbortSignal.any([controller.signal, entry.controller.signal]), sourceContext, entry.directory);
    const source = await openSource(entry.directory, context);
    try {
      const { handle, identity } = source;
      const size = identity.size;
      const previous = entry.identity;
      const extension = previous && sameSource(previous, identity) && size > previous.size;
      const incremental = extension && !entry.provisional;
      if (!incremental) {
        // A replaced or truncated source never reuses offsets from the previous file.
        release(entry.bytes - entryBytes, entry);
        entry.index = trace ? new TraceOffsets(entry) : new Offsets(entry);
        entry.resume = 0;
        if (!extension) entry.generation = randomUUID();
      }
      const start = entry.resume;
      const result = await scan(handle, start, size, extension ? previous.size : 0, context,
        async (record, offset, length, checksum) => entry.index.add(record, offset, length, context, checksum), error, trace);
      if (extension && result.prefix !== entry.digest) throw error("traffic_unavailable", "调用索引的已记录内容发生变化，请刷新后重试");
      // Hash the fixed opening prefix, including any unfinished tail. Re-read it
      // before publication so concurrent prefix rewrites cannot masquerade as append.
      const verified = await digest(handle, size, context);
      if (verified !== result.digest) throw error("traffic_unavailable", "调用索引在构建时发生变化，请刷新后重试");
      const current = await openSource(entry.directory, context);
      try {
        if (!sameSource(identity, current.identity) || current.identity.size < size) throw error("traffic_unavailable", "调用索引文件已替换或截断");
      } finally { await current.handle.close(); }
      await entry.index.sort(context);
      context.check();
      entry.resume = result.resume;
      entry.provisional = result.provisional;
      entry.digest = verified;
      entry.identity = identity;
      entry.delivered = false;
      entry.failure = undefined;
    } finally { await source.handle.close(); }
  }
  return {
    async acquire(directory, context) {
      context.check();
      if (closed || controller.signal.aborted) throw error("traffic_read_cancelled", "调用索引读取已取消");
      let entry = sessions.get(directory);
      if (!entry) {
        entry = { directory, bytes: 0, pins: 0, used: performance.now(), error, dispose: () => remove(entry) };
        reserve(entryBytes, entry);
        entries.add(entry);
        sessions.set(directory, entry);
      }
      entry.used = performance.now();
      // Pin before the first asynchronous identity read, including admission to a
      // build; another store must not evict this entry while acquire is suspended.
      entry.pins++;
      try {
      if (!entry.job) {
        const source = await openSource(directory, context);
        let identity;
        try { identity = source.identity; } finally { await source.handle.close(); }
        context.check();
        // A writer may append faster than the browser's retry interval. Deliver
        // each newly completed opening snapshot once before scheduling its next
        // extension, otherwise cold retries can perpetually restart the build.
        const awaitingDelivery = entry.identity && !entry.delivered
          && sameSource(entry.identity, identity) && identity.size > entry.identity.size;
        if (awaitingDelivery) {
          // Growth alone is not proof of append: revalidate the indexed prefix
          // before delivering a completed snapshot that the writer has advanced.
          // This foreground verification retains the original HTTP byte budget.
          const current = await openSource(directory, context);
          try {
            if (!sameSource(entry.identity, current.identity) || current.identity.size < entry.identity.size
              || await digest(current.handle, entry.identity.size, context) !== entry.digest) {
              entry.delivered = true;
              throw error("traffic_unavailable", "调用索引的已记录内容发生变化，请刷新后重试");
            }
          } finally { await current.handle.close(); }
        }
        if (!entry.job && !awaitingDelivery && (!entry.identity || !sameRevision(entry.identity, identity))) {
          if (entry.failure && sameRevision(entry.failedIdentity, identity) && performance.now() - entry.failedAt < 5000) throw entry.failure;
          if (entry.pins !== 1 || builders >= 2) throw error("traffic_index_building", "正在准备调用索引，请稍后重试");
          builders++;
          entry.failedIdentity = identity;
          entry.controller = new AbortController();
          let idle;
          const expire = () => {
            const remaining = 5000 - (performance.now() - entry.used);
            if (remaining > 0) { idle = setTimeout(expire, remaining); idle.unref(); }
            else entry.controller.abort(error("traffic_read_cancelled", "调用索引无人等待，已停止构建"));
          };
          idle = setTimeout(expire, 5000); idle.unref();
          const deadline = setTimeout(() => entry.controller.abort(error("traffic_index_timeout", "调用索引构建超过 30 秒期限")), 30_000);
          deadline.unref();
          const job = build(entry, context).catch(cause => {
            entry.failure = cause.code === "traffic_read_cancelled" && !controller.signal.aborted ? undefined : cause;
            entry.failedAt = performance.now();
            entry.identity = undefined;
            release(entry.bytes - entryBytes, entry);
            entry.index = undefined;
          }).finally(() => { clearTimeout(idle); clearTimeout(deadline); builders--; entry.job = undefined; jobs.delete(job); });
          entry.job = job;
          jobs.add(job);
        }
      }
      if (entry.job) await shortWait(entry.job, context.signal);
      context.check();
      if (entry.job) throw error("traffic_index_building", "正在准备调用索引，请稍后重试");
      if (entry.failure) throw entry.failure;
      if (!entry.index) throw error("traffic_index_building", "正在准备调用索引，请稍后重试");
      const current = await openSource(directory, context);
      let pending;
      try {
        if (!sameSource(entry.identity, current.identity) || current.identity.size < entry.identity.size
          || current.identity.size === entry.identity.size && !sameRevision(entry.identity, current.identity)) {
          throw error("traffic_unavailable", "调用索引快照已失效，请刷新后重试");
        }
        pending = current.identity.size > entry.identity.size;
      } finally { await current.handle.close(); }
      entry.pins++;
      let released = false;
      return {
        index: entry.index, identity: entry.identity, pending, resume: entry.resume, generation: entry.generation,
        confirmSnapshot() { entry.delivered = true; },
        release() { if (!released) { released = true; entry.pins--; } },
      };
      } finally { entry.pins--; }
    },
    async close() {
      closed = true;
      stop();
      signal?.removeEventListener("abort", stop);
      await Promise.all(jobs);
      for (const entry of sessions.values()) entry.dispose();
    },
  };
}

export function sameSource(left, right) {
  return left.source === right.source && left.dev === right.dev && left.ino === right.ino;
}
export function sameRevision(left, right) {
  return left && right && sameSource(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function shortWait(job, signal) {
  if (signal.aborted) return;
  let timer;
  let aborted;
  try {
    await Promise.race([job, new Promise(resolve => {
      timer = setTimeout(resolve, 250);
      aborted = resolve;
      signal.addEventListener("abort", aborted, { once: true });
    })]);
  } finally { clearTimeout(timer); signal.removeEventListener("abort", aborted); }
}

async function digest(handle, size, context) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(65_536);
  for (let offset = 0; offset < size;) {
    await context.checkpoint();
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!bytesRead) throw new Error("模型流量索引在读取时被截断");
    context.charge("bytes", bytesRead);
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest("hex");
}

async function scan(handle, start, size, prefixSize, context, visit, error, trace) {
  const hash = createHash("sha256");
  const prefix = createHash("sha256");
  const buffer = Buffer.allocUnsafe(65_536);
  let parts = [];
  let length = 0;
  let resume = start;
  for (let offset = 0; offset < size;) {
    await context.checkpoint();
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!bytesRead) throw new Error("模型流量索引在读取时被截断");
    context.charge("bytes", bytesRead);
    hash.update(buffer.subarray(0, bytesRead));
    if (offset < prefixSize) prefix.update(buffer.subarray(0, Math.min(bytesRead, prefixSize - offset)));
    let position = Math.max(0, start - offset);
    while (position < bytesRead) {
      let end = buffer.indexOf(10, position);
      if (end < 0 || end >= bytesRead) end = bytesRead;
      length += end - position;
      if (length > 16 * 1_048_576) throw error("traffic_index_limit", "调用索引单行超过 16 MiB 上限");
      parts.push(Buffer.from(buffer.subarray(position, end)));
      if (end < bytesRead) {
        context.charge("records");
        if (length > 0) {
          let record;
          const bytes = Buffer.concat(parts, length);
          try { record = JSON.parse(bytes.toString("utf8")); }
          catch { throw error("traffic_unavailable", "调用索引记录损坏"); }
          if (!trace && record?.version !== 2) throw error("traffic_unsupported_version", "不支持的调用索引版本");
          await visit(record, resume, length, rowChecksum(bytes));
        }
        resume = offset + end + 1;
        parts = []; length = 0;
        await context.checkpoint();
      }
      position = end + 1;
    }
    offset += bytesRead;
  }
  // Preserve the existing V2 contract: a valid final JSON record needs no LF.
  // Such a provisional row forces a fresh rebuild on append, avoiding stale rows
  // if the added bytes change the meaning or validity of that final record.
  let provisional = false;
  if (length > 0) {
    context.charge("records");
    let record;
    const bytes = Buffer.concat(parts, length);
    try { record = JSON.parse(bytes.toString("utf8")); } catch { /* Torn tail is allowed. */ }
    if (record !== undefined) {
      if (!trace && record?.version !== 2) throw error("traffic_unsupported_version", "不支持的调用索引版本");
      await visit(record, resume, length, rowChecksum(bytes));
      provisional = true;
    }
  }
  return { resume, provisional, digest: hash.digest("hex"), prefix: prefix.digest("hex") };
}
