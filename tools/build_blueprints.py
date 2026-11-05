"""Blueprints for the Atlas blueprint finder.

Reads CCP's Static Data Export (JSON Lines) and writes web/data/blueprints.json:

    {"b":      {blueprintTypeId: [name, productTypeId, productCategoryId, productGroupId]},
     "cats":   {categoryId: name},
     "groups": {groupId: [name, categoryId]}}

for every published blueprint that is sold on the market. The product is what
the blueprint manufactures (or, for reaction formulas, what the reaction
makes); its category and group drive the finder's filters (Ship > Frigate,
Module > Shield Hardener, ...). Blueprints with no product keep 0s.

    python tools/build_blueprints.py <sde-jsonl-dir-or-zip> [out_file]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_jspace import Source, name, rid  # noqa: E402

BLUEPRINT_CATEGORY = 9


def product_of(bp: dict) -> int | None:
    acts = bp.get("activities") or {}
    for act in ("manufacturing", "reaction"):
        for p in (acts.get(act) or {}).get("products") or []:
            tid = p.get("typeID") or p.get("typeId")
            if tid:
                return int(tid)
    return None


def main(src_path: Path, out: Path) -> None:
    src = Source(src_path)
    group_cat, group_name = {}, {}
    for g in src.rows("groups"):
        gid = rid(g, "groupID")
        group_cat[gid] = g.get("categoryID")
        group_name[gid] = name(g)
    cats = {rid(c, "categoryID"): name(c) for c in src.rows("categories")}

    types, bp_ids = {}, set()
    for t in src.rows("types"):
        tid = rid(t, "typeID")
        types[tid] = (name(t), t.get("groupID"))
        if (t.get("published", True) and t.get("marketGroupID")
                and group_cat.get(t.get("groupID")) == BLUEPRINT_CATEGORY):
            bp_ids.add(tid)

    products = {}
    for bp in src.rows("blueprints"):
        bid = rid(bp, "blueprintTypeID", "typeID")
        if bid in bp_ids:
            products[bid] = product_of(bp)

    out_b, used_groups = {}, set()
    for bid in sorted(bp_ids):
        prod = products.get(bid)
        pgroup = types.get(prod, ("", None))[1] if prod else None
        pcat = group_cat.get(pgroup) if pgroup else None
        out_b[str(bid)] = [types[bid][0], prod or 0, pcat or 0, pgroup or 0]
        if pgroup:
            used_groups.add(pgroup)
    doc = {"b": out_b,
           "cats": {str(c): cats.get(c, "") for c in sorted({group_cat[g] for g in used_groups})},
           "groups": {str(g): [group_name.get(g, ""), group_cat.get(g)] for g in sorted(used_groups)}}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, separators=(",", ":")))
    print(json.dumps({"blueprints": len(out_b), "withProduct": sum(1 for v in out_b.values() if v[1]),
                      "cats": len(doc["cats"]), "groups": len(doc["groups"])}))


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]) if len(sys.argv) > 2 else Path("web/data/blueprints.json"))
