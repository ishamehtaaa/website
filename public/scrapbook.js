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
  el.style.transform = `rotate(${it.rotation}deg)`;
  el.style.zIndex = it.z;
  el.dataset.rot = it.rotation;
  el.innerHTML = itemInner(it);
  topZ = Math.max(topZ, it.z);
  makeDraggable(el);
  board.appendChild(el);
  if (emptyMsg) emptyMsg.style.display = "none";
  return el;
}

function loadBoard() {
  fetch("/api/scrapbook")
    .then(r => r.json())
    .then(rows => {
      rows.forEach(renderItem);
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
  postItem({ type: "note", content: r.text, ...freshPlacement() }).then(renderItem);
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
    .then(renderItem);
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
      .then(renderItem);
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

// ---- drag to move (+ persist) ----
function makeDraggable(el) {
  let startX, startY, originLeft, originTop, moved;

  el.addEventListener("pointerdown", e => {
    if (e.target.tagName === "A") return; // let links be clicked
    e.preventDefault();
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    originLeft = parseFloat(el.style.left);
    originTop = parseFloat(el.style.top);
    topZ += 1;
    el.style.zIndex = topZ;
    el.classList.add("dragging");
    el.setPointerCapture(e.pointerId);

    const onMove = ev => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
      el.style.left = originLeft + dx + "px";
      el.style.top = originTop + dy + "px";
    };

    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.classList.remove("dragging");
      if (moved) {
        fetch(`/api/scrapbook/${el.dataset.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            x: parseFloat(el.style.left),
            y: parseFloat(el.style.top),
            rotation: parseFloat(el.dataset.rot),
            z: topZ,
          }),
        });
      }
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  });

  // double-click to remove
  el.addEventListener("dblclick", async () => {
    if (!(await confirmModal("remove this from the board?"))) return;
    fetch(`/api/scrapbook/${el.dataset.id}`, { method: "DELETE" })
      .then(() => el.remove());
  });
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
