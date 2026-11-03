import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from ambush import aggregate_day, nearest_gate, prune, summarize  # noqa: E402

GATES = {1: [(2, 0.0, 0.0, 0.0), (3, 1e6, 0.0, 0.0)]}       # km


def km(sid, x_m, ship=587, pilots=3):
    return {"solar_system_id": sid,
            "victim": {"ship_type_id": ship, "position": {"x": x_m, "y": 0.0, "z": 0.0}},
            "attackers": [{"character_id": 90000000 + i} for i in range(pilots)] + [{"faction_id": 5}]}


def test_nearest_gate_threshold():
    assert nearest_gate({"x": 150e3, "y": 0, "z": 0}, GATES[1]) == 2      # 150 km
    assert nearest_gate({"x": 1e9 - 50e3, "y": 0, "z": 0}, GATES[1]) == 3
    assert nearest_gate({"x": 5e8, "y": 0, "z": 0}, GATES[1]) is None      # deep space
    assert nearest_gate(None, GATES[1]) is None


def test_aggregate_day_counts_gate_kills_and_skips_pods_and_npc():
    mails = [km(1, 10e3), km(1, 20e3, pilots=5), km(1, 5e8),
             km(1, 10e3, ship=670),                  # capsule
             km(1, 10e3, pilots=0),                  # NPC-only attackers
             km(1, 10e3, ship=35832),                # a citadel, not a ship
             km(9, 0.0)]                             # not a tracked system
    out = aggregate_day(mails, {1}, GATES, ships={587})
    assert out == {"1": [3, 2, 11, {"2": 2}]}


def test_prune_and_summarize():
    daily = {f"2026-10-{d:02d}": {"1": [2, 1, 6, {"2": 1}]} for d in range(1, 32)}
    kept = prune(daily, "2026-10-31", days=30)
    assert len(kept) == 30 and "2026-10-01" not in kept
    s = summarize(kept)["1"]
    assert (s["k"], s["g"], s["gang"], s["gates"]) == (60, 30, 3.0, [[2, 30]])
