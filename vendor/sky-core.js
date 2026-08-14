/* DO NOT EDIT — generated copy of public/sky/sky-core.js (companion/scripts/sync-vendor.mjs).
   Edit the original; both the site and this app load the same logic. */
/* Plane of Sky — the measurement layer, shared by /sky and the companion app.

   This file owns the log grammar, the inventory read, "what do you hold", and
   "which tests are done". It is DOM-free and holds no state of its own so both
   surfaces run ONE implementation — the same contract as gear-score.js,
   tier.js and log-parser/engine.js. Edit here; never fork.

   /sky reads a whole log file at once (parseLog). The companion tails a file
   that is still being written, so it drives the same fold one batch of lines
   at a time (stream). parseLog IS a stream fed everything, so the two can
   never disagree about what a line means.

   Requires: window.EQLGearScore (baseName).  */
(function () {
  "use strict";
  const GS = window.EQLGearScore;

  /* ── log ─────────────────────────────────────────────────────────────────
     Six lines carry everything this page needs:

       You looted a Wind Rune Neza from Protector of Sky's corpse and stored
         it in your currency
       --You have looted a Fine Velvet Cloak from Keeper of Souls' corpse.--
       You offered 1 Fine Velvet Cloak to Ranger Spirit.
       Ranger Spirit says, 'I have no need for this, Ravlin. You can have it
         back.'
       You complete the trade with Ranger Spirit.
       You successfully destroyed 1 Fine Velvet Cloak.

     "You offered" fires when an item goes INTO the trade window, so it proves
     nothing on its own — a trade you backed out of prints the same line. Only
     "You complete the trade with X" closes it, and offers are held pending
     until that line names the same NPC.

     "You complete the trade" is NOT proof the NPC kept anything. Walk the wrong
     class's pieces up to the wrong quest giver and he hands them straight back,
     one "I have no need for this" per item — and the trade still closes. A real
     log had five of those with Sky givers, each one counted as a turn-in and
     reported as a turn-in that matched no test. The handback line names YOU, so
     it is matched against the character in the log's filename: the same line
     prints for every other player handing in at the same NPC, and in a crowded
     instance that is constant. */
  const TS = String.raw`^\[(\w{3} \w{3} \d{2} \d{2}:\d{2}:\d{2} \d{4})\] `;
  const RX = {
    // Both loot phrasings in one, with everything after "corpse" kept: that
    // tail decides whether the item ever reached your bags.
    loot:  new RegExp(TS + String.raw`(?:--)?You (?:have )?looted (?:an? |([\d,]+) )?(.+?) from .+?'s corpse(.*)$`),
    offer: new RegExp(TS + String.raw`You offered ([\d,]+) (.+?) to (.+?)\.$`),
    back:  new RegExp(TS + String.raw`(.+?) says, 'I have no need for this, (.+?)\. You can have it back\.'$`),
    done:  new RegExp(TS + String.raw`You complete the trade with (.+?)\.$`),
    // Destroying an item is the one disposal with an exact quantity on it.
    gone:  new RegExp(TS + String.raw`You successfully destroyed ([\d,]+) (.+?)\.$`),
    zone:  new RegExp(TS + String.raw`You have entered (.+?)\.$`),
    /* A merchant sale you made yourself, which is a different line from the
       autosell tail above and is the only thing that separates the two. The
       literal "(s)" is the client's, and the line carries no quantity, so this
       counts transactions, not items. Same regex /log-parser uses. */
    vendor:new RegExp(TS + String.raw`You receive (.+?) from .+? for the (.+?)\(s\)\.$`),
  };

  /* A loot line does NOT mean you kept it. In a real 1.5M-line log, 1,928 lines
     end "and sold it for <coin>." and 334 "and sold it for free." — autosell
     fired and the item went straight to a merchant, never to your bags. Another
     116 end "and stored it in your tradeskill depot", which you DO still have,
     and the currency variant is the only way a wind rune ever appears.
     Counting the tail as loot claimed 7 Bixie Stingers where 1 was held. */
  function keptIt(tail) {
    if (/ and sold it for /.test(tail)) return false;   // autosold, incl. "for free"
    if (/ to create an? /.test(tail)) return false;     // consumed by a combine
    return true;
  }
  const wasSold = (tail) => / and sold it for /.test(tail);
  const qty = (s) => (s ? parseInt(String(s).replace(/,/g, ""), 10) || 1 : 1);
  // The log names items at their upgrade tier ("Efreeti Magi Staff +1"). Sky
  // components and rewards are tracked by base name — five components in a real
  // log were tier-suffixed and would otherwise never match.
  const baseOf = (n) => GS.baseName(n).base.trim();

  /* One fold over log lines. The page hands it a file; the app hands it the
     lines that landed in the last second. Nothing here looks ahead, so the
     two produce the same ledger for the same bytes. */
  function stream(me) {
    const led = {
      looted: new Map(),      // base name -> times looted AND kept
      sold: new Map(),        // base name -> times autosold on pickup
      vendored: new Map(),    // base name -> merchant sales you made yourself
      destroyed: new Map(),   // base name -> destroyed by hand
      delivered: new Map(),   // base name -> times handed over in a closed trade
      trades: [],             // {npc, items:Map(name->qty), ts}
      first: null, last: null, sawSky: false,
      /* Lines this ledger has actually consumed. A tailing host re-renders off
         it: a second of combat spam moves nothing here, and re-deriving a
         95-test board for every batch of log lines is pure waste. */
      n: 0,
    };
    const pending = new Map();      // npc -> [{n, q}] offered but not yet closed
    const handback = new Map();     // npc -> items refused since the offer opened
    const bump = (m, k, v) => m.set(k, (m.get(k) || 0) + v);

    function consume(ln) {
      if (ln.charCodeAt(0) !== 91) return false;    // every real line starts '['
      let m;
      if ((m = RX.loot.exec(ln))) {
        const tail = m[4] || "";
        if (keptIt(tail)) bump(led.looted, baseOf(m[3]), qty(m[2]));
        else if (wasSold(tail)) bump(led.sold, baseOf(m[3]), qty(m[2]));
        led.first = led.first || m[1]; led.last = m[1];
        return true;
      }
      if ((m = RX.offer.exec(ln))) {
        const npc = m[4];
        if (!pending.has(npc)) pending.set(npc, []);
        pending.get(npc).push({ n: baseOf(m[3]), q: qty(m[2]) });
        led.first = led.first || m[1]; led.last = m[1];
        return true;
      }
      if ((m = RX.back.exec(ln))) {
        // Only yours, and only against an offer that is actually open — the
        // same NPC refusing someone else's pieces prints an identical line.
        const npc = m[2];
        if ((!me || m[3] === me) && pending.has(npc)) {
          handback.set(npc, (handback.get(npc) || 0) + 1);
        }
        return true;
      }
      if ((m = RX.done.exec(ln))) {
        const npc = m[2], held = pending.get(npc);
        const refused = handback.get(npc) || 0;
        pending.delete(npc); handback.delete(npc);
        /* One refusal per item, so a refusal for every offer line is the whole
           trade coming back: nothing was handed over and no test advanced.
           A partial refusal has no line naming WHICH item bounced, so the rest
           of the trade is counted as delivered and this one item is overcounted
           — the alternative is discarding a turn-in that really happened. */
        if (held && held.length && refused < held.length) {
          const items = new Map();
          held.forEach((o) => bump(items, o.n, o.q));
          items.forEach((v, k) => bump(led.delivered, k, v));
          led.trades.push({ npc, items, ts: m[1] });
        }
        led.first = led.first || m[1]; led.last = m[1];
        return true;
      }
      if ((m = RX.gone.exec(ln))) {
        bump(led.destroyed, baseOf(m[3]), qty(m[2]));
        led.first = led.first || m[1]; led.last = m[1];
        return true;
      }
      if ((m = RX.vendor.exec(ln))) {
        bump(led.vendored, baseOf(m[3]), 1);
        led.first = led.first || m[1]; led.last = m[1];
        return true;
      }
      if ((m = RX.zone.exec(ln))) {
        // The game says "The Plane of Sky"; the wiki page is "Plane of Sky".
        if (m[2].replace(/^The /, "") === "Plane of Sky") led.sawSky = true;
        led.first = led.first || m[1]; led.last = m[1];
        return true;
      }
      return false;
    }
    const line = (ln) => { if (consume(ln)) led.n++; };

    return {
      led,
      feed(lines) { for (const ln of lines) line(ln); return led; },
      text(t) { for (const ln of String(t).split(/\r?\n/)) line(ln); return led; },
    };
  }

  const parseLog = (text, me) => stream(me).text(text);

  /* ── inventory (optional) ───────────────────────────────────────────────
     Every place the dump can hold a thing, not just the worn slots /gear
     reads — a Sky component sits in a bag, a bank slot or the storage
     Equipment bin, never on your head.

     Locations are kept, not collapsed to a count: "you hold 1" and "it is in
     bank slot 12" are the same question asked twice, and the second one is
     what gets you off the island. Exaltation stones are excluded — a stone is
     named after the item it was rendered from, so counting one would report a
     component you no longer own.

     Returns base name -> { n, where: [{ loc, sec, count }] }. */
  function parseInv(text) {
    const held = new Map();
    for (const r of GS.parseRows(text)) {
      if (r.exalt) continue;
      const n = baseOf(r.base);
      let e = held.get(n);
      if (!e) held.set(n, (e = { n: 0, where: [] }));
      e.n += r.count;
      e.where.push({ loc: r.loc, sec: r.sec, count: r.count });
    }
    return held;
  }
  const invCount = (inv, name) => (inv && inv.get(name) ? inv.get(name).n : 0);
  const invWhere = (inv, name) => (inv && inv.get(name) ? inv.get(name).where : []);

  /* ── what you hold ──────────────────────────────────────────────────────
     From the log alone: looted, minus handed over, minus destroyed. Handing to
     a player prints the same trade lines an NPC does, so that leaves the count
     too. It still undercounts anything you had before logging started.

     A merchant sale is the one disposal the log will not let you subtract: the
     line carries no quantity, so taking 1 off a stack of five would be a guess.
     The Vendored column states that number beside Have instead of quietly
     folding a guess into it. Destroyed gets its own column for the same reason
     — the count is exact and comes off Have, but "you had one of these and
     broke it" is the kind of thing you want to read, not infer from a zero.

     The inventory dump, when given, is the authority for everything except wind
     runes, which it cannot see. */
  /* Two different disposals, two different log lines.

     Autosold on pickup is stamped on the loot line itself ("…from X's corpse and
     sold it for 3gp"), so it can only be the loot filter — the item was never in
     your bags to sell by hand. There is no inventory equivalent: a dump can only
     show what you kept, which is what makes an accidental filter invisible to
     every other tracker.

     A sale you made at a merchant prints its own line instead ("You receive 3
     gold from Merchant Bob for the Jade(s)"), carries no quantity, and says
     nothing about a filter. Counted separately for that reason. */
  const soldCount = (led, name) => led.sold.get(name) || 0;
  const vendorCount = (led, name) => (led.vendored && led.vendored.get(name)) || 0;
  const goneCount = (led, name) => (led.destroyed && led.destroyed.get(name)) || 0;

  // A wind rune goes to the currency tab, which /outputfile inventory does not
  // export — so however good the dump is, the log is the only witness for one.
  const isRune = (name) => String(name).indexOf("Wind Rune") === 0;

  const logHeld = (led, name) => Math.max(0, (led.looted.get(name) || 0)
    - (led.delivered.get(name) || 0) - goneCount(led, name));

  function held(led, inv, name) {
    const fromLog = logHeld(led, name);
    if (!inv) return { n: fromLog, src: "log" };
    if (isRune(name)) return { n: fromLog, src: "log" };
    return { n: invCount(inv, name), src: "inv", where: invWhere(inv, name) };
  }

  /* ── reconciling the two witnesses ───────────────────────────────────────
     The dump is authoritative for what you hold right now, so `held` returns
     it. That silently discards the log's own count, and the two disagree for
     reasons worth reading rather than hiding:

       log HIGHER  — looted before the dump and moved since (traded to a player,
                     put in the Dragon's Hoard while its window was shut, sold
                     by hand), or the dump is simply older than the loot.
       log LOWER   — you had it before `/log on`, or it came from a quest reward
                     or a merchant, neither of which prints a loot line.

     Neither is an error, and neither number is the "right" one. `gap` is
     inv − log; a caller shows both when it is non-zero and says nothing when
     the two agree. Wind runes have no dump number at all, so they reconcile to
     nothing. */
  function reconcile(led, inv, name) {
    const log = logHeld(led, name);
    if (!inv || isRune(name)) return { log, inv: null, gap: 0 };
    const n = invCount(inv, name);
    return { log, inv: n, gap: n - log };
  }

  /* ── which tests are done ───────────────────────────────────────────────
     One closed trade is one turn-in. A trade counts for a test when every item
     that test asks for appears in it; where two tests could match, the one
     asking for more items wins. A trade to a quest giver that matches nothing
     is reported rather than dropped — that is what a split turn-in (rune in one
     trade, piece in another) looks like, and silently ignoring it would read as
     "not done". */
  function completions(data, led, code) {
    const c = data.classes[code];
    const out = { byTest: {}, orphan: 0 };
    if (!c || !c.giver) return out;
    for (const t of c.tests) out.byTest[t.n] = 0;
    for (const tr of led.trades) {
      if (tr.npc !== c.giver) continue;
      let best = null;
      for (const t of c.tests) {
        const need = t.rune.concat(t.items.map((i) => i.n));
        if (!need.length) continue;
        if (need.every((n) => (tr.items.get(n) || 0) >= 1)) {
          if (!best || need.length > best.need) best = { t, need: need.length };
        }
      }
      if (best) out.byTest[best.t.n]++; else out.orphan++;
    }
    return out;
  }

  // Everything one test consumes: its wind rune plus its components, one each.
  const needsOf = (t) => t.rune.concat(t.items.map((i) => i.n));

  /* `have(name)` is the host's held count — /sky reads log-or-dump, the app
     folds in loot since the dump and the player's own "I have this" marks.
     `skip` is a want, not a fact, and suppresses ready. */
  function testState(t, done, skip, have) {
    const missing = needsOf(t).filter((n) => have(n) < 1);
    return { done, skip: !!skip, finished: done > 0,
             ready: missing.length === 0 && done === 0 && !skip, missing };
  }

  /* ── the drop table, arranged for reading ────────────────────────────────
     sky.json keeps every mob the island rosters name — 48 of them — because the
     data should be at full granularity and the grouping should live in the
     display. Forty-eight folds is not a board you read with a corpse on the
     floor, and eleven of them are one-item spiroc commons.

     So: a fold per NAMED mob (the boss, and the Efreeti-cycle mobs that spawn
     off each other), and ONE fold per island for everything else on it. `src`
     keeps which common dropped what, so a row can still say so on hover — the
     detail is grouped, not discarded.

     `rowFor(name, mob)` is the host's: /sky and the companion count what you
     hold differently (a dump with bag slots, a held mark) and neither answer
     belongs in here. */
  function bossBoard(data, rowFor) {
    return (data.isles || []).map(function (isle) {
      const named = [], loose = [];
      isle.mobs.forEach((m) => (m.role === "common" || m.role === "trash" ? loose : named).push(m));
      const mk = (n, role, drops, from, src) => ({
        isl: isle.isl, isle: isle.name, req: isle.req || [], key: isle.key || [],
        n: n, role: role, from: from, src: src || null,
        rows: drops.map((d) => rowFor(d, n)),
      });
      const out = named.map((m) => mk(m.n, m.role, m.drops, [m.n]));
      const drops = [], from = [], src = {};
      for (const m of loose) {
        if (m.drops.length) from.push(m.n);
        for (const n of m.drops) {
          if (!src[n]) { src[n] = []; drops.push(n); }
          src[n].push(m.n);
        }
      }
      if (drops.length) out.push(mk("Island trash", "trash", drops, from, src));
      return { isl: isle.isl, name: isle.name, req: isle.req || [],
               key: isle.key || [], mobs: out };
    });
  }

  window.EQLSky = {
    RX, keptIt, wasSold, qty, baseOf, isRune,
    stream, parseLog, parseInv, invCount, invWhere,
    soldCount, vendorCount, goneCount, held, logHeld, reconcile,
    completions, needsOf, testState, bossBoard,
  };
})();
