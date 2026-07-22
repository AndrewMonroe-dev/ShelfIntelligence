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
