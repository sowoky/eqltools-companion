/* DO NOT EDIT — generated copy of public/_shared/achievements.js (companion/scripts/sync-vendor.mjs).
   Edit the original; both the site and this app load the same logic. */
/* The `/outputfile achievements` dump — parsed, and read honestly.
   ONE implementation; the companion vendors this file rather than forking it.

   The dump is the only client-observed record of what a character did BEFORE
   any tool was watching. That is its whole value: a log can only ever tell you
   about the sessions it was running for, and most players install a tool after
   they have already played for weeks.

   ── the file ───────────────────────────────────────────────────────────────
   Tab-indented, three levels, every row below a section flagged C (complete)
   or I (incomplete):

       Untapped Potential: Classes                <- section: no flag, no tab
       I<TAB>Primary Class Unlock - Bard          <- achievement
       C<TAB><TAB>Obtain Amulet of the Fae.       <- criterion

   865 achievements in the 2026-07-09 dump; the file is MIXED (it carries
   live-EQ rows alongside EQL's — see docs/CLIENT-FILES.md §6), so callers ask
   for the section they understand rather than walking all of it.

   ── the trap ───────────────────────────────────────────────────────────────
   A criterion's C flag DOES NOT mean the criterion happened. When an unlock
   achievement completes — by creation, or by spending an unlock token — the
   client force-marks every one of its criteria complete.

   Proven inside one dump, no inference required: `EverQuest: Progression`
   carries an independent per-faction record, and where a completed Race Unlock
   claims three maxed factions, Progression says none of them are maxed. Six
   contradictions, zero agreements (Barbarian by token, Dwarf by creation).
   The one completed race whose autocomplete AND token criteria are both I
   (Iksar) is the one Progression confirms.

   So: read criteria off an INCOMPLETE achievement freely; read them off a
   COMPLETE one only when neither escape hatch fired. `trust()` is that rule
   and every consumer here goes through it. */
(function () {
  "use strict";

  /* Name matching across three vocabularies (client achievement text, wiki
     page titles, log lines) — case, trailing period, and the backtick/curly
     apostrophe the wiki drops all have to stop mattering. Deliberately NOT
     the kills normName: that one strips leading articles for log matching,
     which would fuse "a crude stein" with "crude stein". Nothing here is an
     identity key; it is only ever used to compare two spellings of one name. */
  function norm(s) {
    return String(s == null ? "" : s)
      .replace(/[`‘’]/g, "'")
      .toLowerCase()
      .trim()
      .replace(/\.+$/, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  /* The two escape hatches every unlock achievement carries. They are
     mechanism rows, not requirements — never counted as progress, and their
     own C flags are what `trust` reads. */
  const RX_AUTO = /\bautocomplete\b/i;
  const RX_TOKEN = /bypassed using .*\bToken\b/i;
  /* The client's own words for "we haven't built this yet". Every Deity unlock
     reads this way, plus two races. Shown verbatim rather than dressed up as a
     requirement — see docs/CLIENT-FILES.md §6. */
  const RX_PLACEHOLDER = /^Future Placeholder for /i;

  const RX_OBTAIN = /^Obtain\s+(.+?)\.?$/i;
  const RX_FACTION = /^Get maximum faction with\s+(.+?)\.?$/i;
  const RX_TASK = /^Complete the\s+'(.+?)'/i;

  function critKind(t) {
    if (RX_AUTO.test(t)) return "auto";
    if (RX_TOKEN.test(t)) return "token";
    if (RX_PLACEHOLDER.test(t)) return "placeholder";
    if (RX_OBTAIN.test(t)) return "obtain";
    if (RX_FACTION.test(t)) return "faction";
    if (RX_TASK.test(t)) return "task";
    return "other";
  }

  /* Row shape is `<flag><TAB>[<TAB> per level]<text>[<TAB><done>/<goal>]`.
     Depth comes from the EMPTY leading fields, and the text is the first
     non-empty one after the flag — not the last, because a Slayer criterion
     carries its kill count in a further field ("Gnolls", "770/5000") and
     reading the last field would put "770/5000" where the name goes. 105 rows
     in a real dump do this and every one of them is that shape.
     Two fields = an achievement, three or more = a criterion: no achievement
     row in a real dump carries a progress field, so the count is unambiguous. */
  const RX_PROGRESS = /^(\d+)\s*\/\s*(\d+)$/;

  function parse(text) {
    const out = { sections: [], list: [], byName: new Map() };
    if (!text) return out;
    let sec = "";
    let cur = null;
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, "");
      if (!line) continue;
      const f = line.split("\t");
      if (f.length === 1) {
        sec = f[0].trim();
        cur = null;
        if (sec && !out.sections.includes(sec)) out.sections.push(sec);
      } else if (f.length === 2) {
        const done = f[0].trim() === "C";
        cur = { sec, name: f[1].trim(), done, crit: [] };
        out.list.push(cur);
        // Names repeat across sections (General: Keys and EverQuest: Keys ship
        // the same four). First wins; section-scoped lookups use `list`.
        if (!out.byName.has(cur.name)) out.byName.set(cur.name, cur);
      } else if (cur) {
        const rest = f.slice(1).filter((x) => x !== "");
        const t = (rest[0] || "").trim();
        const pm = RX_PROGRESS.exec((rest[1] || "").trim());
        cur.crit.push({
          done: f[0].trim() === "C", t, kind: critKind(t),
          // The only per-criterion NUMBER the dump carries: how far a counting
          // achievement has got. Kept because it is real client-observed
          // progress, whether or not a caller draws it yet.
          have: pm ? +pm[1] : null, goal: pm ? +pm[2] : null,
        });
      }
    }
    return out;
  }

  /* Can this achievement's criteria be believed?

       open    — the achievement is incomplete, so nothing was force-marked and
                 every C criterion is a real, earned step. The common case, and
                 the one that carries all the useful backfill.
       earned  — complete, and neither escape hatch fired: it completed the only
                 way left, by doing the work.
       plain   — complete, and it has no escape hatches at all (keys, raid
                 conquests, slayer). Same conclusion, different shape.
       granted — complete because the character was created that way.
       token   — complete because an unlock token was spent.

     The last two are the force-marked cases: the achievement is genuinely
     unlocked, and its criteria say nothing whatsoever. */
  function trust(a) {
    const auto = a.crit.find((c) => c.kind === "auto");
    const token = a.crit.find((c) => c.kind === "token");
    if (!a.done) return { ok: true, why: "open" };
    if (auto && auto.done) return { ok: false, why: "granted" };
    if (token && token.done) return { ok: false, why: "token" };
    return { ok: true, why: auto || token ? "earned" : "plain" };
  }

  /* Two vocabularies for the same fact: a label that sits beside the name, and
     a sentence that explains why nothing under it can be read. Kept together so
     a surface can't show one without the other existing. */
  const WHY_TEXT = {
    open: "",
    earned: "earned",
    plain: "earned",
    granted: "granted at character creation",
    token: "unlocked with a token",
  };
  const WHY_NOTE = {
    granted: "The client marks every requirement complete for what you were created as, so this can't say which you actually did.",
    token: "The client marks every requirement complete when a token is spent, so this can't say which you actually did.",
  };

  const RX_UNLOCK = {
    race: /^Race Unlock - (.+)$/,
    class: /^Primary Class Unlock - (.+)$/,
    deity: /^Deity Unlock - (.+)$/,
  };

  /* One unlock row: what it is, whether it is unlocked, how, and — when the
     criteria can be believed — how far along the requirements are.
     `steps` excludes the two escape-hatch rows: they are how you skip the
     work, not part of it, and counting them would put every locked unlock at
     "0 of 5" when its real denominator is 3. */
  function unlockRow(kind, name, a) {
    const tr = trust(a);
    const steps = a.crit
      .filter((c) => c.kind !== "auto" && c.kind !== "token")
      .map((c) => ({ done: c.done && tr.ok, t: c.t, kind: c.kind }));
    const real = steps.filter((c) => c.kind !== "placeholder");
    return {
      kind,
      name,
      unlocked: a.done,
      why: tr.why,
      whyText: WHY_TEXT[tr.why] || "",
      whyNote: WHY_NOTE[tr.why] || "",
      trusted: tr.ok,
      // The client says the requirements for this one don't exist yet. Never
      // render it as a checklist the player could work on.
      placeholder: steps.length > 0 && real.length === 0,
      steps,
      have: tr.ok ? real.filter((c) => c.done).length : 0,
      need: real.length,
    };
  }

  /* Every Untapped Potential row, grouped. Section-scoped rather than
     name-scoped: the dump's own three sections are the authority on which
     unlocks exist, so a client patch that adds a race shows up without a
     code change here. */
  function unlocks(parsed) {
    const out = { races: [], classes: [], deities: [] };
    const bucket = { race: out.races, class: out.classes, deity: out.deities };
    for (const a of parsed.list) {
      if (!/^Untapped Potential/i.test(a.sec)) continue;
      for (const kind of ["race", "class", "deity"]) {
        const m = RX_UNLOCK[kind].exec(a.name);
        if (m) { bucket[kind].push(unlockRow(kind, m[1], a)); break; }
      }
    }
    return out;
  }

  /* ── Sky ────────────────────────────────────────────────────────────────
     A Primary Class Unlock's "Obtain X" criteria ARE that class's Plane of Sky
     test rewards, one per test — verified against sky.json: the criterion count
     equals the test count for all sixteen classes.

     Since 2026-08-15 sky.json names every reward the way the CLIENT does
     (build_sky_data.py use_client_names — the same 95 strings the dump prints,
     read from AchievementComponentsClient.txt), so 94 of 95 match outright.
     The one that doesn't is a criterion naming a PAIR: the client hands over
     two weapons under one line, and sky.json keeps the test under the sword. */
  const REWARD_ALIAS = {
    "windhowl and spirit render": "Windhowl",
  };

  /* `classNames` is the caller's own code->name map (SKY_CLASS) rather than a
     second copy living here — one more place to drift is one too many.
     Returns, per class code, which tests the client says you finished. */
  function skyTests(skyData, parsed, classNames) {
    const out = {};
    if (!skyData || !skyData.classes || !parsed) return out;
    const codeOf = new Map();
    for (const [code, name] of Object.entries(classNames || {})) {
      codeOf.set(norm(name), code);
      // The dump writes "Shadowknight"; every other surface writes two words.
      codeOf.set(norm(name).replace(/ /g, ""), code);
    }
    for (const a of parsed.list) {
      const m = RX_UNLOCK.class.exec(a.name);
      if (!m) continue;
      const code = codeOf.get(norm(m[1])) || codeOf.get(norm(m[1]).replace(/ /g, ""));
      const cls = code && skyData.classes[code];
      if (!cls) continue;
      const tr = trust(a);
      const byReward = new Map();
      for (const t of cls.tests) byReward.set(norm(t.reward), t.n);
      const byTest = {};
      const unmatched = [];
      for (const c of a.crit) {
        if (c.kind !== "obtain") continue;
        const item = RX_OBTAIN.exec(c.t)[1];
        const key = norm(REWARD_ALIAS[norm(item)] || item);
        const test = byReward.get(key);
        if (!test) { unmatched.push(item); continue; }
        // Untrusted unlocks contribute nothing: every flag under them is C.
        if (c.done && tr.ok) byTest[test] = true;
      }
      out[code] = {
        unlocked: a.done, why: tr.why, whyText: WHY_TEXT[tr.why] || "",
        trusted: tr.ok, byTest, unmatched,
        done: Object.keys(byTest).length, total: cls.tests.length,
      };
    }
    return out;
  }

  /* Quest-shaped rows outside the class unlocks. There are far fewer than you
     would hope: the dump records no general "you finished quest X", so the only
     other completions it can prove are the key achievements (the eight Islands
     of Sky keys, and the standalone keys) and two named tasks. Everything else
     in the 865 is kills, exploration, levels, tradeskills and faction. */
  function keys(parsed) {
    const seen = new Set();
    const out = [];
    for (const a of parsed.list) {
      if (!/Keys$/i.test(a.sec)) continue;
      const tr = trust(a);
      for (const c of a.crit) {
        if (c.kind === "auto" || c.kind === "token") continue;
        if (seen.has(c.t)) continue;
        seen.add(c.t);
        out.push({ name: c.t.replace(/\.$/, ""), done: c.done && tr.ok, from: a.name });
      }
    }
    return out;
  }

  function tasks(parsed) {
    const out = [];
    for (const a of parsed.list) {
      const tr = trust(a);
      for (const c of a.crit) {
        if (c.kind !== "task") continue;
        out.push({ name: RX_TASK.exec(c.t)[1], done: c.done && tr.ok, from: a.name, t: c.t });
      }
    }
    return out;
  }

  /* `/outputfile` names its exports <Char>_<server>-<Thing>.txt, the same shape
     the inventory dump uses. Applying one character's achievements to another's
     tracker would be silent fiction, so every consumer checks this first. */
  function whose(file) {
    const m = /^([^_]+)_([^-]+)-/.exec(String(file || ""));
    return m ? { char: m[1], server: m[2] } : { char: "", server: "" };
  }

  window.EQLAch = {
    parse, trust, unlocks, skyTests, keys, tasks, whose, norm,
    REWARD_ALIAS, WHY_TEXT, WHY_NOTE,
  };
})();
