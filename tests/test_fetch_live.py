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
    def fake(path, meta=None):
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


def test_traffic_hours_dedupe_and_summarize():
    import traffic
    store = {}
    act = {"systems": {"9": [2, 1, 30, 400], "10": [0, 0, 0, 0]}}
    assert traffic.add_hour(store, "2026-11-03T11", act)
    assert not traffic.add_hour(store, "2026-11-03T11", act)        # same ESI hour
    assert traffic.add_hour(store, "2026-11-03T09", {"systems": {"9": [0, 0, 5, 100]}})
    assert store["hours"]["2026-11-03T11"] == {"9": [400, 2, 1, 30]}  # zero rows dropped
    out = traffic.summarize(store, NOW)                                 # NOW = 12:00
    s = out["systems"]["9"]
    assert s["j"][-2:] == [400, None] and s["j"][-4] == 100            # 10:00 never sampled
    assert s["p"][11] == 400 and s["p"][9] == 100 and s["p"][3] is None
    assert out["sampled"] == 2


def test_esi_hour_from_last_modified():
    import traffic
    assert traffic.esi_hour("Tue, 03 Nov 2026 21:07:12 GMT", NOW) == "2026-11-03T21"
    assert traffic.esi_hour(None, NOW) == "2026-11-03T12"


def test_market_aggregate_per_system():
    import fetch_market
    orders = [{"system_id": 30000142, "is_buy_order": False, "price": 5.0, "volume_remain": 100, "type_id": 34},
              {"system_id": 30000142, "is_buy_order": True, "price": 4.0, "volume_remain": 50, "type_id": 34},
              {"system_id": 30000142, "is_buy_order": False, "price": 1e6, "volume_remain": 1, "type_id": 648},
              {"system_id": 30002187, "is_buy_order": False, "price": 6.0, "volume_remain": 10, "type_id": 34}]
    out = fetch_market.aggregate(orders)
    assert out["30000142"] == [2, 1, 2, 1000500, 200]
    assert out["30002187"] == [1, 0, 1, 60, 0]


def test_structure_best_orders_per_type():
    import fetch_structure_markets as fsm
    orders = [{"type_id": 34, "is_buy_order": False, "price": p, "volume_remain": 1, "location_id": 9}
              for p in range(40, 0, -1)] + \
             [{"type_id": 34, "is_buy_order": True, "price": 3.0, "volume_remain": 5, "location_id": 9}]
    out = fsm.best_per_type(orders)[34]
    assert len(out["s"]) == fsm.KEEP and out["s"][0][0] == 1          # cheapest first
    assert out["b"] == [[3.0, 5, 9]]


def test_token_encryption_round_trip():
    import fetch_structure_markets as fsm
    blob = fsm.crypt(b"refresh-token", "a-test-key", False)
    assert blob != b"refresh-token"
    assert fsm.crypt(blob, "a-test-key", True) == b"refresh-token"


def test_station_shelves_best_prices_and_depth():
    import fetch_market
    shelves = {}
    fetch_market.add_shelves(shelves, [
        {"location_id": 1, "type_id": 34, "is_buy_order": False, "price": 5.0, "volume_remain": 10},
        {"location_id": 1, "type_id": 34, "is_buy_order": False, "price": 4.5, "volume_remain": 3},
        {"location_id": 1, "type_id": 34, "is_buy_order": True, "price": 4.0, "volume_remain": 7},
        {"location_id": 1, "type_id": 35, "is_buy_order": True, "price": 9.0, "volume_remain": 1}])
    assert shelves[1][34] == [4.5, 13, 4.0, 7]
    assert shelves[1][35] == [None, 0, 9.0, 1]
