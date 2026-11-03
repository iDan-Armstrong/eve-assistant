"""Structural gank exposure: which highsec systems are trade-route chokepoints.

Highsec haulers travel between the five trade hubs on highsec-only routes.
For every hub pair we count the shortest highsec paths and, for each system,
the fraction of those paths that pass through it (shortest-path flow, the
same idea as betweenness centrality restricted to hub-to-hub traffic). A
system on the only highsec path between two hubs scores 1.0 for that pair;
one on half of the equally short paths scores 0.5.

Exposure then weights that route load by how slowly CONCORD responds:
suicide gankers favour 0.5 systems, where response is slowest.

    python tools/analyze_routes.py      # reads web/data/, writes risk_static.json

Pure Python, no SDE needed: it runs on the dataset the map already serves.
"""

from __future__ import annotations

import json
from collections import defaultdict, deque
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "web" / "data"

TRADE_HUBS = ["Jita", "Amarr", "Dodixie", "Rens", "Hek"]

# Relative gank exposure by displayed security: CONCORD arrives slowest in
# 0.5 space and fastest in 1.0. A monotone weighting, not a timing table.
CONCORD_EXPOSURE = {0.5: 1.0, 0.6: 0.7, 0.7: 0.45, 0.8: 0.3, 0.9: 0.2, 1.0: 0.15}


def bfs_paths(adj: dict, src: int):
    """Hop distance and shortest-path counts from src (unweighted graph)."""
    dist, sigma = {src: 0}, defaultdict(int)
    sigma[src] = 1
    queue = deque([src])
    while queue:
        v = queue.popleft()
        for w in adj[v]:
            if w not in dist:
                dist[w] = dist[v] + 1
                queue.append(w)
            if dist[w] == dist[v] + 1:
                sigma[w] += sigma[v]
    return dist, sigma


def route_load(adj: dict, hubs: list[int]) -> tuple[dict[int, float], dict]:
    """Sum over hub pairs of the fraction of shortest paths through each
    system. Returns (load per system, {(a, b): jumps})."""
    load: dict[int, float] = defaultdict(float)
    routes = {}
    cache = {h: bfs_paths(adj, h) for h in hubs}
    for i, a in enumerate(hubs):
        da, sa = cache[a]
        for b in hubs[i + 1:]:
            if b not in da:
                continue
            db, sb = cache[b]
            routes[(a, b)] = da[b]
            for v, dv in da.items():
                if v in (a, b) or v not in db:
                    continue
                if dv + db[v] == da[b]:                 # v lies on a shortest path
                    load[v] += sa[v] * sb[v] / sa[b]    # share of those paths
    return dict(load), routes


def exposure(load: float, sec: float) -> float:
    return load * CONCORD_EXPOSURE.get(round(sec, 1), 0.0)


def main() -> None:
    sys_fc = json.loads((DATA / "systems.geojson").read_text())
    jumps = json.loads((DATA / "jumps.geojson").read_text())["features"]
    systems = {f["properties"]["id"]: f["properties"] for f in sys_fc["features"]}
    by_name = {p["name"]: i for i, p in systems.items()}

    highsec = {i for i, p in systems.items() if p["sec"] >= 0.5}
    adj: dict[int, list[int]] = defaultdict(list)
    for j in jumps:
        a, b = j["properties"]["from"], j["properties"]["to"]
        if a in highsec and b in highsec:
            adj[a].append(b)
            adj[b].append(a)

    hubs = [by_name[n] for n in TRADE_HUBS if n in by_name]
    load, routes = route_load(adj, hubs)
    exp = {i: exposure(load.get(i, 0.0), systems[i]["sec"]) for i in highsec}
    top_exp = max(exp.values()) or 1.0
    top_load = max(load.values()) or 1.0

    out = {
        "about": "Structural gank exposure for highsec: share of shortest "
                 "highsec trade-hub routes through each system, weighted by "
                 "CONCORD response (0.5 slowest). Computed from the stargate "
                 "graph by tools/analyze_routes.py.",
        "hubs": TRADE_HUBS,
        "routes": [{"from": systems[a]["name"], "to": systems[b]["name"], "jumps": n}
                   for (a, b), n in routes.items()],
        "systems": {
            str(i): {"load": round(load.get(i, 0.0), 3),
                     "choke": round(load.get(i, 0.0) / top_load, 3),
                     "exposure": round(exp[i] / top_exp, 3)}
            for i in highsec if load.get(i, 0.0) > 0
        },
    }
    (DATA / "risk_static.json").write_text(json.dumps(out, separators=(",", ":")))

    ranked = sorted(out["systems"].items(), key=lambda kv: -kv[1]["exposure"])[:10]
    print("top structural gank exposure (highsec):")
    for sid, r in ranked:
        p = systems[int(sid)]
        print(f"  {p['name']:13s} {p['sec']:.1f}  load {r['load']:5.2f}  "
              f"exposure {r['exposure']:.3f}")
    print(f"→ {len(out['systems'])} systems scored, "
          f"{len(out['routes'])} hub routes")


if __name__ == "__main__":
    main()
