/* --- helpers --- */

const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* esc() blocks attribute-breaking but not scheme abuse: javascript: in an href
   runs on click. Anything not http(s) is defused. */
const httpUrl = u => /^https?:\/\//i.test(u) ? u : "#";

/* coalesce a burst of calls (many images finishing at once) into one run on the
   next frame */
function debounce(fn) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(); });
  };
}

/* items measured before their image loads report ~0 height (CSS gives width but
   height:auto), which throws off board sizing and the mobile column. No image,
   or already loaded → run immediately. */
function whenImageReady(el, cb) {
  const img = el.querySelector("img");
  if (!img || img.complete) return cb();
  img.addEventListener("load", cb, { once: true });
  img.addEventListener("error", cb, { once: true });
}

const board = document.getElementById("board");
const emptyMsg = document.getElementById("empty");
const fileInput = document.getElementById("file-input");
const overlay = document.getElementById("overlay");
const modal = document.getElementById("modal");

let topZ = 0;
let items = [];        /* the board's rows, each carrying its .el once rendered */
let authed = false;

/* mobile gets its own layout: items carry a separate mx/my/mscale so a phone and
   a desktop can arrange the same board without overwriting each other. The
   breakpoint matches the CSS one; crossing it (rotation, split-screen resize)
   re-renders from the rows we already hold — no refetch, no lost scroll. */
const mq = window.matchMedia("(max-width: 640px)");
const mobileMode = () => mq.matches;
mq.addEventListener("change", () => {
  board.querySelectorAll(".item").forEach(teardown);
  render();
});

/* hold-to-lift applies wherever the pointer is a finger — input capability, not
   viewport width (a phone in landscape is still a phone) */
const coarsePointer = window.matchMedia("(pointer: coarse)").matches;

/* which board this page is showing (?board=slug, default "main"). GET/POST are
   scoped to it; PATCH/DELETE go by item id (the server gates on the item's
   board). */
const slug = new URLSearchParams(location.search).get("board") || "main";
const listUrl = `/api/scrapbook?board=${encodeURIComponent(slug)}`;

/* --- network --- */

/* rejects on non-2xx and logs, so silent failures stop being silent */
function api(url, opts) {
  return fetch(url, opts).then(r => {
    if (!r.ok) throw new Error(`${opts?.method || "GET"} ${url} → ${r.status}`);
    return r;
  }).catch(err => {
    console.error("[scrapbook]", err);
    throw err;
  });
}

/* a dropped write used to look like a success and then vanish on reload; say so
   instead. Style it with #flash in the stylesheet — only positioning is inline. */
let flashTimer;
function flash(msg) {
  let el = document.getElementById("flash");
  if (!el) {
    el = document.createElement("div");
    el.id = "flash";
    el.style.cssText =
      "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;" +
      "padding:10px 14px;background:#1a1a1a;color:#fff;max-width:min(90vw,32rem)";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

/* one PATCH shape for both layouts; only the columns the row actually has are
   sent, so a desktop save never nulls out a mobile position */
async function savePos(it) {
  const body = {};
  for (const k of ["x", "y", "scale", "mx", "my", "mscale", "rotation", "z"]) {
    if (it[k] != null) body[k] = it[k];
  }
  try {
    return await api(`/api/scrapbook/${it.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return flash("that move didn't save — reload to see where things really are");
  }
}

/* --- render --- */

function itemInner(it) {
  if (it.type === "image") {
    /* no loading="lazy": without stored dimensions the board can't size itself
       until an image loads, and a lazy image below an under-sized board never
       enters the viewport to load. Add both together or neither. */
    return `<img src="${esc(it.content)}" alt="" draggable="false" decoding="async" />` +
      (it.caption ? `<div class="cap">${esc(it.caption)}</div>` : "");
  }
  if (it.type === "link") {
    const cap = it.caption ? `<div class="cap">${esc(it.caption)}</div>` : "";
    return `${cap}<a href="${esc(httpUrl(it.content))}" target="_blank" rel="noopener">${esc(it.content)}</a>`;
  }
  return esc(it.content); /* note */
}

function buildItem(it) {
  const el = document.createElement("div");
  el.className = `item ${it.type}`;
  el.dataset.id = it.id;
  /* on mobile, prefer the item's own mobile position; with none yet, drop it at
     its desktop coords — reflowMobile() repositions it after layout */
  const useMobile = mobileMode() && it.mx != null;
  el.style.left = (useMobile ? it.mx : it.x) + "px";
  el.style.top = (useMobile ? it.my : it.y) + "px";
  el.style.zIndex = it.z || 0;
  el.dataset.rot = it.rotation || 0;
  el.dataset.scale = (useMobile ? it.mscale : it.scale) || 1;
  applyTransform(el);
  /* one parse, not two */
  el.innerHTML = itemInner(it) +
    '<div class="handle" aria-hidden="true"></div>' +
    '<button type="button" class="del" aria-label="remove from board">×</button>';
  topZ = Math.max(topZ, it.z || 0);
  it.el = el;
  makeDraggable(el, it);
  return el;
}

/* interact keeps an Interactable per element until told otherwise; the handle is
   a second one. Dropping a node without unsetting both leaks them. */
function teardown(el) {
  if (typeof interact !== "undefined") {
    const h = el.querySelector(".handle");
    if (h) interact(h).unset();
    interact(el).unset();
  }
  el.remove();
}

/* paint everything currently in `items`, off-DOM, in one append */
function render() {
  topZ = 0;
  const frag = document.createDocumentFragment();
  items.forEach(it => frag.appendChild(buildItem(it)));
  board.appendChild(frag);
  if (emptyMsg) emptyMsg.style.display = items.length ? "none" : "";
  if (mobileMode()) reflowMobile();
  sizeBoard();
  /* images start at ~0 height, so the pass above under-measures anything with a
     photo; re-run as they arrive, folded into one relayout per frame */
  const relayout = debounce(() => {
    if (mobileMode()) reflowMobile();
    sizeBoard();
  });
  items.forEach(it => whenImageReady(it.el, relayout));
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
  /* never smaller than the viewport, but grow to keep every item reachable. The
     reserved toolbar gutter already eats into the page, so discount it from the
     height floor to avoid a permanent sliver of scroll. */
  const reserved = parseFloat(board.style.marginTop) || 0;
  board.style.minWidth = Math.max(maxRight + margin, window.innerWidth) + "px";
  board.style.minHeight = Math.max(maxBottom + margin, window.innerHeight - reserved) + "px";
}

/* the fixed toolbar overlays the top of the board (and wraps into a tall stack on
   mobile), so items near the top sit under it with no scroll-up room to escape.
   Reserve a matching gutter. This is a per-device render offset (board margin,
   not item coords), so a phone's tall bar never rewrites shared positions. */
function reserveToolbarSpace() {
  const bar = document.getElementById("bar");
  if (!bar || bar.hidden) return;
  board.style.marginTop = (bar.offsetHeight + 16) + "px";
}

/* resize fires continuously (and on mobile whenever the address bar slides), and
   each pass measures every item — one run per frame is plenty */
window.addEventListener("resize", debounce(() => { reserveToolbarSpace(); sizeBoard(); }));

/* items in negative space live where native scroll can't reach. Shift each
   coordinate space back into positive territory, preserving relative layout.
   Writes are queued, not sent: only the owner may PATCH, and auth isn't known
   yet when the board first paints — a visitor would just fire N 401s per load. */
const GUTTER = 24;
let pendingWrites = [];

function normalize(rows) {
  const shift = (kx, ky) => {
    const has = rows.filter(r => r[kx] != null);
    if (!has.length) return;
    const dx = Math.max(0, GUTTER - has.reduce((m, r) => Math.min(m, r[kx]), Infinity));
    const dy = Math.max(0, GUTTER - has.reduce((m, r) => Math.min(m, r[ky]), Infinity));
    if (!dx && !dy) return;
    has.forEach(r => {
      r[kx] += dx;
      r[ky] += dy;
      if (!pendingWrites.includes(r)) pendingWrites.push(r);
    });
  };
  shift("x", "y");
  shift("mx", "my");  /* mobile coords drift negative too, and used to be stranded */
}

function flushNormalize() {
  if (!authed) { pendingWrites = []; return; }
  const rows = pendingWrites;
  pendingWrites = [];
  rows.forEach(savePos);
}

function loadBoard() {
  return fetch(listUrl)
    .then(r => {
      /* 404 = private board we can't see, or no such board. Same response either
         way, so a board's existence never leaks. */
      if (r.status === 404) { showDeadEnd(); return null; }
      return r.json();
    })
    .then(rows => {
      if (!rows) return;
      items = rows;
      normalize(items);
      render();
    })
    .catch(() => flash("couldn't load this board"));
}

/* items not yet arranged on mobile (mx == null) flow into a single centred,
   scrollable column in desktop reading order, so a wide collage becomes a usable
   strip. Not persisted — regenerated deterministically each load until a drag
   saves a real mobile spot. Measure everything first, then write: interleaving
   the two forced a synchronous layout on every single item. */
function reflowMobile() {
  const pending = items
    .filter(it => it.mx == null && it.el)
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
  if (!pending.length) return;
  const vw = document.documentElement.clientWidth;
  const sizes = pending.map(it => [it.el.offsetWidth, it.el.offsetHeight]);
  let cursor = 24;   /* board-relative; the reserved margin clears the bar */
  const gap = 28;    /* a little air, and slack for tilted items */
  pending.forEach((it, i) => {
    const [w, h] = sizes[i];
    it.el.style.left = Math.max(12, Math.round((vw - w) / 2)) + "px";
    it.el.style.top = Math.round(cursor) + "px";
    cursor += h + gap;
  });
}

/* no access (private + no key, or no such board): look like any dead link */
function showDeadEnd() {
  board.hidden = true;
  document.getElementById("bar").hidden = true;
  document.getElementById("deadend").hidden = false;
}

/* --- modal --- */

/* openModal({ title, fields:[{name,label,type,placeholder}], okLabel }) resolves
   to { name: value, ... } on submit, or null on cancel */
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

    overlay.showModal();
    const first = modal.querySelector("input, textarea");
    if (first) first.focus();

    let done = false;  /* Escape can reach close() twice; guard double-resolution */
    function close(result) {
      if (done) return;
      done = true;
      overlay.close();
      modal.onsubmit = null;
      overlay.onmousedown = null;
      overlay.oncancel = null;
      document.removeEventListener("keydown", onKey);
      modal.innerHTML = "";
      resolve(result);
    }

    function submit() {
      const out = {};
      fields.forEach(f => { out[f.name] = (modal.querySelector(`#f-${f.name}`).value || "").trim(); });
      close(out);
    }

    /* Escape is the dialog's own job (oncancel); Cmd/Ctrl+Enter submits from a
       textarea, plain Enter submits otherwise */
    function onKey(e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey || e.target.tagName !== "TEXTAREA")) {
        e.preventDefault();
        submit();
      }
    }

    modal.onsubmit = e => { e.preventDefault(); submit(); };
    modal.querySelector(".btn-cancel").onclick = () => close(null);
    overlay.oncancel = () => close(null);
    /* the dialog box has zero padding, so a click on the dialog itself can only
       have landed on the ::backdrop */
    overlay.onmousedown = e => { if (e.target === overlay) close(null); };
    document.addEventListener("keydown", onKey);
  });
}

/* the on-screen keyboard shrinks only the visual viewport; the dialog is laid out
   in the layout viewport, so a bottom sheet would sit under the keys. Lift it by
   the overlap. No-op on desktop: the gap is 0. */
if (window.visualViewport) {
  const vv = window.visualViewport;
  const liftSheet = () => {
    if (!overlay.open) { overlay.style.transform = ""; return; }
    const gap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    overlay.style.transform = gap ? `translateY(${-gap}px)` : "";
  };
  vv.addEventListener("resize", liftSheet);
  vv.addEventListener("scroll", liftSheet);
}

/* styled yes/no, replaces window.confirm */
function confirmModal(title, okLabel = "remove") {
  return openModal({ title, fields: [], okLabel }).then(r => r !== null);
}

/* --- adding --- */

/* POST, render, grow the board to fit. For photos the grow waits on the image so
   a tall picture near the edge still extends the scrollable area. */
function placeNewItem(payload) {
  return api(listUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then(r => r.json())
    .then(it => {
      items.push(it);
      board.appendChild(buildItem(it));
      if (emptyMsg) emptyMsg.style.display = "none";
      whenImageReady(it.el, () => growToFit(it.el));
    })
    .catch(() => flash("couldn't add that to the board"));
}

/* drop new items near the middle, with a small random offset + tilt */
function freshPlacement() {
  const jitter = () => Math.round((Math.random() - 0.5) * 160);
  /* item top is board-relative and the board is pushed down by its reserved
     gutter, so subtract it to land at the viewport centre */
  const boardTop = board.getBoundingClientRect().top + window.scrollY;
  const x = Math.max(12, Math.round(window.scrollX + window.innerWidth / 2 - 110) + jitter());
  const y = Math.round(window.scrollY + window.innerHeight / 2 - 60 - boardTop) + jitter();
  const place = { x, y, rotation: +((Math.random() - 0.5) * 8).toFixed(1) };
  /* on mobile, seed the mobile position too so it lands where the viewer is
     looking instead of being reflowed on next load */
  if (mobileMode()) { place.mx = x; place.my = y; }
  return place;
}

async function addNote() {
  const r = await openModal({
    title: "new note",
    fields: [{ name: "text", label: "what's on your mind?", type: "textarea", placeholder: "type something…" }],
  });
  if (!r || !r.text) return;
  placeNewItem({ type: "note", content: r.text, ...freshPlacement() });
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
  if (!/^https?:\/\//i.test(r.url)) return flash("links need to start with http:// or https://");
  placeNewItem({ type: "link", content: r.url, caption: r.caption, ...freshPlacement() });
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
    if (!r) return; /* cancelled */
    placeNewItem({ type: "image", content: dataUrl, caption: r.caption, ...freshPlacement() });
  });
  reader.readAsDataURL(file);
});

/* shrink large photos client-side so data URLs stay small. A small PNG used to
   pass through untouched at full weight, so re-encode anything that isn't
   already JPEG; the white fill keeps transparency from flattening to black. */
function downscale(dataUrl, maxPx, cb) {
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
    if (scale === 1 && dataUrl.startsWith("data:image/jpeg")) return cb(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    cb(canvas.toDataURL("image/jpeg", 0.85));
  };
  img.onerror = () => cb(dataUrl);
  img.src = dataUrl;
}

/* --- interaction: drag, resize handle, pinch (+ persist) --- */

const MIN_SCALE = 0.3, MAX_SCALE = 4;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function currentScale(el) { return parseFloat(el.dataset.scale) || 1; }

function applyTransform(el) {
  /* the trailing scale(var(--lift, 1)) lets .item.dragging "pick up" an item
     without fighting this inline transform */
  el.style.transform =
    `rotate(${parseFloat(el.dataset.rot) || 0}deg) scale(${currentScale(el)}) scale(var(--lift, 1))`;
}

function bringToFront(el) {
  topZ += 1;
  el.style.zIndex = topZ;
}

/* selection = edit mode for one item: reveals its × badge and resize grip */
function select(el) {
  board.querySelectorAll(".item.selected").forEach(i => {
    if (i !== el) i.classList.remove("selected");
  });
  if (el) el.classList.add("selected");
}
board.addEventListener("pointerdown", e => { if (e.target === board) select(null); });
document.addEventListener("keydown", e => { if (e.key === "Escape") select(null); });

/* write the DOM's truth back onto the row, then save. Keeping the row in sync
   matters beyond the request: reflowMobile reads mx to decide what still needs
   flowing, and a stale row would re-flow an item the viewer just placed. */
function persist(el, it) {
  const left = parseFloat(el.style.left);
  const top = parseFloat(el.style.top);
  const sc = currentScale(el);
  if (mobileMode()) { it.mx = left; it.my = top; it.mscale = sc; }
  else { it.x = left; it.y = top; it.scale = sc; }
  it.rotation = parseFloat(el.dataset.rot) || 0;
  it.z = parseInt(el.style.zIndex, 10) || topZ;
  savePos(it);
}

function makeDraggable(el, it) {
  /* remove from the board (shared by the × badge and desktop double-click) */
  const del = async () => {
    if (!(await confirmModal("remove this from the board?"))) return;
    api(`/api/scrapbook/${it.id}`, { method: "DELETE" })
      .then(() => {
        teardown(el);
        items = items.filter(r => r !== it);
        if (emptyMsg && !items.length) emptyMsg.style.display = "";
        sizeBoard();
      })
      .catch(() => flash("couldn't remove that"));
  };

  el.querySelector(".del").addEventListener("click", del);
  el.addEventListener("dblclick", del);  /* still works if interact.js fails */

  /* .item's touch-action allows native panning so plain swipes scroll the board —
     but once interact owns the touches (post-hold drag, or a pinch), the same
     moves must NOT also pan the page underneath */
  let interacting = false;
  el.addEventListener("touchmove", e => { if (interacting) e.preventDefault(); },
    { passive: false });

  if (typeof interact === "undefined") return; /* library unavailable; static board */

  interact(el)
    .on("tap", e => {
      if (e.target.closest("a, .handle, .del")) return; /* controls own their taps */
      select(el.classList.contains("selected") ? null : el);
    })
    .draggable({
      ignoreFrom: "a, .handle, .del",
      /* fingers must hold to lift, or every scroll swipe would move an item. Mice
         grab instantly: they have no scroll gesture to protect. */
      hold: coarsePointer ? 250 : 0,
      /* pan the page near an edge so items can cross a board bigger than the
         viewport — essential on phones, where it almost always is */
      autoScroll: true,
      listeners: {
        start() {
          interacting = true;
          bringToFront(el);
          select(el);
          el.classList.add("dragging");
          if (navigator.vibrate) navigator.vibrate(10); /* pickup tick (Android) */
        },
        move(e) {
          el.style.left = (parseFloat(el.style.left) + e.dx) + "px";
          el.style.top = (parseFloat(el.style.top) + e.dy) + "px";
        },
        /* resize the board on release only: doing it per move shifted the scroll
           area under the finger and made the drag jitter on touch */
        end() {
          interacting = false;
          el.classList.remove("dragging");
          sizeBoard();
          persist(el, it);
        },
      },
    })
    .gesturable({
      /* two-finger pinch to resize on touch */
      listeners: {
        start() { interacting = true; bringToFront(el); el._s0 = currentScale(el); },
        move(e) {
          el.dataset.scale = clamp(el._s0 * e.scale, MIN_SCALE, MAX_SCALE);
          applyTransform(el);
        },
        end() { interacting = false; sizeBoard(); persist(el, it); },
      },
    });

  /* corner grip → scale by dragging relative to the item's centre */
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
        end() { sizeBoard(); persist(el, it); },
      },
    });
  }
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

/* --- toolbar --- */

document.getElementById("bar").addEventListener("click", e => {
  const add = e.target.dataset.add;
  if (add === "note") addNote();
  else if (add === "image") addPhoto();
  else if (add === "link") addLink();
});

/* --- boards + auth --- */

const boardsNav = document.getElementById("boards");
const ownerControls = document.getElementById("owner-controls");
const authControl = document.getElementById("auth-control");

/* the switcher only exists for logged-in users; a public visitor sees exactly
   what they saw before (add buttons + home link) */
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
  /* no public "log in" button — logging in is a ?key=… link. Only surface a way
     back out once you're in. */
  authControl.innerHTML = authed ? '<button id="logout">log out</button>' : "";
  if (authed) document.getElementById("logout").onclick = logout;
}

/* the shareable secret link for a private board: the password rides in the URL so
   friends just click it. Kept in memory only if it was used this session;
   otherwise the owner fills in the placeholder. */
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
  let created;
  try {
    const res = await api("/api/boards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: r.title, visibility: r.visibility }),
    });
    created = await res.json();
  } catch {
    return flash("couldn't create that board");
  }
  location.href = `/scrapbook?board=${encodeURIComponent(created.slug)}`;
}

async function toggleVisibility(b) {
  const next = b.visibility === "private" ? "public" : "private";
  try {
    await api(`/api/boards/${encodeURIComponent(b.slug)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: next }),
    });
  } catch {
    return flash("couldn't change who can see this board");
  }
  location.reload();
}

async function deleteBoard(b) {
  if (!(await confirmModal(`delete "${b.title}" and everything on it?`, "delete"))) return;
  try {
    await api(`/api/boards/${encodeURIComponent(b.slug)}`, { method: "DELETE" });
  } catch {
    return flash("couldn't delete that board");
  }
  location.href = "/scrapbook";
}

async function logout() {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/scrapbook"; /* drop any private ?board= and land on the public one */
}

/* the key from the secret link, kept in memory so we can build share links */
let unlockKey = null;

/* --- init --- */

(async function init() {
  const params = new URLSearchParams(location.search);
  const key = params.get("key");
  if (key) {
    unlockKey = key;
    /* exchange the key for a session cookie, then scrub it from the address bar
       so the password doesn't sit in the URL after load */
    await api("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: key }),
    }).catch(() => {});
    params.delete("key");
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : ""));
  }

  /* kick off the items (the heaviest payload — images ride inline) in parallel
     with the auth/boards chrome. It only needs the login cookie, which the ?key=
     exchange above has already set. */
  const boardReady = loadBoard();

  const [who, boards] = await Promise.all([
    fetch("/api/whoami").then(r => r.json()).catch(() => ({ authed: false })),
    fetch("/api/boards").then(r => r.json()).catch(() => []),
  ]);
  authed = !!who.authed;
  renderBoards(boards);
  renderOwnerControls(boards);
  renderAuth();
  /* the bar's height is only known once its controls are in the DOM; reserve the
     gutter now and re-fit the board around the new offset */
  reserveToolbarSpace();
  sizeBoard();
  /* now that both auth and the rows have landed, write any coordinate fixes */
  await boardReady;
  flushNormalize();
})();
