import { getStore as openSingleton } from "./node-sqlite";
import { seedDemo } from "./seed";
import { shouldSeedDemo } from "./seed-policy";

let ready = false;

export function getStore() {
  const store = openSingleton();
  if (!ready) {
    ready = true;
    store.recoverAdmittedAfterRestart();
    if (shouldSeedDemo() && store.listBusinesses().length === 0) {
      seedDemo(store);
    }
  }
  return store;
}
