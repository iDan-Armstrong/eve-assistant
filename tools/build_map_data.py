"""Build the universe basemap dataset from the EVE Static Data Export.

Reads the SDE ``universe/eve`` tree (one YAML file per region, constellation
and solar system) and emits the compact, GIS-native dataset the map app
loads:

    web/data/systems.geojson   Point per solar system (coords in light years)
    web/data/jumps.geojson     LineString per stargate connection
    web/data/regions.json      region metadata + label anchors
    web/data/stations.json     every NPC station, keyed to its system
    web/data/celestials/<regionId>.json
                               per-region celestial hierarchy: each
                               system's star, planets and moons, fetched
                               lazily when a system in that region is
                               selected (feature-service style access)

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
AU_M = 1.495978707e11


def au3(pos) -> list[float]:
    """System-local meters -> AU, for the 3D system view. 5 decimals keeps
    moon orbits distinct (~15,000 km resolution)."""
    return [round(v / AU_M, 5) for v in pos]

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


# Gate types that mark a link as something other than ordinary travel.
JOVIAN_GATES = {77918, 77921, 78264, 78265, 78266}   # the Zarzakh hub spokes
TRIGLAVIAN_GATES = {56317}                            # Pochven conduits
SMUGGLER_GATES = {12292}                              # smuggler routes


def special_class(type_a: int | None, type_b: int | None) -> str:
    """Non-empty when either endpoint gate is a special type."""
    pair = {type_a, type_b}
    if pair & JOVIAN_GATES:
        return "jovian"
    if pair & TRIGLAVIAN_GATES:
        return "triglavian"
    if pair & SMUGGLER_GATES:
        return "smuggler"
    return ""


def classify_jump(a: dict, b: dict) -> str:
    """Dotlan-style jump classes: regional > constellation > local."""
    if a["region"] != b["region"]:
        return "regional"
    if a["constellation"] != b["constellation"]:
        return "constellation"
    return "local"


def collect_edges(gate_owner: dict, gate_dest: dict) -> dict[tuple[int, int], set[str]]:
    """Unique system pairs with the travel directions that actually exist.

    Key is the sorted pair (lo, hi); the value holds "ab" when a gate goes
    lo->hi and "ba" when one goes hi->lo. A healthy gate pair has both; a
    single direction marks a one-way link, which the map draws with arrow
    markers instead of a plain line."""
    dirs: dict[tuple[int, int], set[str]] = {}
    for gate_id, dest_gate in gate_dest.items():
        a = gate_owner.get(gate_id)
        b = gate_owner.get(dest_gate)
        if a is None or b is None or a == b:
            continue
        key = (min(a, b), max(a, b))
        dirs.setdefault(key, set()).add("ab" if a == key[0] else "ba")
    return dirs


def dedupe_edges(gate_owner: dict, gate_dest: dict) -> list[tuple[int, int]]:
    """gate->system plus gate->destination-gate becomes unique system pairs."""
    return sorted(collect_edges(gate_owner, gate_dest))


def load_names(root: Path) -> dict[int, str]:
    """itemID -> display name from bsd/invNames.yaml, when available."""
    path = root.parent.parent / "bsd" / "invNames.yaml"
    if not path.is_file():
        print("  (no bsd/invNames.yaml — using folder names)")
        return {}
    rows = yaml.load(path.read_text(), Loader)
    return {r["itemID"]: r["itemName"] for r in rows}


def load_operation_services(root: Path) -> dict[int, list[str]]:
    """operationID -> sorted English service names, from
    fsd/stationOperations.yaml (services per operation) joined to
    fsd/stationServices.yaml (service names)."""
    fsd = root.parent.parent / "fsd"
    ops_path, svc_path = fsd / "stationOperations.yaml", fsd / "stationServices.yaml"
    if not (ops_path.is_file() and svc_path.is_file()):
        print("  (no station operations/services tables — skipping services)")
        return {}
    svc_names = {sid: s.get("serviceNameID", {}).get("en", "")
                 for sid, s in yaml.load(svc_path.read_text(), Loader).items()}
    return {op_id: sorted(filter(None, (svc_names.get(s) for s in
                                        op.get("services", []) or [])))
            for op_id, op in yaml.load(ops_path.read_text(), Loader).items()}


# Symbology classes, most-distinctive-first: a med bay outranks a factory
# outranks a market; everything else is a basic station.
def classify_services(services: list[str]) -> str:
    s = set(services)
    if "Cloning" in s:
        return "cloning"
    if s & {"Factory", "Laboratory", "Laboratories"}:
        return "industry"
    if "Market" in s:
        return "market"
    return "basic"


def load_stations(root: Path, names: dict[int, str],
                  types: dict[int, str]) -> list[dict]:
    """bsd/staStations.yaml -> one row per NPC station, systemId as the
    foreign key, with the profile attributes: operating corporation,
    station type, reprocessing efficiency, docking and office terms."""
    path = root.parent.parent / "bsd" / "staStations.yaml"
    if not path.is_file():
        print("  (no bsd/staStations.yaml — skipping stations)")
        return []
    rows = yaml.load(path.read_text(), Loader)
    op_services = load_operation_services(root)
    out = []
    for r in rows:
        svc = op_services.get(r.get("operationID"), [])
        out.append(
            {"id": r["stationID"], "name": r["stationName"],
             "systemId": r["solarSystemID"],
             "pos": au3((r.get("x", 0), r.get("y", 0), r.get("z", 0))),
             "corp": names.get(r.get("corporationID"), ""),
             "type": types.get(r.get("stationTypeID"), ""),
             "svc": svc, "svcClass": classify_services(svc),
             "reproc": r.get("reprocessingEfficiency", 0),
             "maxDock": r.get("maxShipVolumeDockable", 0),
             "rent": r.get("officeRentalCost", 0)})
    return sorted(out, key=lambda s: s["name"])


CELESTIAL_GROUPS = (6, 7, 8, 9, 10, 15)  # sun, planet, moon, belt, gate, station


def load_type_names(root: Path) -> dict[int, str]:
    """Stream fsd/types.yaml (140 MB) for celestial-ish type names
    (stars, planets, moons, belts, stargates, stations) without a full
    YAML parse."""
    path = root.parent.parent / "fsd" / "types.yaml"
    if not path.is_file():
        print("  (no fsd/types.yaml — celestial type names unavailable)")
        return {}
    names: dict[int, str] = {}
    type_id, group, in_name = None, None, False
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            if line[0].isdigit():
                type_id, group, in_name = int(line.split(":", 1)[0]), None, False
            elif line.startswith("  groupID:"):
                group = int(line.split(":", 1)[1])
            elif line.startswith("  "):
                if not line.startswith("    "):
                    in_name = line.startswith("  name:")
                elif (in_name and line.startswith("    en:")
                        and group in CELESTIAL_GROUPS):
                    names[type_id] = line.split(":", 1)[1].strip().strip("'\"")
    return names


# Per-body physics, stored compactly; the viewer formats units.
STATS_SCHEMA = ["tempK", "gravity", "orbitAU", "orbitDays", "radiusKm",
                "density", "escapeVel", "eccentricity", "locked"]
SECONDS_PER_DAY = 86400.0
SECONDS_PER_YEAR = 3.1557e7


def stats_row(node: dict) -> list:
    """[tempK, gravity m/s2, orbit AU, orbit days, radius km, density
    kg/m3, escape m/s, eccentricity, locked] from a body's statistics."""
    s = node.get("statistics") or {}
    radius_m = node.get("radius") or s.get("radius") or 0
    return [round(s.get("temperature", 0), 1),
            round(s.get("surfaceGravity", 0), 4),
            round(s.get("orbitRadius", 0) / AU_M, 6),
            round(s.get("orbitPeriod", 0) / SECONDS_PER_DAY, 2),
            round(radius_m / 1000),
            round(s.get("density", 0), 1),
            round(s.get("escapeVelocity", 0), 1),
            round(s.get("eccentricity", 0), 5),
            1 if s.get("locked") else 0]


def star_row(doc: dict, names: dict[int, str], types: dict[int, str]) -> dict | None:
    star = doc.get("star")
    if not star:
        return None
    stats = star.get("statistics", {})
    return {
        "id": star.get("id"),
        "name": names.get(star.get("id"), ""),
        "type": types.get(star.get("typeID"), ""),
        "tempK": round(stats.get("temperature", 0)),
        "radiusKm": round((star.get("radius") or stats.get("radius", 0)) / 1000),
        "luminosity": round(stats.get("luminosity", 0), 4),
        "spectral": stats.get("spectralClass", ""),
        "ageYr": round(stats.get("age", 0) / SECONDS_PER_YEAR),
    }


def trailing_number(name: str) -> int:
    """'… - Asteroid Belt 12' -> 12, for natural ordering."""
    tail = name.rsplit(" ", 1)[-1]
    return int(tail) if tail.isdigit() else 0


def planet_rows(doc: dict, names: dict[int, str], types: dict[int, str]) -> list[dict]:
    rows = []
    for pid, p in (doc.get("planets") or {}).items():
        if not isinstance(p, dict):
            continue
        rows.append({
            "id": pid,
            "name": names.get(pid, ""),
            "idx": p.get("celestialIndex", 0),
            "type": types.get(p.get("typeID"), ""),
            "radiusKm": round(p.get("radius", 0) / 1000),
            "pos": au3(p.get("position", (0, 0, 0))),
            "st": stats_row(p),
            "belts": sorted(({"id": bid, "name": names.get(bid, ""),
                              "pos": au3(b.get("position", (0, 0, 0))),
                              "st": stats_row(b)}
                             for bid, b in (p.get("asteroidBelts", {}) or {}).items()),
                            key=lambda b: trailing_number(b["name"])),
            "moons": sorted(({"id": mid, "name": names.get(mid, ""),
                              "pos": au3(m.get("position", (0, 0, 0))),
                              "st": stats_row(m)}
                             for mid, m in (p.get("moons", {}) or {}).items()),
                            key=lambda m: trailing_number(m["name"])),
        })
    rows.sort(key=lambda r: r["idx"])
    return rows


def load_universe(root: Path, names: dict[int, str], types: dict[int, str]):
    """Walk universe/eve/<Region>/<Constellation>/<System>/solarsystem.yaml."""
    systems: dict[int, dict] = {}
    regions: dict[int, dict] = {}
    celestials: dict[int, dict] = {}  # region id -> {system id -> hierarchy}
    gate_owner: dict[int, int] = {}   # stargate id -> owning system id
    gate_dest: dict[int, int] = {}    # stargate id -> destination gate id
    gate_types: dict[int, int] = {}   # stargate id -> gate type id

    region_dirs = sorted(p for p in root.iterdir() if p.is_dir())
    for n, region_dir in enumerate(region_dirs, 1):
        rmeta = yaml.load((region_dir / "region.yaml").read_text(), Loader)
        rid = rmeta["regionID"]
        region_name = names.get(rid, region_dir.name)
        regions[rid] = {
            "id": rid,
            "name": region_name,
            # faction IDs are items too, so invNames is the source of truth
            # (a hardcoded lookup here once mislabeled Pochven — never again)
            "faction": names.get(rmeta.get("factionID"), ""),
            "center": [to_ly(rmeta["center"][0]), to_ly(rmeta["center"][2])],
            "systems": 0,
        }
        celestials[rid] = {}
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
                    gate_types[gid] = g.get("typeID")
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
                celestials[rid][sid] = {
                    "star": star_row(doc, names, types),
                    "planets": planet_rows(doc, names, types),
                    "gates": [{"id": gid, "name": names.get(gid, ""),
                               "type": types.get(g.get("typeID"), ""),
                               "pos": au3(g.get("position", (0, 0, 0)))}
                              for gid, g in gates.items()],
                }

    return systems, regions, celestials, gate_owner, gate_dest, gate_types


def build(root: Path, out_dir: Path) -> dict:
    t0 = time.time()
    names = load_names(root)
    types = load_type_names(root)
    systems, regions, celestials, gate_owner, gate_dest, gate_types = (
        load_universe(root, names, types))
    edge_dirs = collect_edges(gate_owner, gate_dest)
    edges = sorted(edge_dirs)

    # resolve each gate's destination system name for its profile
    for sys_map in celestials.values():
        for cel in sys_map.values():
            for g in cel["gates"]:
                dest_sys = gate_owner.get(gate_dest.get(g["id"]))
                if dest_sys in systems:
                    g["to"] = systems[dest_sys]["name"]

    # gate-level integrity (direction exists only here, so record it in meta)
    dangling = sum(1 for d in gate_dest.values() if d not in gate_owner)
    non_mutual = sum(1 for g, d in gate_dest.items()
                     if d in gate_dest and gate_dest[d] != g)
    edge_special: dict[tuple[int, int], str] = {}
    for gid, dest in gate_dest.items():
        a, b = gate_owner.get(gid), gate_owner.get(dest)
        if a is None or b is None:
            continue
        cls = special_class(gate_types.get(gid), gate_types.get(dest))
        if cls:
            edge_special[(min(a, b), max(a, b))] = cls
    stations = [s for s in load_stations(root, names, types)
                if s["systemId"] in systems]
    n_planets = sum(len(c["planets"]) for r in celestials.values() for c in r.values())
    n_moons = sum(len(p["moons"]) for r in celestials.values()
                  for c in r.values() for p in c["planets"])
    n_belts = sum(len(p["belts"]) for r in celestials.values()
                  for c in r.values() for p in c["planets"])

    sys_features = [{
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [s["x"], s["z"]]},
        "properties": {k: v for k, v in s.items() if k not in ("x", "z")},
    } for s in systems.values()]

    jump_features = []
    for a_id, b_id in edges:
        dirs = edge_dirs[(a_id, b_id)]
        if dirs == {"ba"}:          # geometry always runs travel-direction
            a_id, b_id = b_id, a_id
        a, b = systems[a_id], systems[b_id]
        props = {"from": a_id, "to": b_id,
                 "fromName": a["name"], "toName": b["name"],
                 "class": edge_special.get((min(a_id, b_id), max(a_id, b_id)))
                          or classify_jump(a, b)}
        if len(dirs) == 1:
            props["oneway"] = True
        jump_features.append({
            "type": "Feature",
            "geometry": {"type": "LineString",
                         "coordinates": [[a["x"], a["z"]], [b["x"], b["z"]]]},
            "properties": props,
        })

    out_dir.mkdir(parents=True, exist_ok=True)
    meta = {"built": time.strftime("%Y-%m-%d"),
            "systems": len(sys_features), "jumps": len(jump_features),
            "regions": len(regions), "stations": len(stations),
            "planets": n_planets, "moons": n_moons, "belts": n_belts,
            "gates": len(gate_owner), "danglingGates": dangling,
            "nonMutualGates": non_mutual, "statsSchema": STATS_SCHEMA,
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
    cel_dir = out_dir / "celestials"
    cel_dir.mkdir(exist_ok=True)
    for rid, sys_map in celestials.items():
        (cel_dir / f"{rid}.json").write_text(json.dumps(
            {"regionId": rid, "systems": sys_map}, separators=(",", ":")))

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
