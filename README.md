# Ignite — AQI-Aware Delivery Routing for Delhi NCR

In winter, air quality in Delhi NCR swings hard from one locality to the next — Anand Vihar can sit at AQI 450 while Lodhi Road is at 250. Delivery fleets route on traffic alone, so riders without masks get sent straight through severe pollution micro-zones.

**Ignite** is a routing and dispatch system that assigns and routes every order so that:

1. **Unmasked riders never enter a zone above the AQI limit.**
2. **Masked riders take the orders that must cross bad zones.**
3. **Deadlines are still met where possible, and every order that can't be met is reported with a reason.**

Built for Delhi Hacks.

---

## Architecture

Everything runs on managed infrastructure — no local database, no servers to babysit.

```
              ┌──────────────────── Render ─────────────────────┐
 Cron job ───►│  Workflow service (Python)                      │
 (every 15m)  │    refresh_aqi    (winter scenario drift)       │
              │    dispatch_batch (greedy deadline assignment)  │
              │          ▲                                      │
              │          │ starts tasks                        │
 Web dashboard│  Web service: FastAPI ──────────────────────────┘
 (Next.js) ──►│          │
 Rider app    │          │
 (Expo)    ──►│          ▼
              └──────────┼─────────────────────────────────────┘
                         ▼
                 Neo4j AuraDB Free (city graph)
```

- **Neo4j AuraDB Free** holds the city graph: 30 named NCR zones, ~156 road edges, and a dynamically rebuilt set of `SAFE_ROAD` edges.
- **FastAPI web service** serves quick reads and controls: zones, a single route, AQI spike/refresh, dispatch, run status.
- **Render Workflows** runs the slow or background work: AQI refresh and batch dispatch.
- **Render cron job** triggers `refresh_aqi` every 15 minutes (Workflows have no built-in scheduler).

## The routing trick

AuraDB Free has **no GDS library**, and `apoc.algo.dijkstra` can't filter nodes by property. So whenever AQI changes, the backend rebuilds a separate relationship type:

```
(:Zone)-[:ROAD      {km, minutes}]-(:Zone)   all roads
(:Zone)-[:SAFE_ROAD {km, minutes}]-(:Zone)   roads whose BOTH ends have aqi <= AQI_LIMIT
```

- **Masked rider** → `apoc.algo.dijkstra(a, b, 'ROAD', 'minutes')` — any road.
- **Unmasked rider** → `apoc.algo.dijkstra(a, b, 'SAFE_ROAD', 'minutes')` — clean roads only.

If an unmasked rider has no path, the only way through is a bad zone, and the order must go to a masked rider.

## AQI: simulated winter scenario

Real AQI in September is ~50–150 across the city, so nothing would ever be blocked. Instead Ignite simulates a realistic **November snapshot**:

| Tier | Examples | Base AQI |
|---|---|---|
| Hotspots | Anand Vihar, Bawana, Jahangirpuri, Sector 62, Bisrakh, ITO | 380–480 |
| Poor | Connaught Place, Karol Bagh, Okhla, Laxmi Nagar | 280–350 |
| Relatively clean | Cyber City, Vasant Kunj, Aerocity, Dwarka | 180–260 |

- Base values live in `backend/seed_data.py`.
- `refresh_aqi` drifts every zone up to ±15% around its base each run, so the map looks live.
- `POST /aqi/spike` forces a zone's value and rebuilds `SAFE_ROAD` immediately — the demo control.
- Scale is Indian **NAQI / CPCB**; `AQI_LIMIT=300` matches "Very Poor" onward.

**Upgrade path:** swap the drift function for a WAQI API call. Only `refresh_aqi` changes.

---

## Repository layout

```
backend/
  seed_data.py       30 zones (name, lat, lng, base winter AQI)
  graph.py           Neo4j driver + Cypher (seed, AQI writes, SAFE_ROAD rebuild, Dijkstra route)
  workflow.py        Render Workflows tasks: refresh_aqi, dispatch_batch
  api.py             FastAPI app
  requirements.txt
frontend/            Next.js operations dashboard (AQI map, route planner, dispatch builder)
ignite-rider-app/    Expo / React Native rider app (route choice + turn-by-turn navigation)
render.yaml          Blueprint: web service + workflow service
GUIDED_PATH.md       Build log, phase by phase
explanation.md       Full design rationale
```

## Tech stack

| Layer | Technology |
|---|---|
| Graph | Neo4j AuraDB Free, APOC (`apoc.algo.dijkstra`) |
| Backend | Python, FastAPI, `neo4j` driver, `render` SDK |
| Workflows | Render Workflows + cron |
| Dashboard | Next.js 16, React 19, TypeScript, Tailwind CSS v4, shadcn/ui, Leaflet |
| Rider app | Expo SDK 57, React Native 0.86, Expo Router, `react-native-maps` |
| Hosting | Render (web + workflow) |

---

## Getting started

### Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # then fill in your Neo4j credentials
python -c "from graph import GraphDriver; from seed_data import ZONES; g=GraphDriver(); g.seed_zones(ZONES); g.create_roads(); g.rebuild_safe_roads()"
uvicorn api:app --reload
```

API runs at `http://127.0.0.1:8000`.

### Dashboard

```bash
cd frontend
npm install
npm run dev
```

Runs at `http://localhost:3000`. Point it at a different backend with `NEXT_PUBLIC_API_URL`.

### Rider app

```bash
cd ignite-rider-app
npm install
npx expo start
```

Scan the QR with Expo Go, or press `i` / `a` for a simulator.

## Environment variables

```
NEO4J_URI=neo4j+s://xxxx.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=...
NEO4J_DATABASE=1f2c19fc
AQI_LIMIT=300
RENDER_API_KEY=...        # web service only, to start workflow runs
WORKFLOW_SLUG=ignite-workflows
```

Never commit `.env`. On Render these are set as service environment variables (`sync: false` in `render.yaml`).

## API

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Service status |
| GET | `/zones` | All zones with current AQI + `safe` flag |
| POST | `/route` | `{from_zone, to_zone, masked}` → path, minutes, exposure |
| POST | `/aqi/refresh` | Start `refresh_aqi`, returns run id |
| POST | `/aqi/spike` | `{zone_id, aqi}` → force a zone's AQI, rebuild `SAFE_ROAD` |
| POST | `/dispatch` | `{orders, riders}` → start `dispatch_batch`, returns run id |
| GET | `/runs/{id}` | Workflow run status + result |

Live API: `https://ignite-api-hcuj.onrender.com`

## Demo flow

1. `GET /zones` → 30 zones colored by AQI.
2. `POST /aqi/spike` → spike a zone (e.g. Sector 62 → 500).
3. `POST /route` masked vs unmasked → masks unlock routes that are otherwise blocked.
4. `POST /dispatch` → batch assignment with the new AQI state, polling `/runs/{id}`.
5. Repeat spikes to show dynamic rerouting.

## Not in v1

Real WAQI integration · live traffic API · H3 micro-zones · mid-route rerouting · tiered masks (N95 vs cloth) · OR-Tools VRP dispatch. See `explanation.md` for the full scope table.

---

See [`explanation.md`](explanation.md) for design decisions and [`GUIDED_PATH.md`](GUIDED_PATH.md) for the build log.
