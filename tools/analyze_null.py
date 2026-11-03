"""Strategic geography of lowsec and nullsec, from the stargate graph alone.

For PvP planning, three structural facts matter before any kill data:

entry systems
    Where space changes band: nullsec systems with a gate to lowsec or
    highsec, and lowsec systems with a gate to highsec. Traffic into
    dangerous space must pass through them, so they are classic camp spots.

chokepoints (pockets)
    Cut vertices of the stargate network: systems whose loss would cut a
    pocket of space off from the rest. The pocket size (how many systems
    lie behind the chokepoint) is how much space it controls. Found with
    Tarjan's lowpoint algorithm, iteratively (the graph is deep enough to
    overflow Python's recursion limit).

transit
    Betweenness centrality inside lowsec + nullsec: the share of shortest
    routes between low/null systems passing through each one, i.e. the
    pipes everyone flies.

    python tools/analyze_null.py      # reads web/data/, writes pvp_static.json
"""

from __future__ import annotations

import json
from collections import defaultdict, deque
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "web" / "data"


def band(sec: float) -> str:
    return "hs" if sec >= 0.5 else ("ls" if sec > 0.0 else "ns")


def cut_vertices(adj: dict[int, set[int]], root: int) -> dict[int, int]:
    """Cut vertices of root's component, each with the size of the pocket
    it separates (systems that would lose their route to root)."""
    disc, low, size, parent = {root: 0}, {root: 0}, {root: 1}, {root: None}
    pockets: dict[int, int] = defaultdict(int)
    root_children = 0
    timer = 1
    stack = [(root, iter(sorted(adj[root])))]
    while stack:
        v, it = stack[-1]
        advanced = False
        for w in it:
            if w not in disc:
                disc[w] = low[w] = timer
                timer += 1
                size[w] = 1
                parent[w] = v
                stack.append((w, iter(sorted(adj[w]))))
                advanced = True
                break
            if w != parent[v]:
                low[v] = min(low[v], disc[w])
        if advanced:
            continue
        stack.pop()
        p = parent[v]
        if p is None:
            continue
        low[p] = min(low[p], low[v])
        size[p] += size[v]
        if p == root:
            root_children += 1
        elif low[v] >= disc[p]:
            pockets[p] += size[v]           # v's subtree hangs off p alone
    if root_children > 1:                   # root is a cut vertex too
        pockets[root] = size[root] - 1 - max(
            size[c] for c in adj[root] if parent.get(c) == root)
    return dict(pockets)


def betweenness(adj: dict[int, set[int]], nodes: set[int]) -> dict[int, float]:
    """Brandes' algorithm on the subgraph induced by `nodes` (unweighted)."""
    sub = {v: [w for w in adj[v] if w in nodes] for v in nodes}
    bc = dict.fromkeys(nodes, 0.0)
    for s in nodes:
        order, preds = [], defaultdict(list)
        sigma, dist = defaultdict(int), {s: 0}
        sigma[s] = 1
        queue = deque([s])
        while queue:
            v = queue.popleft()
            order.append(v)
            for w in sub[v]:
                if w not in dist:
                    dist[w] = dist[v] + 1
                    queue.append(w)
                if dist[w] == dist[v] + 1:
                    sigma[w] += sigma[v]
                    preds[w].append(v)
        delta = defaultdict(float)
        for w in reversed(order):
            for v in preds[w]:
                delta[v] += sigma[v] / sigma[w] * (1 + delta[w])
            if w != s:
                bc[w] += delta[w]
    return bc


def main() -> None:
    systems = {f["properties"]["id"]: f["properties"]
               for f in json.loads((DATA / "systems.geojson").read_text())["features"]}
    jumps = json.loads((DATA / "jumps.geojson").read_text())["features"]
    adj: dict[int, set[int]] = defaultdict(set)
    for j in jumps:
        a, b = j["properties"]["from"], j["properties"]["to"]
        adj[a].add(b)
        adj[b].add(a)
    by_name = {p["name"]: i for i, p in systems.items()}
    main_root = by_name["Jita"]

    rank = {"hs": 2, "ls": 1, "ns": 0}
    bands = {i: band(p["sec"]) for i, p in systems.items()}
    entry = {i for i in systems if bands[i] != "hs"
             and any(rank[bands[n]] > rank[bands[i]] for n in adj[i])}

    pockets = cut_vertices(adj, main_root)
    pockets = {v: n for v, n in pockets.items() if bands[v] != "hs"}

    lownull = {i for i in systems if bands[i] != "hs"
               and systems[i]["region"] != "Pochven" and adj[i]}
    bc = betweenness(adj, lownull)
    top = max(bc.values()) or 1.0

    out = {
        "about": "Strategic lowsec/nullsec geography from the stargate graph "
                 "(tools/analyze_null.py): entry systems, chokepoints with the "
                 "size of the pocket behind them, and transit centrality.",
        "systems": {},
    }
    for i in lownull | entry | set(pockets):
        rec = {}
        if i in entry:
            rec["entry"] = True
        if pockets.get(i):
            rec["pocket"] = pockets[i]
        t = round(bc.get(i, 0.0) / top, 3)
        if t >= 0.01:
            rec["transit"] = t
        if rec:
            out["systems"][str(i)] = rec
    (DATA / "pvp_static.json").write_text(json.dumps(out, separators=(",", ":")))

    name = lambda i: f"{systems[i]['name']} ({systems[i]['region']})"
    print(f"entry systems: {len(entry)} "
          f"(null {sum(1 for i in entry if bands[i] == 'ns')})")
    print("largest pockets:", ", ".join(
        f"{name(v)}: {n}" for v, n in sorted(pockets.items(), key=lambda kv: -kv[1])[:8]))
    print("top transit:", ", ".join(
        name(v) for v, _ in sorted(bc.items(), key=lambda kv: -kv[1])[:10]))


if __name__ == "__main__":
    main()
