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

     The upgrade tier comes along because the dump is the only place it is
     written: a bank copy of a reward is "Dark Cloak of the Sky +3", and a
     comparison that scores it at +0 understates the thing you are actually
     holding. Counting and matching still run on the base name.

     Returns base name -> { n, tier, worn, where: [{ loc, sec, count, tier }] }. */
  function parseInv(text) {
    const held = new Map();
    for (const r of GS.parseRows(text)) {
      if (r.exalt) continue;
      const n = baseOf(r.base);
      let e = held.get(n);
      if (!e) held.set(n, (e = { n: 0, tier: 0, worn: 0, where: [] }));
      e.n += r.count;
      e.tier = Math.max(e.tier, r.tier || 0);
      // What you are wearing is not what is crowding your bank. An aug in a
      // -SlotN row is not the worn item itself, so it is not counted as worn.
      if (!r.sub && GS.WORN_RX.test(r.root)) e.worn += r.count;
      e.where.push({ loc: r.loc, sec: r.sec, count: r.count, tier: r.tier || 0 });
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
    if (!inv) return { n: fromLog, src: "log", tier: 0, worn: 0 };
    if (isRune(name)) return { n: fromLog, src: "log", tier: 0, worn: 0 };
    const e = inv.get(name);
    return { n: invCount(inv, name), src: "inv", where: invWhere(inv, name),
             tier: (e && e.tier) || 0, worn: (e && e.worn) || 0 };
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

  /* ── what to skip, and what to clear out ─────────────────────────────────
     Two questions, one after the other: which tests are not worth running
     again, and — once you have ticked those — what is left in your bags that
     nothing wants.

     `skyIndex` is one pass over all 95 tests: per item name, every test that
     consumes it, every test that pays it, where it drops, and the wiki table's
     NO DROP marker. */
  function skyIndex(data) {
    const idx = new Map();
    const get = (n) => {
      let e = idx.get(n);
      if (!e) idx.set(n, (e = { n, isl: "", mob: "", mark: null, uses: [], pays: [] }));
      return e;
    };
    for (const code of Object.keys((data && data.classes) || {})) {
      for (const t of data.classes[code].tests) {
        for (const i of t.items) {
          const e = get(i.n);
          if (!e.isl && i.isl) { e.isl = i.isl; e.mob = i.mob || ""; }
          e.mark = !!(e.mark || i.nodrop);
          // a test asking for two of one piece is still one test
          if (!e.uses.some((u) => u.code === code && u.test === t)) {
            e.uses.push({ code, test: t, reward: t.reward || "" });
          }
        }
        if (t.reward) get(t.reward).pays.push({ code, test: t });
      }
    }
    return idx;
  }

  /* Can anyone else take it off your hands?

     NO DROP and No Trade are the game's answer, and the item window is where it
     is written: `fl` carries the flags, and `sb` — the window itself — is proof
     we have one to read, since an item with no flags line has no `fl` at all.

     The `Plane of Sky` table's own {{SkyNoDrop}} marker is a wiki editor's
     annotation of the same fact and it disagrees with the item window on five
     items (Efreeti Great Staff, Bixie Stinger, Djinni Stave, Sphinxian Ring,
     Crown of Elemental Mastery). The window wins; the marker is what answers
     for the 44 components that have no item page at all. `clash` says when the
     two disagreed, because the difference between the answers is destroying a
     weapon and selling it. */
  const NO_GIVE = { no_drop: 1, no_trade: 1 };
  function disposal(rec, mark) {
    if (!rec || !(rec.fl || rec.sb)) {
      return { give: mark == null ? null : !mark, src: mark == null ? null : "table", clash: false };
    }
    const nd = ((rec && rec.fl) || []).some((f) => NO_GIVE[f]);
    return { give: !nd, src: "item", clash: mark != null && mark !== nd };
  }

  /* ── which tests to skip ──────────────────────────────────────────────────
     **Doing a test the first time is not optional.** A class's Primary Class
     Unlock is exactly its Sky tests — one "Obtain <reward>" criterion each, all
     sixteen classes — so the first run of every test buys the class, whatever
     the reward is worth. Recommending a skip on a test you have never done
     costs you the unlock, which is what most players are up there for.

     Kyle, 2026-08-14: *"most people want to finish all quests for each class
     once to unlock that class … you're recommending things that i have already
     done once that are not strong items."*

     So the recommendation is about the SECOND run and after. A finished test is
     a repeatable source of a duplicate reward, and a duplicate merges into the
     one you hold to raise its upgrade tier — the alternative being motes, which
     are worth keeping (docs/tools/companion-roadmap.md §7). Repeating is worth
     the islands when the reward is; it is not when the reward is the 38th best
     thing that class can wear in the slot.

       unlockFirst  true  — only tests you have already done are candidates
                    false — rank alone decides, for a class you will never roll

     The host owns every measurement:
       have(name)              -> { n, worn, tier, where: [{loc, sec, count}] }
       state(code, test)       -> { done, skip }   done = TIMES, every witness
       rank(name, code, tier)  -> { rank, of, better } | null

     `done` is a count, not a flag, and it counts every witness the host has —
     the log's turn-ins and the achievement record both. /sky keeps those apart
     for display (its Turned in column must not claim a turn-in nobody watched)
     and folds them back together here; passing the log count alone silently
     threw away every test the achievement dump was the only witness for.

     A test you have ALREADY skipped stays in the list, ticked. Dropping it the
     moment the box is ticked takes the box away with it, and an accidental tick
     would then only be undoable from another tab. `held` back is reported too:
     a list that silently drops the tests it will not talk about reads as "there
     is nothing else". */
  function skipRows(data, o) {
    const top = Math.max(1, o.top || 3);
    const unlockFirst = o.unlockFirst !== false;
    const idx = skyIndex(data);
    const out = [];
    let unlock = 0, unranked = 0;
    for (const code of Object.keys((data && data.classes) || {})) {
      for (const t of data.classes[code].tests) {
        const st = o.state(code, t);
        const rk = o.rank(t.reward, code, 0);
        if (!rk) { if (!st.skip) unranked++; continue; }
        if (rk.rank <= top && !st.skip) continue;
        // never sell the unlock for a reward's ranking
        if (unlockFirst && !st.done && !st.skip) { unlock++; continue; }

        /* What ticking this frees: the pieces you are holding that no OTHER
           live test wants. A test you have done is still live — it can be run
           again — so only a skip takes one out. */
        const held = t.items.filter((i) => (o.have(i.n) || { n: 0 }).n > 0);
        const frees = held.filter((i) => {
          const e = idx.get(i.n);
          return !e || !e.uses.some((u) => {
            if (u.code === code && u.test === t) return false;
            return !o.state(u.code, u.test).skip;
          });
        });
        const rew = o.have(t.reward) || { n: 0, tier: 0 };
        out.push({
          code, test: t, reward: t.reward, rk, st, done: st.done,
          // what running it again pays: the merge that takes your copy up a
          // tier, which is the whole reason a finished test is not a closed row
          tier: rew.n ? rew.tier : null,
          held: held.map((i) => i.n), frees: frees.map((i) => i.n),
        });
      }
    }
    /* What skipping frees comes first — those are the rows that put something in
       the cleanout list — then the worst reward. */
    out.sort((a, b) => (a.st.skip - b.st.skip) || (b.frees.length - a.frees.length)
      || (b.held.length - a.held.length) || (b.rk.rank - a.rk.rank)
      || a.test.n.localeCompare(b.test.n));
    out.unlock = unlock;
    out.unranked = unranked;
    return out;
  }

  /* ── the cleanout list ────────────────────────────────────────────────────
     Kyle, 2026-08-14: *"showing me what i have that i have marked skip, sorted
     by location (bank, inventory, storage, etc) so i can clean it out."*

     So this keys on the skip mark and nothing else. An item is on the list when
     you are holding it and EVERY test that consumes it is one you ticked.

     A piece a skipped test wants that some other test does too is held back and
     counted, not listed: a cleanout list you have to re-check before acting on
     is not a cleanout list. So is anything worn — several components are
     equippable weapons, the nineteen Efreeti pieces among them.

     Rewards are never on it. A reward is the thing you did the test FOR: the
     unlock's "Obtain X" criterion, and usually the item you have on.

     **One row per PLACE.** Three Bixie Essences in three different bank slots
     are three things to find, and the whole point of the list is walking to
     them. `have(name).where` is where they are; `sec` is which section of the
     dump (bags / storage / bank / …), and `secIdx` is that section's own order,
     so a surface can sort by place without knowing the vocabulary. */
  const SEC_ORDER = {};
  (GS.LOC_SECTIONS || []).forEach(([k], i) => { SEC_ORDER[k] = i; });
  function cleanoutRows(data, o) {
    const rec = o.rec || (() => null);
    const out = [];
    let mixed = 0, worn = 0;
    for (const e of skyIndex(data).values()) {
      if (isRune(e.n)) continue;        // the currency tab; never in a bag
      if (e.pays.length) continue;      // a reward, not a component
      if (!e.uses.length) continue;
      const h = o.have(e.n) || { n: 0 };
      if (!h.n) continue;
      const uses = e.uses.map((u) => Object.assign({}, u, { st: o.state(u.code, u.test) }));
      const skipped = uses.filter((u) => u.st.skip);
      if (!skipped.length) continue;
      if (skipped.length < uses.length) { mixed++; continue; }
      const r = rec(e.n);
      const d = disposal(r, e.mark);
      const base = {
        n: e.n, rec: r, uses, wt: (r && r.wt) || 0, wantedBy: e.uses.length,
        give: d.give, giveSrc: d.src, clash: d.clash, isl: e.isl, mob: e.mob,
        have: h.n, tier: h.tier || 0,
      };
      const places = (h.where || []).filter((w) => w.sec !== "worn");
      if (places.length < (h.where || []).length) worn++;
      if (!places.length) {
        // held on the log's word alone: no dump, or every copy is worn
        if (!h.where && h.n > (h.worn || 0)) {
          out.push(Object.assign({ loc: "", sec: "", secIdx: 99, count: h.n - (h.worn || 0) }, base));
        }
        continue;
      }
      for (const w of places) {
        out.push(Object.assign({ loc: w.loc, sec: w.sec, secIdx: SEC_ORDER[w.sec] == null ? 99 : SEC_ORDER[w.sec],
                                 count: w.count }, base));
      }
    }
    out.sort((a, b) => (a.secIdx - b.secIdx) || a.loc.localeCompare(b.loc, undefined, { numeric: true })
      || a.n.localeCompare(b.n));
    out.mixed = mixed;
    out.worn = worn;
    return out;
  }
  window.EQLSky = {
    RX, keptIt, wasSold, qty, baseOf, isRune,
    stream, parseLog, parseInv, invCount, invWhere,
    soldCount, vendorCount, goneCount, held, logHeld, reconcile,
    completions, needsOf, testState, bossBoard,
    skyIndex, disposal, skipRows, cleanoutRows,
  };
})();
