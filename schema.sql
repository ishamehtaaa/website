CREATE TABLE IF NOT EXISTS counter(
  id INTEGER PRIMARY KEY,
  visits INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO counter(id, visits) VALUES(1, 0);

CREATE TABLE IF NOT EXISTS guestbook (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public',  -- 'public' | 'private'
  is_default INTEGER NOT NULL DEFAULT 0,       -- 1 for the original scrapbook
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scrapbook (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'note',      -- 'note' | 'image' | 'link'
  content TEXT NOT NULL,                  -- note text, image data-URL, or link URL
  caption TEXT,                           -- optional label (link title, photo caption)
  x REAL NOT NULL DEFAULT 40,
  y REAL NOT NULL DEFAULT 40,
  rotation REAL NOT NULL DEFAULT 0,
  scale REAL NOT NULL DEFAULT 1,          -- uniform resize factor (drag handle / pinch)
  z INTEGER NOT NULL DEFAULT 0,           -- stacking order; bumped on drag
  -- optional mobile layout, kept separate from x/y/scale so phones and desktops
  -- arrange the same board independently. NULL = not yet placed on mobile, so
  -- the client flows the item into a generated column instead.
  mx REAL,
  my REAL,
  mscale REAL,
  board_id INTEGER REFERENCES boards(id), -- which board this item lives on
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- NOTE: the board_id index is created in db.js, after the migration guarantees
-- the column exists (older databases predate it, so it can't go here).

-- bookshelf: a single public shelf of reading notes. each row is a link + the
-- owner's own plain-text writeup. only the owner (shared-password auth) can
-- write; everyone can read. browsing (search/filter/sort) happens client-side.
CREATE TABLE IF NOT EXISTS bookshelf (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT,                              -- source / writer, e.g. "Internet Princess"
  url TEXT,                                 -- optional link to the piece
  category TEXT NOT NULL DEFAULT 'other',   -- genre; drives spine color + filter tabs
  medium TEXT,                              -- format label (book/article/essay/…)
  love INTEGER NOT NULL DEFAULT 0,          -- ♥ score 0–10
  favorite INTEGER NOT NULL DEFAULT 0,      -- 0/1; drives the ★ Favorites tab
  tags TEXT,                                -- comma-separated; parsed to chips client-side
  reading_time INTEGER,                     -- minutes, optional/manual
  writeup TEXT,                             -- plain-text notes
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
