// Columns added after a table first shipped: adds those of cols ([[name, type and default], ...]) the table lacks, all
// or none (its own transaction, or the caller's open one). No row is rewritten. Returns how many it added.
export function addColumns(db, table, cols) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  const missing = cols.filter(([c]) => !have.has(c));
  if (!missing.length) return 0;
  const own = !db.isTransaction;
  if (own) db.exec('BEGIN');
  try {
    for (const [c, def] of missing) db.exec(`ALTER TABLE ${table} ADD COLUMN ${c} ${def}`);
    if (own) db.exec('COMMIT');
  } catch (e) { if (own) db.exec('ROLLBACK'); throw e; }
  return missing.length;
}
