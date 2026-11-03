"""Overlay current geography onto the built basemap (hybrid refresh).

The basemap in web/data/ is built by build_map_data.py from CCP's full
Static Data Export. When only a newer *trimmed* export is at hand, this
overlay refreshes everything that export carries and keeps the rest:

    from the current export (HISA's eve-hk-sde.db, MIT, github.com/Crytopox/HISA)
        systems and regions (adds new ones), security status and class,
        stargate links (adds new ones), stars, planets of new systems,
        hub/border flags
    from HISA's solarSystemsStaticData.db
        ice field counts, Jove Observatory flags, belt counts
    carried forward unchanged (absent from the trimmed export)
        moons, asteroid belts, stations and their services, gate types,
        planet physics, sovereignty power/workforce

Every write is keyed by ID and replaces values outright, so running the
overlay twice gives the same result. A change report goes to
docs/data-refresh.md.

    python tools/overlay_current.py <hisa-data-dir> [<sde-invNames.yaml>]

The optional invNames file names factions for new regions.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_map_data import (PI_RESOURCES, au3, classify_jump,  # noqa: E402
                            planet_kind, sec_round, to_ly, typical_ores)

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "web" / "data"
KSPACE_MAX_REGION = 11000000          # wormhole regions start at 11000000
SECONDS_PER_YEAR = 3.1557e7
# what the full-SDE basemap was built from (npm mirror, last published 2024-06-18)
CARRIED_FROM = "CCP SDE, June 2024 release (npm eve-online-sde 126.6.18)"


def ro(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def load_current(hisa_dir: Path):
    """Read the trimmed current export into plain dicts (k-space only)."""
    db = ro(hisa_dir / "eve-hk-sde.db")
    types = dict(db.execute("SELECT typeID, typeName FROM invTypes"))
    regions = {r[0]: {"name": r[1], "x": r[2], "z": r[3], "factionID": r[4]}
               for r in db.execute("SELECT regionID, regionName, x, z, factionID "
                                   "FROM mapRegions WHERE regionID < ?",
                                   (KSPACE_MAX_REGION,))}
    consts = dict(db.execute("SELECT constellationID, constellationName "
                             "FROM mapConstellations"))
    systems = {}
    for (sid, rid, cid, name, sec, sclass, x, y, z, hub, border,
         star_id) in db.execute(
            "SELECT solarSystemID, regionID, constellationID, solarSystemName, "
            "security, securityClass, x, y, z, hub, border, starID "
            "FROM mapSolarSystems WHERE regionID < ?", (KSPACE_MAX_REGION,)):
        systems[sid] = {"region_id": rid, "constellation": consts.get(cid, ""),
                        "name": name, "sec": sec, "sec_class": sclass or "",
                        "x": x, "y": y, "z": z, "hub": bool(hub),
                        "border": bool(border), "star_id": star_id}
    jumps = {tuple(sorted(r)) for r in db.execute(
        "SELECT fromSolarSystemID, toSolarSystemID FROM mapSolarSystemJumps")}
    jumps = {e for e in jumps if e[0] in systems and e[1] in systems}

    planets = defaultdict(list)
    stars = {}
    for (item, type_id, group, sid, x, y, z, radius, name,
         cidx) in db.execute(
            "SELECT itemID, typeID, groupID, solarSystemID, x, y, z, radius, "
            "itemName, celestialIndex FROM mapDenormalize WHERE groupID IN (6, 7)"):
        if sid not in systems:
            continue
        if group == 6:
            stars[sid] = {"id": item, "type": types.get(type_id, ""),
                          "name": name, "radius": radius}
        else:
            planets[sid].append({"id": item, "name": name, "idx": cidx or 0,
                                 "type": types.get(type_id, ""),
                                 "radiusKm": round((radius or 0) / 1000),
                                 "pos": au3((x, y, z))})
    stats = {r[0]: r[1:] for r in db.execute(
        "SELECT celestialID, temperature, spectralClass, luminosity, age, radius "
        "FROM mapCelestialStatistics")}

    extra = ro(hisa_dir / "solarSystemsStaticData.db")
    flags = {sid: {"jove": bool(j), "ice": ice or 0, "belts": belts or 0}
             for sid, j, ice, belts in extra.execute(
                 "SELECT solarSystemID, hasJoveObservatory, iceFieldCount, "
                 "asteroidBeltCount FROM SolarSystems")}
    return regions, systems, jumps, planets, stars, stats, flags


def star_record(star: dict | None, stat: tuple | None) -> dict | None:
    if not star:
        return None
    temp, spectral, lum, age, radius = stat or (0, "", 0, 0, 0)
    return {"id": star["id"], "name": star["name"], "type": star["type"],
            "tempK": round(temp or 0), "radiusKm": round((radius or star["radius"] or 0) / 1000),
            "luminosity": round(lum or 0, 4), "spectral": spectral or "",
            "ageYr": round((age or 0) / SECONDS_PER_YEAR)}


def faction_names(invnames: Path | None) -> dict[int, str]:
    if not invnames or not invnames.is_file():
        return {}
    import yaml
    loader = getattr(yaml, "CSafeLoader", yaml.SafeLoader)
    return {r["itemID"]: r["itemName"] for r in yaml.load(invnames.read_text(), loader)
            if 500000 <= r["itemID"] < 501000}


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    hisa_dir = Path(sys.argv[1])
    factions = faction_names(Path(sys.argv[2]) if len(sys.argv) > 2 else None)
    regions_c, systems_c, jumps_c, planets_c, stars_c, stats_c, flags = \
        load_current(hisa_dir)

    sys_doc = json.loads((DATA / "systems.geojson").read_text())
    jump_doc = json.loads((DATA / "jumps.geojson").read_text())
    reg_doc = json.loads((DATA / "regions.json").read_text())
    feats = {f["properties"]["id"]: f for f in sys_doc["features"]}
    regions = {r["id"]: r for r in reg_doc["regions"]}
    report = defaultdict(list)

    # -- regions: add new ones --------------------------------------------
    for rid, r in regions_c.items():
        if rid not in regions and any(s["region_id"] == rid for s in systems_c.values()):
            regions[rid] = {"id": rid, "name": r["name"],
                            "faction": factions.get(r["factionID"], ""),
                            "center": [to_ly(r["x"]), to_ly(r["z"])], "systems": 0}
            report["regions added"].append(r["name"])

    # -- systems: update shared fields, add new systems -------------------
    for sid, s in systems_c.items():
        region = regions.get(s["region_id"])
        if region is None:
            continue
        sec = sec_round(s["sec"])
        if sid in feats:
            p = feats[sid]["properties"]
            if abs(p["secTrue"] - s["sec"]) > 5e-4:
                report["security changed"].append(
                    f"{p['name']}: {p['secTrue']} → {round(s['sec'], 4)}")
            p.update({"sec": sec, "secTrue": round(s["sec"], 4),
                      "secClass": s["sec_class"], "hub": s["hub"],
                      "border": s["border"]})
        else:
            planets = planets_c.get(sid, [])
            feats[sid] = {
                "type": "Feature",
                "geometry": {"type": "Point",
                             "coordinates": [to_ly(s["x"]), to_ly(s["z"])]},
                "properties": {
                    "id": sid, "name": s["name"], "region": region["name"],
                    "regionId": s["region_id"], "constellation": s["constellation"],
                    "sec": sec, "secTrue": round(s["sec"], 4),
                    "secClass": s["sec_class"], "y": to_ly(s["y"]),
                    "planets": len(planets), "moons": 0,
                    "belts": flags.get(sid, {}).get("belts", 0),
                    "stations": 0, "gates": 0, "hub": s["hub"],
                    "border": s["border"], "partial": True}}
            report["systems added"].append(f"{s['name']} ({region['name']})")
        p = feats[sid]["properties"]
        fl = flags.get(sid, {})
        p["ice"] = fl.get("ice", 0)
        p["jove"] = fl.get("jove", False)
        if p.get("belts"):
            p["ores"] = typical_ores(p["sec"], p["secTrue"], p["secClass"],
                                     region["faction"])

    # -- jumps: add new links ---------------------------------------------
    have = {tuple(sorted((j["properties"]["from"], j["properties"]["to"])))
            for j in jump_doc["features"]}
    for a, b in sorted(jumps_c - have):
        pa, pb = feats[a]["properties"], feats[b]["properties"]
        jump_doc["features"].append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": [
                feats[a]["geometry"]["coordinates"], feats[b]["geometry"]["coordinates"]]},
            "properties": {"from": a, "to": b, "fromName": pa["name"],
                           "toName": pb["name"], "class": classify_jump(pa, pb)}})
        report["stargate links added"].append(f"{pa['name']} ↔ {pb['name']}")
    degree = Counter()
    for j in jump_doc["features"]:
        degree[j["properties"]["from"]] += 1
        degree[j["properties"]["to"]] += 1
    for sid, f in feats.items():
        if f["properties"].get("partial"):
            f["properties"]["gates"] = degree[sid]

    # -- celestial shards for new systems (star + planets) ----------------
    shards: dict[int, dict] = {}
    for sid, f in feats.items():
        p = f["properties"]
        if not p.get("partial"):
            continue
        rid = p["regionId"]
        if rid not in shards:
            path = DATA / "celestials" / f"{rid}.json"
            shards[rid] = (json.loads(path.read_text()) if path.is_file()
                           else {"regionId": rid, "systems": {}})
        planets = sorted(planets_c.get(sid, []), key=lambda r: r["idx"])
        for pl in planets:
            pl.update({"st": None, "pi": PI_RESOURCES.get(planet_kind(pl["type"]), []),
                       "power": 0, "workforce": 0, "belts": [], "moons": []})
        shards[rid]["systems"][str(sid)] = {
            "star": star_record(stars_c.get(sid), stats_c.get(stars_c.get(sid, {}).get("id"))),
            "planets": planets, "gates": [], "partial": True}
    for rid, shard in shards.items():
        (DATA / "celestials" / f"{rid}.json").write_text(
            json.dumps(shard, separators=(",", ":")))

    # -- counts + meta -----------------------------------------------------
    for r in regions.values():
        r["systems"] = sum(1 for f in feats.values() if f["properties"]["regionId"] == r["id"])
    stamp = time.strftime("%Y-%m-%d")
    overlay_meta = {"overlay": "HISA trimmed export (github.com/Crytopox/HISA, MIT)",
                    "overlaid": stamp,
                    "carriedFrom": CARRIED_FROM}
    for doc in (sys_doc, jump_doc, reg_doc):
        meta = doc.setdefault("meta", {})
        meta.update(overlay_meta)
        meta["systems"] = len(feats)
        meta["jumps"] = len(jump_doc["features"])
        meta["regions"] = len(regions)
    sys_doc["features"] = sorted(feats.values(), key=lambda f: f["properties"]["id"])
    reg_doc["regions"] = sorted(regions.values(), key=lambda r: r["name"])
    (DATA / "systems.geojson").write_text(json.dumps(sys_doc, separators=(",", ":")))
    (DATA / "jumps.geojson").write_text(json.dumps(jump_doc, separators=(",", ":")))
    (DATA / "regions.json").write_text(json.dumps(reg_doc, separators=(",", ":")))

    ice = sum(1 for f in feats.values() if f["properties"].get("ice"))
    jove = sum(1 for f in feats.values() if f["properties"].get("jove"))
    lines = ["# Data refresh report", "",
             f"*{stamp}: HISA trimmed export overlaid on the CCP SDE "
             f"({overlay_meta['carriedFrom']}) basemap by tools/overlay_current.py*", "",
             f"- k-space systems: **{len(feats):,}**; stargate links: "
             f"**{len(jump_doc['features']):,}**; regions: **{len(regions)}**",
             f"- systems with ice fields: **{ice}**; with a Jove Observatory: **{jove}**",
             "- carried forward from the full SDE: moons, belts, stations, gate "
             "types, planet physics, sovereignty power/workforce. New systems "
             "show star and planets only (marked partial).", ""]
    for key in ("regions added", "systems added", "stargate links added",
                "security changed"):
        items = report.get(key, [])
        lines.append(f"## {key.capitalize()} ({len(items)})\n")
        lines += [f"- {x}" for x in items] or ["- none"]
        lines.append("")
    (REPO / "docs" / "data-refresh.md").write_text("\n".join(lines))
    print("\n".join(lines[:8]))
    print({k: len(v) for k, v in report.items()})


if __name__ == "__main__":
    main()
