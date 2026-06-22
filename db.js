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

module.exports = db;
