# Universe dataset audit

*Generated 2026-11-02 by tools/audit_universe.py*

## Referential integrity

- Jump edges referencing a missing system: **0**
- Station rows referencing a missing system: **0**
- Station count, universe tree vs station table: **5431 / 5432 systems agree**
  - Zarzakh (Yasna Zakh): tree says 0, table says 1 — the station exists in `staStations` but not as an `npcStations` entry in the universe files (SDE inconsistency, not a build defect)

## Network topology

- Connected components in the stargate graph: **221**
  - Main cluster: **5,175 systems** — flyable New Eden
  - Island of 27 systems in Pochven (e.g. Ahtila, Ala, Angymonne)
  - Island of 7 systems in UUA-F4 (e.g. 16-31U, 1TS-WN, B-DXO9)
  - Island of 6 systems in UUA-F4 (e.g. 3C-26I, 4-IPWK, 9K-VDI)
- Gateless systems: **217** — A821-A (46), J7HZ-F (77), UUA-F4 (94)
  - All in the three Jove regions: charted in the data, unreachable in game — by design, not a defect
- Pochven forms its own 27-system component: the Triglavian region is deliberately severed from the cluster

## Attribute outliers

- True security runs -1.0 (D4R-H7, Branch) to 1.0 (Sarum Prime, Domain)
- Most moons in one system: **120** (N8D9-Z, Delve)
- Most planets: **18** (Horkkisen, The Citadel)
- Most stations: **22** (Nonni, Lonetrek)
- Most stargates: **8** (Aghesi, Domain)
- Longest stargate link (map plane): **35.9 ly**, HD-JVQ (Venal) ↔ MTO2-2 (Perrigen Falls)

## Curiosities

- Region **Yasna Zakh** contains exactly one system — Zarzakh, the Deathless hub, a region of one
- 37 of 69 regions carry no NPC faction — sovereign nullsec plus the Jove regions
- Thera's 4 Sanctuary stations sit in wormhole space (system 31000005), outside this k-space dataset — excluded by the system-ID join, which is the join doing its job
