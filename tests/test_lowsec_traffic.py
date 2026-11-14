from datetime import datetime, timezone

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import lowsec_traffic as L  # noqa: E402


def test_ores_by_space_and_security():
    assert L.nocxium_ores(0.1, "Metropolis") == ["Hedbergite"]
    assert L.nocxium_ores(0.2, "Aridia") == ["Hemorphite", "Jaspet"]
    assert L.nocxium_ores(0.4, "Aridia") == ["Jaspet"]
    assert L.nocxium_ores(0.3, "The Forge") == []


def test_lowsec_only_and_hours_once():
    systems = L.lowsec_systems({"s": {"1": ["Huna", 0.1, "Aridia"], "2": ["Jita", 0.9, "The Forge"],
                                      "3": ["Ansen", 0.1, "Metropolis"]}}, {"1": 32})
    assert sorted(systems) == ["1", "3"] and systems["1"]["b"] == 32
    store = {}
    act = {"systems": {"1": [1, 1, 5, 4], "2": [0, 0, 0, 900], "3": [0, 0, 0, 0]}}
    assert L.add_hour(store, "2026-11-14T17", act, set(systems))
    assert not L.add_hour(store, "2026-11-14T17", act, set(systems))
    assert store["hours"]["2026-11-14T17"] == {"1": [4, 2, 5]}


def test_seed_and_summary():
    week = {"hours": {f"2026-11-1{d}T{h:02d}": {"1": [h, 0, 0, 0]} for d in (2, 3) for h in range(24)}}
    store = {}
    assert L.seed(store, week, {"1"}) == 48
    L.add_hour(store, "2026-11-14T05", {"systems": {"1": [2, 0, 0, 10]}}, {"1"})
    sysinfo = {"1": {"n": "Huna", "s": 0.1, "r": "Aridia", "b": 32, "o": ["Hemorphite", "Jaspet"]}}
    doc = L.summarize(store, sysinfo, datetime(2026, 11, 14, 6, tzinfo=timezone.utc))
    s = doc["systems"]["1"]
    assert doc["days"] == ["2026-11-12", "2026-11-13", "2026-11-14"]
    assert s["d"] == [276, 276, 10]
    assert s["t"] == [562, 2, 0]
    assert s["h"][5] == round((5 + 5 + 10) / 3, 2) and s["h"][23] == 23
    assert s["w"][3] == 276 and s["w"][4] == 276 and s["w"][5] is None   # Thu, Fri full; Sat partial
    assert s["dk"] == [0, 0, 2]


def test_relay_pull_pages_and_merge():
    pages = {"": {"hours": {"2026-11-14T01": {"1": [3, 1, 0, 2]}}, "more": True},
             "2026-11-14T01": {"hours": {"2026-11-14T02": {"2": [9, 0, 0, 0]}}, "more": False}}
    calls = []
    def get(url):
        calls.append(url)
        return pages[url.split("from=")[1].split("&")[0]]
    got = L.pull_relay(get, "https://relay", "")
    assert sorted(got) == ["2026-11-14T01", "2026-11-14T02"] and len(calls) == 2
    store = {"hours": {"2026-11-14T02": {}}}
    assert L.merge_relay(store, got, {"1"}) == 1
    assert store["hours"]["2026-11-14T01"] == {"1": [3, 1, 2]}
