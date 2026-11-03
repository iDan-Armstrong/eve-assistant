"""Fetch live activity for the Security Risk layer (run hourly in CI).

Writes, under web/data/live/:
    activity.json  CCP ESI: ship/pod/NPC kills and jumps per system, last hour
    ganks.json     zKillboard 'ganked' killmails (CONCORD-involved suicide
                   ganks) aggregated per system over the last 24 hours, with
                   victim details resolved through ESI
    status.json    what each source returned this run

Every source is optional: a failure is recorded in status.json and the
script still exits 0, so the site always deploys with whatever succeeded.
Standard library only. Etiquette: a descriptive User-Agent (project URL,
no personal contact), gzip, ESI's X-Compatibility-Date, and zKillboard's
request spacing.
"""

from __future__ import annotations

import gzip
import json
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
GANK_WINDOW_H = 24
MAX_KILLMAILS = 200          # ESI lookups per run, newest first
ZKILL_SPACING_S = 1.1        # stay well under zKillboard's request rate


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
    """zKillboard summaries for recent ganked kills. zKill's URL scheme for
    labels has varied, so try the known forms and record which answered;
    the last resort filters a highsec listing on the 'ganked' label."""
    attempts = [("label/ganked", f"{ZKILL}/kills/label/ganked/"),
                ("ganked", f"{ZKILL}/kills/ganked/"),
                ("highsec+filter", f"{ZKILL}/kills/highsec/")]
    errors = []
    for name, url in attempts:
        try:
            rows = http(url)
            time.sleep(ZKILL_SPACING_S)
        except Exception as exc:                     # noqa: BLE001
            errors.append(f"{name}: {exc}")
            time.sleep(ZKILL_SPACING_S)
            continue
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


def fetch_ganks(status: dict) -> dict:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=GANK_WINDOW_H)
    summaries = sorted(zkill_ganked(status),
                       key=lambda r: r.get("killmail_id", 0), reverse=True)
    kills, type_ids, failed = [], set(), 0
    for row in summaries[:MAX_KILLMAILS]:
        zkb = row.get("zkb") or {}
        try:
            km = esi_get(f"/killmails/{row['killmail_id']}/{zkb['hash']}")
        except Exception:                            # noqa: BLE001
            failed += 1
            continue
        when = datetime.fromisoformat(km["killmail_time"].replace("Z", "+00:00"))
        if when < cutoff:
            break                                    # newest-first: done
        ship = km.get("victim", {}).get("ship_type_id")
        type_ids.add(ship)
        kills.append({"id": km["killmail_id"], "sys": km["solar_system_id"],
                      "time": km["killmail_time"], "ship": ship,
                      "isk": round(zkb.get("totalValue", 0))})

    names = {}
    if type_ids:
        try:
            body = json.dumps(sorted(t for t in type_ids if t)).encode()
            for rec in http(f"{ESI}/universe/names", data=body, esi=True):
                names[rec["id"]] = rec["name"]
        except Exception as exc:                     # noqa: BLE001
            status["esi_names"] = f"error: {exc}"

    per_sys: dict[str, dict] = {}
    for k in kills:
        k["shipName"] = names.get(k["ship"], "")
        s = per_sys.setdefault(str(k["sys"]), {"n": 0, "isk": 0, "ships": {}})
        s["n"] += 1
        s["isk"] += k["isk"]
        s["ships"][k["shipName"]] = s["ships"].get(k["shipName"], 0) + 1
    for s in per_sys.values():
        s["top"] = sorted(s.pop("ships").items(), key=lambda kv: -kv[1])[:3]
    status["ganks"] = (f"{len(kills)} ganks in {len(per_sys)} systems "
                       f"(last {GANK_WINDOW_H}h), {failed} ESI lookups failed")
    return {"windowHours": GANK_WINDOW_H,
            "source": "zKillboard 'ganked' label (CONCORD-involved kills), "
                      "details from CCP ESI",
            "systems": per_sys, "recent": kills[:50]}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    status = {"generated": now}
    activity = fetch_activity(status)
    ganks = fetch_ganks(status)
    for name, doc in (("activity", activity), ("ganks", ganks)):
        doc["generated"] = now
        (OUT / f"{name}.json").write_text(json.dumps(doc, separators=(",", ":")))
    (OUT / "status.json").write_text(json.dumps(status, indent=1))
    print(json.dumps(status, indent=1))


if __name__ == "__main__":
    main()
