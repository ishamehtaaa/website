// ---- helpers (self-contained; the bookshelf shares no code with the scrapbook) ----
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// central fetch: rejects on non-2xx and logs, so silent failures stop being silent.
function api(url, opts) {
  return fetch(url, opts).then(r => {
    if (!r.ok) throw new Error(`${opts?.method || "GET"} ${url} → ${r.status}`);
    return r;
  }).catch(err => {
    console.error("[bookshelf]", err);
    throw err;
  });
}

// escape text but turn bare http(s) URLs into links; newlines are preserved by the
// writeup's `white-space: pre-wrap`, so no <br> needed.
const URL_RE = /(https?:\/\/[^\s<]+)/g;
function richText(s) {
  s = String(s || "");
  let out = "", last = 0, m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(s))) {
    out += esc(s.slice(last, m.index));
    out += `<a href="${esc(m[0])}" target="_blank" rel="noopener">${esc(m[0])}</a>`;
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}

// must mirror the allow-sets in server.js
const CATEGORIES = ["fiction", "nonfiction", "essay", "advice", "tech", "other"];
const MEDIA = ["book", "article", "essay", "blog post", "paper", "other"];
const SHELF_SIZE = 6; // books per wooden shelf

// ---- state ----
let entries = [];          // every book, newest first from the server
let authed = false;
let unlockKey = null;      // the ?key= secret, kept so logout/whoami stay consistent
let openId = null;         // expanded (read) book, or null
let editingId = null;      // book whose panel is showing the edit form, or null
let adding = false;        // the add form is open at the top
let armedDelete = null;    // id whose delete button is armed for the second click
let tab = "all";           // active filter tab: 'all' | 'favorites' | <category>
let sortKey = "default";

// ---- DOM ----
const shelf = document.getElementById("shelf");
const tabsEl = document.getElementById("tabs");
const countEl = document.getElementById("count");
const sortEl = document.getElementById("sort");
const ownerAdd = document.getElementById("owner-add");
const authControl = document.getElementById("auth-control");

// ---- view: filter + sort ----
function visible() {
  return entries.filter(b => {
    if (tab === "favorites") return !!b.favorite;
    if (tab !== "all") return b.category === tab;
    return true;
  });
}

const byRecent = (a, b) => (b.created_at || "").localeCompare(a.created_at || "") || b.id - a.id;
const SORTS = {
  default: (a, b) => (b.favorite - a.favorite) || (b.love - a.love) || byRecent(a, b),
  love: (a, b) => (b.love - a.love) || byRecent(a, b),
  recent: byRecent,
  title: (a, b) => String(a.title).localeCompare(String(b.title)),
  // longest reads first; unset reading times sink to the bottom
  time: (a, b) => ((b.reading_time || 0) - (a.reading_time || 0)) || byRecent(a, b),
};

// ---- rendering ----
function tagChips(tags) {
  const list = String(tags || "").split(",").map(t => t.trim()).filter(Boolean);
  if (!list.length) return "";
  return `<div class="tags">${list.map(t => `<span class="tag">${esc(t)}</span>`).join("")}</div>`;
}

function selectOptions(values, current, blank) {
  const opts = values.map(v => `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(v)}</option>`);
  if (blank) opts.unshift(`<option value=""${!current ? " selected" : ""}>—</option>`);
  return opts.join("");
}

// the inline add/edit form (no modal). `b` is the book being edited, or null to add.
function formHtml(b) {
  b = b || {};
  return `<form class="bookform" data-id="${b.id != null ? b.id : ""}">
    <div class="frow"><label>title</label><input name="title" value="${esc(b.title)}" required maxlength="200" placeholder="what is it?" /></div>
    <div class="frow"><label>author</label><input name="author" value="${esc(b.author)}" maxlength="120" placeholder="who made it?" /></div>
    <div class="frow"><label>link</label><input name="url" type="url" value="${esc(b.url)}" maxlength="2000" placeholder="https://…" /></div>
    <div class="frow"><label>category</label><select name="category">${selectOptions(CATEGORIES, b.category || "other", false)}</select></div>
    <div class="frow"><label>medium</label><select name="medium">${selectOptions(MEDIA, b.medium || "", true)}</select></div>
    <div class="frow"><label>♥ score</label><input name="love" type="number" min="0" max="10" value="${b.love != null ? b.love : 0}" /></div>
    <div class="frow"><label>reading time</label><input name="reading_time" type="number" min="1" value="${b.reading_time != null ? b.reading_time : ""}" placeholder="minutes" /></div>
    <div class="frow"><label>tags</label><input name="tags" value="${esc(b.tags)}" maxlength="300" placeholder="comma, separated" /></div>
    <div class="frow check"><label><input name="favorite" type="checkbox"${b.favorite ? " checked" : ""} /> favorite ★</label></div>
    <div class="frow full"><label>writeup</label><textarea name="writeup" maxlength="20000" placeholder="learnings, snippets, comments…">${esc(b.writeup)}</textarea></div>
    <div class="form-actions">
      <button type="submit" class="primary">save</button>
      <button type="button" data-action="cancel">cancel</button>
    </div>
  </form>`;
}

function readPanel(b) {
  const bits = [];
  bits.push(`<span class="k">${esc(b.category)}${b.medium ? " · " + esc(b.medium) : ""}</span>`);
  if (b.url) bits.push(`<a class="open" href="${esc(b.url)}" target="_blank" rel="noopener">open ↗</a>`);
  bits.push(`<span class="love">♥ ${b.love}</span>`);
  if (b.favorite) bits.push(`<span class="fav">★ favorite</span>`);
  if (b.reading_time) bits.push(`<span class="rt">${b.reading_time}m read</span>`);
  const actions = authed
    ? `<div class="panel-actions">
         <button data-action="edit" data-id="${b.id}">edit</button>
         <button data-action="delete" data-id="${b.id}"${armedDelete === b.id ? ' class="armed"' : ""}>${armedDelete === b.id ? "remove?" : "delete"}</button>
       </div>`
    : "";
  return `<div class="panel">
    <div class="panel-top">${bits.join("")}</div>
    ${tagChips(b.tags)}
    ${b.writeup ? `<div class="writeup">${richText(b.writeup)}</div>` : `<div class="writeup empty">no notes yet</div>`}
    ${actions}
  </div>`;
}

// deterministic per-book "thickness" so spines vary like real books without
// reshuffling on every render
const thickness = id => 44 + ((id * 7) % 4) * 3;

function bookHtml(b) {
  const open = b.id === openId;
  const meta = [`<span class="b-cat">${esc(b.category)}</span>`, `<span class="b-love">♥ ${b.love}</span>`];
  if (b.favorite) meta.push(`<span class="b-fav">★</span>`);
  if (b.reading_time) meta.push(`<span class="b-rt">${b.reading_time}m</span>`);
  const inner = b.id === editingId ? formHtml(b) : open ? readPanel(b) : "";
  return `<article class="book cat-${esc(b.category)}${open ? " open" : ""}" style="--h:${thickness(b.id)}px">
    <div class="spine" data-action="toggle" data-id="${b.id}">
      <span class="b-title">${esc(b.title)}</span>
      ${b.author ? `<span class="b-by">· ${esc(b.author)}</span>` : ""}
      <span class="b-meta">${meta.join("")}</span>
    </div>
    ${inner}
  </article>`;
}

function render() {
  // tabs reflect the categories actually present, in canonical order
  const present = CATEGORIES.filter(c => entries.some(b => b.category === c));
  const tabList = ["all", "favorites", ...present];
  const label = t => t === "all" ? "all" : t === "favorites" ? "★ favorites" : t;
  tabsEl.innerHTML = tabList.map(t =>
    `<button class="tab${t === tab ? " active" : ""}" data-tab="${esc(t)}">${esc(label(t))}</button>`).join("");

  const list = visible().sort(SORTS[sortKey] || SORTS.default);
  countEl.textContent = `${list.length} of ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;

  // group books onto wooden shelves
  let html = adding ? `<div class="addslot">${formHtml(null)}</div>` : "";
  if (!list.length && !adding) {
    html += `<p class="bare">${entries.length ? "nothing matches." : "the shelf is empty."}</p>`;
  }
  for (let i = 0; i < list.length; i += SHELF_SIZE) {
    const group = list.slice(i, i + SHELF_SIZE).map(bookHtml).join("");
    html += `<div class="shelf-row">${group}<div class="plank"></div></div>`;
  }
  shelf.innerHTML = html;

  // owner-only controls
  ownerAdd.innerHTML = authed ? `<button id="add-book">+ add</button>` : "";
  if (authed) document.getElementById("add-book").onclick = startAdd;
  authControl.innerHTML = authed ? `<button id="logout">log out</button>` : "";
  if (authed) document.getElementById("logout").onclick = logout;
}

// ---- actions ----
function startAdd() {
  adding = true;
  openId = editingId = armedDelete = null;
  render();
  const ta = shelf.querySelector(".addslot input[name=title]");
  if (ta) ta.focus();
}

function gather(form) {
  const get = n => form.querySelector(`[name=${n}]`);
  return {
    title: get("title").value,
    author: get("author").value,
    url: get("url").value,
    category: get("category").value,
    medium: get("medium").value,
    love: get("love").value,
    reading_time: get("reading_time").value,
    tags: get("tags").value,
    favorite: get("favorite").checked,
    writeup: get("writeup").value,
  };
}

async function save(form) {
  const payload = gather(form);
  if (!payload.title.trim()) { form.querySelector("[name=title]").focus(); return; }
  const id = form.dataset.id;
  try {
    const res = await api(id ? `/api/bookshelf/${id}` : "/api/bookshelf", {
      method: id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const row = await res.json();
    if (id) {
      entries = entries.map(b => (b.id === row.id ? row : b));
      editingId = null;
      openId = row.id;
    } else {
      entries.unshift(row);
      adding = false;
      openId = row.id;
    }
    render();
  } catch { /* api() already logged */ }
}

async function remove(id) {
  try {
    await api(`/api/bookshelf/${id}`, { method: "DELETE" });
    entries = entries.filter(b => b.id !== id);
    if (openId === id) openId = null;
    armedDelete = null;
    render();
  } catch { /* logged */ }
}

// ---- events ----
shelf.addEventListener("click", e => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id ? Number(el.dataset.id) : null;

  if (action === "toggle") {
    // ignore toggles while this book is mid-edit
    if (editingId === id) return;
    openId = openId === id ? null : id;
    editingId = null;
    armedDelete = null;
    render();
  } else if (action === "edit") {
    editingId = id;
    armedDelete = null;
    render();
  } else if (action === "delete") {
    if (armedDelete === id) remove(id);          // second click confirms
    else { armedDelete = id; render(); }         // first click arms
  } else if (action === "cancel") {
    adding = false;
    editingId = null;
    render();
  }
});

shelf.addEventListener("submit", e => {
  if (e.target.classList.contains("bookform")) { e.preventDefault(); save(e.target); }
});

tabsEl.addEventListener("click", e => {
  const b = e.target.closest("[data-tab]");
  if (!b) return;
  tab = b.dataset.tab;
  armedDelete = null;
  render();
});

sortEl.addEventListener("change", () => { sortKey = sortEl.value; render(); });

async function logout() {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/bookshelf";
}

// ---- init ----
(async function init() {
  const params = new URLSearchParams(location.search);
  const key = params.get("key");
  if (key) {
    unlockKey = key;
    // exchange the key for a session cookie, then scrub it from the address bar
    await api("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: key }),
    }).catch(() => {});
    params.delete("key");
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : ""));
  }

  const [rows, who] = await Promise.all([
    fetch("/api/bookshelf").then(r => r.json()).catch(() => []),
    fetch("/api/whoami").then(r => r.json()).catch(() => ({ authed: false })),
  ]);
  entries = Array.isArray(rows) ? rows : [];
  authed = !!who.authed;
  render();
})();
