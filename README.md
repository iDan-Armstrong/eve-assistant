# eve-assistant — New Eden Atlas

An interactive star atlas of the EVE Online universe, built the way a GIS
professional builds a map: **5,432 real solar systems** as point features with
full attribute data, **6,888 stargate connections** as a line network,
**5,150 stations** joined to their systems by foreign key, the full celestial
hierarchy (**46,172 planets, 234,651 moons**, every star), and **69 regions**
— a spatial / attribute / relational dataset rendered with the same tooling
(Leaflet, GeoJSON) used in production web GIS.

```
python serve.py        →  http://localhost:8800
```

No build step, no framework, no account needed. The map is a static site:
the same `web/` folder deploys unchanged to GitHub Pages.

## Why EVE as a GIS subject

EVE Online's universe is a genuine geographic information system in disguise:
every location has coordinates (light years, projected from the game's X/Z
plane), attributes (security status, planets, moons, asteroid belts, stations,
trade-hub and border flags), and relationships (the stargate graph, the
region ‹ constellation ‹ system hierarchy). The Atlas treats it exactly like
survey data:

- **Spatial** — systems are GeoJSON `Point` features in a light-year CRS;
  stargate links are `LineString` features classified Dotlan-style
  (local / constellation / regional) by whether they cross a boundary.
- **Attribute** — click any system for its full record; security coloring
  uses the game's own 11-step ramp, so the map reads like the in-game one.
- **Relational** — the jump network is an edge list keyed by system ID;
  stations live in their own table (`stations.json`) with `systemId` as the
  foreign key; and the celestial hierarchy (region › system › star/planet ›
  moon) is sharded into one file per region, fetched lazily when a system
  in that region is first selected and joined client-side — the access
  pattern of a feature-service query, without a server. The info panel
  walks all of it: every neighbor one click away, stations listed per
  system (Jita shows all 15, 4-4 included), planets expandable to their
  moons with star class and temperature up top. The sources cross-check:
  station counts derived from the universe tree match the station table in
  5,431 of 5,432 systems.

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

## Roadmap

- **Live layers (ESI):** CCP's public API serves sovereignty, faction-warfare
  fronts, kills/jumps activity and market data with CORS enabled — fetched by
  the browser at view time and joined onto the basemap by system ID, like any
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

## License

MIT (code). Game data remains © CCP hf.
