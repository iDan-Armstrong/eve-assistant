import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from gank_detect import CONCORD_CORP, detect_ganks  # noqa: E402

HS, LS = 30002768, 30002000          # a highsec and a lowsec system id


def km(i, sys_id, t, victim_char, victim_ship, attackers):
    return {"killmail_id": i, "solar_system_id": sys_id,
            "killmail_time": f"2026-11-01T12:{t:02d}:00Z",
            "victim": {"character_id": victim_char, "ship_type_id": victim_ship},
            "attackers": attackers}


def player(c):
    return {"character_id": c, "corporation_id": 98000001}


def concord():
    return {"corporation_id": CONCORD_CORP}


def test_victim_kill_paired_with_concord_loss_is_a_gank():
    mails = [km(1, HS, 0, 500, 20183, [player(7), player(8)]),   # freighter dies
             km(2, HS, 1, 7, 24692, [concord()])]                # ganker 7 dies to CONCORD
    out = detect_ganks(mails, {HS})
    assert [g["id"] for g in out] == [1]
    assert out[0]["ship"] == 20183


def test_pvp_without_concord_is_not_a_gank():
    mails = [km(1, HS, 0, 500, 587, [player(7)])]                # e.g. a war kill
    assert detect_ganks(mails, {HS}) == []


def test_concord_loss_elsewhere_or_too_late_does_not_count():
    mails = [km(1, HS, 0, 500, 20183, [player(7)]),
             km(2, HS + 1, 1, 7, 24692, [concord()]),            # other system
             km(3, HS, 0, 501, 17476, [player(9)]),
             km(4, HS, 30, 9, 24692, [concord()])]               # 30 minutes later
    assert detect_ganks(mails, {HS, HS + 1}) == []


def test_lowsec_is_ignored():
    mails = [km(1, LS, 0, 500, 20183, [player(7)]),
             km(2, LS, 1, 7, 24692, [concord()])]
    assert detect_ganks(mails, {HS}) == []


def test_backfill_finds_archive_names_from_listing():
    from datetime import datetime
    from backfill_everef import archive_url
    names = ["killmails-2026-10-30.tar.bz2", "killmails-2026-10-31.tar.bz2"]
    url = archive_url(datetime(2026, 10, 31), names, 2026)
    assert url == "https://data.everef.net/killmails/2026/killmails-2026-10-31.tar.bz2"
    assert archive_url(datetime(2026, 11, 1), names, 2026) is None
