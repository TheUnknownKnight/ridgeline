# Sample routes

## `jmt-yosemite.gpx` — John Muir Trail (Happy Isles to Whitney)

The real John Muir Trail, southbound from Happy Isles in Yosemite Valley to the
summit of Mount Whitney. The "Try a sample route" button loads this file.

| | |
|---|---|
| Track | one `<trk>`, one `<trkseg>`, GPX 1.1 |
| Points | 4,965 `<trkpt>`, each with `<ele>` |
| Length | 202.2 mi (325.5 km) as written; 208.6 mi (335.8 km) at full OSM resolution |
| Spacing | 65.6 m average |
| Start | 37.732821, -119.557779 (Happy Isles), 1,236 m |
| End | 36.578590, -118.292138 (Mount Whitney summit), 4,355 m |
| Elevation range | 1,236 m to 4,404 m |
| Built | 2026-10-17 |

### Sources and license

- **Route geometry:** [OpenStreetMap relation 1244828](https://www.openstreetmap.org/relation/1244828)
  (`type=route`, `route=hiking`, `name=John Muir Trail`, `ref=JMT`).
  © OpenStreetMap contributors. The data is available under the
  [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
  This file is a derived extract of that data and is offered under the ODbL 1.0 too.
- **Elevations:** the [Open-Meteo Elevation API](https://open-meteo.com/en/docs/elevation-api),
  under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Open-Meteo takes its values
  from the Copernicus DEM GLO-90: © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH
  2014-2018, provided under COPERNICUS by the European Union and ESA.

The same credits are in the GPX `<metadata>` (`<desc>`, `<copyright>`, `<link>`).

### How it was built

1. **Fetched the geometry.** The relation came from the Overpass API with `rel(1244828); out geom;`.
   It has 94 member ways and 9 guidepost nodes. The nodes were ignored.
2. **Chained the ways.** The build started from the way endpoint nearest Happy Isles and kept
   attaching the unused way whose endpoint was closest to the current tail. Gaps up to 50 m were
   allowed, and ways were reversed when needed. All 94 ways chained end to end, 60 of them reversed.
   The largest joint gap was 0.00 m, and no ways were left over as spurs or alternates. The route
   goes via Clark Point rather than the Mist Trail. It ends 12 m from the Whitney summit benchmark.
   The result is 26,873 vertices and 208.65 mi.
3. **Thinned the points.** Ramer-Douglas-Peucker with an 8 m tolerance keeps the shape of the
   switchbacks. Original vertices were then added back so that no stretch goes far without a
   point (target 150 m; the largest final gap is 224 m). The result is 4,965 points.
4. **Added elevations.** The points went to Open-Meteo 100 per request, one request at a time
   with 15 s between requests. The script backed off when it got HTTP 429.
5. **Wrote the GPX.** Coordinates have 6 decimals and elevations have 0.1 m. The file was checked
   for well-formed GPX 1.1: namespace, child element order, coordinate ranges, and an `<ele>` on
   every point.

### Elevation spot checks

Each pass value is the highest track point within 1.5 km of the pass (2 km for Island Pass).
The published elevations come from trail signage, USGS and NPS.

| Landmark | Mile | DEM (m) | Published (m) | Diff (m) |
|---|---:|---:|---:|---:|
| Happy Isles | 0.0 | 1,236 | ~1,230 (4,035 ft) | +6 |
| Donohue Pass | 34.5 | 3,378 | 3,373 (11,066 ft) | +5 |
| Island Pass | 39.7 | 3,115 | 3,117 (10,226 ft) | -2 |
| Silver Pass | 78.0 | 3,321 | 3,278 (10,754 ft) | +43 |
| Selden Pass | 97.3 | 3,331 | 3,314 (10,873 ft) | +17 |
| Muir Pass | 124.0 | 3,650 | 3,644 (11,955 ft) | +6 |
| Mather Pass | 145.1 | 3,697 | 3,688 (12,100 ft) | +9 |
| Pinchot Pass | 154.6 | 3,680 | 3,697 (12,130 ft) | -17 |
| Glen Pass | 170.2 | 3,667 | 3,651 (11,978 ft) | +16 |
| Forester Pass | 181.7 | 4,014 | 4,009 (13,153 ft) | +5 |
| Mount Whitney summit | 202.2 | 4,355 | 4,421 (14,505 ft) | -66 |

### Caveats

- **The length comes out short.** The trail is usually quoted as about 211 mi. Full-resolution
  OSM geometry gives 208.6 mi. Thinning to about 65 m spacing cuts the small switchbacks, which
  brings the written track down to 202.2 mi (about 3% under full resolution). Mile markers will
  run a few percent low.
- **The summit elevation is low.** At 90 m resolution the DEM smooths Whitney's summit plateau.
  The last point reads 4,355 m, and the highest point on the track is 4,404 m, about 110 m west
  of the summit. The true summit is 4,421 m.
- **Do not trust gain and loss totals summed from this file.** Along steep canyon walls the 90 m
  DEM cells jump around from point to point. A raw sum gives about 72,000 ft of gain. Even with a
  10 m hysteresis band it gives about 63,700 ft. Published figures are about 46,000-47,000 ft.
- The track ends at the summit, which is the official end of the JMT. It does not include the
  11 mi Mount Whitney Trail descent to Whitney Portal.
- This is sample data and is not for navigation.

To rebuild it, re-run the steps above against the current OSM relation. The relation can change
over time.
