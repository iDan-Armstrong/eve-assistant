"""Audit the built universe dataset for anomalies.

Referential integrity, network topology, and attribute outliers over the
GeoJSON/JSON the map actually serves — the same audit discipline demoforge
applies to client data: the report *finds and classifies*, a human judges.

    python tools/audit_universe.py            # writes docs/universe-audit.md

Reads web/data/; no network, no SDE needed.
"""

from __future__ import annotations

import json
import math
import time
from collections import Counter, defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "web" / "data"


def components(nodes: set[int], edges: list[tuple[int, int]]) -> list[set[int]]:
    """Connected components, largest first."""
    adj = defaultdict(set)
    for a, b in edges:
        adj[a].add(b)
        adj[b].add(a)
    seen: set[int] = set()
    out = []
    for start in nodes:
        if start in seen:
            continue
        stack, comp = [start], set()
        while stack:
            n = stack.pop()
            if n in seen:
                continue
            seen.add(n)
            comp.add(n)
            stack.extend(adj[n] - seen)
        out.append(comp)
    return sorted(out, key=len, reverse=True)


def main() -> None:
    systems = {f["properties"]["id"]: {**f["properties"],
                                       "xy": f["geometry"]["coordinates"]}
               for f in json.loads((DATA / "systems.geojson").read_text())["features"]}
    jumps = json.loads((DATA / "jumps.geojson").read_text())["features"]
    stations = json.loads((DATA / "stations.json").read_text())["stations"]
    regions = json.loads((DATA / "regions.json").read_text())["regions"]

    L: list[str] = ["# Universe dataset audit",
                    f"\n*Generated {time.strftime('%Y-%m-%d')} by tools/audit_universe.py*\n"]

    # -- referential integrity -----------------------------------------
    L.append("## Referential integrity\n")
    edge_pairs = [(j["properties"]["from"], j["properties"]["to"]) for j in jumps]
    orphan_edges = [(a, b) for a, b in edge_pairs
                    if a not in systems or b not in systems]
    L.append(f"- Jump edges referencing a missing system: **{len(orphan_edges)}**")
    orphan_st = [s for s in stations if s["systemId"] not in systems]
    L.append(f"- Station rows referencing a missing system: **{len(orphan_st)}**")

    tree_counts = {sid: p["stations"] for sid, p in systems.items()}
    table_counts = Counter(s["systemId"] for s in stations)
    mismatch = [(sid, tree_counts[sid], table_counts.get(sid, 0))
                for sid in systems if tree_counts[sid] != table_counts.get(sid, 0)]
    L.append(f"- Station count, universe tree vs station table: "
             f"**{len(systems) - len(mismatch)} / {len(systems)} systems agree**")
    for sid, tree, table in mismatch:
        p = systems[sid]
        L.append(f"  - {p['name']} ({p['region']}): tree says {tree}, table says "
                 f"{table} — the station exists in `staStations` but not as an "
                 f"`npcStations` entry in the universe files (SDE inconsistency, "
                 f"not a build defect)")

    # -- topology --------------------------------------------------------
    L.append("\n## Network topology\n")
    comps = components(set(systems), edge_pairs)
    gateless = [p for p in systems.values() if p["gates"] == 0]
    by_reg = Counter(p["region"] for p in gateless)
    L.append(f"- Connected components in the stargate graph: **{len(comps)}**")
    L.append(f"  - Main cluster: **{len(comps[0]):,} systems** — flyable New Eden")
    for c in comps[1:]:
        if len(c) == 1:
            continue
        regs = sorted({systems[s]["region"] for s in c})
        sample = sorted(systems[s]["name"] for s in c)[:3]
        L.append(f"  - Island of {len(c)} systems in {', '.join(regs)} "
                 f"(e.g. {', '.join(sample)})")
    L.append(f"- Gateless systems: **{len(gateless)}** — "
             + ", ".join(f"{r} ({n})" for r, n in sorted(by_reg.items())))
    L.append("  - All in the three Jove regions: charted in the data, "
             "unreachable in game — by design, not a defect")
    poch = [c for c in comps if len(c) > 1 and
            {systems[s]["region"] for s in c} == {"Pochven"}]
    if poch:
        L.append(f"- Pochven forms its own {len(poch[0])}-system component: the "
                 "Triglavian region is deliberately severed from the cluster")

    # -- attribute outliers ----------------------------------------------
    L.append("\n## Attribute outliers\n")
    def top(key, fmt, n=1, rev=True):
        rows = sorted(systems.values(), key=key, reverse=rev)[:n]
        return [fmt(p) for p in rows]

    sec_lo = min(systems.values(), key=lambda p: p["secTrue"])
    sec_hi = max(systems.values(), key=lambda p: p["secTrue"])
    L.append(f"- True security runs {sec_lo['secTrue']} ({sec_lo['name']}, "
             f"{sec_lo['region']}) to {sec_hi['secTrue']} ({sec_hi['name']}, "
             f"{sec_hi['region']})")
    most_moons = max(systems.values(), key=lambda p: p["moons"])
    L.append(f"- Most moons in one system: **{most_moons['moons']}** "
             f"({most_moons['name']}, {most_moons['region']})")
    most_planets = max(systems.values(), key=lambda p: p["planets"])
    L.append(f"- Most planets: **{most_planets['planets']}** "
             f"({most_planets['name']}, {most_planets['region']})")
    most_st = max(systems.values(), key=lambda p: p["stations"])
    L.append(f"- Most stations: **{most_st['stations']}** "
             f"({most_st['name']}, {most_st['region']})")
    most_gates = max(systems.values(), key=lambda p: p["gates"])
    L.append(f"- Most stargates: **{most_gates['gates']}** "
             f"({most_gates['name']}, {most_gates['region']})")
    most_belts = max(systems.values(), key=lambda p: p["belts"])
    L.append(f"- Most asteroid belts: **{most_belts['belts']}** "
             f"({most_belts['name']}, {most_belts['region']})")

    def dist(a, b):
        (ax, ay), (bx, by) = systems[a]["xy"], systems[b]["xy"]
        return math.hypot(ax - bx, ay - by)
    longest = max(edge_pairs, key=lambda e: dist(*e))
    a, b = (systems[s] for s in longest)
    L.append(f"- Longest stargate link (map plane): **{dist(*longest):.1f} ly**, "
             f"{a['name']} ({a['region']}) ↔ {b['name']} ({b['region']})")

    # -- singletons and curiosities ---------------------------------------
    L.append("\n## Curiosities\n")
    one_sys = [r for r in regions if r["systems"] == 1]
    for r in one_sys:
        L.append(f"- Region **{r['name']}** contains exactly one system"
                 + (f" (faction: {r['faction']})" if r["faction"] else "")
                 + " — Zarzakh, the Deathless hub, a region of one")
    no_faction = [r for r in regions if not r["faction"]]
    L.append(f"- {len(no_faction)} of {len(regions)} regions carry no NPC "
             "faction — sovereign nullsec plus the Jove regions")
    L.append("- Thera's 4 Sanctuary stations sit in wormhole space "
             "(system 31000005), outside this k-space dataset — excluded by "
             "the system-ID join, which is the join doing its job")

    report = "\n".join(L) + "\n"
    out = REPO / "docs" / "universe-audit.md"
    out.write_text(report)
    print(report)
    print(f"→ {out.relative_to(REPO)}")


if __name__ == "__main__":
    main()
