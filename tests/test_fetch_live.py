import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import fetch_live  # noqa: E402

NOW = datetime(2026, 11, 3, 12, 0, tzinfo=timezone.utc)


def iso(hours_ago):
    return (NOW - timedelta(hours=hours_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def test_merge_ledger_dedupes_and_prunes():
    ledger = [{"id": 1, "sys": 9, "time": iso(2), "shipName": "Charon"},
              {"id": 2, "sys": 9, "time": iso(24 * 40)}]          # older than 30 days
    new = [{"id": 1, "sys": 9, "time": iso(2), "shipName": ""},   # duplicate
           {"id": 3, "sys": 9, "time": iso(1)}]
    out = fetch_live.merge_ledger(ledger, new, NOW)
    assert [k["id"] for k in out] == [3, 1]                       # newest first
    assert out[1]["shipName"] == "Charon"                         # existing entry wins


def test_aggregate_ganks_windows_and_tops():
    kills = [{"id": 1, "sys": 9, "time": iso(1), "isk": 3e9, "shipName": "Charon"},
             {"id": 2, "sys": 9, "time": iso(2), "isk": 1e9, "shipName": "Charon"},
             {"id": 3, "sys": 9, "time": iso(10), "isk": 5e8, "shipName": "Retriever"}]
    now6 = fetch_live.aggregate_ganks(kills, NOW - timedelta(hours=6))
    assert now6["9"]["n"] == 2 and now6["9"]["isk"] == 4e9
    assert now6["9"]["top"] == [("Charon", 2)]
    all30 = fetch_live.aggregate_ganks(kills, NOW - timedelta(days=30))
    assert all30["9"]["n"] == 3


def test_activity_days_accumulate_and_average():
    daily = {}
    sample = {"systems": {"9": [4, 1, 0, 300]}}
    fetch_live.add_activity_day(daily, sample, "2026-11-02")
    fetch_live.add_activity_day(daily, sample, "2026-11-02")
    fetch_live.add_activity_day(daily, {"systems": {"9": [0, 0, 0, 100]}}, "2026-11-03")
    assert daily["2026-11-02"]["9"] == [8, 2, 600, 2]
    avg = fetch_live.activity_averages(daily)
    assert avg["9"] == [round(8 / 3, 3), round(700 / 3, 1)]


def test_activity_days_keep_only_the_window():
    daily = {f"2026-10-{d:02d}": {} for d in range(1, 31)}
    fetch_live.add_activity_day(daily, {"systems": {}}, "2026-10-31", days=30)
    assert len(daily) == 30 and "2026-10-01" not in daily


def test_activity_merges_kills_and_jumps(monkeypatch):
    def fake(path):
        if path.endswith("system_kills"):
            return [{"system_id": 1, "ship_kills": 4, "pod_kills": 1, "npc_kills": 9}]
        return [{"system_id": 1, "ship_jumps": 300}, {"system_id": 2, "ship_jumps": 7}]
    monkeypatch.setattr(fetch_live, "esi_get", fake)
    status = {}
    out = fetch_live.fetch_activity(status)
    assert out["systems"]["1"] == [4, 1, 9, 300]
    assert out["systems"]["2"] == [0, 0, 0, 7]


def test_capsules_are_not_counted_as_ganks():
    kills = [{"id": 1, "sys": 9, "time": iso(1), "ship": 17476, "shipName": "Retriever"},
             {"id": 2, "sys": 9, "time": iso(1), "ship": 670, "shipName": "Capsule"}]
    out = fetch_live.aggregate_ganks(kills, NOW - timedelta(days=30))
    assert out["9"]["n"] == 1 and out["9"]["top"] == [("Retriever", 1)]


def test_evescout_rows_normalize_and_skip_unknown():
    rows = [{"out_system_name": "Thera", "out_system_id": 31000005,
             "in_system_id": 30002768, "in_system_name": "Uedama",
             "in_system_class": "hs", "in_region_name": "The Citadel",
             "wh_type": "Q063", "max_ship_size": "medium",
             "expires_at": "2026-11-03T20:00:00Z", "remaining_hours": 14.25},
            {"out_system_name": "Turnur"}]                     # no k-space end
    out = fetch_live.normalize_evescout(rows)
    assert len(out) == 1
    c = out[0]
    assert (c["hub"], c["to"], c["toName"], c["type"]) == ("Thera", 30002768, "Uedama", "Q063")
    assert c["hoursLeft"] == 14.2 or c["hoursLeft"] == 14.3
