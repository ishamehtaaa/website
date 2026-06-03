// ---- visitor counter ----
function loadCounter() {
  const el = document.getElementById("count");
  const seen = localStorage.getItem("counted");
  fetch(seen ? "/api/count/peek" : "/api/count")
    .then(r => r.json())
    .then(d => {
      const n = d.count;
      el.textContent = `${n.toLocaleString()} ${n === 1 ? "visitor" : "visitors"}`;
      localStorage.setItem("counted", "1");
    })
    .catch(() => { el.textContent = "?"; });
}

// ---- guestbook ----
const esc = s => s.replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function loadGuestbook() {
  fetch("/api/guestbook")
    .then(r => r.json())
    .then(rows => {
      document.getElementById("gb-entries").innerHTML = rows.map(r => `
        <li>
          <strong>${esc(r.name)}</strong>
          <span>${new Date(r.created_at + "Z").toLocaleDateString()}</span>
          <p>${esc(r.message)}</p>
        </li>
      `).join("");
    });
}

function signGuestbook() {
  const nameEl = document.getElementById("gb-name");
  const messageEl = document.getElementById("gb-message");
  const status = document.getElementById("gb-status");
  const name = nameEl.value.trim();
  const message = messageEl.value.trim();

  if (!name || !message) { status.textContent = "fill in both fields"; return; }
  status.textContent = "signing...";

  fetch("/api/guestbook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, message }),
  })
    .then(r => r.json())
    .then(d => {
      if (d.ok) {
        nameEl.value = "";
        messageEl.value = "";
        status.textContent = "";
        loadGuestbook();
      } else {
        status.textContent = d.error || "something went wrong";
      }
    })
    .catch(() => { status.textContent = "couldn't sign, try again"; });
}

// ---- init ----
document.getElementById("gb-submit").addEventListener("click", signGuestbook);
loadCounter();
loadGuestbook();
