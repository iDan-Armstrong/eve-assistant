# EVE Online third-party assistant: API research

*What we have to work with, before designing anything. Researched 2026-11-02.*

## What ESI is

**ESI (EVE Stable Infrastructure, formerly the EVE Swagger Interface)** is CCP's
official, supported, RESTful JSON API for third-party apps. It replaced the old
CREST and XML APIs (shut down May 2018).

- **Base URL:** `https://esi.evetech.net/`
- **Reference + live "try it" explorer:** `https://developers.eveonline.com` (API Explorer)
- **Issues / feature requests:** the public `esi-issues` GitHub repo
- **Datasource:** Tranquility (the live server)

## Two access tiers

### Public (no login, ~76 endpoints)
Anything a tool can show *without* a player connecting their account. Great for a
portfolio piece anyone can try instantly.

- **Universe (29):** the static map + item graph: regions, constellations,
  systems, stargates, stations, plus types/groups/categories for every item.
  Systems carry real 3D coordinates, so the universe is a navigable graph.
- **Market (6):** regional orders, price history, aggregated prices.
- **Sovereignty (3)**, **Faction Warfare (6)**, **Wars (3)**, **Incursions (1)**,
  **Dogma (5)** (item attributes/effects), **Routes (1)** (system-to-system
  pathing), **Insurance (1)**, **Alliances (4)**, **Status (1)** (server up?,
  player count, version).

### Authenticated (EVE SSO / OAuth2, ~119 endpoints)
Character- and corp-specific data; needs the player to log in and consent.

- **Character (10):** skills, skill queue, location, online status, portrait…
- **Assets (6)**, **Wallet (6)**, **Industry (6)** (jobs), **Mail (9)**,
  **Contacts (9)**, **Fleets (14)**, **Market (5)** (your own orders),
  **User Interface (5)** (open windows/waypoints in the client).
- **Corporation (18):** some routes also require the right in-game corp role.

## Auth model (EVE SSO / OAuth2)

- Register an application at `developers.eveonline.com` → get a **client ID**
  (+ **secret** for web apps), set **redirect URLs** (SSO rejects any other),
  and pick the **scopes** the app may ever request.
- **Flows:**
  - *Authorization Code:* web apps with a backend that can keep the secret.
  - *PKCE:* native/desktop/SPA apps that can't store a secret (code verifier +
    S256 challenge, no secret).
- **Endpoints:** authorize `https://login.eveonline.com/v2/oauth/authorize`,
  token `https://login.eveonline.com/v2/oauth/token`, metadata/JWKS at
  `/.well-known/oauth-authorization-server`.
- **Tokens:** access token is a short-lived **JWT** (validate signature vs JWKS,
  `iss`, `aud` contains your client ID + "EVE Online", `exp`; `sub` =
  `EVE:CHARACTER:<id>`, `scp` = granted scopes). Refresh token is long-lived.
  Store it securely; it's valid until the user revokes access.

## Versioning: changed in 2025 (important)

CCP replaced path versioning (`/v1/`, `/v2/`, `/latest/`) with a date header:

- Send **`X-Compatibility-Date: YYYY-MM-DD`** (or `?compatibility_date=`) to pin
  behavior as of that date. Omitting it falls back to the oldest supported date.
- The API "day" rolls over at **11:00 UTC**. Breaking changes (new routes, newly
  required params, type changes, removals) get a new compatibility date; additive
  changes land within existing dates.

## Rate limits & etiquette

- New **floating-window token bucket**, per rate-limit group, per bucket
  (`appID:charID` for authenticated routes, source **IP** for public ones).
- **Token cost per response:** 2xx = 2, 3xx = 1, 4xx = 5 (429 excluded), 5xx = 0.
  Over budget → **429 + `Retry-After`** (seconds). Headers: `X-Ratelimit-Limit`
  (e.g. `150/15m`), `X-Ratelimit-Remaining`.
- Legacy **error limit** still applies on routes without the new limiter:
  ≤ 100 non-2xx/3xx responses per minute, then **420** across ESI.
- **Respect `Expires`/cache times.** Send a **descriptive `User-Agent` with a
  contact email**. CCP asks for this and can rate-limit anonymous traffic harder.

## Player-corporation structures (the "are corp stations in the data?" question)

The 5,154 stations in the SDE are **NPC stations only**. Player-owned
"stations" are **Upwell structures** (Astrahus/Fortizar/Keepstar citadels,
Raitaru/Azbel/Sotiyo engineering complexes, Athanor/Tatara refineries),
anchored and destroyed by players at runtime, so they are deliberately
absent from the static export. (The old player-conquerable NPC outposts
were converted to faction Fortizars in 2018; nothing conquerable remains
in the static station table.)

What the API offers for them, by access tier:

- **Public, no login:** `GET /universe/structures/` returns the IDs of
  every structure whose owner allows public access (optionally filtered
  to ones hosting a public market). IDs only (no names, no positions).
  `GET /sovereignty/structures/` (public) lists sov infrastructure.
  Killmails via zKillboard also reveal structures as they die.
- **Authenticated (any character's SSO token):**
  `GET /universe/structures/{id}` resolves a structure's name, owner,
  solar system, position and type. CCP requires a logged-in character
  because structure visibility is itself gameplay information.

For the Atlas this is a clean phase-2 layer: the basemap stays NPC-true,
and once SSO lands, public player structures join the same
system-ID-keyed join as everything else; they are fetched live, never baked in.

## Companion data sources (not ESI, but standard in the ecosystem)

- **SDE (Static Data Export):** bulk static data, including every type, blueprint,
  **industry recipe**, and the full map. Still required for industry recipes;
  CCP is gradually folding it into ESI.
- **zKillboard API** (`zkillboard.com/api`): community killmail aggregator;
  the canonical source for PvP/kill data at scale.
- **Image server:** character / corp / alliance / item renders.
- **Tooling precedent:** GESI (Google Sheets), `awesome-eve` (community tool
  list), plus mature client libraries in Python, Rust, PHP, JS, etc.

## Takeaways for our project

1. **We can build and demo entirely on public endpoints.** No account linking is
   required for a first version, which makes a portfolio piece anyone can click
   and try. SSO is a clean "phase 2" that adds depth (personal dashboards).
2. **The universe is spatial:** systems have coordinates and a stargate graph.
   A map/network visualization (trade flows, sovereignty, faction-warfare fronts,
   route risk) would play directly to a GIS background and stand out from the
   usual table-and-form EVE tools.
3. **Professional-quality signals to hit:** correct compatibility-date handling,
   polite rate-limit + cache behavior, a proper `User-Agent`, clean OAuth2/PKCE
   if/when we add SSO, and tests around the data layer. This is the same
   discipline demoforge shows.

## Sources

- [ESI overview](https://developers.eveonline.com/docs/services/esi/overview/), EVE: Developers
- [EVE SSO / OAuth2](https://developers.eveonline.com/docs/services/sso/), EVE: Developers
- [ESI rate limiting](https://developers.eveonline.com/docs/services/esi/rate-limiting/), EVE: Developers
- [EVE Swagger Interface](https://wiki.eveuniversity.org/EVE_Swagger_Interface), EVE University Wiki
- [Introducing ESI](https://www.eveonline.com/news/view/introducing-esi), EVE Online
- [ESI Delivered: The Next Chapter (2025)](https://devtrackers.gg/eveonline/p/51f84b82-esi-delivered-the-next-chapter)
- [Changing versions: /v42/ was getting out of hand](https://developers.eveonline.com/blog/changing-versions-v42-was-getting-out-of-hand), EVE: Developers
