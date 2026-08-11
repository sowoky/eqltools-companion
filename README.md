# EQL Tools Companion

Windows companion app for [eqltools.com](https://eqltools.com) — reads your
EverQuest Legends log file in real time and can overlay the game window.

**Download:** grab `EQL-Tools-Companion-Setup-<version>.exe` from the
[latest release](https://github.com/sowoky/eqltools-companion/releases/latest).
It installs per-user — no admin rights needed — and keeps itself updated.

The build is not code-signed yet, so Windows flags the download. Either way
past works:

- When SmartScreen says "Windows protected your PC": **More info** → **Run
  anyway**.
- Or before running: right-click the downloaded file → **Properties** → check
  **Unblock** at the bottom → **OK**.

- **Quest-item loot alerts** — loot an item and the app tells you if it's a
  quest item, which quest wants it, what the reward is, one click to the
  quest's wiki page.
- **Gotta Kill 'Em All** — the eqltools.com kill tracker, fed live from your
  log instead of file drops. Same rules, same math: the app runs the site's
  own `shared.js` verbatim.
- **Item tooltips** — mouse over any item name and get the in-game item
  window: flags, slot, AC, stats, effect, weight, classes, races.
- **Inventory browser** — type `/out inventory` in game and every bag, bank
  slot, depot, and Dragon's Hoard row lands in one table: stats at your
  upgrade tier, resists, weight, effect, trade flags, class, era, which mobs
  drop it in which zones, and which quests want it. Sort by any column,
  search across all of it, filter by area, tradeability, or class.
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
npm run dist:win     # → dist/  (per-user installer, x64)
```

Works from this repo as published: `vendor/` (the site's canonical
parsing/credit modules, copied verbatim from eqltools `public/kills/`) and
`data-snapshot/` (the wiki-derived datasets) are baked in at export time.
Development happens in the private eqltools repo, where `npm run sync`
regenerates both from the canonical sources — this repo is an export, and
pull requests against `vendor/` or `data-snapshot/` can't be taken directly.
Dev loop: `npm run dev`, and `npm run simulate` in a second terminal writes
a fake growing log (point the app's log folder at `tmp-logs/`).
