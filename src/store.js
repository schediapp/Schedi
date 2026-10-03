import fs from 'node:fs';
import path from 'node:path';

export function emptyState() {
  return {
    businesses: [],
    bookings: [],
    sessions: [],
    processedEvents: [],
    prices: { starter: null, pro: null },
  };
}

export function createStore({ file } = {}) {
  let data = emptyState();
  if (file && fs.existsSync(file)) {
    data = { ...emptyState(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  }

  function persist() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }

  return {
    read() {
      return structuredClone(data);
    },
    update(mutator) {
      const draft = structuredClone(data);
      mutator(draft);
      data = draft;
      persist();
      return structuredClone(data);
    },
  };
}
