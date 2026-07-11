# Ridgeline — Project State

## 1. Architecture
GPX -> GeoJSON (@tmcw/togeojson, frontend) -> 1-mile segment chunks
(backend) -> per-segment official hazard detection -> consolidation into
mile-range entries -> reasoning layer fills gaps within the On Trail
lookahead window -> sidebar.js + mapManager.js render the same
consolidated data. differ.js/differ_db.json is the persistence layer
behind "since you last checked" alerts (self-healing, gitignored).

## 2. Load-bearing conventions
- node-cache: useClones: false. Everything from getCached() is a
  reference — never mutate in place, build new wrapper objects instead.
- Expensive geometry (bbox, @turf/simplify) computed once at
  cache-refresh time, never per-request.
- Always bbox-pre-filter before @turf/booleanPointInPolygon.
- Mile-range consolidation merges ONLY on identical signature. Official
  hazards: same hazard identity. Inferred estimates: category AND
  confidence AND full binned-inputs array must all match — category
  alone is not sufficient; raw numeric values are never compared
  directly, only binned labels.
- "No estimate" always falls through to plain "clear" — never a
  hazard-shaped badge.
- Git initialized, repo private on GitHub. Features land as separate,
  reviewable commits.
- Reasoning layer runs ONLY on segments with hazards.length === 0, AND
  only within the active On Trail lookahead window. Planning mode does
  NOT get localized reasoning-layer estimates for the full route — a
  deliberate v1 scope decision.
- Safety line: reasoning layer never computes a competing risk score for
  high-consequence calls (avalanche go/no-go, ford safety, flood
  evacuation) — those stay fully deferred to official sources.

## 3. Data sources
- nifc.js: WFIGS_Interagency_Perimeters_CURRENT (active fires only),
  where: '1=1'. Incident type labeling WF/RX/CX/fallback. Pagination
  kept as fallback.
- avalanche.js: api.avalanche.org, 82 zones globally, bbox + simplify
  (tolerance 0.001) at cache time. Verified via point-ID parity, zero
  mismatches raw-vs-simplified.
- nws.js: forecast only (gridpoints) — NOT suitable for observed/
  trailing precip, confirmed by investigation. AbortController 10s
  timeout wraps the full response including body parsing (a bug where
  clearTimeout fired before the body stream was found and fixed). Cached
  by gridId/gridX,gridY, 1hr TTL.
- openmeteo.js: observed trailing 48h precip (past_days=2), no auth.
  Rate limits 600/min, 5000/hr, 10000/day, no SLA. Same microclimate
  modeling weakness as NWS grids (accepted). Scoped ONLY to the On Trail
  lookahead window — full-route sampling calculated at 2,650+ calls for
  PCT-scale, tested and rejected as too slow/rate-limited.
- burn_scars.js: HISTORICAL WFIGS_Interagency_Perimeters archive
  (deliberately different from nifc.js's Current endpoint). Filter:
  attr_FireDiscoveryDateTime within 2 years AND (attr_PercentContained =
  100 OR attr_ContainmentDateTime IS NOT NULL). Accepted tradeoff: drops
  ~26% of real settled burn scars due to sparse agency record-keeping —
  measured, not a bug. Cache TTL 24h. Explicitly skipped when !location
  (Planning mode) — this was a real bug (unconditional fetch, unused
  result) found and fixed.

## 4. Known measured numbers
- Full PCT (dense-pct.json, 3,410mi) Planning-mode wall-clock: 6,268ms
- Burn scar cold fetch: ~9,145ms HTTP fetch, ~23,314ms JSON parse
  (dominant cost, ~100MB MultiPolygon text), ~962ms bbox/simplify. ~38s
  total, mitigated by 24h TTL.
- On Trail warm-cache run: ~3.5s. Reasoning/lookahead math itself: <5ms.
- Avalanche polygons: 9,105 total vertices across 82 zones, largest zone
  ~5,000 vertices.

## 5. KNOWN OPEN ITEM — NOT DISCOVERABLE FROM CODE, TAKE AS GIVEN
Moving a test coordinate 1.5 miles (crossing an NWS grid boundary)
triggered a real ~8.5 second wait on a single api.weather.gov/points
cache miss, found during manual regression testing. This was never
logged or committed anywhere — it exists only as a verbal finding. It is
a genuine latency problem for the On Trail experience, which is supposed
to be fast and glanceable. TASK: reproduce this independently (pick two
test coordinates that straddle an NWS grid boundary, cold-cache one,
confirm the delay) before trusting or dismissing this finding, then
treat it as a real bug to fix — likely candidates: pre-fetching the
/points lookup for the lookahead window's bounding area in advance, or
a longer/separate cache TTL for the gridId-to-office mapping itself
(which rarely changes) versus the forecast data it unlocks.

## 6. KNOWN UNFINISHED TEST PROOF — NOT DISCOVERABLE FROM CODE, TAKE AS
GIVEN
The reasoning-layer test fixture has 8 cases. Two are not fully proven,
regardless of what test file comments or prior commit messages may
claim:
- Case 7 (outside lookahead window): confirmed and fixed a real bug
  (coarse 3-point sample wasn't fetching outside the window at all).
  NOT yet confirmed: does scorer.js correctly skip running entirely
  outside the window when there's no official hazard present? The only
  test run had an official alert present, which short-circuits before
  this matters. TASK: add an isolated mock — hazard-free segment outside
  the window — confirm it's clear because inference didn't run, not by
  coincidence.
- Case 8 (Open-Meteo timeout): confirmed correct END-USER behavior
  (failure degrades to clear, merges correctly with dry neighbors) but
  this is evidentially ambiguous — a silently swallowed error would look
  identical. TASK: attach a debug flag (e.g. _debugOpenMeteoFailure:
  true) to the specific failing segment to prove the failure branch
  actually executed.

## 7. Deferred / explicitly out of scope for v1
- Aspect/shade-based ice reasoning: elevation gives grade, not compass
  aspect — needs DEM data not available. Grade-based signals only.
- Phase 2 not started: SNOTEL, land/wilderness boundaries, permits
  (recreation.gov/RIDB — no key exists yet), crowdsourced reports.
- Planning mode: no localized reasoning-layer estimates for the full
  route (see section 2).

## 8. Known failure patterns — read before trusting a "done" report
This project has repeatedly produced confident summaries that didn't
survive isolated verification: a field name (irwin_PercentContained)
that never existed in either API's schema, undetected because an earlier
check verified the field existed in the response but never checked what
the code actually read; an early-exit break; that silently dropped
legitimate multi-hazard segments, undetected because prior regression
tests were boolean-only (hazard present, yes/no) rather than count-aware;
a performance benchmark reported as reflecting a fix that actually
predated it. Operating discipline: verify claims against raw JSON
output, not narrative summaries.
