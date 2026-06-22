// ---- helpers ----
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const board = document.getElementById("board");
const emptyMsg = document.getElementById("empty");
const fileInput = document.getElementById("file-input");
const overlay = document.getElementById("overlay");
const modal = document.getElementById("modal");

let topZ = 0;

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
  el.style.left = it.x + "px";
  el.style.top = it.y + "px";
  el.style.zIndex = it.z;
  el.dataset.rot = it.rotation;
  el.dataset.scale = it.scale != null ? it.scale : 1;
  applyTransform(el);
  el.innerHTML = itemInner(it);
  el.insertAdjacentHTML("beforeend", '<div class="handle" aria-hidden="true"></div>');
  topZ = Math.max(topZ, it.z);
  makeDraggable(el);
  board.appendChild(el);
  if (emptyMsg) emptyMsg.style.display = "none";
  return el;
}

// grow the board to encompass every item (+ margin) so off-screen items stay
// reachable by scrolling/panning on mobile. no-op visually on desktop, where
// the board is already clamped to the viewport.
function sizeBoard() {
  const margin = 80;
  const b = board.getBoundingClientRect();
  let maxRight = 0, maxBottom = 0;
  // getBoundingClientRect includes the transform scale, so scaled-up items are
  // measured by their true visual extent; subtracting the board origin converts
  // to board coords (both shift together under scroll)
  board.querySelectorAll(".item").forEach(el => {
    const r = el.getBoundingClientRect();
    maxRight = Math.max(maxRight, r.right - b.left);
    maxBottom = Math.max(maxBottom, r.bottom - b.top);
  });
  // never smaller than the viewport, but grow to keep every item reachable
  board.style.minWidth = Math.max(maxRight + margin, window.innerWidth) + "px";
  board.style.minHeight = Math.max(maxBottom + margin, window.innerHeight) + "px";
}

// re-fit when the window is resized so shrinking it exposes a scrollable area
// instead of clipping off-screen items
window.addEventListener("resize", sizeBoard);

// shift any items that live in negative space (off the top/left, where native
// scroll can't reach) back into positive coords, preserving relative layout,
// and persist the correction so it's a one-time fix. gutterY clears the toolbar.
function normalizePositions(rows) {
  if (!rows.length) return;
  const gutterX = 24, gutterY = 72;
  const minX = Math.min(...rows.map(r => r.x));
  const minY = Math.min(...rows.map(r => r.y));
  const dx = minX < gutterX ? gutterX - minX : 0;
  const dy = minY < gutterY ? gutterY - minY : 0;
  if (!dx && !dy) return;
  rows.forEach(r => {
    r.x += dx;
    r.y += dy;
    fetch(`/api/scrapbook/${r.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x: r.x, y: r.y, rotation: r.rotation, z: r.z }),
    });
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
      rows.forEach(renderItem);
      sizeBoard();
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
  return fetch(listUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then(r => r.json());
}

// drop new items somewhere near the middle, with a small random offset + tilt
function freshPlacement() {
  const jitter = () => Math.round((Math.random() - 0.5) * 160);
  return {
    x: Math.round(window.innerWidth / 2 - 110) + jitter(),
    y: Math.round(window.innerHeight / 2 - 60) + jitter(),
    rotation: +((Math.random() - 0.5) * 8).toFixed(1), // ~ -4° .. 4°
  };
}

async function addNote() {
  const r = await openModal({
    title: "new note",
    fields: [{ name: "text", label: "what's on your mind?", type: "textarea", placeholder: "type something…" }],
  });
  if (!r || !r.text) return;
  postItem({ type: "note", content: r.text, ...freshPlacement() }).then(renderItem).then(sizeBoard);
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
    .then(renderItem).then(sizeBoard);
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
      .then(renderItem).then(sizeBoard);
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
  fetch(`/api/scrapbook/${el.dataset.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      x: parseFloat(el.style.left),
      y: parseFloat(el.style.top),
      rotation: parseFloat(el.dataset.rot) || 0,
      scale: currentScale(el),
      z: parseInt(el.style.zIndex, 10) || topZ,
    }),
  });
}

function makeDraggable(el) {
  // double-click / double-tap to remove (works even if the interact CDN fails)
  el.addEventListener("dblclick", async () => {
    if (!(await confirmModal("remove this from the board?"))) return;
    fetch(`/api/scrapbook/${el.dataset.id}`, { method: "DELETE" })
      .then(() => { el.remove(); sizeBoard(); });
  });

  if (typeof interact === "undefined") return; // library unavailable; static board

  interact(el)
    .draggable({
      ignoreFrom: "a, .handle", // links stay clickable; the grip resizes, not moves
      listeners: {
        start() { bringToFront(el); el.classList.add("dragging"); },
        move(e) {
          el.style.left = (parseFloat(el.style.left) + e.dx) + "px";
          el.style.top = (parseFloat(el.style.top) + e.dy) + "px";
        },
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

  const [who, boards] = await Promise.all([
    fetch("/api/whoami").then(r => r.json()).catch(() => ({ authed: false })),
    fetch("/api/boards").then(r => r.json()).catch(() => []),
  ]);
  authed = !!who.authed;
  renderBoards(boards);
  renderOwnerControls(boards);
  renderAuth();
  loadBoard();
})();
