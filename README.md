# EQL Tools Companion

Windows companion app for [eqltools.com](https://eqltools.com) — reads your
EverQuest Legends log file in real time and can overlay the game window.

**Download:** grab the installer or the portable exe from
[Releases](https://github.com/sowoky/eqltools-companion/releases). The build is
not code-signed yet, so Windows SmartScreen will warn — "More info" → "Run
anyway".

- **Quest-item loot alerts** — loot an item and the app tells you if it's a
  quest item, which quest wants it, what the reward is, one click to the
  quest's wiki page.
- **Gotta Kill 'Em All** — the eqltools.com kill tracker, fed live from your
  log instead of file drops. Same rules, same math: the app runs the site's
  own `shared.js` verbatim.
- **Item tooltips** — mouse over any item name and get the in-game item
  window: flags, slot, AC, stats, effect, weight, classes, races.
- **Auto-updates** — installed builds update themselves from GitHub
  Releases; portable/zip builds tell you when a new version is out.
- **Zone browser** — the atlas mobs & drops data, following your character:
  zone in and the app shows that zone's mobs (with your kill ✓s) and items
  (with quest flags), all linked to the wiki.
- **Overlay** — a translucent always-on-top panel over the game (windowed or
  borderless display mode; exclusive fullscreen draws past every window).
  `Ctrl+Shift+O` shows/hides it, `Ctrl+Shift+L` toggles click-through.

Your log is parsed locally and never leaves your machine. The only network
traffic is downloading data updates from eqltools.com. Quest and mob data
come from the community wiki (CC BY-SA 4.0).

Logging must be on in game: `/log`.

## Build

```
npm install
npm run dist:win     # → dist/  (installer + portable exe, x64)
```

Works from this repo as published: `vendor/` (the site's canonical
parsing/credit modules, copied verbatim from eqltools `public/kills/`) and
`data-snapshot/` (the wiki-derived datasets) are baked in at export time.
Development happens in the private eqltools repo, where `npm run sync`
regenerates both from the canonical sources — this repo is an export, and
pull requests against `vendor/` or `data-snapshot/` can't be taken directly.
Dev loop: `npm run dev`, and `npm run simulate` in a second terminal writes
a fake growing log (point the app's log folder at `tmp-logs/`).
