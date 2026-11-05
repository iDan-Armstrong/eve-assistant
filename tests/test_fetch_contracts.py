import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import fetch_contracts as fc  # noqa: E402

BP = {691, 2047}


def test_single_bpo_only_one_original_and_nothing_asked_back():
    item = {"type_id": 691, "quantity": 1, "is_included": True, "material_efficiency": 10, "time_efficiency": 20}
    assert fc.single_bpo([item], BP) == [691, 10, 20]
    assert fc.single_bpo([{**item, "is_blueprint_copy": True}], BP) == 0
    assert fc.single_bpo([{**item, "type_id": 34}], BP) == 0
    assert fc.single_bpo([item, {"type_id": 34, "quantity": 5, "is_included": False}], BP) == 0
    assert fc.single_bpo([{**item, "is_included": False}], BP) == 0
    assert fc.single_bpo([], BP) == 0


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
