/* Shared tooltip engine.
   Lifted out of /combat/app.js, where it was the only rich-tooltip implementation
   on the site. /attributes needs the same hover/pin/keyboard behaviour for its
   per-class breakdowns, and both pages render source seals, so the engine and the
   six seal explanations live here rather than being hand-copied.

   Contract
     EQLTip.terms.foo = "<h5>…</h5>…"        content for data-tip="term:foo"
     EQLTip.provider("skill", (arg) => html) content for data-tip="skill:<arg>"
     EQLTip.init()                           wire up hover / click / keyboard, once
     EQLTip.decorate()                       re-run after every innerHTML rewrite

   Any element carrying [data-tip], plus every .src seal, is an anchor. A seal with
   no explicit data-tip resolves to its own tier (term:client-mined, term:dev, …). Click
   pins a tip open; anchors that already do something on click (a link, a sort
   header) opt out with [data-tip-nopin]. */
(function () {
  "use strict";

  var terms = {
    seals: "<h5>Source seals</h5><p><b>client-observed</b> = the running game showed it to a player. <b>client-mined</b> = read out of the shipped files. <b>dev</b> = stated by EQL developers. <b>model</b> = ancestral formula, structure only. <b>chat</b> = player consensus, believed not confirmed. <b>wiki</b> = from the community wiki, user submitted. Full legend at <a href=\"/sources\">/sources</a>.</p>",
    "client-observed": "<h5>Seal: client-observed</h5><p>The running game showed this to a player — a window you can open at login and read off the interface. The server sent it; the client drew it. A screenshot would prove the same thing, so we take the game at its word. The highest tier there is: it describes the game as it actually runs, not as its files describe it.</p>",
    "client-mined": "<h5>Seal: client-mined</h5><p>Read out of the game's own data or UI files — the attribute table, the softcap table, the skill-cap table, the stat-window tooltip text, <code>eqgame.exe</code> itself. Primary, and reproducible from the install on your own disk. One caveat: those files are a live-EQ superset. They claim a level cap of 60 and carry spells EQL never sells, so where a file and the in-game window disagree, the window wins.</p>",
    dev: "<h5>Seal: dev</h5><p>Stated by EQL developers — Discord dev channels or patch notes. Official word, though the devs deliberately won't publish exact formulas (\"We aren't going to spoil the exact formula\" — April 2026).</p>",
    model: "<h5>Seal: model</h5><p>The ancestral formula — live EQ, EQEmu source, or Torven's parse-verified classic research. EQL runs on the live codebase and its devs vetted their math against this lineage, so the structure predicts well, but EQL's exact constants are unpublished — reliable in shape, approximate in the exact numbers.</p>",
    chat: "<h5>Seal: chat</h5><p>Player-reported — Discord consensus, or a single measured stat window. Worth reporting and often right, but believed, not confirmed: no client file or dev word backs it yet.</p>",
    wiki: "<h5>Seal: wiki</h5><p>From <a href=\"https://www.eqlwiki.com\" target=\"_blank\" rel=\"noopener\">eqlwiki.com</a>. The wiki is where we get information that can't be legitimately obtained from the game client. It's user submitted. If something we use from the wiki is wrong, go fix it in the wiki. We'll pick it up automatically after some time!</p>",
    tooltips: "<h5>How tooltips work</h5><p>Dotted terms and stat names carry the data behind the claim — tables, formulas, caveats. Click to pin one open.</p>",

    /* ── shared glossary ──────────────────────────────────────────────────
       Every term the site uses in more than one place lives here, so a term
       means the same thing on every page and no page ships a second copy of
       the definition. Each one links to the page that owns the fact. A page
       may still override an entry (Object.assign after this file loads) when
       it needs a page-specific ending — /gear does that for `tier`. */

    trio: '<h5>Trio</h5><p>Every EQ Legends character is three full classes at once. The three combine differently per stat: resource pools sum the best two, caps take the highest, and spell and ability access runs at the <em>lowest</em> of the three levels. <a href="/learn/trio">The trio system</a>.</p>',
    bestof3: '<h5>Best of three</h5><p>Where your three classes offer different values for the same thing — a skill cap, the AC softcap — you get the best one. Universal player consensus plus the THJ ancestor\'s documented rule; not yet dev-stamped for EQL.</p>',
    loadout: '<h5>Loadout</h5><p>A saved set of three classes. Each of your classes levels independently, and swapping loadouts does not reset them. <a href="/learn/trio#loadouts">Swapping &amp; loadouts</a>.</p>',

    tier: '<h5>Item tiers</h5><p>Every item climbs +0 to +10 by merging in another copy of itself or by feeding it motes. Each merge adds experience; crossing the next threshold bumps the tier. A tier is a cumulative +10% to the item\'s stats, and a <code>+N</code> in an item name is its tier. <a href="/learn/upgrades">Upgrades &amp; motes</a>.</p>',
    mote: '<h5>Motes</h5><p>Upgrade currency. A mote drops only from a kill that paid you experience, and the mob\'s level against yours moves the rate — nothing at six or more levels below you, roughly 5–7% at even con and above. Grade is set by the fight\'s difficulty floor. <a href="/learn/motes">Mote drops</a>.</p>',
    difficulty: '<h5>Difficulty (D0–D4)</h5><p>A per-instance setting: D0, D1 Awakened, D2 Adaptive, D3 Fused, D4 Refined. The open world is D0. Notching up does not raise mob levels — it gives mobs player-style class kits and makes their loot arrive pre-upgraded. Solo vs. multiplayer tuning is a separate dial. <a href="/learn/difficulty">Difficulty</a>.</p>',
    aa: '<h5>Alternate Advancement</h5><p>One AA pool shared by all three of your classes, on from level 1 with no slider — points arrive at a fixed rate alongside normal XP. A rank bought once is owned in every combo that qualifies for it. <a href="/learn/aa">Alternate Advancement</a>.</p>',
    era: '<h5>Eras</h5><p>The wiki inherits Kunark and Velious content that EQL hasn\'t unlocked yet, and tags pages by era with its own switch of what\'s live. Items tagged to a locked era — or dropping only in locked-era zones — are hidden until the wiki flips that switch. Untagged items with no drop-zone signal stay visible.</p>',

    ac: '<h5>AC</h5><p>The client\'s own words: "Mitigation and Evasion components of your Armor Class." Worn AC counts fully up to a per-class, per-level softcap, then at a per-class fraction (25–35%). <a href="/combat">Combat &amp; stats</a>.</p>',
    atk: '<h5>ATK</h5><p>The client\'s own words: "Offense and Accuracy components of your melee attacks." <a href="/combat">Combat &amp; stats</a>.</p>',
    softcap: '<h5>Softcap</h5><p>Worn AC counts fully up to a per-class, per-level cap, then at a per-class fraction (25–35%). The cap table ships in the client; your own cap is printed in the stat window. Only Mitigation is softcapped.</p>',
    dmgbonus: '<h5>Damage bonus</h5><p>A flat add on every main-hand hit, sized by your <em>level</em> and the weapon\'s <em>delay</em> — not its damage. Added after the damage roll, where mitigation can\'t touch it. Offhand gets none.</p>',
    haste: '<h5>Haste</h5><p>One additive attack-speed stat drives both haste and slow: worn haste, spell haste and a mob\'s slow all land on the same number. <a href="/learn/control#haste">Slow, haste &amp; CC</a>.</p>',
    ratio: '<h5>DMG/DLY</h5><p>Weapon damage divided by delay — damage per unit of swing time, before your damage bonus, procs, or haste. The usual first cut when comparing two weapons for the same hand.</p>',
    sv: '<h5>Resists (SV)</h5><p>Save values against the five damage schools — fire, cold, magic, disease, poison. <b>SV VOID</b> is not a resist: it is how the wiki writes an item\'s upgrade-tier marker.</p>',
  };

  var providers = {
    term: function (arg) { return terms[arg] || null; },
  };

  var SEL = "[data-tip], .src";
  // authority order; specFor() returns the first class it matches
  var SEAL_TIERS = ["client-observed", "client-mined", "dev", "model", "chat", "wiki"];

  function contentFor(spec) {
    var i = spec.indexOf(":");
    if (i < 0) return null;
    var fn = providers[spec.slice(0, i)];
    return fn ? fn(spec.slice(i + 1)) : null;
  }

  function specFor(el) {
    if (el.dataset.tip) return el.dataset.tip;
    if (el.classList.contains("src")) {
      for (var i = 0; i < SEAL_TIERS.length; i++) {
        if (el.classList.contains(SEAL_TIERS[i])) return "term:" + SEAL_TIERS[i];
      }
    }
    return null;
  }

  // Anchors that already own their click: links navigate, sort headers sort.
  function pinnable(el) {
    return el.tagName !== "A" && !el.hasAttribute("data-tip-nopin");
  }

  var inited = false;

  function init() {
    if (inited) return;
    inited = true;

    var tip = document.getElementById("tip");
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "tip";
      tip.className = "tip";
      tip.hidden = true;
      document.body.appendChild(tip);
    }
    var pinned = false;

    function show(el) {
      var spec = specFor(el);
      var html = spec && contentFor(spec);
      if (!html) return;
      tip.innerHTML = html;
      tip.hidden = false;
      var r = el.getBoundingClientRect();
      var h = tip.offsetHeight, vh = window.innerHeight;
      tip.style.left = Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 10, r.left)) + "px";
      // prefer below; flip above if it fits better; then clamp fully on-screen
      var top = r.bottom + 8;
      if (top + h > vh - 8 && r.top - h - 8 >= 8) top = r.top - h - 8;
      tip.style.top = Math.max(8, Math.min(top, vh - h - 8)) + "px";
    }
    function hide() { pinned = false; tip.hidden = true; }

    document.addEventListener("mouseover", function (e) {
      var el = e.target.closest(SEL);
      if (el && !pinned) show(el);
    });
    document.addEventListener("mouseout", function (e) {
      if (e.target.closest(SEL) && !pinned) tip.hidden = true;
    });
    document.addEventListener("click", function (e) {
      var el = e.target.closest(SEL);
      if (el && !pinnable(el)) return;
      if (el && specFor(el)) { show(el); pinned = true; e.stopPropagation(); }
      else hide();
    });
    // keyboard parity: focus shows, blur hides, Enter/Space pins, Escape closes
    document.addEventListener("focusin", function (e) {
      var el = e.target.closest(SEL);
      if (el && !pinned) show(el);
    });
    document.addEventListener("focusout", function (e) {
      if (e.target.closest(SEL) && !pinned) tip.hidden = true;
    });
    document.addEventListener("keydown", function (e) {
      var el = e.target.closest(SEL);
      if (e.key === "Escape") { hide(); return; }
      if (el && !pinnable(el)) return;   // let Enter follow the link / fire the sort
      if (el && (e.key === "Enter" || e.key === " ") && specFor(el)) {
        e.preventDefault(); show(el); pinned = true;
      }
    });
    window.addEventListener("scroll", function () { if (!pinned) tip.hidden = true; }, { passive: true });
  }

  /* Make every dotted term / seal keyboard-reachable. Re-run after each render —
     innerHTML replacement creates fresh, undecorated elements. */
  function decorate() {
    document.querySelectorAll(SEL).forEach(function (el) {
      // Seals are anchors: already focusable, already labelled, and role=button
      // would lie about what Enter does. Sort headers own their own semantics.
      if (!pinnable(el)) return;
      el.tabIndex = 0;
      el.setAttribute("role", "button");
      if (!el.hasAttribute("aria-label")) el.setAttribute("aria-label", "Show the numbers behind this");
    });
  }

  window.EQLTip = {
    terms: terms,
    provider: function (kind, fn) { providers[kind] = fn; },
    init: init,
    decorate: decorate,
  };

  // Self-start. init() is idempotent, and a page that only has hand-written
  // data-tip markup should not have to remember to call it — the landing page
  // called it from an inline script that ran BEFORE this file loaded, so its
  // one tooltip was dead and the console carried "EQLTip is not defined".
  // Pages that render tooltips from JS still call decorate() after each render.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { init(); decorate(); });
  } else { init(); decorate(); }
})();
