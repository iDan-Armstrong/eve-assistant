import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from build_map_data import (  # noqa: E402
    classify_jump, count_stations, dedupe_edges, sec_round, to_ly,
)


def test_sec_display_rounding_matches_the_game():
    assert sec_round(0.9459) == 0.9
    assert sec_round(0.45) == 0.5          # rounds up at the boundary
    assert sec_round(0.049) == 0.1         # tiny-positive shows as lowsec 0.1
    assert sec_round(0.0) == 0.0
    assert sec_round(-0.98) == -1.0


def test_to_ly():
    assert to_ly(9.4607e15) == 1.0
    assert to_ly(0) == 0.0


def test_dedupe_edges_folds_both_gate_directions_into_one_pair():
    gate_owner = {1: 100, 2: 200, 3: 200, 4: 100}
    gate_dest = {1: 2, 2: 1, 3: 4, 4: 3}   # two gates each way, same systems
    assert dedupe_edges(gate_owner, gate_dest) == [(100, 200)]


def test_dedupe_edges_ignores_dangling_gates():
    assert dedupe_edges({1: 100}, {1: 99}) == []  # destination gate unknown


def test_classify_jump():
    a = {"region": "Essence", "constellation": "Vieres"}
    same_const = {"region": "Essence", "constellation": "Vieres"}
    same_region = {"region": "Essence", "constellation": "Algintal"}
    other = {"region": "Placid", "constellation": "Josmaert"}
    assert classify_jump(a, same_const) == "local"
    assert classify_jump(a, same_region) == "constellation"
    assert classify_jump(a, other) == "regional"


def test_count_stations_walks_planets_and_moons():
    system = {"planets": {
        40000001: {"npcStations": {60000001: {}, 60000002: {}},
                   "moons": {40000002: {"npcStations": {60000003: {}}}}},
        40000003: {},
    }}
    assert count_stations(system) == 3


def test_component_finder_separates_islands():
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
    from audit_universe import components
    nodes = {1, 2, 3, 4, 5}
    edges = [(1, 2), (2, 3)]           # 4 and 5 are isolated
    comps = components(nodes, edges)
    assert [len(c) for c in comps] == [3, 1, 1]
    assert comps[0] == {1, 2, 3}


def test_trailing_number_orders_celestials_naturally():
    from build_map_data import trailing_number
    names = ["X - Asteroid Belt 10", "X - Asteroid Belt 2", "X - Moon 1"]
    assert sorted(names, key=trailing_number) == [
        "X - Moon 1", "X - Asteroid Belt 2", "X - Asteroid Belt 10"]
    assert trailing_number("Zarzakh - Star") == 0
