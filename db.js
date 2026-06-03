const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const db = new Database(process.env.DB_PATH || "/data/site.db");
db.pragma("journal_mode = WAL");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
db.exec(schema);

module.exports = db;
