"""
Render Workflows for Ignite.
Two tasks:
  1. refresh_aqi(): update AQI values (drift ±15% around base) and rebuild SAFE_ROAD
  2. dispatch_batch(orders, riders): assign orders to riders
"""

import os
import random
import math
from datetime import datetime
from dotenv import load_dotenv
from render import Workflows, TaskContext
from graph import GraphDriver
from seed_data import get_zones

load_dotenv()

app = Workflows(default_timeout=3600, default_plan="2c-4g")


@app.task(name="refresh_aqi")
def refresh_aqi(ctx: TaskContext):
    """
    Update all zone AQI values: drift each by ±15% around its base value.
    Then rebuild SAFE_ROAD edges.
    """
    g = GraphDriver()
    zones = get_zones()

    updates = []
    for zone in zones:
        base = zone["base_aqi"]
        drift = random.uniform(-0.15, 0.15)  # ±15%
        new_aqi = max(50, int(base * (1 + drift)))  # clamp to reasonable range
        updates.append({"zone_id": zone["id"], "aqi": new_aqi})

    g.write_aqi_batch(updates)
    g.rebuild_safe_roads()
    g.close()

    return {
        "status": "success",
        "zones_updated": len(updates),
        "timestamp": datetime.now().isoformat(),
    }


@app.task(name="dispatch_batch")
def dispatch_batch(ctx: TaskContext, orders: list, riders: list):
    """
    Assign orders to riders using greedy earliest-deadline-first.

    orders: [{id, pickup_zone, drop_zone, deadline_min}]
    riders: [{id, name, masked, current_zone, free_at_min}]

    Returns: assignment result with routes, ETAs, on-time flags, exposure.
    """
    g = GraphDriver()

    # Sort orders by deadline
    orders_sorted = sorted(orders, key=lambda o: o.get("deadline_min", float("inf")))

    result = {
        "assignments": [],
        "unassigned": [],
        "timestamp": datetime.now().isoformat(),
    }

    # Track rider state
    rider_state = {r["id"]: {"zone": r["current_zone"], "free_at": r.get("free_at_min", 0)} for r in riders}

    for order in orders_sorted:
        order_id = order["id"]
        pickup = order["pickup_zone"]
        drop = order["drop_zone"]
        deadline = order.get("deadline_min", float("inf"))

        best_rider = None
        best_eta = float("inf")
        best_route = None

        # Try each rider
        for rider in riders:
            rider_id = rider["id"]
            masked = rider.get("masked", False)
            current = rider_state[rider_id]["zone"]
            free_at = rider_state[rider_id]["free_at"]

            # Route from current zone to pickup
            route1 = g.route(current, pickup, masked=masked)
            if not route1:
                continue

            # Route from pickup to drop
            route2 = g.route(pickup, drop, masked=masked)
            if not route2:
                continue

            # Calculate ETA
            travel_time = route1["minutes"] + route2["minutes"]
            eta = free_at + travel_time

            # Prefer unmasked riders and lower eta
            if eta < best_eta or (eta == best_eta and not masked and (best_rider is None or rider_state[best_rider]["zone"] == current)):
                best_rider = rider_id
                best_eta = eta
                best_route = {
                    "pickup_route": route1["path"],
                    "drop_route": route2["path"],
                    "total_minutes": travel_time,
                    "exposure": route1["exposure"] + route2["exposure"],
                }

        if best_rider:
            on_time = best_eta <= deadline
            rider_state[best_rider]["zone"] = drop
            rider_state[best_rider]["free_at"] = best_eta

            result["assignments"].append({
                "order_id": order_id,
                "rider_id": best_rider,
                "eta": int(best_eta),
                "deadline": deadline,
                "on_time": on_time,
                "route": best_route,
            })
        else:
            result["unassigned"].append({
                "order_id": order_id,
                "reason": "no_path_available",
            })

    g.close()
    return result


app.start()
