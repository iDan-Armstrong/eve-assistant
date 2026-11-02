"""Build the universe basemap dataset from the EVE Static Data Export.

Reads the SDE ``universe/eve`` tree (one YAML file per region, constellation
and solar system) and emits the compact, GIS-native dataset the map app
loads:

    web/data/systems.geojson   Point per solar system (coords in light years)
    web/data/jumps.geojson     LineString per stargate connection
    web/data/regions.json      region metadata + label anchors
    web/data/stations.json     every NPC station, keyed to its system

Usage:
    python tools/build_map_data.py <path-to-sde>/universe/eve [out_dir]

If ``bsd/invNames.yaml`` exists two levels up from the universe tree (the
standard SDE layout), canonical display names are taken from it — folder
names drop spaces ("TheForge"), invNames carries the real "The Forge".

The SDE is CCP's bulk static data download (developers.eveonline.com →
Static Data Export). Only the ``universe/eve`` k-space tree is needed.

Projection: EVE positions are meters in a 3D frame where Y is "up"; every
2D map of New Eden (in-game star map, Dotlan) projects onto the X/Z plane.
We convert to light years and emit [x_ly, z_ly] as GeoJSON coordinates for
a CRS.Simple map; the vertical y_ly rides along as a property so a 3D view
stays possible later.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import yaml

Loader = getattr(yaml, "CSafeLoader", yaml.SafeLoader)

LIGHT_YEAR_M = 9.4607e15

# factionID -> name for region sovereignty labels (static NPC factions).
FACTIONS = {
    500001: "Caldari State", 500002: "Minmatar Republic", 500003: "Amarr Empire",
    500004: "Gallente Federation", 500005: "Jove Empire", 500007: "Ammatar Mandate",
    500008: "Khanid Kingdom", 500010: "Guristas Pirates", 500011: "Angel Cartel",
    500012: "Blood Raider Covenant", 500014: "ORE", 500016: "Sisters of EVE",
    500019: "Sansha's Nation", 500020: "Serpentis", 500023: "CONCORD",
    500024: "Mordu's Legion", 500026: "The Society", 500027: "InterBus",
    500029: "SoCT", 500110: "Deathless Circle",
}


def to_ly(meters: float) -> float:
    return round(meters / LIGHT_YEAR_M, 3)


def sec_round(security: float) -> float:
    """EVE's displayed security: round to one decimal (0.45 shows as 0.5,
    but anything below true 0.05 that is still positive shows 0.1 — the
    classic 'lowsec rounds up' rule)."""
    if 0.0 < security < 0.05:
        return 0.1
    return round(security, 1)


def count_stations(node) -> int:
    """npcStations appear nested under planets and their moons."""
    if not isinstance(node, dict):
        return 0
    total = len(node.get("npcStations", {}) or {})
    for value in node.values():
        if isinstance(value, dict):
            total += count_stations(value)
    return total


def classify_jump(a: dict, b: dict) -> str:
    """Dotlan-style jump classes: regional > constellation > local."""
    if a["region"] != b["region"]:
        return "regional"
    if a["constellation"] != b["constellation"]:
        return "constellation"
    return "local"


def dedupe_edges(gate_owner: dict, gate_dest: dict) -> list[tuple[int, int]]:
    """gate->system plus gate->destination-gate becomes unique system pairs."""
    edges = set()
    for gate_id, dest_gate in gate_dest.items():
        a = gate_owner.get(gate_id)
        b = gate_owner.get(dest_gate)
        if a is None or b is None or a == b:
            continue
        edges.add((min(a, b), max(a, b)))
    return sorted(edges)


def load_names(root: Path) -> dict[int, str]:
    """itemID -> display name from bsd/invNames.yaml, when available."""
    path = root.parent.parent / "bsd" / "invNames.yaml"
    if not path.is_file():
        print("  (no bsd/invNames.yaml — using folder names)")
        return {}
    rows = yaml.load(path.read_text(), Loader)
    return {r["itemID"]: r["itemName"] for r in rows}


def load_stations(root: Path) -> list[dict]:
    """bsd/staStations.yaml -> one row per NPC station, systemId as the
    foreign key. The station name embeds its celestial and operator
    ("Jita IV - Moon 4 - Caldari Navy Assembly Plant")."""
    path = root.parent.parent / "bsd" / "staStations.yaml"
    if not path.is_file():
        print("  (no bsd/staStations.yaml — skipping stations)")
        return []
    rows = yaml.load(path.read_text(), Loader)
    return sorted(
        ({"id": r["stationID"], "name": r["stationName"],
          "systemId": r["solarSystemID"]} for r in rows),
        key=lambda s: s["name"])


def load_universe(root: Path):
    """Walk universe/eve/<Region>/<Constellation>/<System>/solarsystem.yaml."""
    names = load_names(root)
    systems: dict[int, dict] = {}
    regions: dict[int, dict] = {}
    gate_owner: dict[int, int] = {}   # stargate id -> owning system id
    gate_dest: dict[int, int] = {}    # stargate id -> destination gate id

    region_dirs = sorted(p for p in root.iterdir() if p.is_dir())
    for n, region_dir in enumerate(region_dirs, 1):
        rmeta = yaml.load((region_dir / "region.yaml").read_text(), Loader)
        rid = rmeta["regionID"]
        region_name = names.get(rid, region_dir.name)
        regions[rid] = {
            "id": rid,
            "name": region_name,
            "faction": FACTIONS.get(rmeta.get("factionID"), ""),
            "center": [to_ly(rmeta["center"][0]), to_ly(rmeta["center"][2])],
            "systems": 0,
        }
        print(f"  [{n:3d}/{len(region_dirs)}] {region_name}", flush=True)

        for const_dir in sorted(p for p in region_dir.iterdir() if p.is_dir()):
            cmeta = yaml.load((const_dir / "constellation.yaml").read_text(), Loader)
            const_name = names.get(cmeta.get("constellationID"), const_dir.name)
            for sys_dir in sorted(p for p in const_dir.iterdir() if p.is_dir()):
                doc = yaml.load((sys_dir / "solarsystem.yaml").read_text(), Loader)
                sid = doc["solarSystemID"]
                planets = doc.get("planets") or {}
                moons = sum(len(p.get("moons", {}) or {})
                            for p in planets.values() if isinstance(p, dict))
                belts = sum(len(p.get("asteroidBelts", {}) or {})
                            for p in planets.values() if isinstance(p, dict))
                gates = doc.get("stargates") or {}
                for gid, g in gates.items():
                    gate_owner[gid] = sid
                    gate_dest[gid] = g["destination"]
                x, y, z = doc["center"]
                systems[sid] = {
                    "id": sid,
                    "name": names.get(sid, sys_dir.name),
                    "region": region_name,
                    "regionId": rid,
                    "constellation": const_name,
                    "sec": sec_round(doc["security"]),
                    "secTrue": round(doc["security"], 4),
                    "secClass": doc.get("securityClass", ""),
                    "x": to_ly(x), "y": to_ly(y), "z": to_ly(z),
                    "planets": len(planets),
                    "moons": moons,
                    "belts": belts,
                    "stations": count_stations(doc),
                    "gates": len(gates),
                    "hub": bool(doc.get("hub")),
                    "border": bool(doc.get("border")),
                }
                regions[rid]["systems"] += 1

    return systems, regions, gate_owner, gate_dest


def build(root: Path, out_dir: Path) -> dict:
    t0 = time.time()
    systems, regions, gate_owner, gate_dest = load_universe(root)
    edges = dedupe_edges(gate_owner, gate_dest)
    stations = [s for s in load_stations(root) if s["systemId"] in systems]

    sys_features = [{
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [s["x"], s["z"]]},
        "properties": {k: v for k, v in s.items() if k not in ("x", "z")},
    } for s in systems.values()]

    jump_features = []
    for a_id, b_id in edges:
        a, b = systems[a_id], systems[b_id]
        jump_features.append({
            "type": "Feature",
            "geometry": {"type": "LineString",
                         "coordinates": [[a["x"], a["z"]], [b["x"], b["z"]]]},
            "properties": {"from": a_id, "to": b_id,
                           "fromName": a["name"], "toName": b["name"],
                           "class": classify_jump(a, b)},
        })

    out_dir.mkdir(parents=True, exist_ok=True)
    meta = {"built": time.strftime("%Y-%m-%d"),
            "systems": len(sys_features), "jumps": len(jump_features),
            "regions": len(regions), "stations": len(stations),
            "units": "light years",
            "projection": "EVE X/Z plane (top-down)"}

    (out_dir / "systems.geojson").write_text(json.dumps(
        {"type": "FeatureCollection", "meta": meta, "features": sys_features},
        separators=(",", ":")))
    (out_dir / "jumps.geojson").write_text(json.dumps(
        {"type": "FeatureCollection", "meta": meta, "features": jump_features},
        separators=(",", ":")))
    (out_dir / "regions.json").write_text(json.dumps(
        {"meta": meta, "regions": sorted(regions.values(), key=lambda r: r["name"])},
        separators=(",", ":")))
    (out_dir / "stations.json").write_text(json.dumps(
        {"meta": meta, "stations": stations}, separators=(",", ":")))

    meta["seconds"] = round(time.time() - t0, 1)
    return meta


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    root = Path(sys.argv[1])
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else (
        Path(__file__).resolve().parents[1] / "web" / "data")
    if not root.is_dir():
        sys.exit(f"not a directory: {root}")
    meta = build(root, out_dir)
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
