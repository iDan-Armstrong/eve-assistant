import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import fetch_market  # noqa: E402


def test_bpo_index_keeps_blueprints_cheapest_first_with_averages():
    fetch_market.STATION_SYSTEM.update({60000001: 30000001, 60000002: 30000002})
    shelves = {
        60000001: {691: [1_500_000, 2, None, 0], 34: [5.0, 100, 4.0, 50]},
        60000002: {691: [1_200_000, 1, None, 0], 2047: [None, 0, 900.0, 3]},
    }
    prices = [{"type_id": 691, "average_price": 1_400_000.123}, {"type_id": 34, "average_price": 5.1},
              {"type_id": 2047, "adjusted_price": 10.0}]
    idx = fetch_market.bpo_index(shelves, prices, {691, 2047})
    assert idx["sell"] == {"691": [[60000002, 30000002, 1_200_000, 1], [60000001, 30000001, 1_500_000, 2]]}
    assert idx["avg"] == {"691": 1_400_000.12}
