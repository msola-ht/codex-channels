export class ProviderProxyRuntimeRegistry {
  #runtimes = new Map();
  #startRuntime;
  #startups = new Map();
  #users = new Map();
  #unavailable = new Set();
  #closures = new Map();

  constructor(startRuntime) {
    this.#startRuntime = startRuntime;
  }

  async ensure(key, options) {
    const pending = this.#startups.get(key);
    if (pending) return pending;
    if (this.#unavailable.has(key)) throw new Error(`模型代理资源尚未确认清理：${key}`);
    const active = this.#runtimes.get(key);
    if (active) return active;

    const startup = Promise.resolve()
      .then(() => this.#startRuntime(key, options, runtime => {
        // Retain partial construction before its first asynchronous start.
        this.#runtimes.set(key, runtime);
        this.#unavailable.add(key);
      }))
      .then((runtime) => {
        this.#runtimes.set(key, runtime);
        this.#unavailable.delete(key);
        return runtime;
      }).catch(async error => {
        const runtime = this.#runtimes.get(key);
        if (runtime) {
          try { await this.close(runtime.proxy); }
          catch (cleanupError) {
            throw new AggregateError([error, cleanupError], `模型代理启动失败且清理未完成：${key}`, { cause: cleanupError });
          }
        }
        throw error;
      });
    this.#startups.set(key, startup);
    try {
      return await startup;
    } finally {
      if (this.#startups.get(key) === startup) this.#startups.delete(key);
    }
  }

  get(key) {
    return this.#runtimes.get(key);
  }

  addUser(key, user) {
    const users = this.#users.get(key) ?? new Set();
    users.add(user);
    this.#users.set(key, users);
  }

  removeUser(key, user) {
    const users = this.#users.get(key);
    if (!users) return;
    users.delete(user);
    if (users.size === 0) this.#users.delete(key);
  }

  hasUsers(key) {
    return this.#users.has(key);
  }

  close(proxy) {
    for (const [key, runtime] of this.#runtimes) {
      if (runtime.proxy !== proxy) continue;
      const pending = this.#closures.get(key);
      if (pending) return pending;
      this.#unavailable.add(key);
      const closure = Promise.resolve().then(() => proxy.close()).then(() => {
        this.#runtimes.delete(key);
        this.#users.delete(key);
        this.#unavailable.delete(key);
      }).finally(() => {
        // Retry failed cleanup; never cache a rejected shutdown forever.
        if (this.#closures.get(key) === closure) this.#closures.delete(key);
      });
      this.#closures.set(key, closure);
      return closure;
    }
    return Promise.resolve();
  }

  values() {
    return [...this.#runtimes.values()];
  }
}
