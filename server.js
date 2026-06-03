const express = require("express");
const db = require("./db");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

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

app.use(express.static("public"));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
