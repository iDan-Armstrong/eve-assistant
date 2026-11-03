import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import fetch_live  # noqa: E402


def iso(hours_ago):
    t = datetime.now(timezone.utc) - timedelta(hours=hours_ago)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def test_ganks_aggregate_per_system_and_respect_window(monkeypatch):
    summaries = [
        {"killmail_id": 3, "zkb": {"hash": "c", "totalValue": 3e9}},
        {"killmail_id": 2, "zkb": {"hash": "b", "totalValue": 1e9}},
        {"killmail_id": 1, "zkb": {"hash": "a", "totalValue": 5e8}},
    ]
    kms = {
        3: {"killmail_id": 3, "killmail_time": iso(1), "solar_system_id": 30002768,
            "victim": {"ship_type_id": 20183}},
        2: {"killmail_id": 2, "killmail_time": iso(2), "solar_system_id": 30002768,
            "victim": {"ship_type_id": 20183}},
        1: {"killmail_id": 1, "killmail_time": iso(30), "solar_system_id": 30002768,
            "victim": {"ship_type_id": 17476}},   # outside the 24h window
    }
    monkeypatch.setattr(fetch_live, "zkill_ganked", lambda status: summaries)
    monkeypatch.setattr(fetch_live, "esi_get",
                        lambda path: kms[int(path.split("/")[2])])
    monkeypatch.setattr(fetch_live, "http",
                        lambda url, **kw: [{"id": 20183, "name": "Providence"}])
    status = {}
    out = fetch_live.fetch_ganks(status)
    s = out["systems"]["30002768"]
    assert s["n"] == 2 and s["isk"] == 4_000_000_000
    assert s["top"] == [["Providence", 2]] or s["top"] == [("Providence", 2)]
    assert "2 ganks in 1 systems" in status["ganks"]


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
    assert status["esi_kills"].startswith("ok") and status["esi_jumps"].startswith("ok")
