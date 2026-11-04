"""Player-structure markets (citadels, trade hubs, Keepstars).

CCP's region market feed covers NPC stations only. Orders inside
player-built structures are served per structure, to a signed-in
character with docking access, and a structure can only be downloaded
whole. So this job signs in as one opted-in pilot, walks CCP's public
list of structures that run a market, and downloads every one that pilot
may see.

Login: the pilot's EVE SSO refresh token comes from the
EVE_MARKET_REFRESH_TOKEN secret the first time. If CCP hands back a new
refresh token, it is kept on the live-data branch encrypted with the
MARKET_TOKEN_KEY secret (AES-256 via openssl), so the job keeps working
without anyone touching the secrets again. The token is read-only for
markets and structures, and the access token is never written anywhere.

Outputs (web/data/live/):
  structures.json                {id: [name, systemId]} for structures with orders
  structure_orders/<n>.json      per item, the 25 best sell and 25 best buy orders
                                 across structures; item ids are sharded n = typeId % 64
and per-system totals merged into market.json under "structures".

    python tools/fetch_structure_markets.py --history DIR
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_live import ESI, ESI_COMPAT, OUT, UA  # noqa: E402
from fetch_market import aggregate  # noqa: E402

CLIENT_ID = json.loads((Path(__file__).resolve().parents[1] / "web" / "data" / "sso.json").read_text())["clientId"]
TOKEN_URL = "https://login.eveonline.com/v2/oauth/token"
SHARDS = 64
KEEP = 25
WORKERS = 6
BUDGET_S = 11 * 60          # stop starting new structures after this long


def crypt(data: bytes, key: str, decrypt: bool) -> bytes:
    args = ["openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-salt", "-pass", "env:MARKET_TOKEN_KEY"]
    if decrypt:
        args.append("-d")
    return subprocess.run(args, input=data, capture_output=True, check=True,
                          env={**os.environ, "MARKET_TOKEN_KEY": key}).stdout


def refresh(token: str) -> dict:
    body = urllib.parse.urlencode({"grant_type": "refresh_token", "refresh_token": token,
                                   "client_id": CLIENT_ID}).encode()
    req = urllib.request.Request(TOKEN_URL, data=body, headers={
        "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def esi(path: str, access: str | None = None, meta: dict | None = None):
    headers = {"User-Agent": UA, "X-Compatibility-Date": ESI_COMPAT, "Accept": "application/json"}
    if access:
        headers["Authorization"] = f"Bearer {access}"
    req = urllib.request.Request(f"{ESI}{path}", headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        if meta is not None:
            meta["pages"] = int(resp.headers.get("X-Pages") or 1)
        return json.loads(resp.read())


def structure_orders(sid: int, access: str) -> list[dict]:
    meta: dict = {}
    out = list(esi(f"/markets/structures/{sid}", access, meta))
    for page in range(2, meta.get("pages", 1) + 1):
        out += esi(f"/markets/structures/{sid}?page={page}", access)
    return out


def best_per_type(orders: list[dict]) -> dict[int, dict]:
    """{typeId: {"s": [[price, qty, structureId], ...], "b": [...]}} best KEEP each side"""
    by: dict[int, dict] = {}
    for o in orders:
        side = "b" if o["is_buy_order"] else "s"
        by.setdefault(o["type_id"], {"s": [], "b": []})[side].append(
            [o["price"], o["volume_remain"], o["location_id"]])
    for rec in by.values():
        rec["s"] = sorted(rec["s"], key=lambda r: r[0])[:KEEP]
        rec["b"] = sorted(rec["b"], key=lambda r: -r[0])[:KEEP]
    return by


def main() -> None:
    hist = Path(sys.argv[sys.argv.index("--history") + 1])
    key = os.environ.get("MARKET_TOKEN_KEY", "")
    stored = hist / "market_token.enc"
    token = ""
    if stored.exists() and key:
        try:
            token = crypt(stored.read_bytes(), key, True).decode()
        except subprocess.CalledProcessError:
            token = ""
    token = token or os.environ.get("EVE_MARKET_REFRESH_TOKEN", "")
    if not token or not key:
        print("structure markets: secrets not set, skipping")
        return
    tok = refresh(token)
    access = tok["access_token"]
    if tok.get("refresh_token") and tok["refresh_token"] != token:
        stored.write_bytes(crypt(tok["refresh_token"].encode(), key, False))

    started = time.time()
    ids = esi("/universe/structures?filter=market")
    known = json.loads((hist / "structures.json").read_text()) if (hist / "structures.json").exists() else {}
    seen: dict[str, list] = {}
    all_orders: list[dict] = []
    denied = 0

    def one(sid: int):
        if time.time() - started > BUDGET_S:
            return sid, None, "skipped"
        try:
            orders = structure_orders(sid, access)
        except Exception as exc:                       # noqa: BLE001 - 403 = no docking access
            return sid, None, str(exc)
        info = known.get(str(sid))
        if not info:
            try:
                s = esi(f"/universe/structures/{sid}", access)
                info = [s["name"], s["solar_system_id"]]
            except Exception:                         # noqa: BLE001
                info = None
        return sid, (orders, info), None

    with ThreadPoolExecutor(WORKERS) as pool:
        for sid, got, err in pool.map(one, ids):
            if not got:
                denied += err != "skipped"
                continue
            orders, info = got
            if not info or not orders:
                continue
            seen[str(sid)] = info
            for o in orders:
                o["system_id"] = info[1]
            all_orders += orders

    known.update(seen)
    (hist / "structures.json").write_text(json.dumps(known, separators=(",", ":")))
    (OUT / "structures.json").write_text(json.dumps(seen, separators=(",", ":")))
    shards: dict[int, dict] = {}
    for tid, rec in best_per_type(all_orders).items():
        shards.setdefault(tid % SHARDS, {})[str(tid)] = rec
    sdir = OUT / "structure_orders"
    sdir.mkdir(parents=True, exist_ok=True)
    for n in range(SHARDS):
        (sdir / f"{n}.json").write_text(json.dumps(shards.get(n, {}), separators=(",", ":")))

    mpath = OUT / "market.json"
    if mpath.exists():
        doc = json.loads(mpath.read_text())
        doc["structures"] = aggregate(all_orders)
        doc["structureStatus"] = {"listed": len(ids), "read": len(seen), "noAccess": denied,
                                  "orders": len(all_orders), "seconds": round(time.time() - started)}
        mpath.write_text(json.dumps(doc, separators=(",", ":")))
    print(json.dumps({"listed": len(ids), "read": len(seen), "noAccess": denied,
                      "orders": len(all_orders), "seconds": round(time.time() - started)}))


if __name__ == "__main__":
    main()
