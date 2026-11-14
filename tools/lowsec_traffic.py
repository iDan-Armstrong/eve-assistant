"""Lowsec traffic watch: 30 days of hourly jumps and kills for every lowsec
system, from CCP's last-hour counts (the same ESI samples traffic.py keeps
for a week).

    store  {"hours": {"2026-11-14T17": {systemId: [jumps, pvpKills, npcKills]}}}

One entry per ESI hour (a repeat run in the same hour is ignored, a missed
hour stays missing, never guessed). Only systems with any activity that hour
are written, so a quiet system costs nothing. The week the general traffic
store already holds seeds a new store, so the watch starts with history.

The served summary, per lowsec system:
    t    30-day totals [jumps, pvp kills, npc kills]
    d    daily jumps, one per day in "days" (null for a day with no samples)
    dk   daily pvp kills
    h    average jumps for each UTC hour of the day (0..23)
    hk   average pvp kills for each UTC hour
    w    average jumps per day for each weekday (Monday first)
    b    asteroid belts, from the static data
    o    Nocxium ores its belts should carry (Hedbergite, Hemorphite, Jaspet)
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

KEEP_HOURS = 24 * 30
ROOT = Path(__file__).resolve().parents[1]

# empire space by region, for which Nocxium ores spawn in lowsec belts:
# Hedbergite in Caldari and Minmatar space at 0.1 to 0.2; Hemorphite in Amarr
# and Gallente space at 0.1 to 0.2; Jaspet in Amarr and Gallente space at 0.1 to 0.4
AMARR_GALLENTE = {"Domain", "Kador", "Tash-Murkon", "Kor-Azor", "Derelik", "Devoid", "The Bleak Lands",
                  "Aridia", "Khanid", "Genesis", "Essence", "Everyshore", "Sinq Laison", "Solitude",
                  "Verge Vendor", "Placid"}
CALDARI_MINMATAR = {"The Forge", "Lonetrek", "The Citadel", "Black Rise", "Heimatar", "Metropolis",
                    "Molden Heath"}


def nocxium_ores(sec: float, region: str) -> list[str]:
    ores = []
    if sec <= 0.2 and region in CALDARI_MINMATAR:
        ores.append("Hedbergite")
    if sec <= 0.2 and region in AMARR_GALLENTE:
        ores.append("Hemorphite")
    if region in AMARR_GALLENTE:
        ores.append("Jaspet")
    return ores


def lowsec_systems(kspace: dict, belts: dict) -> dict[str, dict]:
    """kspace.json's {"s": {id: [name, sec, region]}} -> lowsec systems with belts and ores."""
    out = {}
    for sid, (name, sec, region) in kspace.get("s", {}).items():
        if 0.1 <= sec <= 0.4:
            out[sid] = {"n": name, "s": sec, "r": region, "b": belts.get(sid, 0),
                        "o": nocxium_ores(sec, region)}
    return out


def belt_counts(celestials_dir: Path) -> dict[str, int]:
    counts = {}
    for f in celestials_dir.glob("*.json"):
        try:
            systems = json.loads(f.read_text()).get("systems", {})
        except (OSError, ValueError):
            continue
        for sid, s in systems.items():
            counts[sid] = sum(len(p.get("belts") or []) for p in s.get("planets", []))
    return counts


def add_hour(store: dict, hour: str, activity: dict, lowsec: set[str], keep: int = KEEP_HOURS) -> bool:
    """Record one ESI hour of lowsec activity; False if that hour is held already.
    activity["systems"]: {id: [shipKills, podKills, npcKills, jumps]}"""
    hours = store.setdefault("hours", {})
    if hour in hours or not activity.get("systems"):
        return False
    hours[hour] = {sid: [j, k + p, n] for sid, (k, p, n, j) in activity["systems"].items()
                   if sid in lowsec and (j or k or p or n)}
    for old in sorted(hours)[:-keep]:
        del hours[old]
    return True


def seed(store: dict, week: dict, lowsec: set[str]) -> int:
    """Copy hours the weekly store holds and this one lacks; returns how many.
    week["hours"]: {hour: {id: [jumps, shipKills, podKills, npcKills]}}"""
    hours = store.setdefault("hours", {})
    added = 0
    for hour, rows in week.get("hours", {}).items():
        if hour in hours:
            continue
        hours[hour] = {sid: [j, k + p, n] for sid, (j, k, p, n) in rows.items() if sid in lowsec}
        added += 1
    for old in sorted(hours)[:-KEEP_HOURS]:
        del hours[old]
    return added


def relay_url() -> str | None:
    try:
        return json.loads((ROOT / "web" / "data" / "sso.json").read_text()).get("relay", "").rstrip("/") or None
    except (OSError, ValueError):
        return None


def pull_relay(http_get, relay: str, since: str, max_calls: int = 20) -> dict:
    """Hours the relay's hourly sampler holds after `since`:
    {hour: {id: [jumps, shipKills, podKills, npcKills]}}. http_get(url) -> parsed JSON."""
    got: dict = {}
    cursor = since
    for _ in range(max_calls):
        page = http_get(f"{relay}/traffic/hours?from={cursor}&limit=48")
        hours = page.get("hours") or {}
        got.update({h: rows for h, rows in hours.items() if rows is not None})
        if not page.get("more") or not hours:
            break
        cursor = max(hours)
    return got


def merge_relay(store: dict, relay_hours: dict, lowsec: set[str]) -> int:
    """Add relay hours this store lacks (lowsec systems only); returns how many."""
    hours = store.setdefault("hours", {})
    added = 0
    for hour, rows in relay_hours.items():
        if hour in hours:
            continue
        hours[hour] = {sid: [j, k + p, n] for sid, (j, k, p, n) in rows.items() if sid in lowsec}
        added += 1
    for old in sorted(hours)[:-KEEP_HOURS]:
        del hours[old]
    return added


def summarize(store: dict, systems: dict[str, dict], now: datetime) -> dict:
    hours = store.get("hours", {})
    keys = sorted(hours)
    days = sorted({k[:10] for k in keys})
    by_day = {d: [k for k in keys if k.startswith(d)] for d in days}
    by_hod = {h: [k for k in keys if int(k[-2:]) == h] for h in range(24)}
    wd_days: dict[int, list[str]] = {}
    for d in days:
        if len(by_day[d]) >= 20:              # a weekday average only counts near-complete days
            wd_days.setdefault(datetime.strptime(d, "%Y-%m-%d").weekday(), []).append(d)
    out = {}
    for sid, info in systems.items():
        get = lambda k, i: (hours[k].get(sid) or [0, 0, 0])[i]
        tot = [sum(get(k, i) for k in keys) for i in range(3)]
        daily = [sum(get(k, 0) for k in by_day[d]) for d in days]
        daily_k = [sum(get(k, 1) for k in by_day[d]) for d in days]
        hod = [round(sum(get(k, 0) for k in by_hod[h]) / len(by_hod[h]), 2) if by_hod[h] else None
               for h in range(24)]
        hod_k = [round(sum(get(k, 1) for k in by_hod[h]) / len(by_hod[h]), 3) if by_hod[h] else None
                 for h in range(24)]
        wk = []
        for wd in range(7):
            ds = wd_days.get(wd, [])
            wk.append(round(sum(daily[days.index(d)] for d in ds) / len(ds), 1) if ds else None)
        rec = {"n": info["n"], "s": info["s"], "r": info["r"], "b": info["b"], "o": info["o"],
               "t": tot, "d": daily, "h": hod, "w": wk}
        if any(daily_k):
            rec["dk"] = daily_k
            rec["hk"] = hod_k
        out[sid] = rec
    return {"generated": now.isoformat(timespec="seconds"), "windowDays": KEEP_HOURS // 24,
            "hoursHeld": len(keys), "from": keys[0] if keys else None, "to": keys[-1] if keys else None,
            "days": days, "hoursPerDay": [len(by_day[d]) for d in days],
            "source": "CCP ESI /universe/system_jumps and /universe/system_kills, one sample per hour",
            "systems": out}


def run(hist_dir: Path | None, activity: dict, hour: str, now: datetime, out_dir: Path, status: dict,
        relay_hours: dict | None = None) -> None:
    kspace = json.loads((ROOT / "web" / "data" / "jspace" / "kspace.json").read_text())
    systems = lowsec_systems(kspace, belt_counts(ROOT / "web" / "data" / "celestials"))
    ids = set(systems)
    store = {"hours": {}}
    if hist_dir:
        path = hist_dir / "lowsec_hours.json"
        try:
            store = json.loads(path.read_text())
        except (OSError, ValueError):
            store = {"hours": {}}
        seeded = 0
        if not store.get("hours"):
            try:
                seeded = seed(store, json.loads((hist_dir / "traffic_hours.json").read_text()), ids)
            except (OSError, ValueError):
                pass
        from_relay = merge_relay(store, relay_hours or {}, ids)
        new = add_hour(store, hour, activity, ids)
        path.write_text(json.dumps(store, separators=(",", ":")))
        status["lowsecTraffic"] = (f"{len(ids)} lowsec systems, hour {hour} {'new' if new else 'already held'}, "
                                   f"{len(store['hours'])} hours held, {from_relay} from the relay"
                                   + (f", seeded {seeded}" if seeded else ""))
    doc = summarize(store, systems, now)
    (out_dir / "lowsec_traffic.json").write_text(json.dumps(doc, separators=(",", ":")))
