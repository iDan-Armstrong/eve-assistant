# eve-assistant: New Eden Atlas

![Status](https://img.shields.io/badge/status-in%20development-orange)
![License](https://img.shields.io/badge/license-MIT-green)

> **In development.** Live preview: <https://idan-armstrong.github.io/eve-assistant/>.
> Feedback is welcome via [Issues](https://github.com/iDan-Armstrong/eve-assistant/issues).
> Geography is current (Cradle of War era, incl. the new Exordium region);
> moons, belts and stations still come from CCP's June 2024 export until the
> next full SDE refresh.

An interactive star atlas of the EVE Online universe, built the way a GIS
professional builds a map: **5,485 real solar systems** as point features with
full attribute data, **6,989 stargate connections** as a line network,
**5,150 stations** joined to their systems by foreign key, the full celestial
hierarchy (**46,172 planets, 234,651 moons, 40,928 asteroid belts**, every
star), **820 ice-field systems**, **1,028 Jove Observatories**, and
**70 regions**.
It is a spatial / attribute / relational dataset rendered with the same tooling
(Leaflet, GeoJSON) used in production web GIS.

```
python serve.py        →  http://localhost:8800
```

Select any system and **enter it in 3D**: the orrery view renders the
system's real SDE geometry: star colored by its temperature, planets,
moons, belts, stargates and stations each at their true position
(directions preserved; radial distances log-compressed and bodies
enlarged, and the view says so). Jita's four stacked gates really do sit
within a thousandth of an AU of each other; the view fans their labels
instead of pretending otherwise.

No build step, no framework, no account needed. The map is a static site:
the same `web/` folder deploys unchanged to GitHub Pages.

## Why EVE as a GIS subject

EVE Online's universe is a genuine geographic information system in disguise:
every location has coordinates (light years, projected from the game's X/Z
plane), attributes (security status, planets, moons, asteroid belts, stations,
trade-hub and border flags), and relationships (the stargate graph, the
region ‹ constellation ‹ system hierarchy). The Atlas treats it exactly like
survey data:

- **Spatial:** systems are GeoJSON `Point` features in a light-year CRS;
  stargate links are `LineString` features classified Dotlan-style
  (local / constellation / regional) by whether they cross a boundary,
  plus three special classes read from the SDE's own gate types and drawn
  distinctly: 48 smuggler routes, Pochven's 30 Triglavian conduits, and
  the 4 Jovian spokes that all converge on Zarzakh. The gate graph itself
  audits clean: 13,776 gates, none dangling, none one-way. The
  symbology is ready for the day that changes: a one-way link stores its
  geometry in travel order and renders with directional arrow markers
  (chevrons in a caution color) instead of a plain line.
- **Attribute:** click any system for its full record; security coloring
  uses the game's own 11-step ramp, so the map reads like the in-game one.
  In the 3D view every body opens a profile window with its complete
  attribute record, and stations are symbolized by service capability
  (clone bay, factory/lab, market, basic) resolved through the SDE's
  operation → services join. Planets carry their sovereignty power and
  workforce straight from the SDE's `planetResources` table. Two
  attributes are *not* in the SDE and are labeled as references: PI raw
  resources per planet type (stable game rules, from the EVE University
  wiki) and typical belt ores per system, computed from security band,
  empire quarter and the SDE's security class using EVE University's
  ore-distribution table, which its own editors flag as pre-Catalyst.
- **Relational:** the jump network is an edge list keyed by system ID;
  stations live in their own table (`stations.json`) with `systemId` as the
  foreign key; and the celestial hierarchy (region › system › star/planet ›
  moon) is sharded into one file per region, fetched lazily when a system
  in that region is first selected and joined client-side. That is the access
  pattern of a feature-service query, without a server. The info panel
  walks all of it: every neighbor one click away, stations listed per
  system (Jita shows all 15, 4-4 included), planets expandable to their
  moons and named asteroid belts with star class and temperature up top.
  Ice belts and gas clouds are deliberately absent: the static export
  confirms zero ice fields remain in the map (they became dynamic
  anomalies in 2013's Odyssey), and gas sites are scanner signatures.
  Both are runtime content, which is exactly the line between a basemap
  and a live layer. The sources cross-check:
  station counts derived from the universe tree match the station table in
  5,431 of 5,432 systems.

## Layers

Layers are built per player role. For industry there are two risk
layers (**Risk now** is the default) next to the classic **Security
Status** ramp; PvP layers are next.

| | **Risk now** ("should I undock?") | **Risk history** ("is this a bad neighborhood?") |
|---|---|---|
| Ganks (50%) | last 6 hours | last 30 days |
| Kills per traffic (25%) | last hour, CCP ESI | average hour over the collected days |
| Structural exposure (25%) | trade-route chokepoint × CONCORD response | same |

Ganks are zKillboard's `ganked` label (CONCORD-involved kills) hourly, plus
a one-time 30-day backfill from EVE Ref's raw killmail archives using the
same rule directly (`tools/gank_detect.py`: a highsec kill where an attacker
dies to CONCORD in the same system moments later). The system panel shows
both levels side by side with every input behind them.

The structural term is pure network analysis
(`tools/analyze_routes.py`): for the 10 trade-hub pairs (Jita, Amarr,
Dodixie, Rens, Hek) it counts the shortest highsec routes and measures the
share passing through each system, then weights by security (0.5 = slowest
CONCORD). With no kill data at all it independently ranks **Uedama** first,
with **Balle** second and **Sivala** in the top tier, the systems players
know as the classic gank pipes. (On the 2024 map Balle led; the current
stargate network shortened Jita-Amarr from 45 to 34 jumps and moved the
traffic.)

Live inputs refresh hourly: a scheduled GitHub Action runs
`tools/fetch_live.py` (stdlib only, polite User-Agent, zKillboard request
spacing, ESI compatibility date) and redeploys. History persists on the
`live-data` branch as a rolling 30-day gank ledger and daily activity
sums, force-pushed as a single commit so it never grows, along with a
`status.json` for every run. A source outage never blocks a deploy; a
layer with no data degrades to structural risk and says so.

## Data pipeline

```
EVE Static Data Export (CCP)          tools/build_map_data.py         web/data/
universe/eve/**/solarsystem.yaml  →   parse, project X/Z → ly,    →   systems.geojson   1.8 MB
8,436 YAML files, 282 MB              dedupe gate pairs,              jumps.geojson     1.4 MB
bsd/staStations.yaml                  classify jumps,                 regions.json      6 KB
fsd/types.yaml (streamed, 142 MB)     key stations to systems,        stations.json     0.5 MB
                                      shard celestials by region      celestials/*.json 16 MB
```

Rebuild anytime: download the [SDE](https://developers.eveonline.com/docs/guides/staticdata/)
and run `python tools/build_map_data.py <sde>/universe/eve`. The builder is
pure Python + PyYAML; canonical display names come from `bsd/invNames.yaml`
("TheForge" folders become "The Forge").

`tools/audit_universe.py` then audits what was built (referential
integrity, stargate-graph topology, attribute outliers) and writes
[docs/universe-audit.md](docs/universe-audit.md). It classifies, a human
judges: the 27-system Pochven island and 217 gateless Jove systems are by
design; Zarzakh's station missing from the universe tree is a genuine SDE
inconsistency; and the audit's first run caught a mislabeled faction in
this project's own builder.

### Keeping the map current

CCP's full export is the source of record (`tools/build_map_data.py`). When
only a newer *trimmed* export is at hand, `tools/overlay_current.py` patches
the built map by system ID from [HISA](https://github.com/Crytopox/HISA)'s
current database (MIT): new systems and regions, security changes, new
stargate links, stars and planets for new systems, plus ice-field counts and
Jove Observatory flags. Everything the trimmed export lacks (moons, belts,
stations, gate types, planet physics) is carried forward, the overlay is
idempotent, and every change is listed in
[docs/data-refresh.md](docs/data-refresh.md): 1 region (Exordium), 53
systems, 101 stargate links and 60 security changes since the June 2024
export.

## Roadmap

- **Live layers (ESI):** CCP's public API serves sovereignty, faction-warfare
  fronts, kills/jumps activity and market data with CORS enabled. These are
  fetched by the browser at view time and joined onto the basemap by system ID, like any
  live feature service over a basemap. Research notes in
  [docs/esi-research.md](docs/esi-research.md).
- **Routing:** shortest-path over the jump graph with security preference
  (safer vs shorter), drawn as a route layer.
- **Dashboards** around the map, not instead of it.

## Architecture

Same discipline as [demoforge](https://github.com/iDan-Armstrong/demoforge):
the data pipeline is pure, testable Python; the web app is one dependency-free
HTML file plus vendored Leaflet (works fully offline). See
[docs/architecture.md](docs/architecture.md).

## Acknowledgment

EVE Online and all related data are the intellectual property of
[CCP hf.](https://www.ccpgames.com) Map data is derived from CCP's Static
Data Export under the
[Developer License](https://developers.eveonline.com/license-agreement).
This project is a fan-made tool and is not affiliated with or endorsed by CCP.
Current geography, ice fields and observatories come from
[HISA](https://github.com/Crytopox/HISA) by Crytopox (MIT); see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT (code). Game data remains © CCP hf.
