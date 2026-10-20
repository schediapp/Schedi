import { AuthRateLimit } from "../workers/schedi-email-worker/src/auth-rate-limit.js";

// In-process stand-in for the single "auth" Durable Object. One storage map,
// so every sign-in in the test shares the counter the way every data centre does.
export function memoryAuthLimits() {
  const store = new Map<string, unknown>();
  const storage = {
    async get(key: string) {
      return store.has(key) ? store.get(key) : undefined;
    },
    async put(key: string, value: unknown) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(opts?: { limit?: number; startAfter?: string }) {
      const startAfter = opts?.startAfter || "";
      const keys = [...store.keys()].filter((key) => String(key) > startAfter).sort();
      const limit = opts?.limit ?? 1000;
      return new Map(keys.slice(0, limit).map((key) => [key, store.get(key)]));
    },
    async transaction<T>(fn: (txn: typeof storage) => Promise<T>) {
      return fn(storage);
    },
  };
  const object = new AuthRateLimit({ storage }, {});
  const names: string[] = [];
  const bodies: string[] = [];
  const namespace = {
    getByName(name: string) {
      names.push(name);
      return {
        async fetch(input: RequestInfo, init?: RequestInit) {
          const request = input instanceof Request ? input : new Request(input, init);
          const text = await request.text();
          bodies.push(text);
          return object.fetch(new Request(request.url, {
            method: request.method,
            headers: { "Content-Type": "application/json" },
            body: text,
          }));
        },
      };
    },
  };
  return { namespace, store, names, bodies };
}
