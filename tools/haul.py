"""Station-to-station trade pairs for the haul planner.

Instant trades only: buy from sell orders at station A (no tax on the
buyer), carry the goods, sell straight into buy orders at station B (the
seller pays sales tax, no broker fee because no order is placed). For each
item the hourly job keeps every NPC station's 5 cheapest asks and 5
highest bids, then pairs the cheapest-selling stations with the
highest-buying ones and walks both order books until the margin is gone.

Each pair records what the whole opportunity holds; the browser scales it
to the pilot's cargo hold, budget and sales tax, and chains pairs into
round trips.

    pair row: [typeId, fromStation, fromSystem, toStation, toSystem, units, cost, gross]
    net profit = gross * (1 - salesTax) - cost
"""

from __future__ import annotations

import heapq

DEPTH = 5            # book levels kept per station and side
SCAN = 12            # cheapest / dearest stations paired per item
PER_TYPE = 6         # best pairs kept per item
MIN_TAX = 0.033      # Accounting V: the best case, used only to prune
MIN_PROFIT = 50_000  # ISK at MIN_TAX, below which a pair is not worth a jump


def region_book(orders: list[dict]) -> dict[int, dict[int, dict]]:
    """{typeId: {stationId: {"sys", "a": [(price, qty)], "b": [(price, qty, minVol)]}}}"""
    raw: dict[int, dict[int, dict]] = {}
    for o in orders:
        st = raw.setdefault(o["type_id"], {}).setdefault(
            o["location_id"], {"sys": o["system_id"], "a": [], "b": []})
        if o["is_buy_order"]:
            st["b"].append((o["price"], o["volume_remain"], o.get("min_volume", 1) or 1))
        else:
            st["a"].append((o["price"], o["volume_remain"]))
    for stations in raw.values():
        for st in stations.values():
            st["a"] = heapq.nsmallest(DEPTH, st["a"])
            st["b"] = heapq.nlargest(DEPTH, st["b"])
    return raw


def merge(book: dict, part: dict) -> None:
    for tid, stations in part.items():
        book.setdefault(tid, {}).update(stations)


def walk(asks: list, bids: list, tax: float = MIN_TAX) -> tuple[int, float, float]:
    """Units, cost and gross sale value while the margin lasts (after `tax`)."""
    asks = [list(a) for a in asks]
    bids = [list(b) for b in bids]
    i = j = 0
    units, cost, gross = 0, 0.0, 0.0
    while i < len(asks) and j < len(bids):
        pa, qa = asks[i]
        pb, qb, mn = bids[j]
        if pb * (1 - tax) <= pa:
            break
        take = min(qa, qb)
        if take < mn:                       # this buyer wants more than we can supply here
            j += 1
            continue
        units += take
        cost += take * pa
        gross += take * pb
        asks[i][1] -= take
        bids[j][1] -= take
        if asks[i][1] == 0:
            i += 1
        if bids[j][1] == 0:
            j += 1
    return units, cost, gross


def pairs(book: dict, known_systems: set[int] | None = None) -> list[list]:
    out = []
    for tid, stations in book.items():
        st = [(sid, s) for sid, s in stations.items()
              if not known_systems or s["sys"] in known_systems]
        sellers = sorted((x for x in st if x[1]["a"]), key=lambda x: x[1]["a"][0][0])[:SCAN]
        buyers = sorted((x for x in st if x[1]["b"]), key=lambda x: -x[1]["b"][0][0])[:SCAN]
        if not sellers or not buyers or buyers[0][1]["b"][0][0] * (1 - MIN_TAX) <= sellers[0][1]["a"][0][0]:
            continue
        found = []
        for a_id, a in sellers:
            for b_id, b in buyers:
                if a_id == b_id:
                    continue
                units, cost, gross = walk(a["a"], b["b"])
                profit = gross * (1 - MIN_TAX) - cost
                if units and profit >= MIN_PROFIT:
                    found.append((profit, [tid, a_id, a["sys"], b_id, b["sys"], units,
                                           round(cost, 2), round(gross, 2)]))
        out += [row for _, row in heapq.nlargest(PER_TYPE, found, key=lambda x: x[0])]
    return out
