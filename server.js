const express = require("express");
const db = require("./db");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "6mb" }));

app.get("/api/hello", (req, res) => {
  res.json({ message: "Hello from the backend!", time: new Date().toISOString() });
});

app.get("/api/count", (req, res) => {
  const row = db
    .prepare("UPDATE counter SET visits = visits + 1 WHERE id = 1 RETURNING visits")
    .get();
  res.json({ count: row.visits });
});

app.get("/api/count/peek", (req, res) => {
  const row = db.prepare("SELECT visits FROM counter WHERE id = 1").get();
  res.json({ count: row.visits });
});

app.get("/api/guestbook", (req, res) => {
  const rows = db
    .prepare("SELECT name, message, created_at FROM guestbook ORDER BY id DESC LIMIT 100")
    .all();
  res.json(rows);
});

app.post("/api/guestbook", (req, res) => {
  let { name, message } = req.body || {};
  name = (name || "").trim().slice(0, 50);
  message = (message || "").trim().slice(0, 500);
  if (!name || !message) {
    return res.status(400).json({ error: "name and message required" });
  }
  db.prepare("INSERT INTO guestbook (name, message) VALUES (?, ?)").run(name, message);
  res.json({ ok: true });
});

// ---- scrapbook ----
const SCRAP_TYPES = new Set(["note", "image", "link"]);

app.get("/api/scrapbook", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM scrapbook ORDER BY z ASC, id ASC")
    .all();
  res.json(rows);
});

// keep resize within sane bounds (mirrors MIN_SCALE/MAX_SCALE on the client)
const clampScale = s => Math.min(4, Math.max(0.3, Number(s) || 1));

app.post("/api/scrapbook", (req, res) => {
  let { type, content, caption, x, y, rotation, scale } = req.body || {};
  type = SCRAP_TYPES.has(type) ? type : "note";
  content = (content || "").trim();
  caption = (caption || "").trim().slice(0, 200) || null;
  if (!content) {
    return res.status(400).json({ error: "content required" });
  }
  // images are data URLs and can be large; notes/links are short text
  const maxLen = type === "image" ? 6_000_000 : 2000;
  content = content.slice(0, maxLen);

  const top = db.prepare("SELECT COALESCE(MAX(z), 0) + 1 AS z FROM scrapbook").get().z;
  const info = db
    .prepare(
      `INSERT INTO scrapbook (type, content, caption, x, y, rotation, scale, z)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(type, content, caption, Number(x) || 40, Number(y) || 40, Number(rotation) || 0, clampScale(scale), top);
  const row = db.prepare("SELECT * FROM scrapbook WHERE id = ?").get(info.lastInsertRowid);
  res.json(row);
});

app.patch("/api/scrapbook/:id", (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM scrapbook WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "not found" });

  const { x, y, rotation, scale, z } = req.body || {};
  db.prepare(
    `UPDATE scrapbook SET
       x = ?, y = ?, rotation = ?, scale = ?, z = ?
     WHERE id = ?`
  ).run(
    x != null ? Number(x) : existing.x,
    y != null ? Number(y) : existing.y,
    rotation != null ? Number(rotation) : existing.rotation,
    scale != null ? clampScale(scale) : existing.scale,
    z != null ? Number(z) : existing.z,
    id
  );
  res.json({ ok: true });
});

app.delete("/api/scrapbook/:id", (req, res) => {
  db.prepare("DELETE FROM scrapbook WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true });
});

app.get("/scrapbook", (req, res) => {
  res.sendFile(require("path").join(__dirname, "public", "scrapbook.html"));
});

app.use(express.static("public"));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
