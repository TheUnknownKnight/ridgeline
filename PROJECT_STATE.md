# Ridgeline — project state

Last full rewrite: 2026-10-17 (v2). This file records decisions and measured facts that are not obvious from the code. The README covers what the app does and how to run it.

## Load-bearing conventions

- **One geometry implementation.** `shared/geo.js` measures, slices, samples and projects routes for both server and browser. Never use another library for route math, or mile markers drift between map, list and server.
- **One severity scale.** `shared/levels.js` — levels 0–4 (clear, low, moderate, high, extreme) and every hazard color. ESTIMATED hazards are capped at `MAX_ESTIMATED_LEVEL` (2) so a model inference never outranks an official warning.
- **Never "clear" from missing data.** Every source loader returns `{ status, fetchedAt, message, data }` and never throws. `status` is `ok | stale | partial | error | skipped`. Segments carry `checked: [...]` listing only sources that actually evaluated that stretch. The summary is `incomplete` when any source is error/partial/stale.
- **Shared caches are read-only.** `server/lib/cache.js` values are shared across requests. Build new objects; never mutate cached data.
- **Expensive geometry at fetch time.** Simplification, bboxes and spatial indexes are built when upstream data is cached, never per request.
- **Consolidation merges only identical hazard sets** (`id@level` for every hazard plus the `checked` list). Per-chunk notes/distances never block a merge; the closest distance is kept.
- **Clients never supply cache keys.** The server fingerprints coordinates itself; `routeHash` refreshes are only accepted for routes the server already built.
- **No server-side user data.** Routes, positions and results are not persisted on the server. "Since your last check" lives in the browser (IndexedDB).

## Frontend conventions

- Vanilla ES modules, no framework. `src/js/app.js` owns state and orchestration; rendering lives in `src/js/panels/*`; the map is `src/js/map/mapView.js` (MapLibre 6 — named imports only, the worker is wired with `setWorkerUrl`).
- All upstream and file-derived text goes through `h()` / `textContent` (`src/js/ui/dom.js`); links only via `safeUrl()`. No `innerHTML` with data.
- Map paint can't read CSS variables, so map colors come from `shared/levels.js` and the theme objects in `mapView.js`.
- Overpass (the UI font) ships a zero-width middle dot in the Google Fonts subset — don't join UI text with " · ". Server `detail` strings use " · " only as a fact separator that the UI splits into a list.
- Absolutely positioned elements inside the panel must stay inside a positioned ancestor (`.panel` is `position: relative`), or they escape the overflow clip and make the whole page scroll on phones.
- The On-trail plaque is computed client-side from the live position (`aheadView` in `verdict.js`), so it stays right between server refreshes.
- Climb totals: resample every 0.05 mi, smooth over ~0.15 mi, 5 m hysteresis. Raw DEM-derived elevations overstate climb by ~45%.
- "Unchecked" is about coverage, not only failures: a quiet stretch missing any official source from `checked` (outside US data, unrated avalanche terrain) draws grey everywhere (`describeSegments`), even when every source is `ok`. Forecasts outside the On trail window are covered by the window shade instead. Filters never turn a hazard into "Nothing reported" — rows and readouts say "Hidden by filters".
- An On trail answer is never shown in Plan; switching back to Plan replaces an in-flight On trail check. The hint for projecting GPS onto out-and-back routes survives fix-less GPS states (`lastRouteMile`); typing a mile while GPS is live re-picks the pass instead of overriding GPS.
- Smoke layer rules (from its adversarial review): AirNow freshness is judged by the readings' own time (stale after 3 h, unusable after 12 h); a monitor that misses an hour keeps its last reading for 3 h; satellite plumes get a 2.5 s budget and never hold up AirNow; a newer satellite trace replaces an older one; the plume hazard's diff follows the plume feed's health (`airPlumes`); NOAA's forecast gets an 8 s budget before the CAMS fallback (PM2.5-only, picked by trail mile); air data shows its AQI category word and official AQI colors.
- Service worker: the shell is replaced only after every file it needs is cached; OpenFreeMap vector tiles are cached under a build-agnostic key (`/planet/_/z/x/y.pbf`) because the TileJSON points at a new build weekly; style/TileJSON are network-first (3 s) and never evicted; asset trimming keeps whatever the cached shell references. Probes: `.scratch/verify-sw/run-all.mjs`.

## Upstream facts (verified live 2026-10-17)

- **NIFC WFIGS** (`services3.arcgis.com/T4QMspbfLg3qTGWY`): fetched nationwide, minimal fields, `geometryPrecision=5`, `maxAllowableOffset=0.0002` → ~1.4 MB raw instead of 20 MB. ~99 perimeters and ~400 incidents; ~300 incidents have no perimeter (joined by `IrwinID`, uppercase GUID with braces). ArcGIS returns query errors as HTTP 200 with an `error` body. `attr_PercentContained` is null for ~1/3 of perimeters — keep null distinct from 0. Upstream refreshes every 5 min.
- **NWS alerts**: `/alerts/active?status=actual` nationwide is ~166 KB gzip; 97% of alerts have null geometry and need zone shapes (`/zones/{forecast|fire|county}/{id}`, no batch endpoint, cache ~30 days). `expires` is the message expiry, not the hazard end — use `ends`, then `eventEndingTime`. Dedupe by VTEC `office.phen.sig.etn`. Unknown query params return 400. ~6% of burst requests return a transient 500 → retries are mandatory.
- **NWS /points** was 0.2–0.4 s in testing (the earlier "8.5 s" report was not reproduced). Coordinates beyond 4 decimals 301-redirect. Snapping to 0.02° can cross a border; the code retries the exact point on 404.
- **NWS gridpoints**: `validTime` is `start/ISO-duration`; the first values start ~8 h in the past and must be clipped and prorated.
- **avalanche.org map-layer**: `danger_level` −1 = no rating (every zone in October); `off_season` is per center; `start_date`/`end_date` are UTC **without** a `Z`; expired products drop to −1 with null dates. Zone ids change between seasons. CAC, EARAC, EWYAIX, HAC, SOAIX never rate.
- **NOAA NWPS REST** (`api.water.noaa.gov`) is limited to **10 requests per 5 minutes per IP** and needs `srid=EPSG_4326` or it silently returns nothing. Ridgeline instead uses NOAA's ArcGIS gauge service (`mapservices.weather.noaa.gov/.../riv_gauges/MapServer`, layer 0 observed, layer 15 full forecast period), filtered server-side to action/minor/moderate/major: one ~26 KB nationwide request.
- **Open-Meteo**: free tier is non-commercial, 600 location-calls/min, 10k/day per IP; every location counts as a call (×vars/10 above 10 variables). Single-location responses are objects, multi-location are arrays. Used only for past-48 h rainfall and air quality, snapped to 0.05° and cached 1 h.

- **EPA AirNow** (`services.arcgis.com/cJ9YHowT8TU7DUyn`): `AirNowLatestContoursPM25` (AQI-category polygons, `gridcode` 1–6, ~60 polygons / ~80 KB nationwide with `maxAllowableOffset=0.005`) and `Air_Now_Current_Monitors_PM25` (~1,300–1,700 monitors incl. ~20 USFS fire monitors named only by AQS id, plus US embassy monitors abroad). Hourly, published ~40 min past the hour. `ValidTime` is seconds.
- **NOAA HMS smoke**: one KML per UTC day at `satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/KML/YYYY/MM/hms_smokeYYYYMMDD.kml`, appended through the day (100–300 KB); density in `styleUrl` / description, times as `YYYYDDD HHMMUTC`. Today's file can 404 early in the UTC day.
- **NOAA NAQFC PM2.5** (`mapservices.weather.noaa.gov/raster/rest/services/air_quality/ndgd_apm25_hr01_bc/ImageServer`): the catalog also holds ~74 junk rows with null valid times — filter on `idp_issueddate`. getSamples returns at most **20 rasters per call** (extra are silently dropped) and needs `outFields=idp_validtime` for times; points far outside the grid make the whole call fail with 400, points just outside are omitted. Grid ≈ lon −153…−49, lat 12…61.
- **LANDFIRE / IIPP rasters** (`lfps.usgs.gov/.../Landfire_Topo/LF2020_{SlpD,Asp,Elev}_CONUS`, `imagery.geoplatform.gov/iipp/.../USFS_EDW_NLCD_{TCC,Landcover}_CONUS`): getSamples ≤1,000 points per call (truncates silently above). TCC and NLCD are time-series mosaics: lock the newest raster by the last year in its name. Aspect −1 = flat; TCC 254/255 = no data. 3DEP getSamples ignores rendering rules — don't use it for slope.
- **SNODAS** (`mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer`): no point sampler that scales; export a PNG of layer 7 (SWE classes in inches, first class transparent) and match pixel colors to `/legend`. Valid 12Z daily, published ~17–18Z; layer 6 footprint gives `idp_validtime`.
- **Open-Meteo concurrency**: more than two concurrent requests from one IP get HTTP 429 "Too many concurrent requests" (which opens our 60 s circuit). `weatherHistory.js` holds two process-wide slots shared by every caller.
- **OpenStreetMap surfaces**: on the JMT only 30% of miles carry `surface=*` and ~98% of tagged backcountry trail is just `ground`; overpass-api.de asks automated users to self-host. Trail surface is therefore inferred from land cover, slope and canopy, not OSM.

## Resilience rules (from the adversarial review)

- A cached copy inside its stale window is returned within 3 s even if the upstream hangs; the refresh keeps running in the background. Failures covered by stale data pause retries for 30 s.
- Each source loader gets 20 s per analysis; overruns are reported as unavailable, never awaited.
- A 429 opens a per-host circuit for `Retry-After` (default 60 s); 429s are never retried.
- Empty national feeds (0 fires, 0 alerts, 0 avalanche zones) are treated as upstream errors, not as "nothing to report".
- Constant or null elevations are placeholders and are stripped (Google Earth/My Maps KML writes altitude 0); lapse-rate correction is skipped when the trail–grid gap exceeds 1,500 m.
- Route models are capped by total samples (~300k ≈ 30,000 route-miles), not just by count.

## Measured performance (2026-10-17, home connection)

- Full 3,410-mile synthetic route, Planning: ~10 s cold with trail conditions (~4 s without; Open-Meteo hourly history is the long pole), ~0.3–0.6 s warm. On trail warm refresh: ~0.1 s.
- Response size for that route: ~290 KB JSON (gzip ~8× smaller).
- `npm test`: 107 tests, all offline, ~11 s.
- Production bundle: app 96 KB (34.5 KB gzip) + MapLibre 1.05 MB (284 KB gzip) in its own long-cached chunk.
- Sample JMT (202 mi): ~1.6–3.4 s cold (bound by the NWS forecast fan-out, ~100 points), ~20 ms warm, On trail refresh ~5–8 ms and a 0.1 KB request.
- Against v1 (commit f806d6f, same JMT, fresh processes): v1 was ~1.2–2.0 s cold because it fetched far less (3 forecast points, no alert zones, gauges, rain or air quality); v2 is ~5x faster warm (20 vs 90 ms), sends 0.1 KB instead of 140 KB per On trail refresh, and returns 27 KB instead of 157 KB per Plan check. Reopening a saved route shows the last result from IndexedDB before any network call.

## Trail-conditions model

- Deterministic hourly state model in `shared/conditions/` (no AI): snowpack (SWE, liquid, cold content) and tread wetness (FAO-56 depletion) per point, stepped through 10 days of history and 3 days of forecast, read at "now" and 8 AM / 2 PM local for three days. Parameter sources are in `.scratch/conditions/research.md`; snow-firmness and dust thresholds are heuristics awaiting field calibration.
- Points every max(0.25 mi, length/2000); Open-Meteo cells capped at 100 per analysis (points borrow the nearest cell and are lapse-corrected to their own elevation, skipped beyond a 1,500 m gap). SNODAS resets the snowpack at its valid time where it has an answer.
- Snow and ice become ESTIMATED hazards (`trail:snow`, `trail:ice`, type `trail`); mud, slick rock, dust and loose rock stay in the Trail tab. Terrain or snow-analysis outages lower confidence (noted in the tab) but don't make the source partial; missing weather does.
- Measured: JMT cold ~2.6–4.4 s for the whole analysis, warm ~0.1–0.2 s; 3,410-mi synthetic route ~4 s cold, ~0.6 s warm.
- Rules from its adversarial review: cold content is limited to the top ~75 mm SWE (a night's cold doesn't reach a deep pack); snow depth is tracked with Hedstrom–Pomeroy new-snow density and settling; clear nights build a surface crust even above 0 °C; snow likelihood never drops as depth rises; a dusting is never "dry"; cells fetched on different UTC days are aligned by timestamp before reading; unmodeled miles are explicit "Not estimated" stretches; snow-analysis or terrain gaps make the source partial and "dry" uncertain; each snow class is its own hazard id; window labels are recomputed on the device from each window's time.

## Deliberate scope decisions

- Forecast hazards use a 72-hour horizon; Planning mode samples the forecast every max(2 mi, length/120); On trail samples every mile inside the lookahead window only. Official sources always cover the whole route in both modes.
- Avalanche danger uses the zone's max rating across elevation bands (conservative). Per-band refinement needs per-center elevation thresholds parsed from free-text HTML — not done.
- No USGS flow percentiles yet (NWPS flood categories only). USGS legacy WaterServices shuts down 2027-02-22; use `api.waterdata.usgs.gov` if added.
- Phase 2 ideas not started: land-manager closures, permits (RIDB), crowdsourced trail reports, burn-scar debris-flow risk, SNOTEL station annotations, creek-crossing timing from OSM fords, terrain horizon shading (Terrarium tiles) for morning ice.

## Known failure patterns — read before trusting a "done" report

Earlier iterations of this project shipped confident summaries that did not survive isolated checks (a field name that never existed, a midpoint test that missed sub-mile fire crossings, a benchmark that predated its fix, per-point alert caching for an hour). Verify claims against raw upstream JSON and the test suite, not narrative summaries.
