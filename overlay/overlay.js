/* Overlay renderer — a dumb display. The main window resolves quests and
   credit; this window just draws what it's told and stays readable over the
   game. Clicking a quest name opens the wiki (only when not click-through —
   in click-through mode the game owns the mouse).

   The pin button is the exception: while pinned (click-through), hovering it
   tells main to make the window interactive for just that moment
   (overlay:hotspot), so the same button always unpins. */
"use strict";
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const feedEl = document.getElementById("feed");
const zoneEl = document.getElementById("zoneLine");
const pinEl = document.getElementById("btnPin");
const MAX_ROWS = 8;
let THROUGH = false;

function addEvent(ev) {
  const li = document.createElement("li");
  if (ev.kind === "loot") {
    const qty = ev.qty > 1 ? ` ×${ev.qty}` : "";
    if (ev.quests && ev.quests.length) {
      li.className = "quest";
      const q = ev.quests[0];
      const more = ev.quests.length > 1 ? ` <span class="dim">+${ev.quests.length - 1}</span>` : "";
      const rew = q.rewards && q.rewards.length ? ` <span class="rew">→ ${esc(q.rewards.join(", "))}</span>` : "";
      li.innerHTML = `<b>${esc(ev.item)}${qty}</b> — <span class="qn" data-url="${esc(q.url || "")}">${esc(q.n)}</span>${more}${rew}`;
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

function setMode(clickThrough, opacity) {
  THROUGH = !!clickThrough;
  if (opacity !== undefined) document.body.style.opacity = opacity;
  document.body.classList.toggle("through", THROUGH);
  pinEl.textContent = THROUGH ? "unpin" : "pin";
  pinEl.title = THROUGH
    ? "Give the mouse back to this panel (or Ctrl+Shift+L)"
    : "Click-through: the game gets the mouse. This button stays clickable.";
}

window.companion.onOverlayInit(({ opacity, clickThrough, feed, zone }) => {
  setMode(clickThrough, opacity);
  feedEl.innerHTML = "";
  for (const ev of feed || []) addEvent(ev);
  setZone(zone);
});
window.companion.onOverlayMode(({ clickThrough, opacity }) => setMode(clickThrough, opacity));
window.companion.onFeedEvent(addEvent);
window.companion.onFeedZone(setZone);

function setZone(z) {
  zoneEl.textContent = z ? `${z.name} ${z.done}/${z.total}` : "EQL Tools Companion";
}

pinEl.addEventListener("click", () => window.companion.setClickThrough(!THROUGH));
// While pinned, main ignores the mouse — except when it's over this button.
pinEl.addEventListener("mouseenter", () => { if (THROUGH) window.companion.overlayHotspot(true); });
pinEl.addEventListener("mouseleave", () => { if (THROUGH) window.companion.overlayHotspot(false); });

document.addEventListener("click", e => {
  const q = e.target.closest("[data-url]");
  if (q && q.dataset.url) window.companion.openWiki(q.dataset.url);
});
