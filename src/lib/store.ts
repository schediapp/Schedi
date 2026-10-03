import { getStore as openSingleton } from "./db";
import { seedDemo } from "./seed";

let ready = false;

export function getStore() {
  const store = openSingleton();
  if (!ready) {
    ready = true;
    if (process.env.SCHEDI_SEED !== "0" && store.listBusinesses().length === 0) {
      seedDemo(store);
    }
  }
  return store;
}
