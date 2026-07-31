/* Overlay renderer — a dumb display. The main window resolves quests and
   credit; this window just draws what it's told and stays readable over the
   game. Clicking a quest chip opens the wiki (only when not click-through —
   in click-through mode the game owns the mouse by definition). */
"use strict";
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const feedEl = document.getElementById("feed");
const zoneEl = document.getElementById("zoneLine");
const MAX_ROWS = 9;

function addEvent(ev) {
  const li = document.createElement("li");
  if (ev.kind === "loot") {
    const qty = ev.qty > 1 ? ` ×${ev.qty}` : "";
    if (ev.quests && ev.quests.length) {
      li.className = "quest";
      const q = ev.quests[0];
      const more = ev.quests.length > 1 ? ` (+${ev.quests.length - 1} more)` : "";
      const rew = q.rewards && q.rewards.length ? `<span class="rew">reward: ${esc(q.rewards.join(", "))}</span>` : "";
      li.innerHTML = `<b>${esc(ev.item)}${qty}</b> — ${q.as === "r" ? "reward from" : "quest item"}:
        <span class="qn" data-url="${esc(q.url || "")}">${esc(q.n)}</span>${more} ${rew}`;
    } else {
      li.className = "loot";
      li.innerHTML = `${esc(ev.item)}${qty}`;
    }
  } else if (ev.kind === "kill") {
    li.className = "kill";
    li.innerHTML = `✕ ${esc(ev.n)}`;
  } else return;
  feedEl.prepend(li);
  while (feedEl.children.length > MAX_ROWS) feedEl.lastChild.remove();
}

window.companion.onOverlayInit(({ opacity, clickThrough, feed, zone }) => {
  document.body.style.opacity = opacity;
  document.body.classList.toggle("through", clickThrough);
  feedEl.innerHTML = "";
  for (const ev of feed || []) addEvent(ev);
  setZone(zone);
});
window.companion.onOverlayMode(({ clickThrough, opacity }) => {
  document.body.style.opacity = opacity;
  document.body.classList.toggle("through", clickThrough);
});
window.companion.onFeedEvent(addEvent);
window.companion.onFeedZone(setZone);

function setZone(z) {
  zoneEl.textContent = z ? `${z.name} — ${z.done}/${z.total} killed` : "EQL Tools Companion";
}

document.getElementById("btnPin").addEventListener("click", () => window.companion.setClickThrough(true));
document.addEventListener("click", e => {
  const q = e.target.closest("[data-url]");
  if (q && q.dataset.url) window.companion.openWiki(q.dataset.url);
});
