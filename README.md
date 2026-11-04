# eve-assistant: New Eden Atlas

![Status](https://img.shields.io/badge/status-in%20development-orange)
![License](https://img.shields.io/badge/license-MIT-green)

> **In development.** Live preview: <https://idan-armstrong.github.io/eve-assistant/>.
> Feedback is welcome via [Issues](https://github.com/iDan-Armstrong/eve-assistant/issues).
> Geography is current (Cradle of War era, incl. the new Exordium region);
> moons, belts and stations still come from CCP's June 2024 export until the
> next full SDE refresh.

An interactive star atlas of the EVE Online universe, built the way a GIS
professional builds a map: **5,485 real solar systems** as point features with
full attribute data, **6,989 stargate connections** as a line network,
**5,150 stations** joined to their systems by foreign key, the full celestial
hierarchy (**46,172 planets, 234,651 moons, 40,928 asteroid belts**, every
star), **820 ice-field systems**, **1,028 Jove Observatories**, and
**70 regions**.
It is a spatial / attribute / relational dataset rendered with the same tooling
(Leaflet, GeoJSON) used in production web GIS.

```
python serve.py        →  http://localhost:8800
```

Select any system and **enter it in 3D**: the orrery view renders the
system's real SDE geometry: star colored by its temperature, planets,
moons, belts, stargates and stations each at their true position
(directions preserved; radial distances log-compressed and bodies
enlarged, and the view says so). Jita's four stacked gates really do sit
within a thousandth of an AU of each other; the view fans their labels
instead of pretending otherwise.

No build step, no framework, no account needed. The map is a static site:
the same `web/` folder deploys unchanged to GitHub Pages.

## Why EVE as a GIS subject

EVE Online's universe is a genuine geographic information system in disguise:
every location has coordinates (light years, projected from the game's X/Z
plane), attributes (security status, planets, moons, asteroid belts, stations,
trade-hub and border flags), and relationships (the stargate graph, the
region ‹ constellation ‹ system hierarchy). The Atlas treats it exactly like
survey data:

- **Spatial:** systems are GeoJSON `Point` features in a light-year CRS;
  stargate links are `LineString` features classified Dotlan-style
  (local / constellation / regional) by whether they cross a boundary,
  plus three special classes read from the SDE's own gate types and drawn
  distinctly: 48 smuggler routes, Pochven's 30 Triglavian conduits, and
  the 4 Jovian spokes that all converge on Zarzakh. The gate graph itself
  audits clean: 13,776 gates, none dangling, none one-way. The
  symbology is ready for the day that changes: a one-way link stores its
  geometry in travel order and renders with directional arrow markers
  (chevrons in a caution color) instead of a plain line.
- **Attribute:** click any system for its full record; security coloring
  uses the game's own 11-step ramp, so the map reads like the in-game one.
  In the 3D view every body opens a profile window with its complete
  attribute record, and stations are symbolized by service capability
  (clone bay, factory/lab, market, basic) resolved through the SDE's
  operation → services join. Planets carry their sovereignty power and
  workforce straight from the SDE's `planetResources` table. Two
  attributes are *not* in the SDE and are labeled as references: PI raw
  resources per planet type (stable game rules, from the EVE University
  wiki) and typical belt ores per system, computed from security band,
  empire quarter and the SDE's security class using EVE University's
  ore-distribution table, which its own editors flag as pre-Catalyst.
- **Relational:** the jump network is an edge list keyed by system ID;
  stations live in their own table (`stations.json`) with `systemId` as the
  foreign key; and the celestial hierarchy (region › system › star/planet ›
  moon) is sharded into one file per region, fetched lazily when a system
  in that region is first selected and joined client-side. That is the access
  pattern of a feature-service query, without a server. The info panel
  walks all of it: every neighbor one click away, stations listed per
  system (Jita shows all 15, 4-4 included), planets expandable to their
  moons and named asteroid belts with star class and temperature up top.
  Ice belts and gas clouds are deliberately absent: the static export
  confirms zero ice fields remain in the map (they became dynamic
  anomalies in 2013's Odyssey), and gas sites are scanner signatures.
  Both are runtime content, which is exactly the line between a basemap
  and a live layer. The sources cross-check:
  station counts derived from the universe tree match the station table in
  5,431 of 5,432 systems.

## Layers

Layers are built per player role. For industry there are two risk
layers (**Risk now** is the default); for PvP there are **PvP kills**,
**Ambush 30d** and **Ratting**; and **Security** shows the classic in-game
ramp. A **Route** planner sits on top of all of them.

| | **Risk now** ("should I undock?") | **Risk history** ("is this a bad neighborhood?") |
|---|---|---|
| Ganks (50%) | last 6 hours | last 30 days |
| Kills per traffic (25%) | last hour, CCP ESI | average hour over the collected days |
| Structural exposure (25%) | trade-route chokepoint × CONCORD response | same |

Ganks are zKillboard's `ganked` label (CONCORD-involved kills) hourly, plus
a one-time 30-day backfill from EVE Ref's raw killmail archives using the
same rule directly (`tools/gank_detect.py`: a highsec kill where an attacker
dies to CONCORD in the same system moments later). The system panel shows
both levels side by side with every input behind them.

The structural term is pure network analysis
(`tools/analyze_routes.py`): for the 10 trade-hub pairs (Jita, Amarr,
Dodixie, Rens, Hek) it counts the shortest highsec routes and measures the
share passing through each system, then weights by security (0.5 = slowest
CONCORD). With no kill data at all it independently ranks **Uedama** first,
with **Balle** second and **Sivala** in the top tier, the systems players
know as the classic gank pipes. (On the 2024 map Balle led; the current
stargate network shortened Jita-Amarr from 45 to 34 jumps and moved the
traffic.)

**PvP layers** read CCP's last-hour counts for every system at every
security level. **PvP kills** colors systems by ship and pod kills (quiet,
1-2, 3-9, 10+); **Ratting** by NPC kills, which is where PvE pilots are
farming and therefore where hunters look. The **Thera / Turnur holes**
overlay draws the current wormhole connections from
[EVE-Scout](https://www.eve-scout.com/) (Signal Cartel): Turnur is in
k-space, so its holes draw as lines; Thera is wormhole space, so its holes
mark their k-space end. Each system panel lists the last hour's activity
and any wormhole touching that system, with type, ship size and time left.

### Faction warfare

The **Faction war** layer reads CCP's public faction warfare feed hourly
(`tools/fetch_fw.py`): who occupies each of the warzone systems (the four
empires and the Guristas and Angel insurgencies), who owns it, and how
contested it is (victory points against the capture threshold). Warzone
systems take their occupier's color and grow with the contest. Victory
points only move when pilots run complexes or fight, so the job keeps a
snapshot per run and an orange ring marks systems whose contest moved in
the last hour: where the fighting is right now. The panel gives contest,
change over the last hour and day, and who the occupier is at war with;
the legend gives each faction's systems, pilots and kills yesterday.

### Lowsec and nullsec strategy

**Ambush 30d** finds where gate camps actually catch people. Every
killmail records the victim's position in metres within its solar system,
and CCP's static data gives every stargate's position in the same frame
(`tools/extract_gates.py`). A kill within 400 km of a gate happened on that
gate's grid, so `tools/ambush.py` counts kills per system and per gate
over 30 days of EVE Ref archives (player attackers only, capsules left
out). The layer colors systems by gate kills; the panel names the worst
gates ("8-YNBE gate: 14 kills"), the share of kills on gates, and the
average gang size, which says whether a system is a solo hunting ground or
a fleet's camp.

The **entry systems, chokepoints** overlay comes from the stargate graph
alone (`tools/analyze_null.py`):

- **Entry systems** (orange ring) are where space drops a band: lowsec
  next to highsec, nullsec next to lowsec or highsec. Traffic into
  dangerous space has to pass through them.
- **Chokepoints** (gold dashed ring) are cut vertices of the network,
  found with Tarjan's lowpoint algorithm: systems that are the only way in
  or out of a pocket of space. The panel gives the pocket size; the
  largest hold 20 to 30 systems behind a single system.
- **Transit** is betweenness centrality inside lowsec and nullsec, the
  share of shortest routes through each system: the pipes everyone flies.

**Route** plans a trip between any two systems, shortest or safer.
Safer runs Dijkstra with each system weighted by its security band,
30-day kills and gate kills per day, kills in the last hour, and highsec
ganks. The counts go on log scales, then the cost grows with the square of
that danger, so a notorious system such as Ahbazon or Uedama is worth a
long detour while quiet space costs about one jump each. Each jump lists what to
expect: kills on the gate you arrive at and the one you leave by, kills per
day and typical gang size, band changes and chokepoints. Pochven and
Zarzakh gates are left out of routing. Use **Route from here** and
**Route to here** on any system panel to set the ends.

Right-click anything in the system panel (the system name, a station, a
planet, moon or belt, or a stargate connection) to **set the destination**
or **add a waypoint** for the signed-in pilot; it goes straight to the
game client. CCP's API takes systems, stations and structures as targets,
so a planet, moon or belt sends its system.

### Market

Every NPC market order in New Eden is public in CCP's API, and each order
names its solar system, so markets join onto the map like everything
else. The hourly job (`tools/fetch_market.py`) reads every region's
orders and publishes per-system totals: the **Market** layer colors
systems from no market through local and regional markets up to the
trade hubs, and the system panel lists order counts and ISK on the
market.

**Find item** answers "where can I buy (or sell) this near me?" The
browser searches every region's orders for one item live from CCP, then
measures each seller from your pilot (or any system you type) two ways:
jumps, and the safer-route cost the route planner uses. Sort by best
price, nearest, or safest; the best five show their price on the map,
and clicking a row plans the safer route there. A **deal heat map**
option then colors every system with orders from green (best deal)
through yellow and orange to red (worst), ranked so a few absurd prices
cannot wash the colors out.

CCP's region feed covers NPC stations only. Orders inside player-built
structures (citadels, trade towers, Keepstars) are served per structure,
to a signed-in character with docking access, and each structure can
only be downloaded whole, so they cannot be searched live from a browser.
`tools/fetch_structure_markets.py` does it hourly instead, as one
opted-in pilot: it walks CCP's public list of structures that run a
market, downloads each one that pilot may dock at, and publishes the 25
best sell and buy orders per item (sharded by item ID) plus per-system
totals. Find item merges those with the live NPC results and labels them
with the structure's name. The pilot's refresh token lives in a GitHub
Actions secret; if CCP issues a new one, the job keeps it on the
live-data branch encrypted with a second secret. It is read-only and
used for markets and structure names only.

Every station in the system panel has a **market** link that lists
everything on that station's market: lowest sell price and units for
sale, highest buy price and units wanted, with a filter and sorting by
ISK on sale or wanted. CCP serves market orders only by region, so the
hourly job writes one small file per station from the regions it already
downloads. Clicking an item hands it to Find item to compare across New
Eden.

**Fit** shops for a ship fit. Pick one of the pilot's saved fittings, or
paste a fit in EFT format (the fitting window's "Copy to clipboard"). The
pilot's assets are counted first (loose items, and optionally modules
fitted to other ships), so only what is still missing is shopped for. The
hourly job publishes the 40 cheapest NPC stations for every item
(`data/live/sell_index`); stations that stock every missing item in the
needed quantity are ranked by total cost or by jumps, next to the price of
buying each item at its own cheapest station. Pick a station for the
shopping list, a Multibuy copy, and the autopilot destination.

### Haul planner

**Haul** (behind a password) plans round trips that make ISK in both
directions. Each hour `tools/haul.py` keeps every NPC station's five
cheapest sell orders and five highest buy orders for every item, pairs the
cheapest-selling stations with the highest-buying ones, and walks both
order books until the margin runs out. In the browser those pairs become
legs sized to your ship's cargo hold (read from the ship you are flying),
your budget and your sales tax (7.5%, less 11% per Accounting level):
each leg fills the hold with the items that earn the most per m3 between
the same two stations. A loop is one leg out from home and the leg that
best brings you back, ranked by ISK per jump over the whole circuit, with
a highsec-only option and a minimum stock (items with fewer units on the
market than that are skipped, since thin stock is often gone on arrival).
Picking a loop re-reads every item from CCP right then and rebuilds the
legs from what is really on the market, listing anything bought out since
the hourly snapshot. Click a loop to draw it on the map and send the
first buy stop to your autopilot, or send the whole trip: every jump of
the circuit as a waypoint, docking at each trade station.

Sending a trip opens a **haul window** (`web/hud.html`), a small pop-out
to keep beside the game. It asks CCP where the pilot is every 10 seconds
and shows the next stop in large type: buy or sell, the station, how many
jumps away, and the item list with quantities and prices. Docking at the
stop's station shows "docked here"; undocking from it marks the stop done
and moves to the next one.

Leaving a buy stop triggers a cargo check. While docked there, a large
"loaded into my ship" button waits to be tapped; undocking without it
sounds an alarm at once (red banner, beep, flashing title). The window
also reads the pilot's assets on undock: CCP refreshes that list about
once an hour, so if it predates the docking the check is repeated as soon
as CCP's next refresh is due (the response's Expires header), and any
buy-list item still sitting in that station's hangar raises the alarm.

The trades are instant (buy from sell orders, sell into buy orders), so
the only fee is sales tax. The password is a soft gate on a public site:
only its hash is in the code, and the data underneath is public.

### Hourly traffic

CCP publishes, for every system, the stargate jumps and kills of the last
clock hour. `tools/traffic.py` stores each published hour once (the
response's Last-Modified header names the hour, so a repeat run in the
same hour is ignored and a skipped hour stays a gap) and keeps a week. The
system panel charts the last 24 hours of jumps, marks hours with ship
kills, and overlays a typical day: the average for each UTC hour across
the week, which shows when a system is busy and when it is quiet.

There is no public head count. No CCP API reports how many pilots are in
a system, let alone at a belt or a Bulwark reserve, so jumps and kills
per hour are the honest proxy.

### Pilot login (EVE SSO)

**Pilot login** signs characters in with CCP's single sign-on, using the
OAuth 2 PKCE flow made for clients that cannot keep a secret. There is no
server: the browser makes a one-time verifier, trades CCP's code for
tokens, keeps them in its own storage, and sends them only to CCP. Several
characters can be signed in at once, and signing one out also revokes its
token with CCP. Scopes are read-only apart from setting autopilot
waypoints.

Once signed in, the **my pilots and assets** overlay joins each
character's data onto the map by system ID:

- current location (a dashed white ring with the pilot's name) and ship;
- assets per system, valued at CCP's average market prices (gold, sized
  by value). ESI returns assets as a flat table whose parent can be another
  item, so `web/pilot_core.js` walks each item up through containers and
  ship holds to its station, structure or system before the join;
- home and jump clones, PI colonies, active industry jobs, and 30 days of
  the mining ledger, all listed in the system panel;
- Bulwark reserves seen in the mining ledger (violet ring; see Bulwark
  reserve sightings below). The
  limited-time reserve sites ("Republic Kangite Reserve" and the like)
  are not in any CCP data feed: ESI lists only each system's permanent
  belts. A pilot's ledger is the one CCP record that shows the campaign
  ore (Kangite, Raspite, Moissanite or Polycrase X-Grade) being mined in a
  given system, and on which day. All four ores are confirmed in game.

The route planner gains **From my location** and **Send to autopilot**,
which sets the in-game route jump by jump, so the game flies the safer
route rather than its own.

### Bulwark reserve sightings

The limited-time reserve sites are in no CCP data feed, but a pilot's
mining ledger records the reserve ore by system and day, and its daily
total grows while they mine. That makes it sensitive: a map of reserves
being mined right now is a target list for gankers. So sightings are
shared **within a corporation only**, and only with consent.

Right after signing in, a pilot is asked once, with neither answer
preselected, whether to share sightings with their corporation (CCP's
developer license forbids tracking player activity without express
consent). If they agree, their browser sends its login token to a small
relay (`worker/`, a Cloudflare Worker deployed from this repository by
Cloudflare's Git integration). The relay checks the token's signature
against CCP's published keys, looks up the pilot's corporation from CCP's
public record, reads the pilot's ledger from CCP, keeps only the four
reserve ores, and compares with the pilot's previous read. Growth since
then marks the reserve **active** for an hour; any row marks it **seen**
on that day. Sightings are stored per corporation and returned only to a
viewer whose own verified login belongs to that corporation. The relay
stores no token, remembers each pilot only as a salted hash, and never
records a name. Corp mates see a filled violet ring where a reserve is
being mined now, and a dashed one where it was seen in the last 30 days.

### Corp mates on the map

The same relay shares locations, also within a corporation only. Each
pilot chooses separately (the sign-in prompt has two boxes, both
unticked; either can be changed in the pilot menu). A pilot who shares
location reports their system, ship and online status every 60 seconds
while the Atlas is open, and corp mates' maps refresh every 60 seconds
(and at once when the tab comes back into view); corp mates see a
dashed green ring with their name, and the system panel lists who is
there and in what ship. Positions live in a Cloudflare Durable Object,
one per corporation: a single always-current copy, unlike KV storage,
which can serve values up to a minute old and allows few writes a day.
Records older than 10 minutes are dropped, and a pilot is removed at once
when they stop sharing.

The **Corp** button (shown once a pilot is signed in) lists the corp mates
sharing right now, with portrait, system, ship, whether they are online
in game, and when they last reported; clicking one flies the map there.
Its **Corp view** option fades every system where the corporation has
nothing going on and tucks the other overlays away, leaving corp mates,
your own pilots and assets, and the corp's reserve sightings.

### J-Space Survey (wormhole chain mapper)

Wormhole space has no stargates, no local chat until someone speaks, and
connections that open and close every day, so no public feed can map it.
[J-Space Survey](https://idan-armstrong.github.io/eve-assistant/survey/) is a
companion page for mapping it while you fly, built for a second screen, and
it feeds the Atlas. While it is in development the page asks testers for a
password (a soft gate: only a hash of it is in the code). It needs Chrome or
Edge.

**How it collects data.** CCP does not allow tools that read the game
client's memory or send it input, so the survey uses three allowed channels:

- **Survey Link**, a small PowerShell helper for Windows
  (`web/survey/link/`, double-click `Start-SurveyLink.bat`, nothing to
  install). It watches the clipboard and passes on only copies shaped like the
  probe scanner, the directional scanner or a wormhole's Show Info; anything
  else on the clipboard never leaves it. It also reads the Local chat log EVE
  writes in `Documents\EVE\logs\Chatlogs`, so a jump reaches the survey about
  a second after it happens. It serves only `http://localhost:47321`, answers
  only the survey page's origin, keeps copies in memory for ten minutes and
  writes nothing.
- **CCP's location API** every 10 seconds for signed-in pilots, as a backup
  and for pilots without the helper.
- **Paste anywhere** on the page (Ctrl+V outside a text box) when the helper
  is not running.

Every copy goes through one router (`classifyPaste`): probe scans update the
system's signatures and flag new ones, directional scans are summarized
(ships by type and class, structures, holes) and kept as history, and Show
Info sets a hole's age, mass and size.

**Surveyor view (second screen).**

- Current system, large: class, effect, statics and the time since your last
  probe scan.
- **Way home:** a minimum-life countdown to your saved home system. Show Info
  gives each hole a band read at a known time ("fresh" at least about 24
  hours, "beginning to decay" 4 to 24 hours, "end of life" under 4 hours), so
  the survey knows the time each hole is guaranteed open and the latest it can
  last. The countdown is the weakest guarantee along the path home; holes with
  no Show Info read and holes at critical mass are called out. Alarms sound at
  30 minutes, 10 minutes and zero.
- Signature checklist (unscanned, partial, scanned, and which hole each one
  is), connections with their timers, directional scan history and every
  structure ever seen in the system, and an activity feed.

**Points and badges.** Surveying earns points: 10 for a wormhole found by
flying it, 25 for the corp's first survey of a J-system, 2 per new signature,
5 for naming a hole's type, 3 for a Show Info check, 15 for the first record of
a static, 3 for a directional scan and 10 per new structure, with daily caps on
the repeatable ones. Ranks run from Cadet to Survey Master, and 17 badges
cover milestones (First Light, Cartographer I to III, Deep Diver, Full
Spectrum, Night Shift, Seven Days Out and more). With sharing on, the relay
awards points to the verified pilot only, so the corp board cannot be faked
from a browser.

**Chain view.** A tree from any root, colored by class, with line width for
hole size, color for mass state and the guaranteed life on each link. Each
system has class, effect, statics, connections, signatures, directional
scans and notes.

**Where the data lives.**

| Data | Where | Who sees it | How long |
| --- | --- | --- | --- |
| Your working copy | this browser | you | until cleared |
| Live chain (holes, signatures, notes) | Atlas relay, one Durable Object per corporation | verified corp members | expires with the holes |
| Knowledge base (statics, structures, directional scan history, first visits) | same Durable Object, one record per system | verified corp members | kept; scans trimmed to the last 40 or 30 days |
| Points and badges | same Durable Object | corp board | kept |

Nothing is shared until a pilot ticks "share map with corp" (an unticked
consent box). Merging, expiry, parsing, life bounds and scoring live in
`web/survey/chain_core.mjs` and `web/survey/survey_core.mjs`, shared by the
page and the relay and covered by `node --test`.

**On the Atlas:** the **J-Space** button opens the survey, and the "J-Space
Survey chain" overlay rings known-space systems with a hole into wormhole
space and draws links between two known-space systems.

Reference data comes from the SDE: `tools/build_jspace.py` writes 2,604
wormhole systems with class and effect, every wormhole type, and the ship,
structure, starbase, deployable, drone and fighter types that appear on
directional scan, refreshed by the manual "J-space reference data" workflow;
`tools/build_kspace_index.py` writes a 0.4 MB known-space name and gate index.

### Live data

Live inputs refresh hourly: a scheduled GitHub Action runs
`tools/fetch_live.py` (stdlib only, polite User-Agent, zKillboard request
spacing, ESI compatibility date) and redeploys. The same run fetches any
day of EVE Ref archives the history is missing, so the 30-day kill
history trails real time by about a day. History persists on the
`live-data` branch (a rolling gank ledger, daily activity sums and daily
lowsec/nullsec kill aggregates), force-pushed as a single commit so it
never grows, along with a `status.json` for every run. A source outage
never blocks a deploy; a layer with no data degrades and says so.

## Data pipeline

```
EVE Static Data Export (CCP)          tools/build_map_data.py         web/data/
universe/eve/**/solarsystem.yaml  →   parse, project X/Z → ly,    →   systems.geojson   1.8 MB
8,436 YAML files, 282 MB              dedupe gate pairs,              jumps.geojson     1.4 MB
bsd/staStations.yaml                  classify jumps,                 regions.json      6 KB
fsd/types.yaml (streamed, 142 MB)     key stations to systems,        stations.json     0.5 MB
                                      shard celestials by region      celestials/*.json 16 MB
```

Rebuild anytime: download the [SDE](https://developers.eveonline.com/docs/guides/staticdata/)
and run `python tools/build_map_data.py <sde>/universe/eve`. The builder is
pure Python + PyYAML; canonical display names come from `bsd/invNames.yaml`
("TheForge" folders become "The Forge").

`tools/audit_universe.py` then audits what was built (referential
integrity, stargate-graph topology, attribute outliers) and writes
[docs/universe-audit.md](docs/universe-audit.md). It classifies, a human
judges: the 27-system Pochven island and 217 gateless Jove systems are by
design; Zarzakh's station missing from the universe tree is a genuine SDE
inconsistency; and the audit's first run caught a mislabeled faction in
this project's own builder.

### Keeping the map current

CCP's full export is the source of record (`tools/build_map_data.py`). When
only a newer *trimmed* export is at hand, `tools/overlay_current.py` patches
the built map by system ID from [HISA](https://github.com/Crytopox/HISA)'s
current database (MIT): new systems and regions, security changes, new
stargate links, stars and planets for new systems, plus ice-field counts and
Jove Observatory flags. Everything the trimmed export lacks (moons, belts,
stations, gate types, planet physics) is carried forward, the overlay is
idempotent, and every change is listed in
[docs/data-refresh.md](docs/data-refresh.md): 1 region (Exordium), 53
systems, 101 stargate links and 60 security changes since the June 2024
export.

## Roadmap

- **Live layers (ESI):** CCP's public API serves sovereignty, faction-warfare
  fronts, kills/jumps activity and market data with CORS enabled. These are
  fetched by the browser at view time and joined onto the basemap by system ID, like any
  live feature service over a basemap. Research notes in
  [docs/esi-research.md](docs/esi-research.md).
- **Routing:** avoid lists, waypoints, and live gate-camp detection from
  the hourly kill feed.
- **Dashboards** around the map, not instead of it.

## Architecture

Same discipline as [demoforge](https://github.com/iDan-Armstrong/demoforge):
the data pipeline is pure, testable Python; the web app is one dependency-free
HTML file plus vendored Leaflet (works fully offline). See
[docs/architecture.md](docs/architecture.md).

## Acknowledgment

EVE Online and all related data are the intellectual property of
[CCP hf.](https://www.ccpgames.com) Map data is derived from CCP's Static
Data Export under the
[Developer License](https://developers.eveonline.com/license-agreement).
This project is a fan-made tool and is not affiliated with or endorsed by CCP.
Current geography, ice fields and observatories come from
[HISA](https://github.com/Crytopox/HISA) by Crytopox (MIT); see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT (code). Game data remains © CCP hf.
