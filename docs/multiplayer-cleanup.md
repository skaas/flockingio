# Fleet client cleanup — 2026-09-30

The multiplayer entry now uses `FleetAudio`, a presentation-only controller for
menu music, gameplay music, UI selection, boost and gathering. The two build
targets and static servers use the same five-file manifest. Legacy source and
assets remain in the repository for older modes and tests, but are not requested
by the current audio controller or included as audio assets in production builds.

| Measurement | Before | After |
| --- | ---: | ---: |
| Audio manifest entries | 69 | 5 |
| Compressed audio bytes | 5,009,851 | 2,749,435 |
| Reachable client modules, including lazy imports | 29 | 25 |
| Diagnostic esbuild bundle bytes | 346,685 | 276,479 |

The bundle measurement is a dependency-graph comparison, not the production
network payload: production still serves modules separately. Audio fetch/decode
concurrency remains limited to two, with active scene music prioritized. Audio
starts only after a gesture; stale one-shot effects are dropped while loading.

The app no longer initializes legacy ranking credentials or scans pending replay
storage to obtain a nickname. It reads the old profile's nickname once and then
uses `flocking-nickname`; existing profile and replay data are left intact.
Unreachable ground battle, bomb target, food, evolution-camera, and signal-loss
presentation paths were removed. Terrain, live fleet effects, camera fit limits,
standings, minimap, input and authoritative room simulation are preserved.
The shared session still depends on replay code; this change does not remove it.

## Verification

Validation used an isolated copy based on `06d3ff4` plus only this cleanup, to
exclude concurrent simulation changes elsewhere in the working tree.

- Sites and multiplayer builds succeeded; all 430 tests passed.
- Browser entry, menu, leaving and nickname persistence passed, with no captured
  warning/error logs during the game check.
- Initially muted audio enabled with one click; all five buffers decoded and
  gameplay music became active. No legacy audio, radio, ranking or battlefield
  renderer module was requested.
- Synthetic legacy profile and pending replay values remained unchanged after
  nickname migration and saving a new name.
- All five allowed audio URLs returned 200; unused boss music returned 404.
- A six-second local SDK session received one initial snapshot, verified six
  authoritative hashes and made no resync request.

This reduces initial downloads and unused initialization. It is not a claim that
large-fleet simulation or every source of frame stutter has been eliminated.
