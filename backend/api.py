"""
FastAPI for Ignite.
Endpoints:
  GET  /zones              → list zones + AQI
  POST /route              → route between zones
  POST /aqi/refresh        → trigger refresh_aqi workflow
  POST /aqi/spike          → force a zone's AQI (demo)
  POST /dispatch           → trigger dispatch_batch workflow
  GET  /runs/{run_id}      → workflow run status
"""

import os
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from graph import GraphDriver
from render import Render, RenderAsync

load_dotenv()

# Render client for triggering workflows (lazy init)
WORKFLOW_SLUG = os.environ.get("WORKFLOW_SLUG", "ignite-workflows")
USE_LOCAL_DEV = os.environ.get("RENDER_USE_LOCAL_DEV", "").lower() == "true"
RENDER_API_KEY = os.environ.get("RENDER_API_KEY")

def get_render_client():
    """Lazy init of Render client."""
    if not RENDER_API_KEY:
        raise ValueError("RENDER_API_KEY not set. Workflow endpoints disabled.")
    return Render(token=RENDER_API_KEY)

app = FastAPI(title="Ignite AQI Router")


class RouteRequest(BaseModel):
    from_zone: str
    to_zone: str
    masked: bool = False


class SpikeRequest(BaseModel):
    zone_id: str
    aqi: int


class DispatchRequest(BaseModel):
    orders: list
    riders: list


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/zones")
def get_zones():
    """List all zones with current AQI and safe flag."""
    g = GraphDriver()
    zones = g.get_zones()
    g.close()

    result = []
    for z in zones:
        safe = z["z.aqi"] <= int(os.environ.get("AQI_LIMIT", 300))
        result.append({
            "id": z["z.id"],
            "name": z["z.name"],
            "lat": z["z.lat"],
            "lng": z["z.lng"],
            "aqi": z["z.aqi"],
            "aqi_updated": str(z["z.aqi_updated"]) if z["z.aqi_updated"] else None,
            "safe": safe,
        })

    return {"zones": result}


@app.post("/route")
def route(req: RouteRequest):
    """Route from one zone to another (direct graph query, no workflow)."""
    g = GraphDriver()
    route_result = g.route(req.from_zone, req.to_zone, masked=req.masked)
    g.close()

    if not route_result:
        raise HTTPException(status_code=404, detail="No path found")

    return {
        "from_zone": req.from_zone,
        "to_zone": req.to_zone,
        "masked": req.masked,
        "path": route_result["path"],
        "minutes": route_result["minutes"],
        "exposure": route_result["exposure"],
    }


@app.post("/aqi/refresh")
def aqi_refresh():
    """Trigger refresh_aqi workflow."""
    try:
        client = get_render_client()
        run = client.workflows.start_task(f"{WORKFLOW_SLUG}/refresh_aqi", [])
        return {
            "run_id": run.id,
            "status": "started",
            "task": "refresh_aqi",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/aqi/spike")
def aqi_spike(req: SpikeRequest):
    """Force a zone's AQI for demo purposes and rebuild SAFE_ROAD."""
    g = GraphDriver()
    g.write_aqi_batch([{"zone_id": req.zone_id, "aqi": req.aqi}])
    g.rebuild_safe_roads()
    g.close()

    return {
        "zone_id": req.zone_id,
        "new_aqi": req.aqi,
        "status": "spiked",
    }


@app.post("/dispatch")
def dispatch(req: DispatchRequest):
    """Trigger dispatch_batch workflow."""
    try:
        client = get_render_client()
        run = client.workflows.start_task(f"{WORKFLOW_SLUG}/dispatch_batch", [req.orders, req.riders])
        return {
            "run_id": run.id,
            "status": "started",
            "task": "dispatch_batch",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/runs/{run_id}")
def get_run(run_id: str):
    """Get workflow run status and results."""
    try:
        client = get_render_client()
        run = client.workflows.get_task_run(run_id)
        return {
            "run_id": run.id,
            "status": run.status.value,
            "results": run.results,
        }
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
