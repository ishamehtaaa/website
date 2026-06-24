// ---- helpers ----
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const board = document.getElementById("board");
const emptyMsg = document.getElementById("empty");
const fileInput = document.getElementById("file-input");
const overlay = document.getElementById("overlay");
const modal = document.getElementById("modal");

let topZ = 0;

// mobile gets its own layout: items carry a separate mx/my/mscale so a phone and
// a desktop can arrange the same board without overwriting each other. The
// breakpoint matches the CSS one; crossing it (resize/rotate) re-renders so the
// right coordinate set is used.
const mq = window.matchMedia("(max-width: 640px)");
const mobileMode = () => mq.matches;
mq.addEventListener("change", () => location.reload());

// which board this page is showing (?board=slug, default "main"). GET/POST are
// scoped to it; PATCH/DELETE go by item id (the server gates on the item's board).
const slug = new URLSearchParams(location.search).get("board") || "main";
const listUrl = `/api/scrapbook?board=${encodeURIComponent(slug)}`;
let authed = false;

// ---- modal ----
// openModal({ title, fields:[{name,label,type,placeholder}], okLabel })
// resolves to { name: value, ... } on submit, or null on cancel.
function openModal({ title, fields = [], okLabel = "add" }) {
  return new Promise(resolve => {
    modal.innerHTML =
      `<h2>${esc(title)}</h2>` +
      fields.map(f => {
        const id = `f-${f.name}`;
        const ctrl = f.type === "textarea"
          ? `<textarea id="${id}" placeholder="${esc(f.placeholder || "")}"></textarea>`
          : f.type === "select"
          ? `<select id="${id}">${(f.options || []).map(o =>
              `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("")}</select>`
          : `<input id="${id}" type="${f.type || "text"}" placeholder="${esc(f.placeholder || "")}" value="${esc(f.value || "")}" />`;
        return `<div class="field"><label for="${id}">${esc(f.label)}</label>${ctrl}</div>`;
      }).join("") +
      `<div class="actions">
         <button type="button" class="btn-cancel">cancel</button>
         <button type="submit" class="btn-ok">${esc(okLabel)}</button>
       </div>`;

    overlay.classList.add("open");
    const first = modal.querySelector("input, textarea");
    if (first) first.focus();

    function close(result) {
      overlay.classList.remove("open");
      modal.onsubmit = null;
      overlay.onmousedown = null;
      document.removeEventListener("keydown", onKey);
      modal.innerHTML = "";
      resolve(result);
    }

    function submit() {
      const out = {};
      fields.forEach(f => { out[f.name] = (modal.querySelector(`#f-${f.name}`).value || "").trim(); });
      close(out);
    }

    function onKey(e) {
      if (e.key === "Escape") close(null);
      // Cmd/Ctrl+Enter submits from a textarea; plain Enter submits otherwise
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey || e.target.tagName !== "TEXTAREA")) {
        e.preventDefault();
        submit();
      }
    }

    modal.onsubmit = e => { e.preventDefault(); submit(); };
    modal.querySelector(".btn-cancel").onclick = () => close(null);
    overlay.onmousedown = e => { if (e.target === overlay) close(null); };
    document.addEventListener("keydown", onKey);
  });
}

// styled yes/no, replaces window.confirm
function confirmModal(title, okLabel = "remove") {
  return openModal({ title, fields: [], okLabel }).then(r => r !== null);
}

// ---- render ----
function itemInner(it) {
  if (it.type === "image") {
    return `<img src="${esc(it.content)}" alt="" draggable="false" />` +
      (it.caption ? `<div class="cap">${esc(it.caption)}</div>` : "");
  }
  if (it.type === "link") {
    const cap = it.caption ? `<div class="cap">${esc(it.caption)}</div>` : "";
    return `${cap}<a href="${esc(it.content)}" target="_blank" rel="noopener">${esc(it.content)}</a>`;
  }
  return esc(it.content); // note
}

function renderItem(it) {
  const el = document.createElement("div");
  el.className = `item ${it.type}`;
  el.dataset.id = it.id;
  // on mobile, prefer the item's own mobile position; if it has none yet, drop it
  // at its desktop coords for now — reflowMobile() repositions it after layout.
  const useMobile = mobileMode() && it.mx != null;
  el.style.left = (useMobile ? it.mx : it.x) + "px";
  el.style.top = (useMobile ? it.my : it.y) + "px";
  el.style.zIndex = it.z;
  el.dataset.rot = it.rotation;
  el.dataset.scale = (useMobile ? it.mscale : it.scale) != null
    ? (useMobile ? it.mscale : it.scale) : 1;
  applyTransform(el);
  el.innerHTML = itemInner(it);
  el.insertAdjacentHTML("beforeend", '<div class="handle" aria-hidden="true"></div>');
  topZ = Math.max(topZ, it.z);
  makeDraggable(el);
  board.appendChild(el);
  if (emptyMsg) emptyMsg.style.display = "none";
  return el;
}

function sizeBoard() {
  const margin = 80;
  const b = board.getBoundingClientRect();
  let maxRight = 0, maxBottom = 0;
  board.querySelectorAll(".item").forEach(el => {
    const r = el.getBoundingClientRect();
    maxRight = Math.max(maxRight, r.right - b.left);
    maxBottom = Math.max(maxBottom, r.bottom - b.top);
  });
  // never smaller than the viewport, but grow to keep every item reachable.
  // The reserved toolbar gutter (board margin-top) already eats into the page, so
  // discount it from the height floor to avoid a permanent sliver of scroll.
  const reserved = parseFloat(board.style.marginTop) || 0;
  board.style.minWidth = Math.max(maxRight + margin, window.innerWidth) + "px";
  board.style.minHeight = Math.max(maxBottom + margin, window.innerHeight - reserved) + "px";
}

// the fixed toolbar overlays the top of the board (and on mobile it wraps into a
// tall stack), so any item near the top sits under it and can't be grabbed —
// there's no scroll-up room at the origin. Reserve a matching gutter above the
// board so the topmost item always clears the bar. This is a per-device render
// offset (board margin, not item coords), so a phone's tall bar never rewrites
// the positions the desktop shares.
function reserveToolbarSpace() {
  const bar = document.getElementById("bar");
  if (!bar || bar.hidden) return;
  board.style.marginTop = (bar.offsetHeight + 16) + "px";
}

// re-fit when the window is resized so shrinking it exposes a scrollable area
// instead of clipping off-screen items (the bar may also rewrap, changing the
// gutter it needs)
window.addEventListener("resize", () => { reserveToolbarSpace(); sizeBoard(); });

// shift any items that live in negative space (off the top/left, where native
// scroll can't reach) back into positive coords, preserving relative layout,
// and persist the correction so it's a one-time fix. gutterY clears the toolbar.
function normalizePositions(rows) {
  if (!rows.length) return;
  // small gutters: clearing the toolbar is now the board's reserved margin
  // (reserveToolbarSpace), so this only nudges items out of unreachable
  // negative space back to a sane top-left.
  const gutterX = 24, gutterY = 24;
  const minX = Math.min(...rows.map(r => r.x));
  const minY = Math.min(...rows.map(r => r.y));
  const dx = minX < gutterX ? gutterX - minX : 0;
  const dy = minY < gutterY ? gutterY - minY : 0;
  if (!dx && !dy) return;
  rows.forEach(r => {
    r.x += dx;
    r.y += dy;
    api(`/api/scrapbook/${r.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x: r.x, y: r.y, rotation: r.rotation, z: r.z }),
    }).catch(() => {});
  });
}

function loadBoard() {
  fetch(listUrl)
    .then(r => {
      // 404 = private board we can't see, or no such board. Same response either
      // way, so a board's existence never leaks — just a generic dead end.
      if (r.status === 404) { showDeadEnd(); return null; }
      return r.json();
    })
    .then(rows => {
      if (!rows) return;
      normalizePositions(rows);
      const els = rows.map(renderItem);
      if (mobileMode()) reflowMobile(rows, els);
      sizeBoard();
    });
}

// items not yet arranged on mobile (mx == null) get flowed into a single centred,
// scrollable column in the desktop reading order (top-to-bottom, then
// left-to-right), so a collage laid out for a wide screen becomes a usable strip
// that always fits the phone. These positions are NOT persisted — they regenerate
// deterministically each load until the viewer drags an item, which saves its
// mobile spot. Items that already have a mobile position are left where they are.
function reflowMobile(rows, els) {
  const pending = rows
    .map((it, i) => ({ it, el: els[i] }))
    .filter(p => p.it.mx == null)
    .sort((a, b) => (a.it.y - b.it.y) || (a.it.x - b.it.x));
  const vw = document.documentElement.clientWidth;
  let cursor = 24;       // board-relative; the board's reserved margin clears the bar
  const gap = 28;        // a little air, and slack for tilted items
  for (const { el } of pending) {
    const left = Math.max(12, Math.round((vw - el.offsetWidth) / 2));
    el.style.left = left + "px";
    el.style.top = Math.round(cursor) + "px";
    cursor += el.offsetHeight + gap;
  }
}

// central fetch: rejects on non-2xx and logs, so silent failures stop being silent.
function api(url, opts) {
  return fetch(url, opts).then(r => {
    if (!r.ok) throw new Error(`${opts?.method || "GET"} ${url} → ${r.status}`);
    return r;
  }).catch(err => {
    console.error("[scrapbook]", err);
    throw err;
  });
}


// no access (private + no key, or no such board): make the page look like any
// dead link — hide everything and show a plain 404 with a way home.
function showDeadEnd() {
  board.hidden = true;
  document.getElementById("bar").hidden = true;
  document.getElementById("deadend").hidden = false;
}

// ---- adding ----
function postItem(payload) {
  return api(listUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then(r => r.json());
}

// drop new items somewhere near the middle, with a small random offset + tilt
function freshPlacement() {
  const jitter = () => Math.round((Math.random() - 0.5) * 160);
  // item top is board-relative; the board is offset down by its reserved gutter
  // (reserveToolbarSpace), so subtract that to land items at the viewport centre
  // rather than a gutter-height below it.
  const boardTop = board.getBoundingClientRect().top + window.scrollY;
  const x = Math.max(12, Math.round(window.scrollX + window.innerWidth / 2 - 110) + jitter());
  const y = Math.round(window.scrollY + window.innerHeight / 2 - 60 - boardTop) + jitter();
  const place = { x, y, rotation: +((Math.random() - 0.5) * 8).toFixed(1) };
  // on mobile, also seed the item's mobile position (same board-relative spot) so
  // it lands where the viewer is looking instead of being reflowed on next load
  if (mobileMode()) { place.mx = x; place.my = y; }
  return place;
}

async function addNote() {
  const r = await openModal({
    title: "new note",
    fields: [{ name: "text", label: "what's on your mind?", type: "textarea", placeholder: "type something…" }],
  });
  if (!r || !r.text) return;
  postItem({ type: "note", content: r.text, ...freshPlacement() }).then(renderItem).then(growToFit);
}

async function addLink() {
  const r = await openModal({
    title: "new link",
    fields: [
      { name: "url", label: "url", type: "url", placeholder: "https://…" },
      { name: "caption", label: "label (optional)", type: "text", placeholder: "what is it?" },
    ],
  });
  if (!r || !r.url) return;
  postItem({ type: "link", content: r.url, caption: r.caption, ...freshPlacement() })
    .then(renderItem).then(growToFit);
}

function addPhoto() {
  fileInput.value = "";
  fileInput.click();
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => downscale(reader.result, 1000, async dataUrl => {
    const r = await openModal({
      title: "new photo",
      fields: [{ name: "caption", label: "caption (optional)", type: "text", placeholder: "say something…" }],
    });
    if (!r) return; // cancelled
    postItem({ type: "image", content: dataUrl, caption: r.caption, ...freshPlacement() })
      .then(renderItem).then(growToFit);
  });
  reader.readAsDataURL(file);
});

// shrink large photos client-side so data URLs stay small
function downscale(dataUrl, maxPx, cb) {
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
    if (scale === 1) return cb(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    cb(canvas.toDataURL("image/jpeg", 0.85));
  };
  img.onerror = () => cb(dataUrl);
  img.src = dataUrl;
}

// ---- interaction: drag, resize handle, pinch (+ persist) ----
const MIN_SCALE = 0.3, MAX_SCALE = 4;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function currentScale(el) { return parseFloat(el.dataset.scale) || 1; }

function applyTransform(el) {
  el.style.transform = `rotate(${parseFloat(el.dataset.rot) || 0}deg) scale(${currentScale(el)})`;
}

function bringToFront(el) {
  topZ += 1;
  el.style.zIndex = topZ;
}

function persist(el) {
  const left = parseFloat(el.style.left);
  const top = parseFloat(el.style.top);
  const sc = currentScale(el);
  // mobile drags save to the mobile columns only; rotation/z are shared across
  // both layouts. On desktop it's the original x/y/scale.
  const pos = mobileMode()
    ? { mx: left, my: top, mscale: sc }
    : { x: left, y: top, scale: sc };
  api(`/api/scrapbook/${el.dataset.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...pos,
      rotation: parseFloat(el.dataset.rot) || 0,
      z: parseInt(el.style.zIndex, 10) || topZ,
    }),
  }).catch(() => {});
}

function makeDraggable(el) {
  // remove from the board (shared by double-click and touch long-press)
  const del = async () => {
    if (!(await confirmModal("remove this from the board?"))) return;
    api(`/api/scrapbook/${el.dataset.id}`, { method: "DELETE" })
      .then(() => { el.remove(); sizeBoard(); })
      .catch(() => {});
  };

  // double-click to remove on desktop (works even if the interact CDN fails)
  el.addEventListener("dblclick", del);

  // touch: long-press to remove. Double-tap collides with the browser's
  // tap-to-zoom and fires unreliably, so hold-still for 600ms instead. Any drag
  // (pointer moves past a small threshold) or lift cancels it.
  let lpTimer = null, lpX = 0, lpY = 0;
  const cancelLP = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
  el.addEventListener("pointerdown", e => {
    if (e.pointerType === "mouse") return;
    lpX = e.clientX; lpY = e.clientY;
    cancelLP();
    lpTimer = setTimeout(() => { lpTimer = null; del(); }, 600);
  });
  el.addEventListener("pointermove", e => {
    if (lpTimer && Math.hypot(e.clientX - lpX, e.clientY - lpY) > 10) cancelLP();
  });
  el.addEventListener("pointerup", cancelLP);
  el.addEventListener("pointercancel", cancelLP);

  if (typeof interact === "undefined") return; // library unavailable; static board

  interact(el)
    .draggable({
      ignoreFrom: "a, .handle", // links stay clickable; the grip resizes, not moves
      // pan the page when the drag nears an edge so an item can be moved across a
      // board larger than the viewport — essential on phones, where the board is
      // almost always bigger than the screen.
      autoScroll: true,
      listeners: {
        start() { bringToFront(el); el.classList.add("dragging"); },
        move(e) {
          el.style.left = (parseFloat(el.style.left) + e.dx) + "px";
          el.style.top = (parseFloat(el.style.top) + e.dy) + "px";
        },
        // grow the board to fit only on release: doing it every move shifted the
        // scroll area under the finger and made the drag jitter on touch.
        end() { el.classList.remove("dragging"); sizeBoard(); persist(el); },
      },
    })
    .gesturable({
      // two-finger pinch to resize on touch
      listeners: {
        start() { bringToFront(el); el._s0 = currentScale(el); },
        move(e) {
          el.dataset.scale = clamp(el._s0 * e.scale, MIN_SCALE, MAX_SCALE);
          applyTransform(el);
        },
        end() { sizeBoard(); persist(el); },
      },
    });

  // corner grip → scale by dragging relative to the item's centre
  const handle = el.querySelector(".handle");
  if (handle) {
    let cx, cy, d0, s0;
    interact(handle).draggable({
      listeners: {
        start(e) {
          bringToFront(el);
          const r = el.getBoundingClientRect();
          cx = r.left + r.width / 2;
          cy = r.top + r.height / 2;
          s0 = currentScale(el);
          d0 = Math.hypot(e.clientX - cx, e.clientY - cy) || 1;
        },
        move(e) {
          const d = Math.hypot(e.clientX - cx, e.clientY - cy);
          el.dataset.scale = clamp(s0 * (d / d0), MIN_SCALE, MAX_SCALE);
          applyTransform(el);
        },
        end() { sizeBoard(); persist(el); },
      },
    });
  }
}

// ---- toolbar: add items ----
document.getElementById("bar").addEventListener("click", e => {
  const add = e.target.dataset.add;
  if (add === "note") addNote();
  else if (add === "image") addPhoto();
  else if (add === "link") addLink();
});

// ---- boards + auth ----
const boardsNav = document.getElementById("boards");
const ownerControls = document.getElementById("owner-controls");
const authControl = document.getElementById("auth-control");

// the board switcher only exists for logged-in users; to a public visitor the
// page looks exactly as it did before (just the add buttons + home link).
function renderBoards(boards) {
  if (!authed) { boardsNav.innerHTML = ""; return; }
  boardsNav.innerHTML = boards.map(b => {
    const lock = b.visibility === "private" ? " 🔒" : "";
    const cls = b.slug === slug ? ' class="active"' : "";
    return `<a href="/scrapbook?board=${encodeURIComponent(b.slug)}"${cls}>${esc(b.title)}${lock}</a>`;
  }).join("");
}

function renderOwnerControls(boards) {
  if (!authed) { ownerControls.innerHTML = ""; return; }
  const current = boards.find(b => b.slug === slug);
  let html = '<button id="new-board">+ board</button>';
  if (current && !current.is_default) {
    const flip = current.visibility === "private" ? "make public" : "make private";
    html += ` <button id="toggle-vis">${flip}</button>`;
    if (current.visibility === "private") html += ' <button id="share-board">share link</button>';
    html += ' <button id="del-board">delete board</button>';
  }
  ownerControls.innerHTML = html;

  document.getElementById("new-board").onclick = newBoard;
  const tog = document.getElementById("toggle-vis");
  if (tog) tog.onclick = () => toggleVisibility(current);
  const share = document.getElementById("share-board");
  if (share) share.onclick = () => shareBoard(current);
  const del = document.getElementById("del-board");
  if (del) del.onclick = () => deleteBoard(current);
}

function renderAuth() {
  // no public "log in" button — logging in is done with a ?key=… link. Only
  // surface a way back out once you're in.
  authControl.innerHTML = authed ? '<button id="logout">log out</button>' : "";
  if (authed) document.getElementById("logout").onclick = logout;
}

function growToFit(el) {
  const margin = 80;
  const b = board.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const right = r.right - b.left + margin;
  const bottom = r.bottom - b.top + margin;
  const curW = parseFloat(board.style.minWidth) || 0;
  const curH = parseFloat(board.style.minHeight) || 0;
  if (right > curW) board.style.minWidth = Math.max(right, window.innerWidth) + "px";
  if (bottom > curH) board.style.minHeight = Math.max(bottom, window.innerHeight) + "px";
}

// the shareable secret link for a private board: the password rides in the URL
// so friends just click it. We keep the key in memory only if it was used this
// session; otherwise the owner fills it into the placeholder.
function shareBoard(b) {
  const link = `${location.origin}/scrapbook?board=${encodeURIComponent(b.slug)}&key=${encodeURIComponent(unlockKey || "YOUR_PASSWORD")}`;
  if (navigator.clipboard && unlockKey) {
    navigator.clipboard.writeText(link).catch(() => {});
  }
  openModal({
    title: unlockKey ? "link copied — anyone with it can open this board" : "share link (swap in your password)",
    fields: [{ name: "link", label: "secret link", type: "text", value: link }],
    okLabel: "done",
  });
}

async function newBoard() {
  const r = await openModal({
    title: "new board",
    fields: [
      { name: "title", label: "name", type: "text", placeholder: "summer 2026…" },
      { name: "visibility", label: "who can see it", type: "select",
        options: [{ value: "private", label: "private (just us)" }, { value: "public", label: "public" }] },
    ],
    okLabel: "create",
  });
  if (!r || !r.title) return;
  const res = await fetch("/api/boards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: r.title, visibility: r.visibility }),
  });
  if (!res.ok) return;
  const created = await res.json();
  location.href = `/scrapbook?board=${encodeURIComponent(created.slug)}`;
}

async function toggleVisibility(b) {
  const next = b.visibility === "private" ? "public" : "private";
  await fetch(`/api/boards/${encodeURIComponent(b.slug)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visibility: next }),
  });
  location.reload();
}

async function deleteBoard(b) {
  if (!(await confirmModal(`delete "${b.title}" and everything on it?`, "delete"))) return;
  await fetch(`/api/boards/${encodeURIComponent(b.slug)}`, { method: "DELETE" });
  location.href = "/scrapbook";
}

async function logout() {
  await fetch("/api/logout", { method: "POST" });
  location.href = "/scrapbook"; // drop any private ?board= and land on the public one
}

// the key from the secret link, kept in memory so we can build share links.
let unlockKey = null;

// ---- init ----
(async function init() {
  const params = new URLSearchParams(location.search);
  const key = params.get("key");
  if (key) {
    unlockKey = key;
    // exchange the key for a session cookie, then scrub it from the address bar
    // so the password doesn't sit in the URL after the page loads.
    await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: key }),
    }).catch(() => {});
    params.delete("key");
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : ""));
  }

  // kick off the board items (the heaviest payload — images ride inline) right
  // away, in parallel with the auth/boards chrome. It only needs the login
  // cookie, which the ?key= exchange above has already set.
  loadBoard();

  const [who, boards] = await Promise.all([
    fetch("/api/whoami").then(r => r.json()).catch(() => ({ authed: false })),
    fetch("/api/boards").then(r => r.json()).catch(() => []),
  ]);
  authed = !!who.authed;
  renderBoards(boards);
  renderOwnerControls(boards);
  renderAuth();
  // the bar's height is only known once its controls are in the DOM; reserve the
  // gutter now and re-fit the board around the new offset.
  reserveToolbarSpace();
  sizeBoard();
})();
