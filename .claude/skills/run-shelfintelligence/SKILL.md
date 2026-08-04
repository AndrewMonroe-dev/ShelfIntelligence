---
name: run-shelfintelligence
description: Build, run, and drive ShelfIntelligence. Use when asked to start the app, take a screenshot of it, test a UI change, or interact with the running Planogram Viewer/Set Layout/Optimization Engine.
---

ShelfIntelligence is a plain static HTML/JS/CSS app (no build step, no
`package.json` of its own) that loads its data client-side via `fetch`
from `data/*.json` on boot -- no manual import step needed. For
agent/automated use, serve it with `.claude/skills/run-shelfintelligence/server.mjs`
(Node's `http`, not Python's -- see Gotchas) and drive it via the
Playwright REPL at `.claude/skills/run-shelfintelligence/driver.mjs`
(`chromium-cli` isn't available on this machine, so this driver is the
documented fallback for a browser-driven web app).

All paths below are relative to the repo root (`D:\ShelfIntelligence`).

## Prerequisites

Node.js (any recent version; verified against v24.18.0). No OS packages
needed -- this runs on native Windows, not a headless Linux container.

## Setup

Playwright lives in the skill's own `package.json`, scoped to this
directory so it never touches the app itself (which has no dependencies
of its own):

```bash
cd .claude/skills/run-shelfintelligence
npm install
npx playwright install chromium   # no-op if already cached
cd ../../..
```

## Run (agent path)

1. Start the static server (from repo root):

```bash
node .claude/skills/run-shelfintelligence/server.mjs &
# polls, don't sleep-and-hope:
timeout 15 bash -c 'until curl -sf http://localhost:8791/index.html >/dev/null; do sleep 0.5; done'
```

Stop it when done: find the `node .../server.mjs` process and kill it
(e.g. on Windows, `Get-CimInstance Win32_Process -Filter "name='node.exe'"`
filtered by `CommandLine -like '*server.mjs*'`, then `Stop-Process`).

2. Drive it with the REPL driver. Pipe a script to stdin (heredoc) for a
   one-shot run, same idea as `chromium-cli`:

```bash
node .claude/skills/run-shelfintelligence/driver.mjs <<'EOF'
launch planogram-viewer
select-store Retailer X - Location 12
wait .planogram-box
ss 01-planogram
quit
EOF
```

Screenshots land in `%TEMP%\shelfintelligence-shots\` (override:
`SCREENSHOT_DIR`). Page errors print automatically as `PAGE ERROR: ...`
as they happen -- no separate check command needed, just read the
output.

For iterative/interactive use, run the driver without a heredoc (or
under tmux with `send-keys`/`capture-pane`) and type commands at the
`driver>` prompt one at a time.

### Commands

| command | what it does |
|---|---|
| `launch [hashRoute]` | open the browser, navigate to `/` or `/#<hashRoute>` |
| `nav <hashRoute>` | navigate to a different `#`-routed view (e.g. `set-layout`, `optimization-engine`) |
| `select-store <name-substring>` | pick a store from `.store-select` by matching option text (e.g. `Retailer X - Location 12`) |
| `ss [name]` | screenshot -> `<SHOT_DIR>/<name>.png` |
| `click <css-sel>` | click via Playwright locator |
| `click-text <text>` | click a button/link/`[role=button]` containing exact or partial text |
| `fill <css-sel> <text>` | fill an input |
| `type <text>` / `press <key>` | keyboard input |
| `wait <css-sel>` | wait up to 10s for an element |
| `eval <js-expr>` | evaluate JS in the page, print JSON result |
| `text [css-sel]` | print `innerText` of an element (or `body`) |
| `quit` | close the browser, exit |

### Known views (hash routes)

`dashboard`, `sku-database`, `sales-import`, `store-builder`,
`set-layout`, `metric-center`, `calculation-engine`,
`optimization-engine`, `digital-twin`, `planogram-viewer`,
`set-overview`, `scenario-manager`, `reports`, `settings`,
`administration`.

### Known sample stores

Baked into `data/stores.json`: `Retailer X - Location 12`,
`Retailer X - Location 27`, `Retailer Y - Location 5`.

## Run (human path)

Open `http://localhost:8791/` (after starting the server above) in a
real browser. No build step, no separate dev-server process.

## Test

No automated test suite exists for this app. `verify_missing_cats.mjs`
at the repo root is a one-off data-audit script, not a test runner.

---

## Gotchas

- **Don't use Python's `http.server`.** It's single-threaded and
  chokes on `data/skus.json` (~3.9MB), dropping the connection
  (`ERR_CONNECTION_RESET`) partway through the fetch. `server.mjs`
  (Node's `http`) handles it fine.
- **`chromium-cli` isn't installed on this machine.** It's a
  Linux-container tool; this is native Windows. `driver.mjs` is a
  hand-rolled Playwright REPL that plays the same role (see the
  `run-skill-generator`'s own fallback note for exactly this case).
- **Piped/heredoc stdin makes Node's `readline` auto-close (`close`
  event) the instant it hits EOF** -- immediately, long before queued
  async commands (like `launch`, which takes a few seconds) finish.
  Two things in `driver.mjs` exist specifically because of this: (1)
  every line is queued through a single promise chain so commands run
  strictly in order instead of racing each other (an early version had
  every command after `launch` fail with "launch first" because they
  started before `launch`'s promise resolved); (2) `quit` calls
  `process.exit(0)` directly from its own turn in that chain instead of
  waiting on the `close` event, and every other prompt call is guarded
  against firing after `close` (`ERR_USE_AFTER_CLOSE` otherwise).
- **Data loads automatically on boot** -- there's no "import" step to
  drive through the UI first. `fetch`s from `data/*.json` happen as
  soon as `index.html` loads.
- **On-screen planogram boxes render one `<div>` per facing, not one
  per SKU.** A SKU with 2 facings produces two `.planogram-box`
  elements with the identical `data-sku-id` -- use `.first()` when
  locating a box by SKU ID if you only need one.
- **Print Set output is invisible in a normal screenshot.** It's a
  `@media print`-only DOM region (`#planogram-print-root`), hidden on
  screen by design and only rendered under print/PDF emulation
  (`page.emulateMedia({ media: 'print' })` in Playwright, or an actual
  generated PDF). Clicking the button and screenshotting the normal
  page will correctly show no visible change.

## Troubleshooting

- **`ERR_CONNECTION_RESET` loading the app / large data files fail to
  fetch**: you're using Python's `http.server` instead of
  `server.mjs`. Switch servers.
- **Driver commands after `launch` all print `ERROR: launch first`**:
  you're running an old/hand-rolled version of the REPL without the
  promise-chain fix above -- use `driver.mjs` as committed, not a
  from-scratch script.
- **`Error [ERR_USE_AFTER_CLOSE]: readline was closed`**: same root
  cause as above (readline closes before the async queue drains) --
  again, use `driver.mjs` as committed; this is already handled.
- **`chromium-cli: command not found`**: expected on this machine. Use
  `driver.mjs`, not `chromium-cli`, for ShelfIntelligence.
