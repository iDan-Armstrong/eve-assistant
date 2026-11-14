"""Wormhole activity: what killmails say about each J-system over 30 days.

CCP publishes no jumps or NPC kills for wormhole space, so killmails are the
only record of activity there. The daily EVE Ref archives (read by
backfill_everef.py) feed one aggregate per day:

    wh_daily.json {"days": {"2026-11-13": {systemId: {
        "k": ships and pods killed by players, "s": structures killed,
        "p": pods (of k), "h": [24 counts by UTC hour],
        "vc": {victim corp: n}, "ac": {attacking corp: n}}}}}

Victims' corporations hint at who lives in a system, attackers' at who
hunts there. The served summary (wormhole_activity.json) keeps, per system
with any kill: totals, kills each day, kills by hour of day, the last kill
and the leading corporations by name.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime

WINDOW_DAYS = 30
CAPSULES = {670, 33328}
STRUCTURE_CATS = {23, 65}            # starbases, Upwell structures


def is_wspace(sid) -> bool:
    try:
        return 31000000 <= int(sid) < 32000000
    except (TypeError, ValueError):
        return False


def aggregate_day(killmails, cat_of) -> dict:
    """One day's killmails -> {systemId: {k, s, p, h, vc, ac, last}}; player kills only."""
    out: dict[str, dict] = {}
    for km in killmails:
        sid = km.get("solar_system_id")
        if not is_wspace(sid):
            continue
        attackers = [a for a in km.get("attackers", []) if a.get("character_id")]
        victim = km.get("victim", {})
        t = victim.get("ship_type_id")
        rec = out.setdefault(str(sid), {"k": 0, "s": 0, "p": 0, "n": 0, "h": [0] * 24, "vc": {}, "ac": {}, "last": ""})
        if cat_of(t) in STRUCTURE_CATS:
            rec["s"] += 1
        elif not attackers:
            rec["n"] += 1                        # lost to NPCs (sleepers, drifters)
        else:
            rec["k"] += 1
            if t in CAPSULES:
                rec["p"] += 1
        when = km.get("killmail_time", "")
        try:
            rec["h"][int(when[11:13])] += 1
        except (ValueError, IndexError):
            pass
        rec["last"] = max(rec["last"], when)
        vc = victim.get("corporation_id")
        if vc:
            rec["vc"][str(vc)] = rec["vc"].get(str(vc), 0) + 1
        for c in {a.get("corporation_id") for a in attackers if a.get("corporation_id")}:
            rec["ac"][str(c)] = rec["ac"].get(str(c), 0) + 1
    return out


def prune(daily: dict, newest: str, days: int = WINDOW_DAYS) -> dict:
    keep = sorted(d for d in daily if d <= newest)[-days:]
    return {d: daily[d] for d in keep}


def top_corps(daily: dict) -> set[int]:
    ids: set[int] = set()
    for sid in {s for day in daily.values() for s in day}:
        v, a = Counter(), Counter()
        for day in daily.values():
            r = day.get(sid)
            if r:
                v.update(r["vc"])
                a.update(r["ac"])
        ids |= {int(c) for c, _ in v.most_common(3)} | {int(c) for c, _ in a.most_common(3)}
    return ids


def summarize(daily: dict, names: dict, now: datetime) -> dict:
    days = sorted(daily)
    out = {}
    for sid in sorted({s for day in daily.values() for s in day}):
        recs = [daily[d].get(sid) for d in days]
        tot = {"k": 0, "s": 0, "p": 0, "n": 0}
        hours = [0] * 24
        v, a = Counter(), Counter()
        last = ""
        for r in recs:
            if not r:
                continue
            for key in tot:
                tot[key] += r.get(key, 0)
            hours = [x + y for x, y in zip(hours, r["h"])]
            v.update(r["vc"])
            a.update(r["ac"])
            last = max(last, r["last"])
        name = lambda c: names.get(str(c), f"corp {c}")
        out[sid] = {"t": [tot["k"], tot["s"], tot["p"], tot["n"]],
                    "d": [(r["k"] + r["s"] + r["n"]) if r else 0 for r in recs],
                    "h": hours, "last": last,
                    "victims": [[name(c), n] for c, n in v.most_common(3)],
                    "hunters": [[name(c), n] for c, n in a.most_common(3)]}
    return {"generated": now.isoformat(timespec="seconds"), "days": days,
            "schema": {"t": "[player kills, structures killed, pods (of player kills), lost to NPCs]",
                       "d": "kills each day", "h": "kills by UTC hour of day"},
            "source": "EVE Ref daily killmail archives (raw CCP killmails), about one day behind",
            "systems": out}
