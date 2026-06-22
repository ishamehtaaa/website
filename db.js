const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const db = new Database(process.env.DB_PATH || "/data/site.db");
db.pragma("journal_mode = WAL");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
db.exec(schema);

// migrations for already-existing databases (CREATE TABLE IF NOT EXISTS above
// won't add new columns to a table that already exists)
const scrapCols = db.prepare("PRAGMA table_info(scrapbook)").all();
if (!scrapCols.some(c => c.name === "scale")) {
  db.exec("ALTER TABLE scrapbook ADD COLUMN scale REAL NOT NULL DEFAULT 1");
}

// boards: every scrapbook item belongs to a board. older databases predate the
// boards table, so ensure the default ("main") board exists, add board_id to
// scrapbook if missing, then backfill any orphaned items onto the default board.
let defaultBoard = db.prepare("SELECT id FROM boards WHERE is_default = 1").get();
if (!defaultBoard) {
  const info = db
    .prepare("INSERT INTO boards (slug, title, visibility, is_default) VALUES ('main', 'scrapbook', 'public', 1)")
    .run();
  defaultBoard = { id: info.lastInsertRowid };
}

if (!scrapCols.some(c => c.name === "board_id")) {
  db.exec("ALTER TABLE scrapbook ADD COLUMN board_id INTEGER REFERENCES boards(id)");
}
db.prepare("UPDATE scrapbook SET board_id = ? WHERE board_id IS NULL").run(defaultBoard.id);
// safe now that board_id is guaranteed to exist on both fresh and migrated DBs
db.exec("CREATE INDEX IF NOT EXISTS idx_scrapbook_board ON scrapbook(board_id)");

module.exports = db;
