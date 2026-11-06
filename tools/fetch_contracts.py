"""Blueprint offers beyond NPC stations, for the blueprint finder.

Adds two lists to web/data/live/bpo_index.json (written first by
fetch_market.py with the NPC-station sellers and market averages):

    "st": {blueprintId: [[structureId, systemId, price, units], ...]}
          cheapest sell orders in player structures, from the structure
          market job's shards (one opted-in pilot's access; each viewer's
          own docking access is checked in the browser)
    "ct": {blueprintId: [[contractId, locationId, systemId, price, me, te], ...]}
          public item-exchange contracts that sell exactly one blueprint
          original and nothing else, and ask for nothing in return

Contracts: every k-space region's public contract list is read each run
(about a thousand per page). What a contract holds needs one more call per
contract, so each contract's contents are read once and remembered in the
history folder (contract_items.json); only new contracts are read, at most
MAX_NEW a run, newest first, so the first runs fill the backlog over a few
hours. Expired contracts drop out of the memory when they leave the list.

Haul planner, from the same scan (web/data/live/):

    courier.json  public courier contracts: [contractId, startLocation, startSystem,
                  endLocation, endSystem, reward, collateral, volume m3, days to
                  complete, expires (ISO)]
    deals.json    item-exchange contracts worth more at a trade hub's buy orders than
                  their price: [contractId, location, system, price, hub value, hub
                  station, volume m3, item kinds, [[typeId, qty], ...top 3 by value],
                  units no hub buys, expires]

Contents are remembered as [[typeId, qty, isCopy, me, te], ...] (0 when the
contract asks for items back or is too big to judge), so every use above
comes from one read per contract.

    python tools/fetch_contracts.py --history ledger
"""

from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_live import ESI, OUT, http  # noqa: E402

DATA = Path(__file__).resolve().parents[1] / "web" / "data"
KEEP = 10
MAX_NEW = 10000
MAX_ITEMS = 50
HUBS = [60003760, 60008494, 60011866, 60004588, 60005686]   # Jita 4-4, Amarr, Dodixie, Rens, Hek
DEAL_TAX = 0.075 * (1 - 0.11 * 4)                            # sales tax at Accounting 4
DEAL_MIN_PROFIT = 1_000_000
DEAL_MIN_MARGIN = 0.05
DEAL_KEEP = 800
WORKERS = 16
MAX_ERRORS = 60          # CCP blocks clients that rack up ~100 errors a minute


def get(path: str, meta: dict | None = None):
    return http(f"{ESI}{path}", esi=True, meta=meta)


def region_contracts(region_id: int) -> list[dict]:
    meta: dict = {}
    first = get(f"/contracts/public/{region_id}", meta)
    rows = list(first or [])
    for page in range(2, meta.get("pages", 1) + 1):
        try:
            rows += get(f"/contracts/public/{region_id}?page={page}") or []
        except Exception:                            # noqa: BLE001 - a lost page drops its contracts
            pass
    return rows


def contents(items: list[dict]):
    """What a contract hands over: [[typeId, qty, isCopy, me, te], ...], or 0 when
    it asks for items back, holds nothing, or is too big to judge."""
    if not items or len(items) > MAX_ITEMS or any(not it.get("is_included", True) for it in items):
        return 0
    return [[it["type_id"], it.get("quantity", 1), 1 if it.get("is_blueprint_copy") else 0,
             it.get("material_efficiency", 0), it.get("time_efficiency", 0)] for it in items]


def single_bpo(rec, blueprint_ids: set[int]):
    """[typeId, me, te] when the contents are exactly one blueprint original; else 0."""
    if not rec or len(rec) != 1:
        return 0
    tid, qty, copy, me, te = rec[0]
    if copy or tid not in blueprint_ids or qty != 1:
        return 0
    return [tid, me, te]


def hub_value(rec, books: dict):
    """Best single hub to dump the contents into its buy orders: (hub, gross ISK,
    units no buyer there takes). Blueprint copies count as unsold."""
    best = (None, 0.0, 0)
    for hub, book in books.items():
        gross, unsold = 0.0, 0
        for tid, qty, copy, _me, _te in rec:
            buy, bq = book.get(tid, (None, 0))
            take = 0 if copy or not buy else min(qty, bq)
            gross += take * (buy or 0)
            unsold += qty - take
        if gross > best[1]:
            best = (hub, gross, unsold)
    return best


def deals(contracts: list[dict], seen: dict, systems: dict, books: dict) -> list:
    out = []
    for c in contracts:
        rec = seen.get(str(c["contract_id"]))
        if not rec:
            continue
        hub, gross, unsold = hub_value(rec, books)
        profit = gross * (1 - DEAL_TAX) - c["price"]
        if hub is None or profit < DEAL_MIN_PROFIT or profit < DEAL_MIN_MARGIN * c["price"]:
            continue
        book = books[hub]
        top = sorted(((tid, qty) for tid, qty, copy, *_ in rec if not copy),
                     key=lambda x: -x[1] * ((book.get(x[0]) or (0, 0))[0] or 0))[:3]
        loc = c.get("start_location_id") or 0
        out.append([c["contract_id"], loc, systems.get(loc, 0), c["price"], round(gross, 2), hub,
                    c.get("volume", 0), len(rec), [list(t) for t in top], unsold, c.get("date_expired", "")])
    out.sort(key=lambda r: -(r[4] * (1 - DEAL_TAX) - r[3]))
    return out[:DEAL_KEEP]


def couriers(contracts: list[dict], systems: dict) -> list:
    out = []
    for c in contracts:
        if c.get("type") != "courier" or not c.get("reward"):
            continue
        a, b = c.get("start_location_id") or 0, c.get("end_location_id") or 0
        out.append([c["contract_id"], a, systems.get(a, 0), b, systems.get(b, 0), c["reward"],
                    c.get("collateral", 0), c.get("volume", 0), c.get("days_to_complete", 0), c.get("date_expired", "")])
    return out


def hub_books(stations_dir: Path) -> dict:
    """{hub: {typeId: (best buy, units wanted)}} from the hourly station files."""
    books = {}
    for hub in HUBS:
        f = stations_dir / f"{hub}.json"
        if f.exists():
            books[hub] = {r[0]: (r[3], r[4]) for r in json.loads(f.read_text())["items"] if r[3]}
    return books


def contract_offers(contracts: list[dict], seen: dict, systems: dict) -> dict:
    """Per blueprint, the KEEP cheapest contracts: [contractId, locationId, systemId, price, me, te]."""
    out: dict[int, list] = {}
    for c in contracts:
        hit = seen.get(str(c["contract_id"]))
        if not hit:
            continue
        tid, me, te = hit
        loc = c.get("start_location_id") or 0
        out.setdefault(tid, []).append([c["contract_id"], loc, systems.get(loc, 0), c["price"], me, te])
    return {str(t): sorted(rows, key=lambda r: r[3])[:KEEP] for t, rows in out.items()}


def structure_offers(shard_dir: Path, structures: dict, blueprint_ids: set[int]) -> dict:
    """Per blueprint, the KEEP cheapest structure sell orders: [structureId, systemId, price, units]."""
    out = {}
    for f in sorted(shard_dir.glob("*.json")) if shard_dir.exists() else []:
        for tid, rec in json.loads(f.read_text()).items():
            if int(tid) not in blueprint_ids:
                continue
            rows = [[sid, (structures.get(str(sid)) or [None, 0])[1], price, qty]
                    for price, qty, sid in rec.get("s", []) if qty > 0]
            if rows:
                out[str(tid)] = sorted(rows, key=lambda r: r[2])[:KEEP]
    return out


def main() -> None:
    hist = Path(sys.argv[sys.argv.index("--history") + 1]) if "--history" in sys.argv else None
    now = datetime.now(timezone.utc)
    blueprint_ids = {int(k) for k in json.loads((DATA / "blueprints.json").read_text())["b"]}
    regions = [r["id"] for r in json.loads((DATA / "regions.json").read_text())["regions"]
               if r.get("systems") and r["id"] < 11000000]
    systems = {s["id"]: s["systemId"] for s in json.loads((DATA / "stations.json").read_text())["stations"]}
    live_structs = OUT / "structures.json"
    structures = json.loads(live_structs.read_text()) if live_structs.exists() else {}
    for sid, (_name, sys_id) in structures.items():
        systems[int(sid)] = sys_id

    cache = hist / "contract_items.json" if hist else None
    seen = json.loads(cache.read_text()) if cache and cache.exists() else {}
    old_cache = hist / "contract_bpo.json" if hist else None
    if old_cache and old_cache.exists():
        # earlier format kept only single-blueprint results: those carry over,
        # everything else is read again for its full contents
        for k, v in json.loads(old_cache.read_text()).items():
            if v and k not in seen:
                seen[k] = [[v[0], 1, 0, v[1], v[2]]]
        old_cache.unlink()

    contracts, courier_rows, failed = [], [], []
    with ThreadPoolExecutor(8) as pool:
        for rid, res in zip(regions, pool.map(lambda r: _safe(region_contracts, r), regions)):
            if isinstance(res, Exception):
                failed.append(rid)
                continue
            live = [c for c in res if _ts(c.get("date_expired")) > now]
            contracts += [c for c in live if c.get("type") == "item_exchange" and c.get("price", 0) > 0]
            courier_rows += [c for c in live if c.get("type") == "courier"]

    listed = {str(c["contract_id"]) for c in contracts}
    seen = {k: v for k, v in seen.items() if k in listed}            # expired ones leave
    todo = sorted((c for c in contracts if str(c["contract_id"]) not in seen),
                  key=lambda c: c.get("date_issued", ""), reverse=True)[:MAX_NEW]
    errors = 0

    def read(c):
        nonlocal errors
        if errors >= MAX_ERRORS:
            return c["contract_id"], None
        try:
            meta: dict = {}
            items = get(f"/contracts/public/items/{c['contract_id']}", meta) or []
            if meta.get("pages", 1) > 1:
                return c["contract_id"], 0
            return c["contract_id"], contents(items)
        except Exception:                            # noqa: BLE001
            errors += 1
            return c["contract_id"], None

    with ThreadPoolExecutor(WORKERS) as pool:
        for cid, val in pool.map(read, todo):
            if val is not None:
                seen[str(cid)] = val
    if cache:
        cache.write_text(json.dumps(seen, separators=(",", ":")))

    idx_path = OUT / "bpo_index.json"
    idx = json.loads(idx_path.read_text()) if idx_path.exists() else {"sell": {}, "avg": {}}
    bpo_seen = {k: single_bpo(v, blueprint_ids) for k, v in seen.items()}
    idx["ct"] = contract_offers(contracts, bpo_seen, systems)
    idx["st"] = structure_offers(OUT / "structure_orders", structures, blueprint_ids)
    idx["contractsAt"] = now.isoformat(timespec="seconds")
    idx_path.write_text(json.dumps(idx, separators=(",", ":")))
    stamp = now.isoformat(timespec="seconds")
    cour = couriers(courier_rows, systems)
    (OUT / "courier.json").write_text(json.dumps({"generated": stamp, "rows": cour}, separators=(",", ":")))
    books = hub_books(OUT / "stations")
    deal_rows = deals(contracts, seen, systems, books)
    backlog = sum(1 for c in contracts if str(c["contract_id"]) not in seen)
    (OUT / "deals.json").write_text(json.dumps({"generated": stamp, "tax": DEAL_TAX, "hubs": list(books),
                                                "known": len(seen), "backlog": backlog, "rows": deal_rows},
                                               separators=(",", ":")))
    print(json.dumps({"couriers": len(cour), "deals": len(deal_rows), "hubs": len(books),
                      "contracts": len(contracts), "known": len(seen), "readNow": len(todo), "errors": errors,
                      "backlog": backlog,
                      "bpoContracts": sum(len(v) for v in idx["ct"].values()),
                      "bpoStructures": len(idx["st"]), "failedRegions": failed}))


def _safe(fn, *a):
    try:
        return fn(*a)
    except Exception as exc:                         # noqa: BLE001
        return exc


def _ts(s: str | None) -> datetime:
    try:
        return datetime.fromisoformat((s or "").replace("Z", "+00:00"))
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)


if __name__ == "__main__":
    main()
