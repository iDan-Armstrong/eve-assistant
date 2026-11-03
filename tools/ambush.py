"""Lowsec/nullsec kill history and ambush-site detection.

Every killmail records where the victim died, in metres, in the solar
system's own frame. The SDE gives every stargate's position in the same
frame (tools/extract_gates.py). A kill within ON_GATE_KM of a stargate
happened on that gate's grid: a gate camp. Counting those per gate over
30 days shows where people actually get caught, and on which side of
which gate.

Daily aggregates are stored instead of a raw ledger (lowsec and nullsec
see far more kills than highsec ganks), keyed by UTC day:

    {day: {systemId: [kills, gateKills, attackerTotal, {destId: n}]}}

    kills          player ship losses: ships only (structures, deployables
                   and capsules are left out; pods double count)
    gateKills      of those, how many died on a gate grid
    attackerTotal  sum of player attackers, for average gang size
    destId: n      gate kills per gate, named by the system it leads to
"""

from __future__ import annotations

import json
import math
from pathlib import Path

GATES_FILE = Path(__file__).resolve().parent / "data" / "stargates.json"
SHIPS_FILE = Path(__file__).resolve().parent / "data" / "ship_types.json"   # SDE category 6
ON_GATE_KM = 400.0
CAPSULES = {670, 33328}
WINDOW_DAYS = 30


def load_gates(path: Path = GATES_FILE) -> dict[int, list[tuple[int, float, float, float]]]:
    raw = json.loads(path.read_text())
    return {int(s): [tuple(g) for g in rows] for s, rows in raw.items()}


def nearest_gate(pos: dict | None, gates: list[tuple[int, float, float, float]]):
    """Destination system of the gate the position sits on, or None."""
    if not pos or not gates:
        return None
    x, y, z = pos.get("x"), pos.get("y"), pos.get("z")
    if x is None or y is None or z is None:
        return None
    x, y, z = x / 1e3, y / 1e3, z / 1e3
    best, best_d = None, ON_GATE_KM
    for dest, gx, gy, gz in gates:
        d = math.dist((x, y, z), (gx, gy, gz))
        if d <= best_d:
            best, best_d = dest, d
    return best


def player_attackers(km: dict) -> int:
    return sum(1 for a in km.get("attackers", []) if a.get("character_id"))


def load_ships(path: Path = SHIPS_FILE) -> set[int]:
    return set(json.loads(path.read_text())) - CAPSULES


def aggregate_day(killmails, systems: set[int], gates: dict, ships: set[int] | None = None) -> dict:
    """One day's killmails -> {systemId: [kills, gateKills, attackers, {dest: n}]}."""
    ships = load_ships() if ships is None else ships
    out: dict[str, list] = {}
    for km in killmails:
        sid = km.get("solar_system_id")
        victim = km.get("victim", {})
        if sid not in systems or victim.get("ship_type_id") not in ships:
            continue
        attackers = player_attackers(km)
        if not attackers:                       # NPC kill, not PvP
            continue
        rec = out.setdefault(str(sid), [0, 0, 0, {}])
        rec[0] += 1
        rec[2] += attackers
        dest = nearest_gate(victim.get("position"), gates.get(sid, []))
        if dest is not None:
            rec[1] += 1
            rec[3][str(dest)] = rec[3].get(str(dest), 0) + 1
    return out


def prune(daily: dict, newest: str, days: int = WINDOW_DAYS) -> dict:
    keep = sorted(d for d in daily if d <= newest)[-days:]
    return {d: daily[d] for d in keep}


def summarize(daily: dict, top: int = 8) -> dict:
    """Window totals per system for the map:
    {systemId: {k, g, gang, gates: [[destId, n], ...]}}"""
    tot: dict[str, list] = {}
    for day in daily.values():
        for sid, (k, g, att, per_gate) in day.items():
            t = tot.setdefault(sid, [0, 0, 0, {}])
            t[0] += k
            t[1] += g
            t[2] += att
            for dest, n in per_gate.items():
                t[3][dest] = t[3].get(dest, 0) + n
    out = {}
    for sid, (k, g, att, per_gate) in tot.items():
        rec = {"k": k, "g": g, "gang": round(att / k, 1) if k else 0}
        hot = sorted(per_gate.items(), key=lambda kv: -kv[1])[:top]
        if hot:
            rec["gates"] = [[int(d), n] for d, n in hot]
        out[sid] = rec
    return out
