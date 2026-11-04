import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import haul  # noqa: E402


def o(tid, loc, sysid, price, qty, buy=False, mn=1):
    return {"type_id": tid, "location_id": loc, "system_id": sysid, "price": price,
            "volume_remain": qty, "is_buy_order": buy, "min_volume": mn}


def test_walk_stops_when_margin_is_gone():
    asks = [(100.0, 10), (110.0, 10), (200.0, 5)]
    bids = [(150.0, 15, 1), (112.0, 50, 1)]
    units, cost, gross = haul.walk(asks, bids, tax=0.0)
    assert units == 20                        # 10 @100 + 5 @110 into 150, then 5 @110 into 112
    assert cost == 10 * 100 + 10 * 110
    assert gross == 15 * 150 + 5 * 112


def test_walk_respects_minimum_volume():
    units, *_ = haul.walk([(10.0, 3)], [(50.0, 100, 10), (40.0, 5, 1)], tax=0.0)
    assert units == 3                         # the min-10 buyer is skipped


def test_pairs_find_cross_station_trades_only():
    orders = [o(34, 1, 100, 5.0, 1_000_000), o(34, 2, 200, 9.0, 1_000_000, buy=True),
              o(34, 1, 100, 4.0, 10, buy=True),          # same station: never paired with itself
              o(35, 1, 100, 10.0, 5), o(35, 2, 200, 10.2, 5, buy=True)]   # too thin after tax
    book = haul.region_book(orders)
    rows = haul.pairs(book)
    assert len(rows) == 1
    tid, a, asys, b, bsys, units, cost, gross = rows[0]
    assert (tid, a, b, asys, bsys, units) == (34, 1, 2, 100, 200, 1_000_000)
