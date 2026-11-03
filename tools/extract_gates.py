"""Extract precise stargate positions from the SDE universe YAML.

Killmails carry the victim's position in metres, in the same solar-system
frame as the SDE's stargate positions. Matching the two tells us whether a
kill happened on a gate, and which one: the basis of ambush-site detection.

    python tools/extract_gates.py /path/to/sde      # writes tools/data/stargates.json

Output: {systemId: [[destinationSystemId, x_km, y_km, z_km], ...]}
Kilometre precision is plenty against a 400 km on-grid threshold.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent / "data" / "stargates.json"
GATE = re.compile(
    r"^  (\d+):\n    destination: (\d+)\n    position:\n"
    r"    - (\S+)\n    - (\S+)\n    - (\S+)\n", re.M)


def parse_system(text: str) -> tuple[int, list[tuple[int, int, float, float, float]]]:
    sid = int(re.search(r"^solarSystemID: (\d+)", text, re.M).group(1))
    m = re.search(r"^stargates:\n((?:  .*\n|    .*\n)*)", text, re.M)
    gates = []
    if m:
        for g in GATE.finditer(m.group(1)):
            gates.append((int(g[1]), int(g[2]), *(float(v) for v in g.group(3, 4, 5))))
    return sid, gates


def main(sde: Path) -> None:
    gate_sys, raw = {}, {}
    for f in sorted((sde / "universe" / "eve").glob("*/*/*/solarsystem.yaml")):
        sid, gates = parse_system(f.read_text())
        raw[sid] = gates
        for gid, *_ in gates:
            gate_sys[gid] = sid
    out = {}
    for sid, gates in raw.items():
        rows = [[gate_sys[dest], round(x / 1e3), round(y / 1e3), round(z / 1e3)]
                for gid, dest, x, y, z in gates if dest in gate_sys]
        if rows:
            out[str(sid)] = rows
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"{sum(map(len, out.values()))} gates in {len(out)} systems -> {OUT}")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
