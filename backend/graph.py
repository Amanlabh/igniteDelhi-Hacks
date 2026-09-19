"""
Neo4j graph operations for Ignite.
Handles: zone seeding, AQI updates, SAFE_ROAD rebuilding, routing.

The graph uses:
  (:Zone {id, name, lat, lng, aqi, aqi_updated})
  (:Zone)-[:ROAD {km, minutes}]-(:Zone)       all roads
  (:Zone)-[:SAFE_ROAD {km, minutes}]-(:Zone)  roads both ends have aqi <= AQI_LIMIT
"""

import os
import math
from dotenv import load_dotenv
from neo4j import GraphDatabase

load_dotenv()

URI = os.environ["NEO4J_URI"]
USERNAME = os.environ["NEO4J_USERNAME"]
PASSWORD = os.environ["NEO4J_PASSWORD"]
DATABASE = os.environ["NEO4J_DATABASE"]
AQI_LIMIT = int(os.environ.get("AQI_LIMIT", 300))


class GraphDriver:
    def __init__(self):
        self.driver = GraphDatabase.driver(URI, auth=(USERNAME, PASSWORD))

    def close(self):
        self.driver.close()

    def seed_zones(self, zones):
        """Create all zones. Uses MERGE, so safe to re-run."""
        def work(tx):
            for zone in zones:
                tx.run(
                    """
                    MERGE (z:Zone {id: $id})
                    SET z.name = $name, z.lat = $lat, z.lng = $lng,
                        z.aqi = $base_aqi, z.aqi_updated = datetime()
                    """,
                    id=zone["id"],
                    name=zone["name"],
                    lat=zone["lat"],
                    lng=zone["lng"],
                    base_aqi=zone["base_aqi"],
                )
        with self.driver.session(database=DATABASE) as session:
            session.execute_write(work)
        print(f"Seeded {len(zones)} zones")

    def create_roads(self):
        """Connect each zone to its 3-4 nearest zones via ROAD relationships."""
        # Fetch all zones with coordinates
        with self.driver.session(database=DATABASE) as session:
            result = session.run("MATCH (z:Zone) RETURN z.id AS id, z.lat AS lat, z.lng AS lng ORDER BY z.id")
            zones_map = {r["id"]: (r["lat"], r["lng"]) for r in result}

        zones_list = list(zones_map.items())

        # For each zone, find 3-4 nearest and create ROAD edges
        def work(tx):
            for i, (z1_id, (z1_lat, z1_lng)) in enumerate(zones_list):
                distances = []
                for j, (z2_id, (z2_lat, z2_lng)) in enumerate(zones_list):
                    if i == j:
                        continue
                    km = haversine(z1_lat, z1_lng, z2_lat, z2_lng) * 1.3
                    distances.append((km, z2_id))

                distances.sort()
                for km, z2_id in distances[:4]:
                    minutes = (km / 22.0) * 60 * 1.3
                    tx.run(
                        """
                        MATCH (z1:Zone {id: $z1}), (z2:Zone {id: $z2})
                        MERGE (z1)-[r:ROAD]-(z2)
                        SET r.km = $km, r.minutes = $minutes
                        """,
                        z1=z1_id,
                        z2=z2_id,
                        km=round(km, 2),
                        minutes=round(minutes, 2),
                    )

        with self.driver.session(database=DATABASE) as session:
            session.execute_write(work)
        print("Created roads")

    def rebuild_safe_roads(self):
        """Delete and recreate SAFE_ROAD edges (both zones have aqi <= AQI_LIMIT)."""
        def work(tx):
            tx.run("MATCH (z1)-[r:SAFE_ROAD]-(z2) DELETE r")
            tx.run(
                """
                MATCH (z1)-[road:ROAD]-(z2)
                WHERE z1.aqi <= $limit AND z2.aqi <= $limit
                MERGE (z1)-[safe:SAFE_ROAD {km: road.km, minutes: road.minutes}]-(z2)
                """,
                limit=AQI_LIMIT,
            )
        with self.driver.session(database=DATABASE) as session:
            session.execute_write(work)

    def write_aqi_batch(self, aqi_updates):
        """Update AQI for multiple zones."""
        def work(tx):
            for update in aqi_updates:
                tx.run(
                    "MATCH (z:Zone {id: $id}) SET z.aqi = $aqi, z.aqi_updated = datetime()",
                    id=update["zone_id"],
                    aqi=update["aqi"],
                )
        with self.driver.session(database=DATABASE) as session:
            session.execute_write(work)

    def get_zones(self):
        """Fetch all zones with current AQI."""
        def work(tx):
            result = tx.run(
                """
                MATCH (z:Zone)
                RETURN z.id, z.name, z.lat, z.lng, z.aqi, z.aqi_updated
                ORDER BY z.name
                """
            )
            return [dict(r) for r in result]

        with self.driver.session(database=DATABASE) as session:
            return session.execute_read(work)

    def route(self, from_id, to_id, masked=False):
        """
        Route from one zone to another.
        masked=True: use ROAD (all zones), masked=False: use SAFE_ROAD (aqi <= limit)
        """
        rel = "ROAD" if masked else "SAFE_ROAD"

        def work(tx):
            result = tx.run(
                f"""
                MATCH (start:Zone {{id: $from_id}}), (end:Zone {{id: $to_id}})
                CALL apoc.algo.dijkstra(start, end, '{rel}', 'minutes')
                YIELD path, weight
                WITH [node IN nodes(path) | node.id] AS zone_path, weight
                RETURN zone_path, weight
                LIMIT 1
                """,
                from_id=from_id,
                to_id=to_id,
            )
            records = list(result)
            if not records:
                return None

            path = records[0]["zone_path"]
            minutes = records[0]["weight"]

            # Calculate AQI exposure
            aqi_result = tx.run(
                "MATCH (z:Zone) WHERE z.id IN $path RETURN z.id, z.aqi",
                path=path,
            )
            aqi_map = {r["z.id"]: r["z.aqi"] for r in aqi_result}
            exposure = sum(aqi_map.get(zid, 0) for zid in path) * minutes / max(len(path), 1)

            return {"path": path, "minutes": round(minutes, 2), "exposure": round(exposure, 2)}

        with self.driver.session(database=DATABASE) as session:
            return session.execute_read(work)

    def get_stats(self):
        """Graph statistics."""
        def work(tx):
            zones = tx.run("MATCH (z:Zone) RETURN COUNT(z) AS c").single()["c"]
            roads = tx.run("MATCH ()-[r:ROAD]-() RETURN COUNT(r) AS c").single()["c"]
            safe = tx.run("MATCH ()-[r:SAFE_ROAD]-() RETURN COUNT(r) AS c").single()["c"]
            return {"zones": zones, "roads": roads, "safe_roads": safe}

        with self.driver.session(database=DATABASE) as session:
            return session.execute_read(work)


def haversine(lat1, lon1, lat2, lon2):
    """Distance in km between two points."""
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    c = 2 * math.asin(math.sqrt(a))
    return R * c


if __name__ == "__main__":
    from seed_data import get_zones

    g = GraphDriver()
    zones = get_zones()
    print(f"Seeding {len(zones)} zones...")
    g.seed_zones(zones)
    print("Creating roads...")
    g.create_roads()
    print("Rebuilding SAFE_ROAD...")
    g.rebuild_safe_roads()

    stats = g.get_stats()
    print(f"Stats: {stats}")

    zones_list = g.get_zones()
    print(f"\nFirst 3 zones:")
    for z in zones_list[:3]:
        print(f"  {z['z.name']}: AQI {z['z.aqi']}")

    g.close()
