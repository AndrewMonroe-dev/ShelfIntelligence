# ShelfIntelligence -- Project Instructions

## Standing authorization: commit and push

Granted 2026-07-22. Once a change in this repo is verified working (tests
pass, or live/headless verification against real data as done in recent
sessions), commit and push to `origin/main` without asking for confirmation
first. This overrides the general "confirm before commit/push" default for
this repo only.

Still applies normally:
- State what changed and why in the commit message.
- If a change is NOT verified (couldn't test, ambiguous result), stop and
  ask before committing rather than pushing something unverified.
- Destructive git operations (force-push, reset --hard, history rewrite)
  are NOT covered by this authorization -- confirm those every time.

## Cache-busting: bump the version marker on every code/CSS/data change

Added 2026-08-05, after a report that GitHub Pages changes weren't
reaching one browser (DuckDuckGo desktop) even after a hard reload. This
app has no build step and no bundler, so there's no automatic
content-hashing -- every `.js`/`.css`/`data/*.json` file is served at a
permanent, unversioned URL by default, which some browsers/proxies cache
more aggressively than a normal hard-reload can bypass.

The fix: every internal ES module import (`import ... from '...'` and
`import('...')`), every `<link>`/`<script>` tag in `index.html`, and
every `data/*.json` fetch in `src/data/adapters/jsonAdapter.js` carries a
`?v=YYYYMMDD` query string (currently `20260805`). Changing the query
string changes the URL, which forces every browser/CDN to treat it as a
brand-new resource -- no reliance on any specific cache-bypass behavior.

**Whenever a session changes ANY `.js` file under `src/`, any file under
`assets/css/`, or any file under `data/`, bump this marker to the
current date (or increment a letter suffix, e.g. `20260805b`, for a
same-day second deploy) across ALL of these in the same commit:**
- Every `?v=...` occurrence in every `src/**/*.js` file (`from '...js?v=...'`
  and `import('...js?v=...')`).
- The `?v=...` on every `<link>`/`<script>` tag in `index.html`.
- `CACHE_BUST` in `src/data/adapters/jsonAdapter.js`.

A single find-and-replace of the old date/suffix for the new one across
`src/` + `index.html` handles it in one pass -- there is no central
constant to edit instead, since a `<link href>` attribute can't reference
a JS export without a build step. Forgetting this bump doesn't break
anything immediately (the OLD version still works), it just means that
specific deploy might not reach a browser with a stubborn cache -- the
exact failure mode this exists to prevent.
