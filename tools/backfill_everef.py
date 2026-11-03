"""Backfill the gank ledger from EVE Ref's daily killmail archives.

EVE Ref (data.everef.net/killmails/) mirrors every killmail as raw ESI
JSON, one archive per day. Raw killmails carry no zKillboard labels, so
ganks are detected with tools/gank_detect.py (highsec kill + attacker
killed by CONCORD in the same system moments later).

Archive file names are discovered from EVE Ref's directory listing rather
than guessed. Each archive is streamed (never held whole in memory) and
known-space killmails are kept. One pass feeds two stores:

- highsec ganks merge into the gank ledger by killmail id, so re-running
  is safe;
- lowsec and nullsec PvP kills become per-day, per-system, per-gate
  aggregates in pvp_daily.json (tools/ambush.py).

    python tools/backfill_everef.py --days 30 --history DIR
    python tools/backfill_everef.py --missing --history DIR

--missing only fetches days in the 30-day window that pvp_daily.json does
not have yet, so the hourly job keeps history current at about one day of
lag (EVE Ref publishes each day's archive after it ends).

Known limit: a gank whose CONCORD response falls after midnight UTC is
split across two archives and missed; these are rare.
"""

from __future__ import annotations

import json
import re
import sys
import tarfile
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ambush import WINDOW_DAYS, aggregate_day, load_gates, prune  # noqa: E402
from fetch_live import UA, load_json, merge_ledger  # noqa: E402
from gank_detect import detect_ganks  # noqa: E402

BASE = "https://data.everef.net/killmails"
DATA = Path(__file__).resolve().parents[1] / "web" / "data"


def band_ids() -> tuple[set[int], set[int]]:
    """(highsec, lowsec+nullsec) system ids. Pochven counts as lownull."""
    fc = json.loads((DATA / "systems.geojson").read_text())
    hs, ln = set(), set()
    for f in fc["features"]:
        p = f["properties"]
        (hs if p["sec"] >= 0.5 else ln).add(p["id"])
    return hs, ln


def listing(year: int) -> list[str]:
    req = urllib.request.Request(f"{BASE}/{year}/", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        html = resp.read().decode("utf-8", "replace")
    return sorted(set(re.findall(r'href="([^"]*killmails-\d{4}-\d{2}-\d{2}[^"]*)"', html)))


def archive_url(day: datetime, names: list[str], year: int) -> str | None:
    tag = day.strftime("%Y-%m-%d")
    hit = next((n for n in names if tag in n and n.endswith((".tar.bz2", ".tar.gz", ".tgz"))), None)
    if not hit:
        return None
    return hit if hit.startswith("http") else f"{BASE}/{year}/{hit.split('/')[-1]}"


def stream_killmails(url: str, keep: set[int]):
    """Yield killmails in `keep` systems from one daily archive, streamed."""
    mode = "r|bz2" if url.endswith(".bz2") else "r|gz"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=300) as resp, \
            tarfile.open(fileobj=resp, mode=mode) as tar:
        for member in tar:
            if not member.isfile() or not member.name.endswith(".json"):
                continue
            fh = tar.extractfile(member)
            if fh is None:
                continue
            try:
                km = json.load(fh)
            except ValueError:
                continue
            if km.get("solar_system_id") in keep:
                yield km


def main() -> None:
    missing = "--missing" in sys.argv
    days = int(sys.argv[sys.argv.index("--days") + 1]) if "--days" in sys.argv else WINDOW_DAYS
    hist = Path(sys.argv[sys.argv.index("--history") + 1])
    hist.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    hs, ln = band_ids()
    gates = load_gates()
    pvp_daily = load_json(hist / "pvp_daily.json", {"days": {}})["days"]
    listings: dict[int, list[str]] = {}
    found, report = [], []
    for back in range(1, days + 1):                  # yesterday backwards
        day = now - timedelta(days=back)
        tag = f"{day:%Y-%m-%d}"
        if missing and tag in pvp_daily:
            continue
        try:
            if day.year not in listings:
                listings[day.year] = listing(day.year)
            url = archive_url(day, listings[day.year], day.year)
            if not url:
                report.append(f"{tag}: no archive listed")
                continue
            hs_mails, ln_mails = [], []
            for km in stream_killmails(url, hs | ln):
                (hs_mails if km["solar_system_id"] in hs else ln_mails).append(km)
            ganks = detect_ganks(hs_mails, hs)
            for g in ganks:
                g.update({"isk": 0, "src": "everef"})
            found += ganks
            pvp_daily[tag] = aggregate_day(ln_mails, ln, gates)
            report.append(f"{tag}: {len(hs_mails)} highsec killmails, {len(ganks)} ganks; "
                          f"{len(ln_mails)} low/null killmails")
        except Exception as exc:                     # noqa: BLE001 - record and go on
            report.append(f"{tag}: error {exc}")
        print(report[-1], flush=True)

    ledger = load_json(hist / "ganks_ledger.json", {"ganks": []})["ganks"]
    merged = merge_ledger(ledger, found, now, days=max(days, 30))
    (hist / "ganks_ledger.json").write_text(json.dumps(
        {"updated": now.isoformat(timespec="seconds"), "ganks": merged},
        separators=(",", ":")))
    if pvp_daily:
        pvp_daily = prune(pvp_daily, max(pvp_daily))
    (hist / "pvp_daily.json").write_text(json.dumps(
        {"updated": now.isoformat(timespec="seconds"), "days": pvp_daily},
        separators=(",", ":")))
    if report or not missing:
        (hist / "backfill_status.json").write_text(json.dumps(
            {"ran": now.isoformat(timespec="seconds"), "days": days, "missingOnly": missing,
             "ganksFound": len(found), "ledgerSize": len(merged),
             "pvpDays": sorted(pvp_daily), "perDay": report},
            indent=1))
    print(f"backfill: {len(found)} ganks found; ledger now {len(merged)}; "
          f"pvp history covers {len(pvp_daily)} days")


if __name__ == "__main__":
    main()
