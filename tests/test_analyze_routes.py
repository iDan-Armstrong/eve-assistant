import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from analyze_routes import exposure, route_load  # noqa: E402


def graph(edges):
    adj = defaultdict(list)
    for a, b in edges:
        adj[a].append(b)
        adj[b].append(a)
    return adj


def test_single_corridor_carries_the_whole_route():
    # hub 1 - 2 - 3 - hub 4: both middle systems carry every shortest path
    load, routes = route_load(graph([(1, 2), (2, 3), (3, 4)]), [1, 4])
    assert routes[(1, 4)] == 3
    assert load[2] == 1.0 and load[3] == 1.0


def test_parallel_paths_split_the_load():
    # two equally short routes 1-2-4 and 1-3-4: each middle node gets half
    load, _ = route_load(graph([(1, 2), (2, 4), (1, 3), (3, 4)]), [1, 4])
    assert load[2] == 0.5 and load[3] == 0.5


def test_longer_detour_carries_nothing():
    # 1-2-4 is shortest; the 1-3-5-4 detour gets no load
    load, _ = route_load(graph([(1, 2), (2, 4), (1, 3), (3, 5), (5, 4)]), [1, 4])
    assert load[2] == 1.0
    assert 3 not in load and 5 not in load


def test_exposure_peaks_at_point_five():
    assert exposure(1.0, 0.5) > exposure(1.0, 0.6) > exposure(1.0, 1.0)
    assert exposure(1.0, 0.4) == 0.0     # not highsec: out of scope
