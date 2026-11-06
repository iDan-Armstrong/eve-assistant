import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import fetch_contracts as fc  # noqa: E402

BP = {691, 2047}


def test_contents_and_single_bpo():
    item = {"type_id": 691, "quantity": 1, "is_included": True, "material_efficiency": 10, "time_efficiency": 20}
    rec = fc.contents([item])
    assert rec == [[691, 1, 0, 10, 20]]
    assert fc.single_bpo(rec, BP) == [691, 10, 20]
    assert fc.single_bpo(fc.contents([{**item, "is_blueprint_copy": True}]), BP) == 0
    assert fc.single_bpo(fc.contents([{**item, "type_id": 34}]), BP) == 0
    assert fc.single_bpo(fc.contents([item, {"type_id": 34, "quantity": 5}]), BP) == 0
    assert fc.contents([item, {"type_id": 34, "quantity": 5, "is_included": False}]) == 0   # asks for items back
    assert fc.contents([]) == 0
    assert fc.single_bpo(0, BP) == 0


def test_hub_value_picks_the_best_single_hub_and_respects_buy_volume():
    rec = [[34, 1000, 0, 0, 0], [35, 10, 0, 0, 0], [692, 1, 1, 0, 0]]          # last one a copy
    books = {60003760: {34: (5.0, 600), 35: (100.0, 100)}, 60008494: {34: (6.0, 2000)}}
    assert fc.hub_value(rec, books) == (60008494, 6000.0, 11)              # 6000 beats 5*600 + 1000
    books[60003760][34] = (5.0, 2000)
    assert fc.hub_value(rec, books) == (60003760, 6000.0, 1)                # a tie keeps the first hub


def test_deals_keep_only_profitable_contracts_best_first():
    books = {60003760: {34: (5.0, 10**9)}}
    seen = {"1": [[34, 1_000_000, 0, 0, 0]], "2": [[34, 1_000_000, 0, 0, 0]], "3": 0}
    contracts = [
        {"contract_id": 1, "start_location_id": 60004588, "price": 3_000_000, "volume": 10_000, "date_expired": "x"},
        {"contract_id": 2, "start_location_id": 60004588, "price": 4_900_000, "volume": 10_000},  # thin margin
        {"contract_id": 3, "start_location_id": 60004588, "price": 1},
    ]
    rows = fc.deals(contracts, seen, {60004588: 30002510}, books)
    assert [r[0] for r in rows] == [1]
    assert rows[0][1:8] == [60004588, 30002510, 3_000_000, 5_000_000.0, 60003760, 10_000, 1]
    assert rows[0][8] == [[34, 1_000_000]] and rows[0][9] == 0


def test_couriers_rows():
    rows = fc.couriers([{"type": "courier", "contract_id": 9, "start_location_id": 60003760, "end_location_id": 60008494,
                         "reward": 5e6, "collateral": 1e8, "volume": 12000, "days_to_complete": 3, "date_expired": "e"},
                        {"type": "courier", "contract_id": 10, "reward": 0}],
                       {60003760: 30000142, 60008494: 30002187})
    assert rows == [[9, 60003760, 30000142, 60008494, 30002187, 5e6, 1e8, 12000, 3, "e"]]


def test_contract_offers_cheapest_first_with_place():
    contracts = [{"contract_id": 1, "start_location_id": 60003760, "price": 900.0},
                 {"contract_id": 2, "start_location_id": 1035466617946, "price": 700.0},
                 {"contract_id": 3, "start_location_id": 60003760, "price": 5.0}]
    seen = {"1": [691, 10, 20], "2": [691, 0, 0], "3": 0}
    out = fc.contract_offers(contracts, seen, {60003760: 30000142})
    assert out == {"691": [[2, 1035466617946, 0, 700.0, 0, 0], [1, 60003760, 30000142, 900.0, 10, 20]]}


def test_structure_offers_from_shards(tmp_path):
    (tmp_path / "3.json").write_text(json.dumps({"691": {"s": [[1200.0, 1, 1035466617946], [1100.0, 0, 9]], "b": []},
                                                 "34": {"s": [[5.0, 100, 1035466617946]]}}))
    out = fc.structure_offers(tmp_path, {"1035466617946": ["Perimeter - Tranquility Trading Tower", 30000144]}, BP)
    assert out == {"691": [[1035466617946, 30000144, 1200.0, 1]]}
