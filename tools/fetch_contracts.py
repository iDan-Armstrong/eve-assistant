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
history folder (contract_bpo.json); only new contracts are read, at most
MAX_NEW a run, newest first, so the first runs fill the backlog over a few
hours. Expired contracts drop out of the memory when they leave the list.

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
MAX_NEW = 8000
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


def single_bpo(items: list[dict], blueprint_ids: set[int]):
    """[typeId, me, te] when the contract sells exactly one blueprint original
    and asks for nothing back; else 0."""
    if len(items) != 1:
        return 0
    it = items[0]
    if (not it.get("is_included", True) or it.get("is_blueprint_copy")
            or it.get("type_id") not in blueprint_ids or it.get("quantity", 1) != 1):
        return 0
    return [it["type_id"], it.get("material_efficiency", 0), it.get("time_efficiency", 0)]


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

    cache = hist / "contract_bpo.json" if hist else None
    seen = json.loads(cache.read_text()) if cache and cache.exists() else {}

    contracts, failed = [], []
    with ThreadPoolExecutor(8) as pool:
        for rid, res in zip(regions, pool.map(lambda r: _safe(region_contracts, r), regions)):
            if isinstance(res, Exception):
                failed.append(rid)
                continue
            contracts += [c for c in res if c.get("type") == "item_exchange" and c.get("price", 0) > 0
                          and _ts(c.get("date_expired")) > now]

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
            return c["contract_id"], single_bpo(items, blueprint_ids)
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
    idx["ct"] = contract_offers(contracts, seen, systems)
    idx["st"] = structure_offers(OUT / "structure_orders", structures, blueprint_ids)
    idx["contractsAt"] = now.isoformat(timespec="seconds")
    idx_path.write_text(json.dumps(idx, separators=(",", ":")))
    print(json.dumps({"contracts": len(contracts), "known": len(seen), "readNow": len(todo), "errors": errors,
                      "backlog": sum(1 for c in contracts if str(c["contract_id"]) not in seen),
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
