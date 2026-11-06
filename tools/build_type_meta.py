"""Item facts for the Atlas market search filters.

Reads CCP's Static Data Export (JSON Lines) and writes web/data/type_meta.json:

    {"t":     {typeId: [slot, categoryId, metaGroupId, rigSize, volume m3]},
     "cats":  {categoryId: name},
     "metas": {metaGroupId: name}}

for every published type that is sold on the market. slot is "H", "M", "L", "R"
(rig) or "S" (subsystem) for fittable modules and "" otherwise, taken from the
type's dogma effects (hiPower, medPower, loPower, rigSlot, subSystem), resolved by
effect NAME rather than hard-coded id. rigSize is 1-4 (small to capital) for rigs,
else 0. volume is the type's packaged volume where the SDE gives one, else
its volume (ships: the page asks CCP for the packaged size instead).

    python tools/build_type_meta.py <sde-jsonl-dir-or-zip> [out_file]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_jspace import Source, name, rid  # noqa: E402

SLOT_EFFECTS = {"hiPower": "H", "medPower": "M", "loPower": "L", "rigSlot": "R", "subSystem": "S"}


def main(src_path: Path, out: Path) -> None:
    src = Source(src_path)
    effect_slot = {}
    for e in src.rows("dogmaEffects"):
        n = e.get("name") or e.get("effectName") or name(e)
        if n in SLOT_EFFECTS:
            effect_slot[rid(e, "effectID")] = SLOT_EFFECTS[n]
    rig_size_attr = None
    for a in src.rows("dogmaAttributes"):
        if (a.get("name") or name(a)) == "rigSize":
            rig_size_attr = rid(a, "attributeID")
    print("slot effects:", effect_slot, "rigSize attribute:", rig_size_attr)
    for t in src.rows("types"):
        if rid(t, "typeID") == 587:          # a Rifter: which volume keys this SDE carries
            print("volume keys on a ship:", {k: v for k, v in t.items() if "olume" in k})
            break

    group_cat, cats, metas = {}, {}, {}
    for g in src.rows("groups"):
        group_cat[rid(g, "groupID")] = g.get("categoryID")
    for c in src.rows("categories"):
        cats[str(rid(c, "categoryID"))] = name(c)
    try:
        for m in src.rows("metaGroups"):
            metas[str(rid(m, "metaGroupID"))] = name(m)
    except FileNotFoundError:
        print("note: no metaGroups file")

    market = {}
    for t in src.rows("types"):
        if not t.get("published", True) or not t.get("marketGroupID"):
            continue
        tid = rid(t, "typeID")
        vol = t.get("packagedVolume") or t.get("repackagedVolume") or t.get("volume") or 0
        market[tid] = [group_cat.get(t.get("groupID")) or 0, t.get("metaGroupID") or 0, round(float(vol), 4)]

    slots, sizes = {}, {}
    for d in src.rows("typeDogma"):
        tid = rid(d, "typeID")
        if tid not in market:
            continue
        for e in d.get("dogmaEffects", []):
            s = effect_slot.get(e.get("effectID"))
            if s:
                slots[tid] = s
        for a in d.get("dogmaAttributes", []):
            if rig_size_attr is not None and a.get("attributeID") == rig_size_attr:
                sizes[tid] = int(a.get("value") or 0)

    out_t = {str(tid): [slots.get(tid, ""), cat, meta, sizes.get(tid, 0) if slots.get(tid) == "R" else 0, vol]
             for tid, (cat, meta, vol) in market.items()}
    used_cats = {str(v[1]) for v in out_t.values()}
    used_metas = {str(v[2]) for v in out_t.values()}
    doc = {"t": out_t,
           "cats": {k: v for k, v in cats.items() if k in used_cats},
           "metas": {k: v for k, v in metas.items() if k in used_metas}}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, separators=(",", ":")))
    count = {}
    for v in out_t.values():
        count[v[0] or "-"] = count.get(v[0] or "-", 0) + 1
    print(json.dumps({"types": len(out_t), "slots": count, "cats": len(doc["cats"]), "metas": doc["metas"]}))


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]) if len(sys.argv) > 2 else Path("web/data/type_meta.json"))
