const express = require("express");
const crypto = require("crypto");
const db = require("./db");
const app = express();
const PORT = process.env.PORT || 3000;

// shared-password auth. when unset, login fails closed (nobody can ever be
// authed) so private boards stay locked and the public site is unaffected.
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";

// Caddy terminates TLS and reverse-proxies plain HTTP to us; trust its single
// hop so req.secure reflects X-Forwarded-Proto (https in prod, http in dev).
app.set("trust proxy", 1);

app.use(express.json({ limit: "6mb" }));

// ---- auth (stateless HMAC-signed cookie, no sessions table) ----
const COOKIE = "sb_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// key derived from the password, so rotating SITE_PASSWORD invalidates all
// outstanding sessions for free.
const SECRET = crypto.createHash("sha256").update(SITE_PASSWORD).digest();

const b64url = buf => Buffer.from(buf).toString("base64url");

function timingEqual(a, b) {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  // pre-hash equalizes length so timingSafeEqual never throws / leaks length
  const ah = crypto.createHash("sha256").update(ab).digest();
  const bh = crypto.createHash("sha256").update(bb).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function passwordOk(input) {
  if (!SITE_PASSWORD) return false;
  return timingEqual(String(input || ""), SITE_PASSWORD);
}

function makeToken() {
  const payload = b64url(JSON.stringify({ v: 1, exp: Date.now() + SESSION_MS }));
  const sig = b64url(crypto.createHmac("sha256", SECRET).update(payload).digest());
  return `${payload}.${sig}`;
}

function tokenValid(token) {
  if (!SITE_PASSWORD || !token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = b64url(crypto.createHmac("sha256", SECRET).update(payload).digest());
  if (!timingEqual(sig, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.exp > Date.now();
  } catch {
    return false;
  }
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const isAuthed = req => tokenValid(readCookie(req, COOKIE));

function requireAuth(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ error: "unauthorized" });
  next();
}

// crude in-memory brute-force limiter: lock an IP out for a bit after repeated
// failures. resets on success. fine for a single shared secret on one process.
const MAX_FAILS = 8, LOCK_MS = 5 * 60 * 1000;
const attempts = new Map(); // ip -> { count, until }

function loginBlocked(ip) {
  const a = attempts.get(ip);
  return a && a.until > Date.now();
}
function recordFail(ip) {
  const a = attempts.get(ip) || { count: 0, until: 0 };
  a.count += 1;
  if (a.count >= MAX_FAILS) { a.until = Date.now() + LOCK_MS; a.count = 0; }
  attempts.set(ip, a);
}

app.post("/api/login", (req, res) => {
  if (!SITE_PASSWORD) return res.status(503).json({ error: "login disabled" });
  if (loginBlocked(req.ip)) return res.status(429).json({ error: "too many attempts, try later" });
  if (!passwordOk((req.body || {}).password)) {
    recordFail(req.ip);
    return res.status(401).json({ error: "wrong password" });
  }
  attempts.delete(req.ip);
  res.cookie(COOKIE, makeToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure, // Secure in prod (https via Caddy), not on dev http
    path: "/",
    maxAge: SESSION_MS,
  });
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
});

app.get("/api/whoami", (req, res) => {
  res.json({ authed: isAuthed(req) });
});

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

// ---- boards ----
const VISIBILITIES = new Set(["public", "private"]);

// turn a title into a url-safe, unique slug. "main" is reserved for the default.
function makeSlug(title) {
  let base = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!base || base === "main") base = "board";
  let slug = base, n = 1;
  while (db.prepare("SELECT 1 FROM boards WHERE slug = ?").get(slug)) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

// list boards. anonymous callers only ever see public ones, so private boards
// never leak through the switcher.
app.get("/api/boards", (req, res) => {
  const rows = isAuthed(req)
    ? db.prepare("SELECT id, slug, title, visibility, is_default FROM boards ORDER BY id ASC").all()
    : db.prepare("SELECT id, slug, title, visibility, is_default FROM boards WHERE visibility = 'public' ORDER BY id ASC").all();
  res.json(rows);
});

app.post("/api/boards", requireAuth, (req, res) => {
  let { title, visibility } = req.body || {};
  title = (title || "").trim().slice(0, 80);
  visibility = VISIBILITIES.has(visibility) ? visibility : "private";
  if (!title) return res.status(400).json({ error: "title required" });
  const slug = makeSlug(title);
  const info = db
    .prepare("INSERT INTO boards (slug, title, visibility, is_default) VALUES (?, ?, ?, 0)")
    .run(slug, title, visibility);
  const row = db.prepare("SELECT id, slug, title, visibility, is_default FROM boards WHERE id = ?").get(info.lastInsertRowid);
  res.json(row);
});

app.patch("/api/boards/:slug", requireAuth, (req, res) => {
  const board = db.prepare("SELECT * FROM boards WHERE slug = ?").get(req.params.slug);
  if (!board) return res.status(404).json({ error: "not found" });

  let { title, visibility } = req.body || {};
  if (visibility != null) {
    if (!VISIBILITIES.has(visibility)) return res.status(400).json({ error: "bad visibility" });
    // the default board must stay public, else the public scrapbook disappears
    if (board.is_default && visibility !== "public") {
      return res.status(400).json({ error: "default board must stay public" });
    }
  }
  const newTitle = title != null ? String(title).trim().slice(0, 80) || board.title : board.title;
  const newVis = visibility != null ? visibility : board.visibility;
  db.prepare("UPDATE boards SET title = ?, visibility = ? WHERE id = ?").run(newTitle, newVis, board.id);
  res.json({ ok: true });
});

app.delete("/api/boards/:slug", requireAuth, (req, res) => {
  const board = db.prepare("SELECT * FROM boards WHERE slug = ?").get(req.params.slug);
  if (!board) return res.status(404).json({ error: "not found" });
  if (board.is_default) return res.status(400).json({ error: "cannot delete default board" });
  const wipe = db.transaction(id => {
    db.prepare("DELETE FROM scrapbook WHERE board_id = ?").run(id);
    db.prepare("DELETE FROM boards WHERE id = ?").run(id);
  });
  wipe(board.id);
  res.json({ ok: true });
});

// resolve the board for a scrapbook request and enforce visibility. returns the
// board row, or null after sending a 404 (also used as the not-authorized
// response for private boards so their existence never leaks).
function boardAccess(req, res, slug) {
  slug = slug || req.query.board || "main";
  const board = db.prepare("SELECT * FROM boards WHERE slug = ?").get(slug);
  if (!board) { res.status(404).json({ error: "not found" }); return null; }
  if (board.visibility === "private" && !isAuthed(req)) {
    res.status(404).json({ error: "not found" });
    return null;
  }
  return board;
}

// ---- scrapbook ----
const SCRAP_TYPES = new Set(["note", "image", "link"]);

app.get("/api/scrapbook", (req, res) => {
  const board = boardAccess(req, res);
  if (!board) return;
  const rows = db
    .prepare("SELECT * FROM scrapbook WHERE board_id = ? ORDER BY z ASC, id ASC")
    .all(board.id);
  // images ship as a cacheable URL instead of a fat inline data URL, so the
  // list payload stays small and the browser caches each photo across refreshes
  // (re-validating with a 304 rather than re-downloading).
  for (const r of rows) {
    if (r.type === "image") r.content = `/api/scrapbook/img/${r.id}`;
  }
  res.json(rows);
});

// serve an image item's bytes decoded from its stored data URL. content is
// immutable once created (only position/scale change), so the id is a stable
// ETag and we can cache hard. private boards get a `private` directive so a
// shared cache never holds their images.
app.get("/api/scrapbook/img/:id", (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM scrapbook WHERE id = ?").get(id);
  if (!row || row.type !== "image") return res.status(404).end();
  const board = db.prepare("SELECT * FROM boards WHERE id = ?").get(row.board_id);
  if (board && !boardAccess(req, res, board.slug)) return;

  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(row.content || "");
  if (!m) return res.status(404).end();
  const mime = m[1] || "application/octet-stream";
  const buf = m[2]
    ? Buffer.from(m[3], "base64")
    : Buffer.from(decodeURIComponent(m[3]), "utf8");

  const etag = `"img-${id}"`;
  const privacy = board && board.visibility === "private" ? "private" : "public";
  res.set("Cache-Control", `${privacy}, max-age=31536000, immutable`);
  res.set("ETag", etag);
  res.type(mime);
  if (req.headers["if-none-match"] === etag) return res.status(304).end();
  res.send(buf);
});

// keep resize within sane bounds (mirrors MIN_SCALE/MAX_SCALE on the client)
const clampScale = s => Math.min(4, Math.max(0.3, Number(s) || 1));

app.post("/api/scrapbook", (req, res) => {
  const board = boardAccess(req, res);
  if (!board) return;
  let { type, content, caption, x, y, rotation, scale, mx, my, mscale } = req.body || {};
  type = SCRAP_TYPES.has(type) ? type : "note";
  content = (content || "").trim();
  caption = (caption || "").trim().slice(0, 200) || null;
  if (!content) {
    return res.status(400).json({ error: "content required" });
  }
  // images are data URLs and can be large; notes/links are short text
  const maxLen = type === "image" ? 6_000_000 : 2000;
  content = content.slice(0, maxLen);

  const top = db.prepare("SELECT COALESCE(MAX(z), 0) + 1 AS z FROM scrapbook WHERE board_id = ?").get(board.id).z;
  const info = db
    .prepare(
      `INSERT INTO scrapbook (type, content, caption, x, y, rotation, scale, z, mx, my, mscale, board_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      type, content, caption, Number(x) || 40, Number(y) || 40, Number(rotation) || 0, clampScale(scale), top,
      mx != null ? Number(mx) : null,
      my != null ? Number(my) : null,
      mscale != null ? clampScale(mscale) : null,
      board.id
    );
  const row = db.prepare("SELECT * FROM scrapbook WHERE id = ?").get(info.lastInsertRowid);
  res.json(row);
});

app.patch("/api/scrapbook/:id", (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM scrapbook WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "not found" });
  // gate on the item's own board (don't trust a query param for ownership)
  const board = db.prepare("SELECT * FROM boards WHERE id = ?").get(existing.board_id);
  if (board && !boardAccess(req, res, board.slug)) return;

  const { x, y, rotation, scale, z, mx, my, mscale } = req.body || {};
  db.prepare(
    `UPDATE scrapbook SET
       x = ?, y = ?, rotation = ?, scale = ?, z = ?, mx = ?, my = ?, mscale = ?
     WHERE id = ?`
  ).run(
    x != null ? Number(x) : existing.x,
    y != null ? Number(y) : existing.y,
    rotation != null ? Number(rotation) : existing.rotation,
    scale != null ? clampScale(scale) : existing.scale,
    z != null ? Number(z) : existing.z,
    // mobile layout: only the mobile client sends these, so desktop edits leave
    // them untouched (and vice-versa)
    mx != null ? Number(mx) : existing.mx,
    my != null ? Number(my) : existing.my,
    mscale != null ? clampScale(mscale) : existing.mscale,
    id
  );
  res.json({ ok: true });
});

app.delete("/api/scrapbook/:id", (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM scrapbook WHERE id = ?").get(id);
  if (!existing) return res.json({ ok: true });
  const board = db.prepare("SELECT * FROM boards WHERE id = ?").get(existing.board_id);
  if (board && !boardAccess(req, res, board.slug)) return;
  db.prepare("DELETE FROM scrapbook WHERE id = ?").run(id);
  res.json({ ok: true });
});

// ---- bookshelf (single public shelf; owner-only writes) ----
const BOOK_CATEGORIES = new Set(["fiction", "nonfiction", "essay", "advice", "tech", "other"]);
const BOOK_MEDIA = new Set(["book", "article", "essay", "blog post", "paper", "other"]);
const clampLove = v => Math.min(10, Math.max(0, Math.round(Number(v) || 0)));

// pull the writable fields off a request body, validated + normalized. `partial`
// (PATCH) leaves unset fields as undefined so the caller can keep existing values;
// a full insert (POST) falls back to sane defaults instead.
function bookFields(body, partial) {
  const b = body || {};
  const out = {};
  const has = k => Object.prototype.hasOwnProperty.call(b, k);

  if (!partial || has("title")) out.title = String(b.title || "").trim().slice(0, 200);
  if (!partial || has("author")) out.author = (String(b.author || "").trim().slice(0, 120)) || null;
  if (!partial || has("url")) out.url = (String(b.url || "").trim().slice(0, 2000)) || null;
  if (!partial || has("category"))
    out.category = BOOK_CATEGORIES.has(b.category) ? b.category : "other";
  if (!partial || has("medium"))
    out.medium = BOOK_MEDIA.has(b.medium) ? b.medium : null;
  if (!partial || has("love")) out.love = clampLove(b.love);
  if (!partial || has("favorite")) out.favorite = b.favorite ? 1 : 0;
  if (!partial || has("tags")) out.tags = (String(b.tags || "").trim().slice(0, 300)) || null;
  if (!partial || has("reading_time")) {
    const n = Number(b.reading_time);
    out.reading_time = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  if (!partial || has("writeup")) out.writeup = (String(b.writeup || "").trim().slice(0, 20000)) || null;
  return out;
}

app.get("/api/bookshelf", (req, res) => {
  const rows = db.prepare("SELECT * FROM bookshelf ORDER BY created_at DESC, id DESC").all();
  res.json(rows);
});

app.post("/api/bookshelf", requireAuth, (req, res) => {
  const f = bookFields(req.body, false);
  if (!f.title) return res.status(400).json({ error: "title required" });
  const info = db
    .prepare(
      `INSERT INTO bookshelf (title, author, url, category, medium, love, favorite, tags, reading_time, writeup)
       VALUES (@title, @author, @url, @category, @medium, @love, @favorite, @tags, @reading_time, @writeup)`
    )
    .run(f);
  const row = db.prepare("SELECT * FROM bookshelf WHERE id = ?").get(info.lastInsertRowid);
  res.json(row);
});

app.patch("/api/bookshelf/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM bookshelf WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const f = bookFields(req.body, true);
  // a title, if provided, can't be blanked to empty
  if ("title" in f && !f.title) return res.status(400).json({ error: "title required" });
  const merged = { ...existing, ...f };
  db.prepare(
    `UPDATE bookshelf SET
       title = @title, author = @author, url = @url, category = @category, medium = @medium,
       love = @love, favorite = @favorite, tags = @tags, reading_time = @reading_time, writeup = @writeup
     WHERE id = @id`
  ).run({ ...merged, id });
  res.json(db.prepare("SELECT * FROM bookshelf WHERE id = ?").get(id));
});

app.delete("/api/bookshelf/:id", requireAuth, (req, res) => {
  db.prepare("DELETE FROM bookshelf WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true });
});

app.get("/bookshelf", (req, res) => {
  res.sendFile(require("path").join(__dirname, "public", "bookshelf.html"));
});

app.get("/scrapbook", (req, res) => {
  res.sendFile(require("path").join(__dirname, "public", "scrapbook.html"));
});

app.use(express.static("public"));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
