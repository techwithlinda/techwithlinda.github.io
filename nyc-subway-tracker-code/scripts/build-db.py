#!/usr/bin/env python3
"""Build data/transit.db from the MTA static GTFS bundle.

Reads data/gtfs.zip (stops.txt, routes.txt, trips.txt, stop_times.txt) and
produces a SQLite database with:
  stations(complex_id, name, lat, lon, lines)   -- one row per station complex
  schedule(child_stop_id, trip_suffix, arrival_secs) -- for delay computation
Run:  python3 scripts/build-db.py
"""
import csv
import os
import sqlite3
import sys
import zipfile

BASE = os.path.join(os.path.dirname(__file__), "..")
DATA = os.path.join(BASE, "data")
ZIP_PATH = os.path.join(DATA, "gtfs.zip")
DB_PATH = os.path.join(DATA, "transit.db")


def parse_secs(t: str) -> int:
    h, m, s = t.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def main() -> None:
    if not os.path.exists(ZIP_PATH):
        sys.exit(f"Missing {ZIP_PATH}. Download the MTA GTFS first (see README).")

    with zipfile.ZipFile(ZIP_PATH) as z:
        stops = list(csv.DictReader(z.open("stops.txt").read().decode("utf-8").splitlines()))
        routes = {r["route_id"]: r for r in csv.DictReader(z.open("routes.txt").read().decode("utf-8").splitlines())}
        trips = {}
        for t in csv.DictReader(z.open("trips.txt").read().decode("utf-8").splitlines()):
            trips[t["trip_id"]] = t["route_id"]
        stop_times = csv.DictReader(z.open("stop_times.txt").read().decode("utf-8").splitlines())

        parents = {}          # complex_id -> dict(name, lat, lon)
        child_to_parent = {}  # child stop_id -> complex_id
        for s in stops:
            if s["location_type"] == "1":
                parents[s["stop_id"]] = {
                    "name": s["stop_name"],
                    "lat": float(s["stop_lat"]),
                    "lon": float(s["stop_lon"]),
                }
            elif s["parent_station"]:
                child_to_parent[s["stop_id"]] = s["parent_station"]

        parent_routes = {pid: set() for pid in parents}
        schedule_rows = []
        trip_terminal = {}  # static trip_id -> (stop_sequence, stop_id) of last stop
        for st in stop_times:
            parent = child_to_parent.get(st["stop_id"])
            if not parent:
                continue
            route_id = trips.get(st["trip_id"])
            if route_id:
                parent_routes[parent].add(route_id)
            # realtime trip_id == static trip_id minus the first "_"-segment,
            # e.g. "BSP26GEN-N061-Sunday-00_001050_N..S20R" -> "001050_N..S20R"
            suffix = st["trip_id"].split("_", 1)[1]
            try:
                arr = parse_secs(st["arrival_time"])
            except ValueError:
                continue
            schedule_rows.append((st["stop_id"], suffix, arr))
            seq = int(st["stop_sequence"])
            prev = trip_terminal.get(st["trip_id"])
            if prev is None or seq > prev[0]:
                trip_terminal[st["trip_id"]] = (seq, st["stop_id"])

    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    db = sqlite3.connect(DB_PATH)
    db.execute(
        "CREATE TABLE stations(complex_id TEXT PRIMARY KEY, name TEXT, lat REAL, lon REAL, lines TEXT)"
    )
    db.execute(
        "CREATE TABLE schedule(child_stop_id TEXT, trip_suffix TEXT, arrival_secs INTEGER)"
    )
    db.execute("CREATE INDEX idx_sched ON schedule(child_stop_id, trip_suffix)")

    station_rows = [
        (pid, p["name"], p["lat"], p["lon"], ",".join(sorted(parent_routes[pid])))
        for pid, p in parents.items()
    ]
    db.executemany("INSERT INTO stations VALUES (?,?,?,?,?)", station_rows)
    db.executemany("INSERT INTO schedule VALUES (?,?,?)", schedule_rows)
    db.execute("CREATE TABLE station_children(complex_id TEXT, child_stop_id TEXT)")
    db.executemany(
        "INSERT INTO station_children VALUES (?,?)",
        [(parent, child) for child, parent in child_to_parent.items()],
    )
    db.execute("CREATE INDEX idx_children ON station_children(complex_id)")

    # destination = name of the terminal station complex for each trip
    db.execute("CREATE TABLE destinations(trip_suffix TEXT PRIMARY KEY, destination TEXT)")
    dest_rows = []
    for trip_id, (_, last_stop) in trip_terminal.items():
        suffix = trip_id.split("_", 1)[1]
        parent = child_to_parent.get(last_stop)
        name = parents[parent]["name"] if parent in parents else last_stop
        dest_rows.append((suffix, name))
    db.executemany("INSERT OR IGNORE INTO destinations VALUES (?,?)", dest_rows)

    # route metadata for bullets
    db.execute("CREATE TABLE routes(route_id TEXT PRIMARY KEY, short_name TEXT, long_name TEXT, color TEXT)")
    db.executemany(
        "INSERT INTO routes VALUES (?,?,?,?)",
        [(rid, r.get("route_short_name"), r.get("route_long_name"), r.get("route_color")) for rid, r in routes.items()],
    )
    db.commit()

    n_stations = db.execute("SELECT COUNT(*) FROM stations").fetchone()[0]
    n_sched = db.execute("SELECT COUNT(*) FROM schedule").fetchone()[0]
    print(f"Wrote {DB_PATH}: {n_stations} station complexes, {n_sched} schedule rows.")
    db.close()


if __name__ == "__main__":
    main()
