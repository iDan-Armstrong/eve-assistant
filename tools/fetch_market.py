"""Market summaries from CCP's public market data.

Every NPC market order in New Eden is public, region by region, and each
order names its solar system. This job reads every region's orders, keeps
per-system totals for the Market layer, and publishes the list of traded
item names the browser's item picker searches. Item lookups ("where to buy
X") run live in the browser against one item at a time, which is small.

    python tools/fetch_market.py [--history DIR]   # market.json, market_types.json, haul.json

The same pass builds the haul planner's station-to-station trade pairs
(tools/haul.py) and their item volumes (cached in DIR between runs).

Per system: [sellOrders, buyOrders, distinctItems, sellIsk, buyIsk]
"""

from __future__ import annotations

import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import haul  # noqa: E402
from fetch_live import ESI, OUT, http  # noqa: E402

DATA = Path(__file__).resolve().parents[1] / "web" / "data"
WORKERS = 6


def get(path: str, meta: dict | None = None, tries: int = 3):
    for attempt in range(tries):
        try:
            return http(f"{ESI}{path}", esi=True, meta=meta)
        except Exception:                            # noqa: BLE001 - retry, then give up
            if attempt == tries - 1:
                raise
            time.sleep(2 * (attempt + 1))


def region_orders(region_id: int) -> list[dict]:
    meta: dict = {}
    first = get(f"/markets/{region_id}/orders?order_type=all", meta)
    pages = meta.get("pages", 1)
    out = list(first)
    for page in range(2, pages + 1):
        out.extend(get(f"/markets/{region_id}/orders?order_type=all&page={page}"))
    return out


def aggregate(orders: list[dict]) -> dict[str, list]:
    acc: dict[str, list] = {}
    types: dict[str, set] = {}
    for o in orders:
        sid = str(o["system_id"])
        rec = acc.setdefault(sid, [0, 0, 0, 0.0, 0.0])
        value = o["price"] * o["volume_remain"]
        if o["is_buy_order"]:
            rec[1] += 1
            rec[4] += value
        else:
            rec[0] += 1
            rec[3] += value
        types.setdefault(sid, set()).add(o["type_id"])
    for sid, rec in acc.items():
        rec[2] = len(types[sid])
        rec[3], rec[4] = round(rec[3]), round(rec[4])
    return acc


def type_names(type_ids: list[int]) -> list[list]:
    names = []
    for i in range(0, len(type_ids), 1000):
        chunk = type_ids[i:i + 1000]
        try:
            rows = http(f"{ESI}/universe/names", esi=True, data=json.dumps(chunk).encode())
        except Exception:                            # noqa: BLE001 - one bad id fails a batch
            rows = []
            for j in range(0, len(chunk), 100):
                try:
                    rows += http(f"{ESI}/universe/names", esi=True, data=json.dumps(chunk[j:j + 100]).encode())
                except Exception:                    # noqa: BLE001
                    pass
        names += [[r["id"], r["name"]] for r in rows if r.get("category") == "inventory_type"]
    return sorted(names, key=lambda r: r[1].lower())


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    started = time.time()
    regions = [r for r in json.loads((DATA / "regions.json").read_text())["regions"]
               if r["systems"] and r["id"] < 11000000]          # k-space only
    status = {"regions": len(regions)}
    systems: dict[str, list] = {}
    book: dict = {}
    failed = []
    with ThreadPoolExecutor(WORKERS) as pool:
        for region, result in zip(regions, pool.map(lambda r: _safe(region_orders, r["id"]), regions)):
            if isinstance(result, Exception):
                failed.append(region["name"])
                continue
            systems.update(aggregate(result))
            haul.merge(book, haul.region_book(result))
    status.update({"systemsWithMarkets": len(systems), "failedRegions": failed,
                   "seconds": round(time.time() - started)})

    try:
        prices = get("/markets/prices")
        names = type_names(sorted({p["type_id"] for p in prices}))
        (OUT / "market_types.json").write_text(json.dumps(
            {"generated": _now(), "types": names}, separators=(",", ":")))
        status["types"] = len(names)
    except Exception as exc:                         # noqa: BLE001
        status["types"] = f"error: {exc}"

    try:
        write_haul(book)
        status["haulPairs"] = "ok"
    except Exception as exc:                         # noqa: BLE001
        status["haulPairs"] = f"error: {exc}"

    (OUT / "market.json").write_text(json.dumps(
        {"generated": _now(), "schema": ["sellOrders", "buyOrders", "items", "sellIsk", "buyIsk"],
         "systems": systems, "status": status}, separators=(",", ":")))
    print(json.dumps(status, indent=1))


def write_haul(book: dict) -> None:
    hist = Path(sys.argv[sys.argv.index("--history") + 1]) if "--history" in sys.argv else None
    known = {f["properties"]["id"] for f in json.loads((DATA / "systems.geojson").read_text())["features"]}
    rows = haul.pairs(book, known)
    vol_path = hist / "type_volumes.json" if hist else None
    volumes = json.loads(vol_path.read_text()) if vol_path and vol_path.exists() else {}
    need = sorted({str(r[0]) for r in rows} - set(volumes))

    def vol(tid):
        try:
            t = get(f"/universe/types/{tid}")
            return tid, t.get("packaged_volume") or t.get("volume")
        except Exception:                            # noqa: BLE001
            return tid, None
    with ThreadPoolExecutor(WORKERS) as pool:
        for tid, v in pool.map(vol, need):
            if v is not None:
                volumes[tid] = v
    if vol_path:
        vol_path.write_text(json.dumps(volumes, separators=(",", ":")))
    rows = [r for r in rows if str(r[0]) in volumes]
    (OUT / "haul.json").write_text(json.dumps({
        "generated": _now(),
        "schema": ["typeId", "fromStation", "fromSystem", "toStation", "toSystem", "units", "cost", "gross"],
        "tax": {"base": 0.075, "perAccountingLevel": 0.11,
                "note": "instant trades: buy from sell orders, sell into buy orders; sales tax only"},
        "pairs": rows, "volumes": {str(r[0]): volumes[str(r[0])] for r in rows}},
        separators=(",", ":")))
    print(f"haul: {len(rows)} pairs, {len(need)} new item volumes")


def _safe(fn, *args):
    try:
        return fn(*args)
    except Exception as exc:                         # noqa: BLE001
        return exc


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


if __name__ == "__main__":
    main()
