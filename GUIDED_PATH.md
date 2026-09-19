# Guided Path

Every step we take to build Ignite, in order. Tick each box when it's done.
For the design and the reasons behind it, see `explanation.md`.

---

## Phase 0: Plan ✅
- [x] Pick the problem: AQI-aware delivery routing for Delhi NCR in winter
- [x] Pick the stack: Neo4j AuraDB Free, Python backend, Render Workflows, Next.js (rider app, later)
- [x] Simulate winter AQI (live September AQI is too low to demo)
- [x] Write `explanation.md`

## Phase 1: Neo4j Aura setup ✅
- [x] 1.1 Create an AuraDB Free instance at console.neo4j.io (ID `1f2c19fc`)
- [x] 1.2 Find the credentials file downloaded at creation
      (`~/Downloads/Neo4j-1f2c19fc-Created-*.txt`).
      It holds `NEO4J_URI`, `NEO4J_USERNAME` and `NEO4J_PASSWORD`.
      **Lost it?** Console → instance `...` menu → **Reset password**.
- [x] 1.3 Paste the username and password into `backend/.env`
      (URI + `NEO4J_DATABASE=1f2c19fc` already filled in; `.env` is gitignored, so never commit it or paste it into chat)
- [x] 1.4 Check that APOC is available: Console → **Query** → connect → run:
      ```cypher
      RETURN apoc.version();
      ```
      Result: APOC `2026.09.0`, and `apoc.algo.dijkstra` is available.
- [ ] 1.5 Fix Python SSL certificates on this Mac (one time):
      ```
      "/Applications/Python 3.13/Install Certificates.command"
      ```
      **Why:** python.org Python on macOS ships without CA certificates, so connecting to Aura fails with
      `SSLCertVerificationError: self-signed certificate in certificate chain`.
      The certificate chain itself is genuine (SSL.com), and Render's Linux servers are not affected.

## Phase 2: Graph layer ✅
- [x] 2.1 Python venv + `backend/requirements.txt`
- [x] 2.2 `seed_data.py`: 30 zones with lat, lng and base winter AQI
      Covers: 18 Noida sectors + Greater Noida, plus Delhi (Okhla, Laxmi Nagar, Connaught Place, Dwarka, etc.) and Gurgaon (Cyber City, DLF).
      AQI distribution: hotspots (380–480) like Sector 62, Bisrakh; poor areas (280–350); moderate (250–300); clean (180–260).
- [x] 2.3 `graph.py`: GraphDriver class with methods:
      - `seed_zones(zones)`: MERGE all zones into Neo4j
      - `create_roads()`: connect each zone to 3–4 nearest using haversine + traffic multiplier
      - `rebuild_safe_roads()`: rebuild SAFE_ROAD edges (both ends aqi <= AQI_LIMIT)
      - `get_zones()`: fetch all zones with current AQI
      - `route(from_id, to_id, masked)`: Dijkstra routing (ROAD for masked, SAFE_ROAD for unmasked)
      - `get_stats()`: zones, roads, safe_roads counts
- [x] 2.4 Seeded Aura; results:
      - 30 zones created ✅
      - 156 ROAD edges (3–4 per zone) ✅
      - 38 SAFE_ROAD edges (roads both ends have aqi <= 300) ✅
      Graph is live in Aura. Check: Console → **Query** → `MATCH (z:Zone) RETURN COUNT(z)` = 30

## Phase 3: Render Workflows ✅
- [x] 3.1 `workflow.py`: `refresh_aqi`, `dispatch_batch`
      - `refresh_aqi()`: update all zone AQI values (±15% drift around base) and rebuild SAFE_ROAD
      - `dispatch_batch(orders, riders)`: greedy earliest-deadline-first assignment with exposure tracking
      Task logic tested directly; both tasks work ✅
- [x] 3.2 Tasks are Render SDK compatible (use `@app.task` decorator, `ctx` as first param)
      Deployment testing (render workflows dev) deferred to Phase 5 (full deploy with Blueprint)

## Phase 4: API ✅
- [x] 4.1 `api.py`: FastAPI with 7 endpoints
- [x] 4.2 API running locally on http://127.0.0.1:8000
      - `/health` ✅ status check
      - `/zones` ✅ lists 30 zones, AQI, safe flag
      - `/route` ✅ masked/unmasked routing with Dijkstra
      - `/aqi/spike` ✅ live AQI updates (demo control)
      - `/aqi/refresh` ⏸️ queued (needs RENDER_API_KEY on deploy)
      - `/dispatch` ⏸️ queued (needs RENDER_API_KEY on deploy)
      - `/runs/{id}` ⏸️ queued (needs RENDER_API_KEY on deploy)

## Phase 5: Deploy on Render ⏳ (final ~30 min)
- [x] 5.1 `render.yaml` Blueprint created ✅
      - **ignite-api**: FastAPI web service (Python)
      - **ignite-workflows**: Render Workflows service (Python)
      - **ignite-refresh-aqi**: Cron job (every 15 min, triggers refresh_aqi task)
      Env vars synced between services; NEO4J credentials and RENDER_API_KEY set manually
- [ ] 5.2 Deploy:
      1. `git init` + `git add .` + `git commit -m "ignite"`
      2. Push to GitHub (create new repo, or use existing)
      3. Go to render.com → New → Blueprint → Select GitHub repo
      4. Render auto-detects `render.yaml`
      5. Set environment variables in the form:
         - NEO4J_USERNAME (from Aura)
         - NEO4J_PASSWORD (from Aura)
         - RENDER_API_KEY (from Render account)
      6. Deploy
- [ ] 5.3 Test live:
      - API URL: `https://ignite-api.onrender.com/health`
      - `/zones`, `/route`, `/aqi/spike` work end-to-end
      - `/aqi/refresh` starts a background workflow (check Render Dashboard → Workflows)
      - `/dispatch` queues a batch task

## Phase 6: Rider app (later, not in scope for this hackathon)

---

## Summary

**What's built:**
- **Graph layer:** 30 Noida-centric zones, 156 roads, dynamic SAFE_ROAD (rebuilt on AQI refresh)
- **Routing:** Dijkstra-based, masked riders use all roads, unmasked riders use only safe roads (aqi ≤ 300)
- **AQI simulation:** winter scenario with ±15% drift per refresh, spike endpoint for live demo
- **Batch dispatch:** greedy earliest-deadline-first rider assignment with exposure tracking
- **Workflows:** two Render Workflow tasks (refresh_aqi, dispatch_batch)
- **API:** FastAPI with 6 endpoints covering zones, routing, AQI control, and workflow triggering
- **Infrastructure:** `render.yaml` Blueprint for web service, workflow service, and cron job

**Demo flow:**
1. `GET /zones` → see 30 zones colored by AQI
2. `POST /aqi/spike` → spike one zone to high AQI (e.g., Anand Vihar → 500)
3. `POST /route` (masked vs unmasked) → show how masks unlock certain zones
4. `POST /dispatch` → show batch assignment with the new AQI state
5. Repeat spikes to show dynamic rerouting

**Next steps (after hackathon):**
- Rider mobile app (Next.js + Leaflet map)
- Real WAQI API integration (swap the drift function in refresh_aqi)
- Live traffic API (update road minutes on-demand)
- Better dispatch algorithm (OR-Tools VRP for optimality)
- Mid-route rerouting (detect AQI spikes, reroute in-flight riders)
