/* DO NOT EDIT — generated copy of public/_shared/exalt-slots.js (companion/scripts/sync-vendor.mjs).
   Edit the original; both the site and this app load the same logic. */
/* Exaltation sockets — reading "Head-Slot7" as a thing with a meaning.

   The `/outputfile inventory` dump nests a socketed stone under its host item
   with a numbered location, "Head-Slot7". Every surface that showed those rows
   printed the raw number, which tells the player nothing (Kyle, 2026-08-14:
   "exaltations are showing as SlotN, figure out what each slot is").

   ── the map, and how it was established ─────────────────────────────────────
   The wiki page "Exaltations" states five slot types that unlock as an item's
   LEVEL (its +N upgrade tier) rises:

     Ornamentation  level +0   the look of another item (visible equipment only)
     Focus          level +1   a Focus Effect from another item
     Click          level +2   a Click Effect
     Worn           level +3   a passive Worn Effect
     Proc           level +4   a Proc Effect

   The dump's socket ids are 1 or 2 (Ornamentation) and 7, 8, 9, 10. Two stones
   apiece is not enough evidence to put a WORD on a player's screen, so the map
   is not resting on them. It rests on a prediction the map makes and the naive
   reading does not: if 7/8/9/10 really are Focus/Click/Worn/Proc unlocking at
   +1/+2/+3/+4, then the socket ids present on any item are fully determined by
   its tier — no measurement of the stones involved.

     sockets(item) = [ornament id, if the slot is visible equipment]
                   + 7 if tier>=1, 8 if tier>=2, 9 if tier>=3, 10 if tier>=4

   Checked against all 23 worn items on the reference character: 23 match, 0
   mismatch. A Waist at +1 has exactly [7]; a Head at +3 has [1,7,8,9] and no
   10; Hands at +0 has [2] alone; a Chest at +6 has [2,7,8,9,10] and stops
   there. Occupancy agrees separately and with no crossover — all 7 filled
   ornament sockets are id 1 or 2, all 22 filled exaltation sockets are 7-10.

   WHAT IS STILL UNKNOWN: why Head and Range use ornament id 1 while every other
   visible slot uses 2. Both are Ornamentation-only in the data; the split has
   no explanation here and is not guessed at in the label. Ids 3-6 have never
   been seen and are reported as unknown rather than invented.

   ── sockets are not bag slots ───────────────────────────────────────────────
   "-SlotN" also means "position N inside this container": "General 1-Slot14" is
   bag 1's fourteenth slot, not a socket. The two are told apart by what the
   suffix hangs off — a worn slot name, or an item that is itself inside
   something ("General 1-Slot14-Slot7") — never by the number.

   Requires: window.EQLGearScore (WORN_RX). */
(function () {
  "use strict";
  const GS = window.EQLGearScore;

  /* `at` is the item level the wiki says unlocks the type; `sort` is display
     order, which follows the unlock order rather than the raw id. */
  const TYPES = {
    1:  { key: "orn",   label: "Ornament", at: 0, sort: 0,
          what: "The look of another item. Visible equipment only." },
    2:  { key: "orn",   label: "Ornament", at: 0, sort: 0,
          what: "The look of another item. Visible equipment only." },
    7:  { key: "focus", label: "Focus",    at: 1, sort: 1,
          what: "A focus effect carried over from another item." },
    8:  { key: "click", label: "Click",    at: 2, sort: 2,
          what: "A clickable effect carried over from another item." },
    9:  { key: "worn",  label: "Worn",     at: 3, sort: 3,
          what: "A passive worn effect carried over from another item." },
    10: { key: "proc",  label: "Proc",     at: 4, sort: 4,
          what: "A combat proc carried over from another item." },
  };
  const typeOf = (n) => TYPES[n] || null;

  /* Is this location a socket, and which one? Returns null for a bag position
     and for anything with no -SlotN at all. */
  function socketAt(loc) {
    const m = /^(.*)-Slot(\d+)$/.exec(String(loc || ""));
    if (!m) return null;
    const host = m[1], n = +m[2];
    // hangs off a worn slot, or off something already nested inside a container
    if (!GS.WORN_RX.test(host) && !/-Slot\d+$/.test(host)) return null;
    return { n, host, type: typeOf(n) };
  }

  /* The socket ids an item of this tier should have, per the rule above. The
     ornament id is not predictable from the tier — it depends on the slot — so
     it is passed in when the caller knows it. */
  function expectedSockets(tier, ornamentId) {
    const out = ornamentId ? [ornamentId] : [];
    for (const n of [7, 8, 9, 10]) if (tier >= TYPES[n].at) out.push(n);
    return out;
  }

  /* What a stone in this socket actually gives you, read off the record of the
     item it was rendered from. Returns null when the data cannot say — which is
     honest and visible, rather than a blank that reads as "nothing". */
  function grants(rec, socketN) {
    const t = typeOf(socketN);
    if (!rec || !t) return null;
    const effs = rec.eff || [];
    const pick = (test) => effs.find(test) || null;
    if (t.key === "focus") {
      // `foc` is the wiki's own {{Itempage}} field — the in-game item window
      // never prints a focus effect, so it is not in the statsblock and was
      // absent from gear-data until 2026-08-14 (gearparse.py).
      if (rec.foc) return { text: rec.foc, kind: "focus" };
      const e = pick((x) => x.k === "focus");
      return e ? { text: e.n, kind: "focus" } : null;
    }
    if (t.key === "click") {
      const e = pick((x) => x.m === "clicky" || x.m === "must_equip" || x.k === "click"
        || (!x.m && x.ct));
      return e ? { text: e.n, kind: "click", ct: e.ct, lvl: e.l } : null;
    }
    if (t.key === "worn") {
      const e = pick((x) => x.m === "worn" || x.k === "worn_eff");
      return e ? { text: e.n, kind: "worn" } : null;
    }
    if (t.key === "proc") {
      const e = pick((x) => x.m === "combat" || x.k === "combat_eff");
      return e ? { text: e.n, kind: "proc", lvl: e.l } : null;
    }
    return null;                       // ornament: the look IS the source item
  }

  /* A stone sitting loose in the Augmentation bin. Nothing has told us which of
     its source item's properties it holds — a stone is one property, not all of
     them — so every transferable one is listed and none is claimed. */
  function describeLoose(rec, srcName) {
    const rows = [];
    for (const n of [7, 8, 9, 10]) {
      const g = grants(rec, n);
      if (g) rows.push({ label: typeOf(n).label, text: g.text });
    }
    return rows;
  }

  /* One line for a hover: what this stone is and what it does. `srcName` is the
     item the stone was rendered from (the stone's own name minus the suffix). */
  function describe(rec, socketN, srcName) {
    const t = typeOf(socketN);
    if (!t) {
      const rows = describeLoose(rec, srcName);
      return { title: "Exaltation", rows,
               body: rows.length
                 ? rows.map((r) => `${r.label}: ${r.text}`).join(" · ")
                 : `Rendered from ${srcName || "an item"}. The wiki records no transferable effect on it.` };
    }
    if (t.key === "orn") {
      return { title: "Ornament",
               body: srcName ? `Makes this item look like ${srcName}.` : t.what };
    }
    const g = grants(rec, socketN);
    const from = srcName ? ` from ${srcName}` : "";
    if (!g) {
      return { title: t.label,
               body: `${t.what}${srcName ? ` Rendered from ${srcName}.` : ""} The wiki does not record which effect this one carries.` };
    }
    const tail = g.ct && g.ct !== "Instant" ? ` (${g.ct})` : "";
    const lvl = g.lvl ? ` (level ${g.lvl})` : "";
    return { title: t.label, body: `${g.text}${tail}${lvl} — ${t.label.toLowerCase()} effect${from}.` };
  }

  window.EQLExalt = { TYPES, typeOf, socketAt, expectedSockets, grants, describe, describeLoose };
})();
