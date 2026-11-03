import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from analyze_null import betweenness, cut_vertices  # noqa: E402


def graph(edges):
    adj = defaultdict(set)
    for a, b in edges:
        adj[a].add(b)
        adj[b].add(a)
    return adj


def test_cut_vertex_reports_pocket_size():
    # 1-2-3 is a ring; 3 leads to a pocket 4-5-6 through one door
    adj = graph([(1, 2), (2, 3), (3, 1), (3, 4), (4, 5), (5, 6)])
    pockets = cut_vertices(adj, 1)
    assert pockets[3] == 3           # 4, 5, 6 are cut off without 3
    assert pockets[4] == 2 and pockets[5] == 1
    assert 1 not in pockets and 2 not in pockets


def test_ring_has_no_cut_vertices():
    adj = graph([(1, 2), (2, 3), (3, 4), (4, 1)])
    assert cut_vertices(adj, 1) == {}


def test_root_as_cut_vertex():
    # root 1 joins two branches: losing it cuts off the smaller one
    adj = graph([(1, 2), (2, 3), (1, 4)])
    assert cut_vertices(adj, 1)[1] == 1


def test_betweenness_peaks_on_the_bridge():
    # two triangles joined by 3-4: those two carry all cross traffic
    adj = graph([(1, 2), (2, 3), (3, 1), (3, 4), (4, 5), (5, 6), (6, 4)])
    bc = betweenness(adj, set(range(1, 7)))
    assert bc[3] == bc[4] and bc[3] > bc[1]
