import sys
from datetime import datetime, timezone
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import wh_activity as W  # noqa: E402

cat = lambda t: {35832: 65, 587: 6, 670: 29}.get(t, 0)


def km(sid, t, when, vc, attackers):
    return {"solar_system_id": sid, "killmail_time": when, "victim": {"ship_type_id": t, "corporation_id": vc},
            "attackers": attackers}


def test_day_counts_players_structures_pods_and_npc_losses():
    p1 = [{"character_id": 1, "corporation_id": 900}, {"character_id": 2, "corporation_id": 900}]
    mails = [km(31000260, 587, "2026-11-13T21:05:00Z", 100, p1),
             km(31000260, 670, "2026-11-13T21:06:00Z", 100, p1),
             km(31000260, 35832, "2026-11-13T03:00:00Z", 100, p1),
             km(31000260, 587, "2026-11-13T04:00:00Z", 101, [{"faction_id": 500021}]),
             km(30000142, 587, "2026-11-13T04:00:00Z", 1, p1)]
    d = W.aggregate_day(mails, cat)
    assert list(d) == ["31000260"]
    r = d["31000260"]
    assert (r["k"], r["s"], r["p"], r["n"]) == (2, 1, 1, 1)
    assert r["h"][21] == 2 and r["h"][3] == 1 and r["h"][4] == 1
    assert r["vc"] == {"100": 3, "101": 1} and r["ac"] == {"900": 3}
    assert r["last"] == "2026-11-13T21:06:00Z"


def test_summary_and_names():
    p1 = [{"character_id": 1, "corporation_id": 900}]
    daily = {"2026-11-12": W.aggregate_day([km(31000001, 587, "2026-11-12T10:00:00Z", 100, p1)], cat),
             "2026-11-13": {}}
    assert W.top_corps(daily) == {100, 900}
    doc = W.summarize(daily, {"100": "Home Corp"}, datetime(2026, 11, 14, tzinfo=timezone.utc))
    s = doc["systems"]["31000001"]
    assert doc["days"] == ["2026-11-12", "2026-11-13"]
    assert s["d"] == [1, 0] and s["t"] == [1, 0, 0, 0]
    assert s["victims"] == [["Home Corp", 1]] and s["hunters"] == [["corp 900", 1]]
