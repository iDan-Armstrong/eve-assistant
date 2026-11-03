"""Backfill the gank ledger from EVE Ref's daily killmail archives.

EVE Ref (data.everef.net/killmails/) mirrors every killmail as raw ESI
JSON, one archive per day. Raw killmails carry no zKillboard labels, so
ganks are detected with tools/gank_detect.py (highsec kill + attacker
killed by CONCORD in the same system moments later).

Archive file names are discovered from EVE Ref's directory listing rather
than guessed. Each archive is streamed (never held whole in memory) and
only highsec killmails are kept. Results merge into the ledger by
killmail id, so re-running is safe.

    python tools/backfill_everef.py --days 30 --history DIR

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
from fetch_live import UA, load_json, merge_ledger  # noqa: E402
from gank_detect import detect_ganks  # noqa: E402

BASE = "https://data.everef.net/killmails"
DATA = Path(__file__).resolve().parents[1] / "web" / "data"


def highsec_ids() -> set[int]:
    fc = json.loads((DATA / "systems.geojson").read_text())
    return {f["properties"]["id"] for f in fc["features"] if f["properties"]["sec"] >= 0.5}


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
    """Yield highsec killmails from one daily archive, streamed."""
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
    days = int(sys.argv[sys.argv.index("--days") + 1]) if "--days" in sys.argv else 30
    hist = Path(sys.argv[sys.argv.index("--history") + 1])
    hist.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    keep = highsec_ids()
    listings: dict[int, list[str]] = {}
    found, report = [], []
    for back in range(1, days + 1):                  # yesterday backwards
        day = now - timedelta(days=back)
        try:
            if day.year not in listings:
                listings[day.year] = listing(day.year)
            url = archive_url(day, listings[day.year], day.year)
            if not url:
                report.append(f"{day:%Y-%m-%d}: no archive listed")
                continue
            mails = list(stream_killmails(url, keep))
            ganks = detect_ganks(mails, keep)
            for g in ganks:
                g.update({"isk": 0, "src": "everef"})
            found += ganks
            report.append(f"{day:%Y-%m-%d}: {len(mails)} highsec killmails, {len(ganks)} ganks")
        except Exception as exc:                     # noqa: BLE001 - record and go on
            report.append(f"{day:%Y-%m-%d}: error {exc}")
        print(report[-1], flush=True)

    ledger = load_json(hist / "ganks_ledger.json", {"ganks": []})["ganks"]
    merged = merge_ledger(ledger, found, now, days=max(days, 30))
    (hist / "ganks_ledger.json").write_text(json.dumps(
        {"updated": now.isoformat(timespec="seconds"), "ganks": merged},
        separators=(",", ":")))
    (hist / "backfill_status.json").write_text(json.dumps(
        {"ran": now.isoformat(timespec="seconds"), "days": days,
         "ganksFound": len(found), "ledgerSize": len(merged), "perDay": report},
        indent=1))
    print(f"backfill: {len(found)} ganks found; ledger now {len(merged)}")


if __name__ == "__main__":
    main()
