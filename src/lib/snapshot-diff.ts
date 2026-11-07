/** Key counts between two snapshot JSON files. No database and no network. */
export function diffSnapshotKeys(
  before: { tables: Record<string, Array<Record<string, unknown>>> },
  after: { tables: Record<string, Array<Record<string, unknown>>> },
  keys: Record<string, string>,
): Record<string, { added: number; removed: number; changed: number }> {
  const out: Record<string, { added: number; removed: number; changed: number }> = {};
  for (const [table, pk] of Object.entries(keys)) {
    const left = new Map((before.tables[table] || []).map((row) => [String(row[pk]), JSON.stringify(row)]));
    const right = new Map((after.tables[table] || []).map((row) => [String(row[pk]), JSON.stringify(row)]));
    let added = 0;
    let removed = 0;
    let changed = 0;
    for (const [id, value] of right) {
      if (!left.has(id)) added += 1;
      else if (left.get(id) !== value) changed += 1;
    }
    for (const id of left.keys()) if (!right.has(id)) removed += 1;
    out[table] = { added, removed, changed };
  }
  return out;
}
