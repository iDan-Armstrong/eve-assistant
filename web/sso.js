/* EVE SSO for a static site: OAuth 2 authorization code with PKCE.

   No server and no client secret. The browser makes a one-time code
   verifier, sends its hash to CCP's login page, and trades the returned
   code (plus the verifier) for tokens. Tokens are kept in this browser's
   localStorage, sent only to CCP (login.eveonline.com and esi.evetech.net),
   and refreshed when they expire. Several characters can be signed in at
   once; "log out" forgets a character here and revokes its refresh token
   with CCP.

   Exposes window.EveSSO. The page sets EveSSO.clientId before calling
   EveSSO.init(). */
(function () {
  "use strict";
  const LOGIN = "https://login.eveonline.com";
  const ESI = "https://esi.evetech.net";
  const COMPAT = "2025-09-30";
  const WAYPOINT_GAP_MS = 1500;   /* between autopilot waypoints */
  const WAYPOINT_MAX = 25;
  const STORE = "atlas.pilots";
  const PENDING = "atlas.sso.pending";
  const SCOPES = [
    "publicData",
    "esi-location.read_location.v1",
    "esi-location.read_ship_type.v1",
    "esi-location.read_online.v1",
    "esi-assets.read_assets.v1",
    "esi-universe.read_structures.v1",
    "esi-clones.read_clones.v1",
    "esi-planets.manage_planets.v1",
    "esi-industry.read_character_jobs.v1",
    "esi-industry.read_character_mining.v1",
    "esi-ui.write_waypoint.v1",
    "esi-markets.structure_markets.v1",
  ];

  const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const randomString = n => b64url(crypto.getRandomValues(new Uint8Array(n)));
  /* CCP sends the pilot back to one registered address, the Atlas page. A page
     elsewhere on the site (J-Space Survey) sets EveSSO.redirectUri to that
     address and gets the pilot back through `returnTo` once login completes;
     both pages share this origin's localStorage, so the login is shared too. */
  const redirectUri = () => EveSSO.redirectUri || location.origin + location.pathname;

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
  }
  function save(pilots) {
    try { localStorage.setItem(STORE, JSON.stringify(pilots)); } catch { /* private mode */ }
  }
  /* the access token is a JWT; its payload names the character */
  function claims(jwt) {
    const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(part))));
  }

  async function tokenRequest(form) {
    const resp = await fetch(`${LOGIN}/v2/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...form, client_id: EveSSO.clientId }),
    });
    if (!resp.ok) throw new Error(`token request failed: ${resp.status}`);
    return resp.json();
  }
  function store(tok) {
    const c = claims(tok.access_token);
    const id = +String(c.sub).split(":").pop();
    const pilots = load();
    pilots[id] = {
      id, name: c.name,
      access: tok.access_token, refresh: tok.refresh_token,
      expires: Date.now() + (tok.expires_in || 1199) * 1000,
      scopes: [].concat(c.scp || []),
    };
    save(pilots);
    return pilots[id];
  }

  const EveSSO = {
    clientId: "",
    redirectUri: "",
    scopes: SCOPES,

    configured() { return !!EveSSO.clientId; },
    pilots() { return Object.values(load()).sort((a, b) => a.name.localeCompare(b.name)); },

    /* extra: optional scopes asked for only when a feature needs them */
    async login(extra = [], opts = {}) {
      if (!EveSSO.configured()) throw new Error("no client id configured");
      const verifier = randomString(32), state = randomString(16);
      const challenge = b64url(await crypto.subtle.digest("SHA-256",
        new TextEncoder().encode(verifier)));
      const here = location.origin + location.pathname;
      sessionStorage.setItem(PENDING, JSON.stringify({ verifier, state, back: location.hash,
                                                       collector: !!opts.collector,
                                                       returnTo: here !== redirectUri() ? location.href : null }));
      location.assign(`${LOGIN}/v2/oauth/authorize?` + new URLSearchParams({
        response_type: "code", redirect_uri: redirectUri(), client_id: EveSSO.clientId,
        scope: [...SCOPES, ...extra].join(" "), state,
        code_challenge: challenge, code_challenge_method: "S256",
      }));
    },

    /* call once at page load: completes a login if CCP just sent us back */
    async init() {
      const q = new URLSearchParams(location.search);
      if (!q.has("code") && !q.has("error")) return null;
      let pending = null;
      try { pending = JSON.parse(sessionStorage.getItem(PENDING)); } catch { /* none */ }
      sessionStorage.removeItem(PENDING);
      history.replaceState(null, "", redirectUri() + ((pending && pending.back) || ""));
      if (q.has("error")) throw new Error(`login cancelled: ${q.get("error")}`);
      if (!pending || q.get("state") !== pending.state) throw new Error("login state mismatch");
      const tok = await tokenRequest({ grant_type: "authorization_code",
        code: q.get("code"), code_verifier: pending.verifier });
      /* a login made only for the hourly market collector: its own token
         chain, never used by this browser, handed over once and forgotten */
      if (pending.collector) {
        const c = claims(tok.access_token);
        return { collector: true, name: c.name, refresh: tok.refresh_token,
                 scopes: [].concat(c.scp || []) };
      }
      const pilot = store(tok);
      if (pending.returnTo && new URL(pending.returnTo).origin === location.origin) {
        location.replace(pending.returnTo);
        return new Promise(() => {});              /* leaving the page */
      }
      return pilot;
    },

    async token(id) {
      const p = load()[id];
      if (!p) throw new Error("not signed in");
      if (Date.now() < p.expires - 60e3) return p.access;
      const tok = await tokenRequest({ grant_type: "refresh_token", refresh_token: p.refresh });
      return store(tok).access;
    },

    async logout(id) {
      const p = load()[id];
      const pilots = load();
      delete pilots[id];
      save(pilots);
      if (p) {
        fetch(`${LOGIN}/v2/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: p.refresh, token_type_hint: "refresh_token",
                                      client_id: EveSSO.clientId }),
        }).catch(() => {});
      }
    },

    /* authenticated ESI call; follows X-Pages for paged endpoints */
    async esi(id, path, { method = "GET", body } = {}) {
      const headers = { "Authorization": `Bearer ${await EveSSO.token(id)}`,
                        "X-Compatibility-Date": COMPAT };
      if (body) headers["Content-Type"] = "application/json";
      const get = page => fetch(`${ESI}${path}${page > 1 ? (path.includes("?") ? "&" : "?") + "page=" + page : ""}`,
        { method, headers, body: body ? JSON.stringify(body) : undefined });
      const first = await get(1);
      if (!first.ok) throw new Error(`ESI ${path}: ${first.status}`);
      if (first.status === 204) return null;
      const pages = +first.headers.get("X-Pages") || 1;
      const data = await first.json();
      if (pages === 1 || !Array.isArray(data)) return data;
      for (let pg = 2; pg <= pages; pg++) {
        const r = await get(pg);
        if (r.ok) data.push(...await r.json());
      }
      return data;
    },

    /* Set the in-game autopilot: the first destination replaces the route,
       the rest are added as waypoints. Sent one at a time with a pause in
       between, because the client rebuilds its whole route on every
       waypoint and a fast burst of them has dropped a pilot from the server.
       progress(i, n) before each; returns how many were sent. */
    async waypoints(id, destinations, progress = () => {}) {
      const list = destinations.filter((d, i) => d && d !== destinations[i - 1]);
      if (list.length > WAYPOINT_MAX) throw new Error(`too many stops (${list.length}); the most is ${WAYPOINT_MAX}`);
      for (let i = 0; i < list.length; i++) {
        if (i) await new Promise(r => setTimeout(r, WAYPOINT_GAP_MS));
        progress(i + 1, list.length);
        await EveSSO.esi(id, `/ui/autopilot/waypoint?add_to_beginning=false&clear_other_waypoints=${i === 0}` +
                             `&destination_id=${list[i]}`, { method: "POST" });
      }
      return list.length;
    },

    /* public ESI POST (names, etc.), no token */
    async esiPublic(path, body) {
      const r = await fetch(`${ESI}${path}`, { method: body ? "POST" : "GET",
        headers: { "X-Compatibility-Date": COMPAT, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined });
      if (!r.ok) throw new Error(`ESI ${path}: ${r.status}`);
      return r.json();
    },
  };
  window.EveSSO = EveSSO;
})();
