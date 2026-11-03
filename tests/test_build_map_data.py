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


def test_special_gate_classes_override_geography():
    from build_map_data import special_class
    assert special_class(77921, 77918) == "jovian"      # Zarzakh spoke
    assert special_class(56317, 56317) == "triglavian"  # Pochven conduit
    assert special_class(12292, 16) == "smuggler"       # one end suffices
    assert special_class(77921, 56317) == "jovian"      # jovian outranks
    assert special_class(16, 3875) == ""                # ordinary gates


def test_one_way_links_detected_with_direction():
    from build_map_data import collect_edges
    owner = {1: 100, 2: 200, 3: 300}
    dest = {1: 2, 2: 1, 3: 1}        # 100<->200 mutual; 300->100 one-way
    dirs = collect_edges(owner, dest)
    assert dirs[(100, 200)] == {"ab", "ba"}
    assert dirs[(100, 300)] == {"ba"}   # travel runs hi->lo only


def test_station_service_classes_rank_by_distinctiveness():
    from build_map_data import classify_services
    assert classify_services(["Cloning", "Market", "Factory"]) == "cloning"
    assert classify_services(["Factory", "Market"]) == "industry"
    assert classify_services(["Laboratory", "Repair Facilities"]) == "industry"
    assert classify_services(["Market", "Fitting"]) == "market"
    assert classify_services(["Repair Facilities"]) == "basic"
    assert classify_services([]) == "basic"


def test_planet_kind_and_pi_table():
    from build_map_data import PI_RESOURCES, planet_kind
    assert planet_kind("Planet (Gas)") == "Gas"
    assert "Reactive Gas" in PI_RESOURCES["Gas"]
    assert planet_kind("Planet (Shattered)") not in PI_RESOURCES  # no PI
    assert all(len(v) == 5 for v in PI_RESOURCES.values())


def test_typical_ores_by_band_quarter_and_class():
    from build_map_data import typical_ores
    # highsec 1.0: common ores only, no 0.9-band extras
    assert typical_ores(1.0, 0.95, "B", "Caldari State") == ["Veldspar", "Scordite"]
    # caldari 0.7 picks up plagioclase
    assert "Plagioclase" in typical_ores(0.7, 0.7, "C", "Caldari State")
    # deep lowsec adds the quarter's rare ore
    assert "Hemorphite" in typical_ores(0.1, 0.1, "E", "Gallente Federation")
    # nullsec class F at -0.8: bistot, arkonor, pyroxeres, mercoxit
    assert set(typical_ores(-0.8, -0.8, "F", "")) == {
        "Bistot", "Arkonor", "Pyroxeres", "Mercoxit"}
    # Drone regions (class K)
    assert typical_ores(-0.3, -0.3, "K", "") == ["Arkonor", "Bistot", "Mercoxit"]


def test_typical_ores_reads_sde_subclass_suffix():
    from build_map_data import typical_ores
    # SDE securityClass values carry a numeric suffix (D4R-H7 is "H7")
    assert "Bistot" in typical_ores(-1.0, -1.0, "H7", "")


def test_overlay_star_record_converts_units():
    from overlay_current import star_record
    star = {"id": 1, "type": "Sun G5 (Yellow)", "name": "X - Star", "radius": 5.0e8}
    rec = star_record(star, (5600.4, "G5 V", 1.02, 3.1557e16, 0))
    assert rec["tempK"] == 5600 and rec["radiusKm"] == 500000
    assert rec["ageYr"] == 1_000_000_000 and rec["spectral"] == "G5 V"
    assert star_record(None, None) is None
