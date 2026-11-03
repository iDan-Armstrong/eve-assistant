# Universe dataset audit

*Generated 2026-11-03 by tools/audit_universe.py*

## Referential integrity

- Jump edges referencing a missing system: **0**
- Station rows referencing a missing system: **0**
- Station count, universe tree vs station table: **5484 / 5485 systems agree**
  - Zarzakh (Yasna Zakh): tree says 0, table says 1; the station exists in `staStations` but not as an `npcStations` entry in the universe files (SDE inconsistency, not a build defect)

## Network topology

- Connected components in the stargate graph: **221**
  - Main cluster: **5,228 systems** (flyable New Eden)
  - Island of 27 systems in Pochven (e.g. Ahtila, Ala, Angymonne)
  - Island of 7 systems in UUA-F4 (e.g. 16-31U, 1TS-WN, B-DXO9)
  - Island of 6 systems in UUA-F4 (e.g. 3C-26I, 4-IPWK, 9K-VDI)
- Gateless systems: **217**, in A821-A (46), J7HZ-F (77), UUA-F4 (94)
  - All in the three Jove regions: charted in the data, unreachable in game; this is by design, not a defect
- Pochven forms its own 27-system component: the Triglavian region is deliberately severed from the cluster

## Stargates

- 13,776 gates in the universe tree; **0 dangling** (destination gate missing) and **0 non-mutual** (A→B without B→A); every gate pair is intact and symmetric
- Links on special gate types (from the SDE's own gate typing), styled distinctly on the map:
  - **jovian**: 4 links
    - G-0Q86 ↔ Zarzakh
    - H-PA29 ↔ Zarzakh
    - Turnur ↔ Zarzakh
    - Alsavoinon ↔ Zarzakh
  - **smuggler**: 48 links
  - **triglavian**: 30 links

## Attribute outliers

- True security runs -1.0 (Kuharah, Pochven) to 1.0 (Manifest, Exordium)
- Most moons in one system: **120** (N8D9-Z, Delve)
- Most planets: **18** (Horkkisen, The Citadel)
- Most stations: **22** (Nonni, Lonetrek)
- Most stargates: **8** (Tash-Murkon Prime, Tash-Murkon)
- Most asteroid belts: **50** (Jarkkolen, The Bleak Lands)
- Longest stargate link (map plane): **35.9 ly**, HD-JVQ (Venal) ↔ MTO2-2 (Perrigen Falls)

## Curiosities

- Region **Yasna Zakh** contains exactly one system: Zarzakh, the Deathless hub, making it a region of one
- 37 of 70 regions carry no NPC faction: sovereign nullsec plus the Jove regions
- Thera's 4 Sanctuary stations sit in wormhole space (system 31000005), outside this k-space dataset. They are excluded by the system-ID join, which is the join doing its job
