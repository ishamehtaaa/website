// ---- helpers ----
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const board = document.getElementById("board");
const emptyMsg = document.getElementById("empty");
const fileInput = document.getElementById("file-input");
const overlay = document.getElementById("overlay");
const modal = document.getElementById("modal");

let topZ = 0;

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
          : `<input id="${id}" type="${f.type || "text"}" placeholder="${esc(f.placeholder || "")}" />`;
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
  fetch("/api/scrapbook")
    .then(r => r.json())
    .then(rows => {
      normalizePositions(rows);
      rows.forEach(renderItem);
      sizeBoard();
    });
}

// ---- adding ----
function postItem(payload) {
  return fetch("/api/scrapbook", {
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

// ---- toolbar ----
document.getElementById("bar").addEventListener("click", e => {
  const add = e.target.dataset.add;
  if (add === "note") addNote();
  else if (add === "image") addPhoto();
  else if (add === "link") addLink();
});

// ---- init ----
loadBoard();
