"""Build the J-space (wormhole space) reference data for J-Space Survey.

Reads CCP's Static Data Export in its JSON Lines form and writes:

    web/data/jspace/systems.json     {systemId: [name, classId, effect, region, constellation, planets, moons]}
                                      for every J-space system (ids 31000000-31999999)
    web/data/jspace/wormholes.json   {code: {to, life, mass, jump, regen}} for every wormhole type
                                      (to = target class id, life = hours, mass and jump in kg,
                                      regen = kg per day)
    web/data/jspace/classes.json     class id -> label (C1..C6, HS, LS, NS, Thera, ...)

Usage:
    python tools/build_jspace.py <sde-jsonl-dir-or-zip> [out_dir]

The SDE comes from developers.eveonline.com (static-data, latest jsonl zip). Row ids are
read from "_key" or the obvious id field, and names may be plain strings or {"en": ...}
maps, so the reader does not depend on one exact schema revision. Dogma attributes are
resolved by NAME (wormholeTargetSystemClass and friends), never by hard-coded id.
"""

from __future__ import annotations

import io
import json
import sys
import zipfile
from pathlib import Path

CLASS_LABELS = {
    1: "C1", 2: "C2", 3: "C3", 4: "C4", 5: "C5", 6: "C6",
    7: "HS", 8: "LS", 9: "NS", 10: "Jove", 11: "Jove",
    12: "Thera", 13: "C13", 14: "Drifter", 15: "Drifter", 16: "Drifter",
    17: "Drifter", 18: "Drifter", 25: "Pochven",
}
ATTRS = {
    "wormholeTargetSystemClass": "to",
    "wormholeMaxStableTime": "life",      # minutes in dogma
    "wormholeMaxStableMass": "mass",
    "wormholeMaxJumpMass": "jump",
    "wormholeMassRegeneration": "regen",
}


class Source:
    """A directory of *.jsonl files or a zip holding them (any depth)."""

    def __init__(self, path: Path):
        self.zip = zipfile.ZipFile(path) if path.suffix == ".zip" else None
        self.dir = None if self.zip else path

    def rows(self, stem: str):
        if self.zip:
            names = [n for n in self.zip.namelist() if Path(n).name == f"{stem}.jsonl"]
            if not names:
                raise FileNotFoundError(stem)
            fh = io.TextIOWrapper(self.zip.open(names[0]), encoding="utf-8")
        else:
            hits = list(self.dir.rglob(f"{stem}.jsonl"))
            if not hits:
                raise FileNotFoundError(stem)
            fh = hits[0].open(encoding="utf-8")
        with fh:
            for line in fh:
                line = line.strip()
                if line:
                    yield json.loads(line)


def rid(row: dict, *alts: str):
    for k in ("_key", *alts):
        if k in row:
            return row[k]
    return None


def name(row: dict, field: str = "name") -> str:
    v = row.get(field)
    if isinstance(v, dict):
        return v.get("en") or next(iter(v.values()), "")
    return v or ""


def effect_name(type_name: str) -> str:
    """'Wolf-Rayet Effect Beacon Class 4' -> 'Wolf-Rayet'"""
    n = type_name.split(" Effect Beacon")[0]
    return n.replace("Star", "").strip() or type_name


def main(src_path: Path, out: Path) -> None:
    src = Source(src_path)
    out.mkdir(parents=True, exist_ok=True)

    regions, constellations = {}, {}
    for r in src.rows("mapRegions"):
        regions[rid(r, "regionID")] = (name(r), r.get("wormholeClassID"))
    for c in src.rows("mapConstellations"):
        constellations[rid(c, "constellationID")] = (name(c), c.get("wormholeClassID"), c.get("regionID"))

    types, groups = {}, {}
    for g in src.rows("groups"):
        groups[rid(g, "groupID")] = name(g)
    for t in src.rows("types"):
        types[rid(t, "typeID")] = (name(t), t.get("groupID"))

    effects = {}
    try:
        for s in src.rows("mapSecondarySuns"):
            beacon = s.get("effectBeaconTypeID")
            effects[s.get("solarSystemID")] = effect_name(types.get(beacon, ("",))[0]) if beacon else ""
    except FileNotFoundError:
        print("note: no mapSecondarySuns file; effects left blank")

    planets_per, moons_per = {}, {}
    for stem, bucket in (("mapPlanets", planets_per), ("mapMoons", moons_per)):
        try:
            for row in src.rows(stem):
                sid = row.get("solarSystemID")
                if sid and 31000000 <= sid < 32000000:
                    bucket[sid] = bucket.get(sid, 0) + 1
        except FileNotFoundError:
            print(f"note: no {stem} file")

    systems = {}
    first = True
    for s in src.rows("mapSolarSystems"):
        if first:
            print("mapSolarSystems keys:", sorted(s.keys()))
            first = False
        sid = rid(s, "solarSystemID")
        if not sid or not 31000000 <= sid < 32000000:
            continue
        cname, cclass, region_id = constellations.get(s.get("constellationID"), ("", None, None))
        region_id = s.get("regionID") or region_id
        rname, rclass = regions.get(region_id, ("", None))
        wclass = s.get("wormholeClassID") or cclass or rclass or 0
        systems[str(sid)] = [name(s), wclass, effects.get(sid, ""), rname, cname,
                             planets_per.get(sid, 0), moons_per.get(sid, 0)]

    attr_ids = {}
    for a in src.rows("dogmaAttributes"):
        n = a.get("name") or name(a)
        if n in ATTRS:
            attr_ids[rid(a, "attributeID")] = ATTRS[n]
    if len(attr_ids) != len(ATTRS):
        print("warning: attributes found:", attr_ids)

    wh_group = {gid for gid, n in groups.items() if n == "Wormhole"}
    wh_types = {tid: n for tid, (n, g) in types.items() if g in wh_group}
    wormholes = {}
    for d in src.rows("typeDogma"):
        tid = rid(d, "typeID")
        if tid not in wh_types:
            continue
        rec = {}
        for a in d.get("dogmaAttributes", []):
            key = attr_ids.get(a.get("attributeID"))
            if key:
                rec[key] = a.get("value")
        code = wh_types[tid].replace("Wormhole ", "").strip()
        if not code or not rec:      # K162 (the exit side) has no target class; keep it anyway
            continue
        if "life" in rec:
            rec["life"] = round(rec["life"] / 60, 1)      # minutes -> hours
        wormholes[code] = {k: (int(v) if isinstance(v, float) and v.is_integer() else v)
                           for k, v in rec.items()}

    (out / "systems.json").write_text(json.dumps(systems, separators=(",", ":")))
    (out / "wormholes.json").write_text(json.dumps(dict(sorted(wormholes.items())), separators=(",", ":")))
    (out / "classes.json").write_text(json.dumps(CLASS_LABELS, separators=(",", ":")))
    by_class = {}
    for v in systems.values():
        by_class[v[1]] = by_class.get(v[1], 0) + 1
    print(json.dumps({"systems": len(systems), "byClass": by_class, "wormholes": len(wormholes),
                      "sample": {k: wormholes.get(k) for k in ("B274", "K162", "N110", "H296")}}))


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]) if len(sys.argv) > 2 else Path("web/data/jspace"))
