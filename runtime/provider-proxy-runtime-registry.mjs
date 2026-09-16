export class ProviderProxyRuntimeRegistry {
  #runtimes = new Map();
  #startRuntime;
  #startups = new Map();
  #users = new Map();

  constructor(startRuntime) {
    this.#startRuntime = startRuntime;
  }

  async ensure(key, options) {
    const active = this.#runtimes.get(key);
    if (active) return active;

    const pending = this.#startups.get(key);
    if (pending) return pending;

    const startup = Promise.resolve()
      .then(() => this.#startRuntime(key, options))
      .then((runtime) => {
        this.#runtimes.set(key, runtime);
        return runtime;
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

  remove(proxy) {
    for (const [key, runtime] of this.#runtimes) {
      if (runtime.proxy !== proxy) continue;
      this.#runtimes.delete(key);
      this.#users.delete(key);
      return true;
    }
    return false;
  }

  values() {
    return [...this.#runtimes.values()];
  }
}
