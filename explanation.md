# Ignite: AQI-Aware Delivery Routing for Delhi NCR

## Problem

In winter, air quality in Delhi NCR swings hard from one locality to the next. Anand Vihar can sit at AQI 450 while Lodhi Road is at 250. Delivery fleets route on traffic alone, so riders without masks get sent straight through severe micro-zones.

**Goal:** assign and route every order so that:
1. Unmasked riders never enter a zone above the AQI limit.
2. Masked riders take the orders that must go through bad zones.
3. Delivery deadlines are still met wherever possible, and every order that can't be met is reported with a reason.

## Scope (hackathon, 2–3 hours)

| In v1 | Cut (add later) |
|---|---|
| Simulated winter AQI scenario + live "spike" control | Real AQI from WAQI (useless in Sept: city is ~50–150, nothing to route around) |
| Time-of-day traffic multiplier | Live traffic API |
| ~30 named Delhi NCR zones | Hex grid (H3) micro-zones |
| Single-rider route API | Rider mobile app (after backend works) |
| Full batch dispatch (many riders × many orders) | Mid-route rerouting on AQI spikes |
| Binary mask rule | Tiered masks (N95 vs cloth) |

## Architecture

```
            ┌──────────────── Render ─────────────────┐
 Cron job ──►  Workflow service (Python)              │
 (every 15m)│    refresh_aqi   (winter scenario drift)│
            │    dispatch_batch                        │
            │          │                               │
 Rider app ─►  Web service: FastAPI ── starts tasks ──┘
 (later)    │          │
            └──────────┼──────────────────────────────┘
                       ▼
               Neo4j AuraDB Free (console.neo4j.io)
```

- **Neo4j AuraDB Free** holds the city graph. We use one cloud DB, with no local install.
- **FastAPI (web service)** serves quick reads: zones, and a single route.
- **Render Workflows** runs the slow or background work: AQI refresh and batch dispatch.
- **Render cron job** triggers `refresh_aqi` every 15 minutes. Workflows have no built-in scheduler, so a tiny cron job starts the task.

## Data model (Neo4j)

```
(:Zone  {id, name, lat, lng, aqi, aqi_updated})
(:Zone)-[:ROAD {km, minutes}]-(:Zone)        all roads
(:Zone)-[:SAFE_ROAD {km, minutes}]-(:Zone)   roads whose BOTH ends have aqi <= AQI_LIMIT
(:Rider {id, name, masked})-[:AT]->(:Zone)
(:Order {id, deadline_min})-[:PICKUP]->(:Zone)
(:Order)-[:DROP]->(:Zone)
```

### Why a separate `SAFE_ROAD` relationship?
AuraDB Free has **no GDS** (Graph Data Science library), and `apoc.algo.dijkstra` can't filter nodes by property. So each time AQI refreshes, we rebuild `SAFE_ROAD` edges. Then:

- Masked rider: `apoc.algo.dijkstra(a, b, 'ROAD', 'minutes')`
- Unmasked rider: `apoc.algo.dijkstra(a, b, 'SAFE_ROAD', 'minutes')`

If an unmasked rider has no path, the only way through is a bad zone, and the order must go to a masked rider.

## Zones: why 30 named localities, not a grid

- Readable in a demo ("avoid Anand Vihar") and in the rider app later.
- Delhi has only about 40 AQI stations, so a fine grid would mostly be interpolated guesses anyway.
- Seeded once from `seed_data.py` (name, lat, lng). All writes use `MERGE`, so re-seeding is safe.

**Roads:** each zone connects to its 3–4 nearest zones.
- `km` = straight-line (haversine) distance × 1.3, to account for roads not being straight.
- `minutes` = km / 22 km/h (average Delhi speed) × traffic multiplier: 1.6 at rush hours (8–11, 17–21), 1.0 otherwise.

## AQI source: simulated winter scenario

Real AQI right now (September) is ~50–150 across Delhi, so no zone would ever be blocked. Instead we simulate a realistic **November snapshot**:

| Tier | Zones (examples) | Base AQI |
|---|---|---|
| Hotspots | Anand Vihar, Bawana, Mundka, Jahangirpuri, Wazirpur, Ghaziabad, ITO | 380–480 |
| Poor | Connaught Place, Karol Bagh, Okhla, Noida, Laxmi Nagar | 280–350 |
| Relatively clean | Gurugram Cyber City, Vasant Kunj, Aerocity, Dwarka | 180–260 |

- Base values live in `seed_data.py` next to each zone.
- Each `refresh_aqi` run moves every zone's value by up to ±15% around its base, so the map looks live.
- **Demo control:** `POST /aqi/spike {zone, aqi}` forces a zone's value and rebuilds `SAFE_ROAD` immediately. Then re-run dispatch and routes bend around it.
- **Scale:** Indian **NAQI / CPCB** (301–400 Very Poor, 401–500 Severe). `AQI_LIMIT=300` matches "Very Poor" onward.
- **Upgrade path:** swap the drift function for a WAQI call (`/map/bounds` over the NCR area, inverse-distance-weighted average of the 3 nearest stations per zone). Only `refresh_aqi` changes.

## Mask rule (binary)

| Rider | Allowed zones |
|---|---|
| `masked: true` | Any zone |
| `masked: false` | Only zones with `aqi <= AQI_LIMIT` (route and drop zone) |

## Batch dispatch algorithm (the `dispatch_batch` task)

Greedy, earliest-deadline-first. It's simple, explainable, and fast enough for tens of riders and orders.

```
sort orders by deadline
for each order:
    for each rider:
        graph = SAFE_ROAD if rider unmasked else ROAD
        eta = rider.free_at + path(rider.zone → pickup) + path(pickup → drop)
        skip rider if no path in their graph
    choose rider with smallest eta that meets deadline
        (tie → prefer unmasked, to keep masked riders free for dirty zones)
    if none meet deadline → choose smallest eta anyway, flag LATE
    if no rider has any path → UNASSIGNED (reason: needs masked rider / unreachable)
    rider.zone = drop, rider.free_at = eta
```

Output per order: rider, full path (zone names), eta, deadline, on_time, and exposure = Σ(zone AQI × minutes spent in zone).

Known ceiling: greedy isn't optimal. If we need better, OR-Tools VRP (vehicle routing solver) is the upgrade path. Not for this hackathon.

## Render Workflows: what runs where

| Task | Started by | Why a workflow, not the API |
|---|---|---|
| `refresh_aqi()` | Cron (every 15 min), `POST /aqi/refresh` | Scheduled background update, off the request path (and the future home of the WAQI call, with retries). Also keeps the Aura Free DB from auto-pausing (Free pauses after about 3 idle days) |
| `dispatch_batch(orders, riders)` | `POST /dispatch` | Many route computations; can outgrow a request timeout; each run's result and logs are visible in the Render dashboard |

The SDK is the Python package `render` (tasks use `@app.task` and take `ctx` as the first argument). The API triggers runs with `Render().workflows.start_task("ignite-workflows/dispatch_batch", [...])`.
Local dev: `render workflows dev -- python workflow.py` + `RENDER_USE_LOCAL_DEV=true` in the API.

## API (FastAPI)

| Method | Path | Returns |
|---|---|---|
| GET | `/zones` | Zones with current AQI + safe flag |
| POST | `/route` | `{from_zone, to_zone, masked}` → path, minutes, exposure (direct Neo4j, no workflow) |
| POST | `/aqi/refresh` | Starts `refresh_aqi`, returns run id |
| POST | `/aqi/spike` | `{zone, aqi}` → force a zone's AQI (demo), rebuild `SAFE_ROAD` |
| POST | `/dispatch` | `{orders, riders}` → starts `dispatch_batch`, returns run id |
| GET | `/runs/{id}` | Workflow run status + result |

## Project layout

```
backend/
  requirements.txt   neo4j, fastapi, uvicorn, render
  seed_data.py       30 zones (name, lat, lng, base winter AQI)
  graph.py           Neo4j driver + all Cypher (seed, write AQI, rebuild SAFE_ROAD, route)
  workflow.py        Render Workflows tasks: refresh_aqi, dispatch_batch
  api.py             FastAPI
  .env.example
render.yaml          Blueprint: web service + workflow + cron
frontend/            (rider app, later)
```

## Environment variables

```
NEO4J_URI=neo4j+s://xxxx.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=...
AQI_LIMIT=300
RENDER_API_KEY=...          # API service, to start workflow runs
WORKFLOW_SLUG=ignite-workflows
```

Never commit `.env`. On Render, set these as env vars (`sync: false` in `render.yaml`).

## Build order (about 2.5 h)

1. **0:00–0:15**: Create the Aura Free instance, fill in `backend/.env`.
2. **0:15–0:45**: `seed_data.py` + `graph.py`; seed the graph; check it in the Aura console.
3. **0:45–1:15**: `refresh_aqi`, run locally via `render workflows dev`; see winter AQI on the zones; try `/aqi/spike`.
4. **1:15–1:45**: `/zones`, `/route`, and `dispatch_batch`, tested with curl.
5. **1:45–2:30**: Deploy with `render.yaml`; wire up the cron; smoke test on the live URL.

Then: the rider app.
