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
let PREFS = { fontScale: 1, showKills: true, questOnly: false, view: "loot" };
const FEED_CAP = 50; // matches main's relay ring; the window scrolls, not truncates

/* Two views, tab-switched: Tracked (quest working lists) and Loot (the feed).
   The choice persists through main's prefs like every other overlay pref. */
const filtersEl = document.getElementById("filters");
function applyView() {
  const t = PREFS.view === "tracked";
  questsEl.hidden = !t;
  feedEl.hidden = t;
  filtersEl.hidden = t;
  document.getElementById("otTracked").classList.toggle("on", t);
  document.getElementById("otLoot").classList.toggle("on", !t);
}
document.getElementById("otabs").addEventListener("click", e => {
  const b = e.target.closest("[data-oview]");
  if (!b || PREFS.view === b.dataset.oview) return;
  PREFS.view = b.dataset.oview;
  window.companion.setOverlayPrefs({ view: PREFS.view });
  applyView();
});

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
  if (wanted(ev)) { prependRow(ev); rehotspot(); }
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

/* Tracked view — pre-resolved rows from the main renderer: {n, url, got,
   need, done, oe, comps: [{n, have, url, src: [{mn, mu, zn, zu}]}]}. The
   whole working list: every component with a held mark, wiki links on the
   item, and the missing pieces' mob · zone sources (Kyle, 2026-07-31: "I
   need to see the list of things i need. i need to see what zone and mob.
   i need to be able to click all of those things"). */
let TRACKED = [];
const link = (text, url, cls) => {
  const a = document.createElement("span");
  a.className = cls; a.textContent = text;
  if (url) a.dataset.url = url;
  return a;
};
function renderQuests() {
  questsEl.innerHTML = "";
  if (!TRACKED.length) {
    const li = document.createElement("li");
    li.className = "tq-none";
    li.textContent = "Nothing tracked — hit Track on a quest in the app.";
    questsEl.append(li);
    return;
  }
  for (const q of TRACKED) {
    const li = document.createElement("li");
    li.className = q.done ? "tq is-done" : "tq";
    li.append(link(q.n, q.url, "tq__n"));
    if (q.oe) {
      const o = document.createElement("span");
      o.className = "oe"; o.textContent = "out of era";
      li.append(o);
    }
    const c = document.createElement("span");
    c.className = "tq__c"; c.textContent = q.done ? `✓ ${q.got}/${q.need}` : `${q.got}/${q.need}`;
    li.append(c);
    const ul = document.createElement("ul");
    ul.className = "tqc";
    for (const comp of q.comps || []) {
      const cl = document.createElement("li");
      cl.className = comp.have ? "is-have" : "";
      const tick = document.createElement("span");
      tick.className = "tqc__tick"; tick.textContent = comp.have ? "✓" : "·";
      cl.append(tick, link(comp.n, comp.url, "tqc__n"));
      if (comp.have > 1) {
        const x = document.createElement("span");
        x.className = "dim"; x.textContent = ` ×${comp.have}`;
        cl.append(x);
      }
      if (!comp.have && comp.src && comp.src.length) {
        const s = document.createElement("span");
        s.className = "tqc__src";
        comp.src.forEach((d, i) => {
          if (i) s.append(", ");
          s.append(link(d.mn, d.mu, "tqc__m"));
          if (d.zn) { s.append(" · "); s.append(link(d.zn, d.zu, "tqc__z")); }
        });
        cl.append(s);
      }
      ul.append(cl);
    }
    li.append(ul);
    questsEl.append(li);
  }
}
window.companion.onFeedQuests(q => { TRACKED = q || []; renderQuests(); rehotspot(); });

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
  applyView();
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
let MX = 0, MY = 0;
document.addEventListener("mousemove", e => {
  MX = e.clientX; MY = e.clientY;
  if (!tipEl.hidden) moveTip(e.clientX, e.clientY);
});

/* A rebuild can swap the DOM out from under a pinned cursor — the hotspot
   state must track what is under the pointer NOW, or the next game click
   gets swallowed by a window that thinks it's still over a link. */
function rehotspot() {
  if (!THROUGH) return;
  const el = document.elementFromPoint(MX, MY);
  const hot = el && el.closest ? el.closest("[data-url], #btnPin, #filters, #otabs") : null;
  window.companion.overlayHotspot(!!hot);
}

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
  const hot = e.target.closest ? e.target.closest("[data-url], #btnPin, #filters, #otabs") : null;
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
