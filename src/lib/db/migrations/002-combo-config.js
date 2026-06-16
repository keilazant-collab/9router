// Adds combos.config (nullable JSON text) for fusion combo settings.
// Forward-only, idempotent guard for DBs that already have the column.
export default {
  version: 2,
  name: "combo-config",
  up(db) {
    const cols = db.all(`PRAGMA table_info(combos)`) || [];
    const hasConfig = cols.some((c) => c.name === "config");
    if (!hasConfig) {
      db.exec(`ALTER TABLE combos ADD COLUMN config TEXT`);
    }
  },
};
