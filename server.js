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

app.use(express.static("public"));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
