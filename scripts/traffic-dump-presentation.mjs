/** 从转储的原始字段投影展示信息；不改写终态，也不把推导结果写回磁盘。 */
export function requestMetadata(body) {
  const client = body?.client_metadata;
  const raw = client?.["x-codex-turn-metadata"];
  const metadata = typeof raw === "string" ? parseObject(raw) : raw;
  return {
    requestKind: stringValue(metadata?.request_kind),
    threadId: stringValue(metadata?.thread_id) ?? stringValue(client?.thread_id),
    turnId: stringValue(metadata?.turn_id) ?? stringValue(client?.turn_id),
  };
}

export function requestParameters(body) {
  return {
    reasoningEffort: stringValue(body?.reasoning?.effort),
    serviceTier: stringValue(body?.service_tier),
    previousResponseId: stringValue(body?.previous_response_id),
    generate: typeof body?.generate === "boolean" ? body.generate : undefined,
  };
}

/** 仅投影已保存的输入；裁剪标记、非文本内容和未知条目保留为 JSON。 */
export function requestContent(body) {
  const input = body?.input;
  return {
    instructions: body?.instructions == null ? null : displayText(body.instructions),
    input: input == null ? null : (Array.isArray(input) ? input : [input]).map((item) => {
      if (typeof item === "string") return { type: "message", role: "user", text: item };
      const type = stringValue(item?.type) ?? (typeof item?.role === "string" ? "message" : "unknown");
      return {
        ...outputItem({ ...item, type }),
        role: stringValue(item?.role),
        omittedItems: type === "omitted" ? tokenCount(item.omitted_items) : undefined,
      };
    }),
    tools: Array.isArray(body?.tools) ? body.tools.map((tool) => ({
      type: stringValue(tool?.type) ?? "unknown",
      name: stringValue(tool?.name),
      definition: displayText(tool),
    })) : null,
  };
}

export function parameterComparison(request, body) {
  const response = body?.response ?? body;
  const fields = ["reasoning.effort", "reasoning.summary", "text.verbosity", "text.format",
    "tool_choice", "parallel_tool_calls", "temperature", "top_p", "frequency_penalty",
    "presence_penalty", "max_output_tokens", "service_tier"];
  return fields.map((field) => {
    const read = (value) => field.split(".").reduce((part, key) => part?.[key], value);
    const sent = read(request);
    const reported = read(response);
    return { field, request: sent == null ? null : displayText(sent),
      response: reported == null ? null : displayText(reported) };
  }).filter((row) => row.request !== null || row.response !== null);
}

function displayText(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function responseFacts(body) {
  const response = body?.response ?? body;
  const usage = response?.usage;
  return {
    responseId: stringValue(response?.id),
    serviceTier: stringValue(response?.service_tier),
    usage: usage == null ? null : {
      inputTokens: tokenCount(usage.input_tokens),
      cachedTokens: tokenCount(usage.input_tokens_details?.cached_tokens),
      outputTokens: tokenCount(usage.output_tokens),
      reasoningTokens: tokenCount(usage.output_tokens_details?.reasoning_tokens),
      totalTokens: tokenCount(usage.total_tokens),
    },
    failure: response?.error == null && response?.incomplete_details == null
      ? undefined
      : JSON.stringify({ error: response?.error, incomplete_details: response?.incomplete_details }),
  };
}

function tokenCount(value) {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseObject(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** 完成条目独立于 trace 页收集；正文、重组缓冲与输出总量都受展示字节上限约束。 */
export function createOutputCollector(maxBytes, terminalOutput, responseId) {
  const items = new Map();
  let bytes = 0;
  let truncated = false;
  let frame;
  let sse = "";
  let droppingSse = false;
  let timing = null;
  const hasTerminalOutput = Array.isArray(terminalOutput) && terminalOutput.length > 0;

  function add(index, item) {
    if (!item || typeof item !== "object") return;
    const size = Buffer.byteLength(JSON.stringify(item));
    const previous = items.get(index)?.size ?? 0;
    if (bytes - previous + size > maxBytes) {
      truncated = true;
      return;
    }
    items.set(index, { item, size });
    bytes += size - previous;
  }

  function event(text) {
    const value = parseObject(text);
    if (value === undefined && text.trim() !== "[DONE]" && !hasTerminalOutput) truncated = true;
    const metrics = value?.timing_metrics;
    if (value?.type === "responsesapi.websocket_timing" && metrics?.timing_scope === "logical_turn"
      && typeof responseId === "string" && metrics.response_id === responseId) {
      const seconds = tokenCount(metrics.total_turn_time_s);
      timing = {
        scope: metrics.timing_scope,
        responseId,
        totalMs: seconds === undefined ? undefined : tokenCount(seconds * 1000),
        firstTokenMs: tokenCount(metrics.first_sampled_message_ttft_ms),
        queueMaxMs: tokenCount(metrics.engine_queue_max_ms),
        samplingMs: tokenCount(metrics.engine_service_sampling_total_ms),
        toolPauseMs: tokenCount(metrics.client_tool_pause_total_ms),
      };
    }
    if (!hasTerminalOutput && value?.type === "response.output_item.done"
      && Number.isSafeInteger(value.output_index) && value.output_index >= 0) {
      add(value.output_index, value.item);
    }
  }

  function sseBlock(block) {
    const data = block.split(/\r?\n/u).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (data.trim().length > 0) event(data);
  }

  function consumeSse(text) {
    // 只保存一个有界事件；超大事件跳过到下一个空行后继续。
    const blocks = (sse + text).split(/\r?\n\r?\n/u);
    sse = blocks.pop() ?? "";
    for (const block of blocks) {
      if (droppingSse) droppingSse = false;
      else if (Buffer.byteLength(block) <= maxBytes) sseBlock(block);
      else truncated = true;
    }
    if (Buffer.byteLength(sse) > maxBytes) {
      truncated = true;
      droppingSse = true;
      sse = sse.slice(-3);
    }
  }

  if (hasTerminalOutput) terminalOutput.forEach((item, index) => add(index, item));
  return {
    consume(record) {
      if (typeof record.text !== "string") return;
      if (record.kind === "response_body" && record.encoding === "utf8") {
        if (!hasTerminalOutput) consumeSse(record.text);
      } else if (record.kind === "websocket_frame" && record.direction === "upstream"
        && record.binary !== true) {
        if (record.parts > 1) {
          if (record.part === 1) frame = { text: "", next: 1, parts: record.parts };
          if (!frame || frame.next !== record.part || frame.parts !== record.parts) {
            if (!hasTerminalOutput) truncated = true;
            frame = undefined;
            return;
          }
          if (Buffer.byteLength(frame.text) + Buffer.byteLength(record.text) > maxBytes) {
            if (!hasTerminalOutput) truncated = true;
            frame = undefined;
            return;
          }
          frame.text += record.text;
          frame.next += 1;
          if (record.part === record.parts) {
            event(frame.text);
            frame = undefined;
          }
        } else if (Buffer.byteLength(record.text) <= maxBytes) event(record.text);
        else if (!hasTerminalOutput) truncated = true;
      }
    },
    result() {
      if (sse && !droppingSse) sseBlock(sse);
      return {
        output: [...items.entries()].sort(([left], [right]) => left - right)
          .map(([, { item }]) => outputItem(item)),
        outputTruncated: truncated || (!hasTerminalOutput && frame !== undefined),
        outputSource: hasTerminalOutput ? "terminal" : "trace",
        timing,
      };
    },
  };
}

function outputItem(item) {
  let text;
  if (item.type === "message") {
    text = Array.isArray(item.content)
      ? item.content.map((part) => part.text ?? part.refusal ?? JSON.stringify(part)).join("\n")
      : typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? null);
  } else if (item.type === "reasoning") {
    text = Array.isArray(item.summary)
      ? item.summary.map((part) => part.text ?? "").join("\n")
      : JSON.stringify(item.summary ?? null);
  } else if (item.type === "function_call" || item.type === "custom_tool_call") {
    const input = item.arguments ?? item.input;
    text = typeof input === "string" ? input : JSON.stringify(input ?? null);
  } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    text = displayText(item.output ?? null);
  } else text = JSON.stringify(item);
  return {
    type: stringValue(item.type) ?? "unknown",
    name: stringValue(item.name),
    callId: stringValue(item.call_id),
    phase: stringValue(item.phase),
    text,
  };
}
