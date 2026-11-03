"""Fetch live activity and maintain the risk history (run hourly in CI).

Writes, under web/data/live/:
    activity.json  CCP ESI: ship/pod/NPC kills and jumps per system, last hour
    ganks.json     "risk now": ganks per system over the last NOW_HOURS
    wormholes.json EVE-Scout: current Thera and Turnur connections
    history.json   "risk history": ganks per system over the last
                   HISTORY_DAYS plus average hourly kills and jumps
    status.json    what each source returned this run

With --history DIR the run also maintains a persistent store in DIR (CI
keeps it on the repo's live-data branch):
    ganks_ledger.json    every gank seen, deduplicated by killmail id,
                         pruned to HISTORY_DAYS; fed hourly by zKillboard
                         and once by the EVE Ref backfill
    activity_daily.json  per-day sums of ESI kills/jumps per system

Every source is optional: a failure is recorded in status.json and the
script exits 0, so the site always deploys with whatever succeeded.
Standard library only. Etiquette: descriptive User-Agent (project URL, no
personal contact), gzip, ESI's X-Compatibility-Date, zKillboard spacing.

    python tools/fetch_live.py [--history DIR]
"""

from __future__ import annotations

import gzip
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "web" / "data" / "live"
UA = "eve-assistant New Eden Atlas (+https://github.com/iDan-Armstrong/eve-assistant)"
ESI = "https://esi.evetech.net"
ESI_COMPAT = "2025-09-30"
ZKILL = "https://zkillboard.com/api"
NOW_HOURS = 6
HISTORY_DAYS = 30
MAX_KILLMAILS = 200           # ESI killmail lookups per run, newest first
ZKILL_SPACING_S = 1.1


def http(url: str, *, data: bytes | None = None, esi: bool = False,
         timeout: int = 30):
    headers = {"User-Agent": UA, "Accept": "application/json",
               "Accept-Encoding": "gzip"}
    if esi:
        headers["X-Compatibility-Date"] = ESI_COMPAT
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return json.loads(raw)


def esi_get(path: str):
    """Current ESI path style first, then the legacy /latest/ form."""
    try:
        return http(f"{ESI}{path}", esi=True)
    except (urllib.error.URLError, ValueError):
        return http(f"{ESI}/latest{path}/?datasource=tranquility", esi=True)


def parse_time(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


# ---- sources ------------------------------------------------------------

def fetch_activity(status: dict) -> dict:
    systems: dict[str, list[int]] = {}
    try:
        for row in esi_get("/universe/system_kills"):
            systems[str(row["system_id"])] = [row.get("ship_kills", 0),
                                              row.get("pod_kills", 0),
                                              row.get("npc_kills", 0), 0]
        status["esi_kills"] = f"ok, {len(systems)} systems"
    except Exception as exc:                         # noqa: BLE001 - record it
        status["esi_kills"] = f"error: {exc}"
    try:
        n = 0
        for row in esi_get("/universe/system_jumps"):
            rec = systems.setdefault(str(row["system_id"]), [0, 0, 0, 0])
            rec[3] = row.get("ship_jumps", 0)
            n += 1
        status["esi_jumps"] = f"ok, {n} systems"
    except Exception as exc:                         # noqa: BLE001
        status["esi_jumps"] = f"error: {exc}"
    return {"schema": ["shipKills", "podKills", "npcKills", "jumps"],
            "window": "last hour (ESI)", "systems": systems}


def zkill_ganked(status: dict) -> list[dict]:
    """zKillboard summaries for recent ganked kills. Try the known URL
    forms and record which answered; the last resort filters a highsec
    listing on the 'ganked' label."""
    attempts = [("label/ganked", f"{ZKILL}/kills/label/ganked/"),
                ("ganked", f"{ZKILL}/kills/ganked/"),
                ("highsec+filter", f"{ZKILL}/kills/highsec/")]
    errors = []
    for name, url in attempts:
        try:
            rows = http(url)
        except Exception as exc:                     # noqa: BLE001
            errors.append(f"{name}: {exc}")
            time.sleep(ZKILL_SPACING_S)
            continue
        time.sleep(ZKILL_SPACING_S)
        if not isinstance(rows, list):
            errors.append(f"{name}: unexpected response")
            continue
        if name == "highsec+filter":
            rows = [r for r in rows
                    if "ganked" in ((r.get("zkb") or {}).get("labels") or [])]
        status["zkill"] = f"ok via {name}, {len(rows)} summaries"
        return rows
    status["zkill"] = "error: " + "; ".join(errors)
    return []


def fetch_recent_ganks(status: dict, known: set[int]) -> list[dict]:
    """New ganks from zKillboard, resolved through ESI (skips known ids)."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=1)
    summaries = sorted(zkill_ganked(status),
                       key=lambda r: r.get("killmail_id", 0), reverse=True)
    out, failed = [], 0
    for row in summaries[:MAX_KILLMAILS]:
        if row.get("killmail_id") in known:
            continue
        zkb = row.get("zkb") or {}
        try:
            km = esi_get(f"/killmails/{row['killmail_id']}/{zkb['hash']}")
        except Exception:                            # noqa: BLE001
            failed += 1
            continue
        if parse_time(km["killmail_time"]) < cutoff:
            break                                    # newest first: done
        out.append({"id": km["killmail_id"], "sys": km["solar_system_id"],
                    "time": km["killmail_time"],
                    "ship": km.get("victim", {}).get("ship_type_id"),
                    "isk": round(zkb.get("totalValue", 0)), "src": "zkill"})
    status["zkill_new"] = f"{len(out)} new ganks, {failed} ESI lookups failed"
    return out


EVESCOUT = "https://api.eve-scout.com/v2/public/signatures"


def normalize_evescout(rows: list[dict]) -> list[dict]:
    """EVE-Scout signatures -> compact connection records. Field names are
    read defensively (with fallbacks) since the public API's schema is not
    published as a spec; rows without a known k-space end are skipped."""
    out = []
    for r in rows:
        to = r.get("in_system_id") or r.get("system_id")
        hub = r.get("out_system_name") or r.get("out_system") or ""
        if not to or not hub:
            continue
        hours = r.get("remaining_hours")
        out.append({
            "hub": hub, "hubId": r.get("out_system_id"),
            "to": to, "toName": r.get("in_system_name", ""),
            "toClass": r.get("in_system_class", ""),
            "region": r.get("in_region_name", ""),
            "type": r.get("wh_type") or r.get("signature_type") or "",
            "maxShip": r.get("max_ship_size", ""),
            "expires": r.get("expires_at", ""),
            "hoursLeft": round(hours, 1) if isinstance(hours, (int, float)) else None,
        })
    return out


def fetch_evescout(status: dict) -> dict:
    try:
        rows = http(EVESCOUT)
        if not isinstance(rows, list):
            raise ValueError("unexpected response")
        conns = normalize_evescout(rows)
        keys = sorted(rows[0].keys()) if rows else []
        status["evescout"] = (f"ok, {len(rows)} signatures, {len(conns)} connections; "
                              f"fields: {', '.join(keys)}")
    except Exception as exc:                         # noqa: BLE001
        conns = []
        status["evescout"] = f"error: {exc}"
    return {"source": "EVE-Scout (Signal Cartel), api.eve-scout.com",
            "connections": conns}


def resolve_ship_names(kills: list[dict], status: dict) -> None:
    """Fill shipName for kills that lack one (ESI /universe/names, ≤1000/call)."""
    ids = sorted({k["ship"] for k in kills if k.get("ship") and not k.get("shipName")})
    names = {}
    for i in range(0, len(ids), 1000):
        try:
            body = json.dumps(ids[i:i + 1000]).encode()
            for rec in http(f"{ESI}/universe/names", data=body, esi=True):
                names[rec["id"]] = rec["name"]
        except Exception as exc:                     # noqa: BLE001
            status["esi_names"] = f"error: {exc}"
    for k in kills:
        if not k.get("shipName"):
            k["shipName"] = names.get(k.get("ship"), "")


# ---- ledger + aggregation -------------------------------------------------

def merge_ledger(ledger: list[dict], new: list[dict], now: datetime,
                 days: int = HISTORY_DAYS) -> list[dict]:
    """Union by killmail id (existing entries win), pruned to `days`."""
    by_id = {k["id"]: k for k in new}
    by_id.update({k["id"]: k for k in ledger})
    cutoff = now - timedelta(days=days)
    return sorted((k for k in by_id.values() if parse_time(k["time"]) >= cutoff),
                  key=lambda k: k["time"], reverse=True)


# Pod kills after a gank stay in the ledger but are not counted as ganks:
# one gank is one lost ship, so the victim's capsule is not a second gank.
CAPSULES = {670, 33328}


def aggregate_ganks(kills: list[dict], since: datetime) -> dict:
    per_sys: dict[str, dict] = {}
    for k in kills:
        if k.get("ship") in CAPSULES or parse_time(k["time"]) < since:
            continue
        s = per_sys.setdefault(str(k["sys"]), {"n": 0, "isk": 0, "ships": {}})
        s["n"] += 1
        s["isk"] += k.get("isk") or 0
        name = k.get("shipName") or ""
        if name:
            s["ships"][name] = s["ships"].get(name, 0) + 1
    for s in per_sys.values():
        s["top"] = sorted(s.pop("ships").items(), key=lambda kv: -kv[1])[:3]
    return per_sys


def add_activity_day(daily: dict, activity: dict, day: str,
                     days: int = HISTORY_DAYS) -> dict:
    """Accumulate one hourly ESI sample into per-day sums [kills, pods,
    jumps, samples]; keep the most recent `days` days."""
    bucket = daily.setdefault(day, {})
    for sid, (kills, pods, _npc, jumps) in activity["systems"].items():
        rec = bucket.setdefault(sid, [0, 0, 0, 0])
        rec[0] += kills
        rec[1] += pods
        rec[2] += jumps
        rec[3] += 1
    for old in sorted(daily)[:-days]:
        del daily[old]
    return daily


def activity_averages(daily: dict) -> dict:
    """Average per-sample (per hour) ship kills and jumps across days."""
    totals: dict[str, list[int]] = {}
    for bucket in daily.values():
        for sid, (kills, _pods, jumps, n) in bucket.items():
            t = totals.setdefault(sid, [0, 0, 0])
            t[0] += kills
            t[1] += jumps
            t[2] += n
    return {sid: [round(k / n, 3), round(j / n, 1)] for sid, (k, j, n) in totals.items() if n}


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def main() -> None:
    hist_dir = None
    if "--history" in sys.argv:
        hist_dir = Path(sys.argv[sys.argv.index("--history") + 1])
        hist_dir.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    stamp = now.isoformat(timespec="seconds")
    status = {"generated": stamp}

    activity = fetch_activity(status)
    wormholes = fetch_evescout(status)
    ledger = load_json(hist_dir / "ganks_ledger.json", {"ganks": []})["ganks"] if hist_dir else []
    new = fetch_recent_ganks(status, {k["id"] for k in ledger})
    ledger = merge_ledger(ledger, new, now)
    resolve_ship_names(ledger, status)

    daily = {}
    if hist_dir:
        daily = load_json(hist_dir / "activity_daily.json", {"days": {}})["days"]
        if activity["systems"]:
            daily = add_activity_day(daily, activity, now.strftime("%Y-%m-%d"))
        (hist_dir / "ganks_ledger.json").write_text(
            json.dumps({"updated": stamp, "ganks": ledger}, separators=(",", ":")))
        (hist_dir / "activity_daily.json").write_text(
            json.dumps({"updated": stamp, "days": daily}, separators=(",", ":")))

    oldest = min((k["time"] for k in ledger), default=None)
    status["ledger"] = (f"{len(ledger)} ganks held, oldest {oldest}, "
                        f"{len(daily)} activity days")
    ganks_now = {"windowHours": NOW_HOURS,
                 "source": "zKillboard 'ganked' label + CONCORD-pairing backfill, "
                           "details from CCP ESI",
                 "systems": aggregate_ganks(ledger, now - timedelta(hours=NOW_HOURS))}
    history = {"windowDays": HISTORY_DAYS, "oldestGank": oldest,
               "activityDays": len(daily),
               "ganks": aggregate_ganks(ledger, now - timedelta(days=HISTORY_DAYS)),
               "activity": {"schema": ["avgShipKillsPerHour", "avgJumpsPerHour"],
                            "systems": activity_averages(daily)}}
    for name, doc in (("activity", activity), ("ganks", ganks_now), ("history", history),
                      ("wormholes", wormholes)):
        doc["generated"] = stamp
        (OUT / f"{name}.json").write_text(json.dumps(doc, separators=(",", ":")))
    (OUT / "status.json").write_text(json.dumps(status, indent=1))
    if hist_dir:
        (hist_dir / "status.json").write_text(json.dumps(status, indent=1))
    print(json.dumps(status, indent=1))


if __name__ == "__main__":
    main()
