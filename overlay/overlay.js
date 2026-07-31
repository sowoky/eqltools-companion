/* Overlay renderer — a dumb display. The main window resolves quests and
   credit; this window just draws what it's told and stays readable over the
   game.

   Click-through ("pinned") uses forward:true, so mousemove still reaches us
   even while clicks fall through to the game. Anything actionable — the pin
   button AND quest links — is a HOTSPOT: hovering it tells main to make the
   window interactive for just that moment, so pinned overlays keep working
   links (Kyle, 2026-07-31: "why can't i click links in the overlay").

   Transparent frameless windows have no native resize borders on Windows;
   the corner grip resizes through main instead. */
"use strict";
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const feedEl = document.getElementById("feed");
const questsEl = document.getElementById("quests");
const zoneEl = document.getElementById("zoneLine");
const pinEl = document.getElementById("btnPin");
const gripEl = document.getElementById("grip");
const panelEl = document.getElementById("panel");
let THROUGH = false;
let PREFS = { fontScale: 1, showKills: true, questOnly: false, showQuests: true };
const FEED_CAP = 50; // matches main's relay ring; the window scrolls, not truncates

function wanted(ev) {
  if (ev.kind === "kill") return PREFS.showKills;
  if (ev.kind === "loot") return !PREFS.questOnly || (ev.quests && ev.quests.length > 0);
  return false;
}

/* Item refs {n, url, sb} arrive pre-resolved from the main renderer. sb (the
   EQ item-window lines) rides on the element itself for the mini tooltip. */
function itemSpan(name, url, sb, cls) {
  const s = document.createElement("span");
  s.className = cls + (url ? " is-link" : "");
  s.textContent = name;
  if (url) s.dataset.url = url;
  if (sb) s._sb = { n: name, sb };
  return s;
}

/* Raw events kept locally so a filter change re-filters HISTORY instead of
   rebuilding from main's 50-item relay ring and losing older rows. */
let EVENTS = [];
const EVENT_CAP = 200;

function addEvent(ev) {
  EVENTS.push(ev);
  if (EVENTS.length > EVENT_CAP) EVENTS.shift();
  if (wanted(ev)) prependRow(ev);
}

function rebuildFeed() {
  feedEl.innerHTML = "";
  for (const ev of EVENTS.filter(wanted).slice(-FEED_CAP)) prependRow(ev);
}

function prependRow(ev) {
  const li = document.createElement("li");
  if (ev.kind === "loot") {
    const qty = ev.qty > 1 ? ` ×${ev.qty}` : "";
    if (ev.quests && ev.quests.length) {
      li.className = "quest";
      // an in-era quest outranks out-of-era ones for the single shown slot
      const q = ev.quests.find(x => !x.oe) || ev.quests[0];
      li.append(itemSpan(ev.item + qty, ev.url, ev.sb, "itm"));
      li.insertAdjacentHTML("beforeend", ` — <span class="qn" data-url="${esc(q.url || "")}">${esc(q.n)}</span>`);
      if (q.oe) li.insertAdjacentHTML("beforeend", ` <span class="oe">out of era</span>`);
      if (ev.quests.length > 1) li.insertAdjacentHTML("beforeend", ` <span class="dim">+${ev.quests.length - 1}</span>`);
      if (q.rewards && q.rewards.length) {
        const r = document.createElement("span");
        r.className = "rew"; r.append(" → ");
        q.rewards.forEach((ref, i) => {
          if (i) r.append(", ");
          r.append(itemSpan(ref.n, ref.url, ref.sb, "ri"));
        });
        li.append(r);
      }
    } else {
      li.className = "loot";
      li.append(itemSpan(ev.item + qty, ev.url, ev.sb, "itm itm--plain"));
    }
  } else {
    li.className = "kill";
    li.innerHTML = `✕ ${esc(ev.n)}`;
  }
  feedEl.prepend(li);
  while (feedEl.children.length > FEED_CAP) feedEl.lastChild.remove();
}

/* The filter row drives the same prefs as Settings; main echoes the change
   back through overlay:init, which rebuilds the feed under the new filters. */
const fKills = document.getElementById("fKills");
const fQuestOnly = document.getElementById("fQuestOnly");
function renderFilters() { fKills.checked = PREFS.showKills; fQuestOnly.checked = PREFS.questOnly; }
fKills.addEventListener("change", () => window.companion.setOverlayPrefs({ showKills: fKills.checked }));
fQuestOnly.addEventListener("change", () => window.companion.setOverlayPrefs({ questOnly: fQuestOnly.checked }));

/* Tracked quests — pre-resolved rows from the main renderer: {n, url, got,
   need, done, miss, missMore}. The panel sits above the feed and only takes
   the height it uses. */
let TRACKED = [];
function renderQuests() {
  questsEl.innerHTML = "";
  const shown = PREFS.showQuests ? TRACKED.slice(0, 10) : [];
  questsEl.hidden = !shown.length;
  for (const q of shown) {
    const li = document.createElement("li");
    li.className = q.done ? "tq is-done" : "tq";
    const n = document.createElement("span");
    n.className = "tq__n"; n.textContent = q.n;
    if (q.url) n.dataset.url = q.url;
    const c = document.createElement("span");
    c.className = "tq__c"; c.textContent = q.done ? `✓ ${q.got}/${q.need}` : `${q.got}/${q.need}`;
    li.append(n, c);
    if (q.oe) {
      const o = document.createElement("span");
      o.className = "oe"; o.textContent = "out of era";
      n.after(o);
    }
    if (!q.done && q.miss && q.miss.length) {
      const m = document.createElement("div");
      m.className = "tq__miss";
      m.textContent = `need ${q.miss.join(", ")}${q.missMore ? ` +${q.missMore}` : ""}`;
      li.append(m);
    }
    questsEl.append(li);
  }
}
window.companion.onFeedQuests(q => { TRACKED = q || []; renderQuests(); });

function setMode(clickThrough, opacity) {
  THROUGH = !!clickThrough;
  if (opacity !== undefined) document.body.style.opacity = opacity;
  document.body.classList.toggle("through", THROUGH);
  pinEl.textContent = THROUGH ? "unpin" : "pin";
  pinEl.title = THROUGH
    ? "Give the mouse back to this panel (or Ctrl+Shift+L)"
    : "Click-through: the game gets the mouse. This button and quest links stay clickable.";
}

window.companion.onOverlayInit(({ opacity, clickThrough, prefs, feed, zone, quests }) => {
  if (prefs) PREFS = { ...PREFS, ...prefs };
  panelEl.style.zoom = PREFS.fontScale;
  setMode(clickThrough, opacity);
  renderFilters();
  // a fresh window seeds from main's ring; a prefs re-init keeps the richer
  // local history and just re-filters it
  if (!EVENTS.length) EVENTS = (feed || []).slice(-EVENT_CAP);
  rebuildFeed();
  setZone(zone);
  TRACKED = quests || [];
  renderQuests();
});
window.companion.onOverlayMode(({ clickThrough, opacity }) => setMode(clickThrough, opacity));
window.companion.onFeedEvent(addEvent);
window.companion.onFeedZone(setZone);

function setZone(z) {
  zoneEl.textContent = z ? `${z.name} ${z.done}/${z.total}` : "EQL Tools Companion";
}

pinEl.addEventListener("click", () => window.companion.setClickThrough(!THROUGH));

/* Mini EQ item tooltip — the sb lines ride on the hovered element. Works
   pinned too (forward:true keeps mousemove flowing). */
const tipEl = document.createElement("div");
tipEl.id = "otip"; tipEl.hidden = true;
document.body.appendChild(tipEl);
function moveTip(x, y) {
  const r = tipEl.getBoundingClientRect();
  let tx = x + 10, ty = y + 10;
  if (tx + r.width > innerWidth - 4) tx = Math.max(4, x - r.width - 10);
  if (ty + r.height > innerHeight - 4) ty = Math.max(4, innerHeight - r.height - 4);
  tipEl.style.left = tx + "px"; tipEl.style.top = ty + "px";
}
document.addEventListener("mousemove", e => { if (!tipEl.hidden) moveTip(e.clientX, e.clientY); });

/* Hotspot tracking: while pinned, hovering anything actionable makes the
   window interactive; leaving it hands the mouse back to the game. Shares
   the mouseover pass with the tooltip. */
document.addEventListener("mouseover", e => {
  let tip = null;
  for (let el = e.target; el && el !== document.body; el = el.parentElement)
    if (el._sb) { tip = el._sb; break; }
  if (tip) {
    tipEl.innerHTML = `<div class="ot__name">${esc(tip.n)}</div>` +
      tip.sb.map(l => `<div>${esc(l)}</div>`).join("");
    tipEl.hidden = false; moveTip(e.clientX, e.clientY);
  } else tipEl.hidden = true;
  if (!THROUGH) return;
  const hot = e.target.closest ? e.target.closest("[data-url], #btnPin, #filters") : null;
  window.companion.overlayHotspot(!!hot);
});
document.addEventListener("mouseout", e => {
  if (THROUGH && !e.relatedTarget) window.companion.overlayHotspot(false);
});

document.addEventListener("click", e => {
  const q = e.target.closest("[data-url]");
  if (q && q.dataset.url) window.companion.openWiki(q.dataset.url);
});

/* Corner resize grip. Pointer capture keeps the drag alive even when the
   cursor briefly leaves this small window. Sizes are DIPs, same as
   setBounds. */
gripEl.addEventListener("pointerdown", e => {
  e.preventDefault();
  gripEl.setPointerCapture(e.pointerId);
  const sx = e.screenX, sy = e.screenY, sw = window.innerWidth, sh = window.innerHeight;
  const move = ev => window.companion.resizeOverlay(sw + ev.screenX - sx, sh + ev.screenY - sy);
  const up = () => gripEl.removeEventListener("pointermove", move);
  gripEl.addEventListener("pointermove", move);
  gripEl.addEventListener("pointerup", up, { once: true });
});
