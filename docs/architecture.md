# Architecture

## The shape of the thing

```
                 build time (run anywhere, offline)
  ┌──────────────────────────────────────────────────────────┐
  │  EVE SDE (CCP bulk download, YAML)                       │
  │     └─ tools/build_map_data.py                           │
  │           └─ web/data/*.geojson  (basemap: static truth) │
  └──────────────────────────────────────────────────────────┘
                 view time (the player's browser)
  ┌──────────────────────────────────────────────────────────┐
  │  web/index.html  — Leaflet, CRS.Simple, canvas renderer  │
  │     ├─ basemap layers: systems, jumps, region labels     │
  │     └─ live layers (planned): ESI fetches from the       │
  │        browser, joined onto systems by ID                │
  └──────────────────────────────────────────────────────────┘
```

Two kinds of data, two lifecycles:

1. **The basemap is static.** Systems, coordinates, stargates and the
   region hierarchy change a few times a year (CCP expansions). They ship
   as GeoJSON built once from the SDE, so the map loads instantly and the
   site needs no backend — it's deployable on GitHub Pages.
2. **The overlay is live.** Sovereignty, faction warfare, kill/jump
   activity and market stats change by the minute. ESI (CCP's public API)
   serves all of it with CORS enabled, so the *viewer's* browser fetches
   it at view time and the join happens client-side by solar-system ID.
   No server of ours ever proxies game data.

This split is the standard web-GIS pattern (basemap + feature services),
which is the point: the project demonstrates the pattern on data people
find fun.

## Projection and units

EVE positions are meters in a 3D frame where **Y is up**; every 2D map of
New Eden (the in-game star map, Dotlan) projects onto the **X/Z plane**.
The builder converts meters → light years (9.4607 × 10¹⁵ m) and emits
`[x_ly, z_ly]` GeoJSON coordinates. In Leaflet's `CRS.Simple`,
`latLng = [z, x]` — verified against known geography (Branch/Tenal north,
Esoteria/Period Basis south, Cache east). The vertical `y_ly` rides along
as a property so a 3D view stays possible.

Security coloring uses the game's own 11-step ramp and the game's display
rounding (true security 0.0–0.05 displays as 0.1).

## Rendering decisions

- **One canvas renderer** for all 5,432 points + 6,888 lines. Jump lines
  are three non-interactive multi-polylines (one per class), which keeps
  the hit-testing tree tiny; only system markers are interactive.
- **Labels are DOM, data is canvas.** Region labels (69) always exist and
  fade by zoom; system labels materialize only at zoom ≥ 6 for systems in
  the viewport (capped), rebuilt on `moveend`.
- **No framework.** The app is one HTML file; Leaflet is vendored so the
  whole thing works offline and never breaks on a CDN.

## Testing

The builder's pure parts (edge dedup, jump classification, security
rounding, unit conversion) have unit tests — `pytest` in `tests/`.
Rendering is verified with headless-Chromium screenshot passes during
development.

## Constraints learned on the way

- CCP's SDE download and ESI are not reachable from every environment
  (corporate proxies); the npm package `eve-online-sde` mirrors the SDE
  through registries that usually are. The builder only cares about a
  directory path, so any mirror works.
- ESI etiquette (for the live layers): send a descriptive `User-Agent`,
  honor `Expires` caching, pin an `X-Compatibility-Date`, and respect the
  token-bucket rate limits. Details in [esi-research.md](esi-research.md).
