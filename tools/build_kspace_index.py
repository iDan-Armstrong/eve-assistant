"""Compact known-space index for N-Space Survey.

The survey page needs two things about k-space: a system's name, security and region
(to label wormhole exits), and which systems share a stargate, special gates included
(so a jump between them is not mistaken for a wormhole). Atlas's map files hold both but
weigh about 3.4 MB, so this writes a small join of them:

    web/data/jspace/kspace.json   {"s": {id: [name, sec, region]}, "g": {id: [neighbor ids]}}

    python tools/build_kspace_index.py
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    systems = json.loads((ROOT / "web" / "data" / "systems.geojson").read_text())
    jumps = json.loads((ROOT / "web" / "data" / "jumps.geojson").read_text())
    s = {str(f["properties"]["id"]): [f["properties"]["name"], f["properties"]["sec"],
                                      f["properties"]["region"]]
         for f in systems["features"]}
    adj: dict[str, set] = {}
    for f in jumps["features"]:
        a, b = f["properties"]["from"], f["properties"]["to"]
        adj.setdefault(str(a), set()).add(b)
        adj.setdefault(str(b), set()).add(a)
    g = {k: sorted(v) for k, v in adj.items()}
    out = ROOT / "web" / "data" / "jspace"
    out.mkdir(parents=True, exist_ok=True)
    (out / "kspace.json").write_text(json.dumps({"s": s, "g": g}, separators=(",", ":")))
    print(len(s), "systems,", sum(len(v) for v in g.values()) // 2, "gate links")


if __name__ == "__main__":
    main()
