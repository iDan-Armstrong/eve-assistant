"""Faction warfare from CCP's public feed, with hourly momentum.

/fw/systems gives every warzone system's occupier, owner and contest
level (victory points against the capture threshold); /fw/stats gives
each faction's pilots, kills and victory points. Victory points only move
when pilots run complexes or fight in a system, so the job keeps one
snapshot per run (48 hours) and publishes how much each system's contest
moved in the last hour and the last day: that is where the fighting is.

    python tools/fetch_fw.py --history DIR      # writes web/data/live/fw.json
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_live import OUT, esi_get, load_json  # noqa: E402

FACTIONS = {500001: "Caldari State", 500002: "Minmatar Republic", 500003: "Amarr Empire",
            500004: "Gallente Federation", 500010: "Guristas Pirates", 500011: "Angel Cartel"}
KEEP_HOURS = 48


def snapshot(rows: list[dict]) -> dict[str, list]:
    """{systemId: [contested fraction 0..1, occupier]}"""
    return {str(r["solar_system_id"]): [round(r["victory_points"] / max(1, r["victory_points_threshold"]), 4),
                                         r["occupier_faction_id"]] for r in rows}


def momentum(history: dict, now: datetime, sid: str, hours: int):
    """Change in contest fraction over the last `hours` (None without an old enough sample)."""
    current = history.get(max(history), {}).get(sid) if history else None
    cutoff = (now - timedelta(hours=hours)).isoformat(timespec="minutes")
    older = [k for k in history if k <= cutoff]
    if not current or not older:
        return None
    then = history[max(older)].get(sid)
    if not then or then[1] != current[1]:         # changed hands: momentum not comparable
        return None
    return round(current[0] - then[0], 4)


def main() -> None:
    hist_dir = Path(sys.argv[sys.argv.index("--history") + 1]) if "--history" in sys.argv else None
    now = datetime.now(timezone.utc)
    rows = esi_get("/fw/systems")
    stats = esi_get("/fw/stats")
    wars = esi_get("/fw/wars")
    history = load_json(hist_dir / "fw_history.json", {}) if hist_dir else {}
    history[now.isoformat(timespec="minutes")] = snapshot(rows)
    for key in sorted(history)[:-KEEP_HOURS * 2]:        # up to two runs an hour
        del history[key]
    cutoff = (now - timedelta(hours=KEEP_HOURS)).isoformat(timespec="minutes")
    history = {k: v for k, v in history.items() if k >= cutoff}
    if hist_dir:
        (hist_dir / "fw_history.json").write_text(json.dumps(history, separators=(",", ":")))
    systems = {}
    for r in rows:
        sid = str(r["solar_system_id"])
        systems[sid] = {"occ": r["occupier_faction_id"], "own": r["owner_faction_id"],
                        "status": r["contested"], "vp": r["victory_points"], "max": r["victory_points_threshold"],
                        "d1": momentum(history, now, sid, 1), "d24": momentum(history, now, sid, 24)}
    out = {"generated": now.isoformat(timespec="seconds"), "factions": {str(k): v for k, v in FACTIONS.items()},
           "wars": [[w["faction_id"], w["against_id"]] for w in wars],
           "stats": {str(s["faction_id"]): {"pilots": s["pilots"], "systems": s["systems_controlled"],
                                            "killsYesterday": s["kills"]["yesterday"], "killsWeek": s["kills"]["last_week"],
                                            "vpYesterday": s["victory_points"]["yesterday"]} for s in stats},
           "samples": len(history), "systems": systems}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "fw.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"fw: {len(systems)} systems, {len(history)} snapshots")


if __name__ == "__main__":
    main()
