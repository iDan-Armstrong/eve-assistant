"""Hourly traffic history from CCP's last-hour counts.

ESI's /universe/system_jumps and /universe/system_kills each describe one
clock hour and change once an hour; the response's Last-Modified header
says which. The scheduled job may run several times in an hour, or skip
an hour, so samples are stored by that ESI hour: a repeat is ignored, a
gap stays a gap (null), and nothing is double counted.

    store  {"hours": {"2026-11-03T21": {systemId: [jumps, shipKills, podKills, npcKills]}}}

The served summary per system holds the last 24 hours of jumps and ship
kills (null where no sample exists) and a typical-day profile: average
jumps for each UTC hour of the day over the stored week.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

KEEP_HOURS = 24 * 7


def hour_key(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H")


def esi_hour(last_modified: str | None, now: datetime) -> str:
    """The clock hour an ESI last-hour count describes."""
    if last_modified:
        try:
            return hour_key(parsedate_to_datetime(last_modified))
        except (TypeError, ValueError):
            pass
    return hour_key(now)


def add_hour(store: dict, hour: str, activity: dict, keep: int = KEEP_HOURS) -> bool:
    """Record one ESI hour; False if that hour is already stored."""
    hours = store.setdefault("hours", {})
    if hour in hours or not activity.get("systems"):
        return False
    hours[hour] = {sid: [j, k, p, n] for sid, (k, p, n, j) in activity["systems"].items()
                   if j or k or p or n}
    for old in sorted(hours)[:-keep]:
        del hours[old]
    return True


def summarize(store: dict, now: datetime) -> dict:
    hours = store.get("hours", {})
    last24 = [hour_key(now - timedelta(hours=h)) for h in range(23, -1, -1)]
    systems: dict[str, dict] = {}
    seen = set()
    for rows in hours.values():
        seen.update(rows)
    by_hod: dict[int, list[str]] = {}
    for key in hours:
        by_hod.setdefault(int(key[-2:]), []).append(key)
    for sid in seen:
        jumps = [hours[k][sid][0] if k in hours and sid in hours[k] else (0 if k in hours else None)
                 for k in last24]
        kills = [hours[k][sid][1] if k in hours and sid in hours[k] else (0 if k in hours else None)
                 for k in last24]
        profile = []
        for hod in range(24):
            keys = by_hod.get(hod, [])
            profile.append(round(sum(hours[k].get(sid, [0])[0] for k in keys) / len(keys), 1)
                           if keys else None)
        rec = {"j": jumps, "p": profile}
        if any(kills):
            rec["k"] = kills
        systems[sid] = rec
    return {"hours": last24, "sampled": sum(1 for k in last24 if k in hours),
            "storedHours": len(hours), "systems": systems}
