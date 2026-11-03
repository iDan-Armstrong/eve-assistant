"""Detect highsec suicide ganks in raw ESI killmails.

A suicide gank leaves two kinds of killmail in the same system within
moments: the victim's loss (killed by players) and each ganker's loss
(killed by CONCORD, which always answers criminal aggression in highsec).
zKillboard's 'ganked' label uses the same association; this module applies
it directly to raw ESI killmails, which carry no zKillboard labels (EVE
Ref's daily archives, for instance).

Rule: a killmail is a gank when it happened in highsec, CONCORD is not
among its attackers, and at least one of its player attackers was itself
killed by CONCORD in the same system within WINDOW_S seconds after it.
"""

from __future__ import annotations

from datetime import datetime

CONCORD_CORP = 1000125
WINDOW_S = 300        # CONCORD response is well under this, even at 0.5


def _ts(km: dict) -> float:
    return datetime.fromisoformat(km["killmail_time"].replace("Z", "+00:00")).timestamp()


def _concord_involved(km: dict) -> bool:
    return any(a.get("corporation_id") == CONCORD_CORP for a in km.get("attackers", []))


def detect_ganks(killmails, highsec: set[int]) -> list[dict]:
    """Return gank records {id, sys, time, ship} from raw ESI killmails."""
    concord_losses: dict[tuple[int, int], list[float]] = {}
    candidates = []
    for km in killmails:
        sys_id = km.get("solar_system_id")
        if sys_id not in highsec:
            continue
        if _concord_involved(km):
            char = km.get("victim", {}).get("character_id")
            if char:
                concord_losses.setdefault((sys_id, char), []).append(_ts(km))
        else:
            candidates.append(km)

    ganks = []
    for km in candidates:
        t, sys_id = _ts(km), km["solar_system_id"]
        attackers = {a.get("character_id") for a in km.get("attackers", [])
                     if a.get("character_id")}
        if any(0 <= ct - t <= WINDOW_S
               for char in attackers
               for ct in concord_losses.get((sys_id, char), [])):
            ganks.append({"id": km["killmail_id"], "sys": sys_id,
                          "time": km["killmail_time"],
                          "ship": km.get("victim", {}).get("ship_type_id")})
    return ganks
