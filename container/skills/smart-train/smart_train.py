#!/usr/bin/env python3
"""SMART Train schedule lookup using GTFS data."""

import argparse
import csv
import io
import os
import sys
import time
import urllib.request
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

GTFS_URL = "https://data.trilliumtransit.com/gtfs/smart-ca-us/smart-ca-us.zip"
CACHE_DIR = Path("/tmp/smart-gtfs")
CACHE_MAX_AGE = 86400  # 24 hours


def download_gtfs():
    """Download and extract GTFS data, using cache if fresh."""
    marker = CACHE_DIR / ".downloaded"
    if marker.exists() and (time.time() - marker.stat().st_mtime) < CACHE_MAX_AGE:
        return

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    print("Downloading GTFS data...", file=sys.stderr)
    resp = urllib.request.urlopen(GTFS_URL, timeout=30)
    data = resp.read()
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        zf.extractall(CACHE_DIR)
    marker.touch()


def read_csv(filename):
    """Read a GTFS CSV file and return list of dicts."""
    path = CACHE_DIR / filename
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def match_station(query, stops):
    """Fuzzy match a station name. Returns (stop_id, stop_name) for the parent station, or exits with error."""
    query_lower = query.lower().strip()
    matches = []
    for s in stops:
        if query_lower in s["stop_name"].lower():
            matches.append(s)
    if not matches:
        # Show available parent stations only
        station_names = sorted(set(
            s["stop_name"] for s in stops if s.get("location_type") == "1"
        ))
        print(f"Error: No station matching '{query}'", file=sys.stderr)
        print(f"Available stations:", file=sys.stderr)
        for name in station_names:
            print(f"  - {name}", file=sys.stderr)
        sys.exit(1)

    # Prefer parent stations (location_type=1) to avoid child-stop mismatches
    parents = [m for m in matches if m.get("location_type") == "1"]
    if parents:
        return parents[0]["stop_id"], parents[0]["stop_name"]

    # If only child stops matched, resolve to their parent
    first = matches[0]
    parent_id = first.get("parent_station", "")
    if parent_id:
        for s in stops:
            if s["stop_id"] == parent_id:
                return s["stop_id"], s["stop_name"]
    return first["stop_id"], first["stop_name"]


def get_active_services(date, calendar, calendar_dates):
    """Determine active service_ids for a given date."""
    day_names = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    day_of_week = day_names[date.weekday()]
    date_str = date.strftime("%Y%m%d")

    active = set()
    for row in calendar:
        start = row["start_date"]
        end = row["end_date"]
        if start <= date_str <= end and row[day_of_week] == "1":
            active.add(row["service_id"])

    for row in calendar_dates:
        if row["date"] == date_str:
            if row["exception_type"] == "1":
                active.add(row["service_id"])
            elif row["exception_type"] == "2":
                active.discard(row["service_id"])

    return active


def get_direction(trip):
    """Determine direction label from trip headsign or direction_id."""
    headsign = trip.get("trip_headsign", "").lower()
    south_keywords = ["larkspur", "san rafael", "san marin", "novato", "petaluma"]
    north_keywords = ["cloverdale", "airport", "santa rosa", "windsor", "healdsburg", "sonoma county"]

    for kw in south_keywords:
        if kw in headsign:
            return "Southbound"
    for kw in north_keywords:
        if kw in headsign:
            return "Northbound"

    # Fall back to direction_id
    did = trip.get("direction_id", "")
    if did == "0":
        return "Southbound"
    elif did == "1":
        return "Northbound"
    return "Unknown"


def format_time(time_str):
    """Convert GTFS time (HH:MM:SS, may be 25:00+) to 12-hour AM/PM."""
    parts = time_str.strip().split(":")
    h, m = int(parts[0]), int(parts[1])
    # Handle past-midnight times
    if h >= 24:
        h -= 24
    period = "AM" if h < 12 else "PM"
    display_h = h % 12
    if display_h == 0:
        display_h = 12
    return f"{display_h}:{m:02d} {period}"


def time_to_minutes(time_str):
    """Convert GTFS time string to minutes since midnight (supports 25:00+)."""
    parts = time_str.strip().split(":")
    return int(parts[0]) * 60 + int(parts[1])


def now_minutes():
    """Current time in minutes since midnight, respecting TZ env var."""
    now = datetime.now()
    return now.hour * 60 + now.minute


def today_date():
    """Today's date, respecting TZ env var."""
    return datetime.now().date()


def cmd_stations(args):
    """List all stations."""
    download_gtfs()
    stops = read_csv("stops.txt")
    # Show only parent stations (location_type=1)
    parents = [s for s in stops if s.get("location_type") == "1"]
    if not parents:
        parents = stops
    print(f"{'Stop ID':<10} {'Station Name'}")
    print("-" * 50)
    for s in sorted(parents, key=lambda x: x["stop_name"]):
        print(f"{s['stop_id']:<10} {s['stop_name']}")


def cmd_trips(args):
    """Show trips between two stations."""
    download_gtfs()

    stops = read_csv("stops.txt")
    trips = read_csv("trips.txt")
    stop_times = read_csv("stop_times.txt")
    calendar = read_csv("calendar.txt")
    calendar_dates = read_csv("calendar_dates.txt")

    from_id, from_name = match_station(args.from_station, stops)
    to_id, to_name = match_station(args.to_station, stops)

    # Determine date
    if args.date:
        date = datetime.strptime(args.date, "%Y-%m-%d").date()
    else:
        date = today_date()

    active_services = get_active_services(date, calendar, calendar_dates)
    if not active_services:
        print(f"No service found for {date.strftime('%A, %B %d, %Y')}.")
        return

    # Filter trips by active service
    active_trip_ids = {}
    for t in trips:
        if t["service_id"] in active_services:
            active_trip_ids[t["trip_id"]] = t

    # Build stop_times index by trip_id — only for trips serving both stations
    # First pass: find which trips serve both stations
    trip_from = {}  # trip_id -> stop_time row for from_station
    trip_to = {}    # trip_id -> stop_time row for to_station

    # Also collect all stop_ids that match (parent + child stops)
    from_ids = {s["stop_id"] for s in stops if s["stop_id"] == from_id or s.get("parent_station") == from_id}
    to_ids = {s["stop_id"] for s in stops if s["stop_id"] == to_id or s.get("parent_station") == to_id}
    from_ids.add(from_id)
    to_ids.add(to_id)

    for st in stop_times:
        tid = st["trip_id"]
        if tid not in active_trip_ids:
            continue
        if st["stop_id"] in from_ids:
            trip_from[tid] = st
        if st["stop_id"] in to_ids:
            trip_to[tid] = st

    # Find trips that serve both stations with correct sequence order
    results = []
    for tid in trip_from:
        if tid not in trip_to:
            continue
        dep = trip_from[tid]
        arr = trip_to[tid]
        dep_seq = int(dep["stop_sequence"])
        arr_seq = int(arr["stop_sequence"])
        if dep_seq >= arr_seq:
            continue  # Wrong direction — from must come before to
        dep_minutes = time_to_minutes(dep["departure_time"])
        arr_minutes = time_to_minutes(arr["arrival_time"])
        if arr_minutes <= dep_minutes:
            continue  # Sanity check

        # Apply time filters
        if args.after:
            after_min = time_to_minutes(args.after + ":00")
            if dep_minutes < after_min:
                continue
        if args.before:
            before_min = time_to_minutes(args.before + ":00")
            if dep_minutes > before_min:
                continue

        direction = get_direction(active_trip_ids[tid])
        travel = arr_minutes - dep_minutes
        results.append({
            "trip_id": tid,
            "depart": dep["departure_time"],
            "arrive": arr["arrival_time"],
            "dep_min": dep_minutes,
            "arr_min": arr_minutes,
            "travel": travel,
            "direction": direction,
        })

    results.sort(key=lambda x: x["dep_min"])

    if not results:
        print(f"No trips found from {from_name} to {to_name} on {date.strftime('%A, %B %d, %Y')}.")
        if args.after or args.before:
            print("Try removing the --after/--before filters.")
        return

    direction = results[0]["direction"]
    print(f"\n{direction.upper()}: {from_name} → {to_name}")
    print(f"Date: {date.strftime('%A, %B %d, %Y')}")
    if active_services:
        print(f"Service IDs: {', '.join(sorted(active_services))}")
    print(f"Found {len(results)} trip(s)\n")

    # Determine "next" train
    current_min = now_minutes() if date == today_date() else -1
    next_marked = False

    print(f"  {'Depart':<10} {'Arrive':<10} {'Travel':<10} {'Trip ID':<15} {'Note'}")
    print(f"  {'-'*10} {'-'*10} {'-'*10} {'-'*15} {'-'*10}")

    for i, r in enumerate(results):
        dep_fmt = format_time(r["depart"])
        arr_fmt = format_time(r["arrive"])
        travel_fmt = f"{r['travel']} min"
        note = ""
        if i == 0:
            note = "FIRST"
        if i == len(results) - 1:
            if note:
                note += " / LAST"
            else:
                note = "LAST"
        if not next_marked and r["dep_min"] >= current_min and current_min >= 0:
            if note:
                note += " ← NEXT"
            else:
                note = "← NEXT"
            next_marked = True
        print(f"  {dep_fmt:<10} {arr_fmt:<10} {travel_fmt:<10} {r['trip_id']:<15} {note}")

    if date == today_date() and not next_marked:
        print(f"\nNo more trains today from {from_name} to {to_name}.")
        # Find tomorrow's first train
        tomorrow = date + timedelta(days=1)
        tmrw_services = get_active_services(tomorrow, calendar, calendar_dates)
        if tmrw_services:
            tmrw_trips = {t["trip_id"]: t for t in trips if t["service_id"] in tmrw_services}
            tmrw_results = []
            for tid in trip_from:
                if tid not in tmrw_trips or tid not in trip_to:
                    continue
                dep = trip_from[tid]
                arr = trip_to[tid]
                if int(dep["stop_sequence"]) >= int(arr["stop_sequence"]):
                    continue
                tmrw_results.append({
                    "depart": dep["departure_time"],
                    "dep_min": time_to_minutes(dep["departure_time"]),
                })
            if tmrw_results:
                tmrw_results.sort(key=lambda x: x["dep_min"])
                print(f"First train tomorrow ({tomorrow.strftime('%A')}): {format_time(tmrw_results[0]['depart'])}")


def cmd_next(args):
    """Show next departures from a station."""
    download_gtfs()

    stops = read_csv("stops.txt")
    trips_data = read_csv("trips.txt")
    stop_times = read_csv("stop_times.txt")
    calendar = read_csv("calendar.txt")
    calendar_dates = read_csv("calendar_dates.txt")

    station_id, station_name = match_station(args.from_station, stops)

    date = today_date()
    active_services = get_active_services(date, calendar, calendar_dates)
    if not active_services:
        print(f"No service found for {date.strftime('%A, %B %d, %Y')}.")
        return

    # Filter trips by service and direction
    active_trip_ids = {}
    for t in trips_data:
        if t["service_id"] in active_services:
            direction = get_direction(t)
            if args.direction:
                dir_lower = args.direction.lower()
                if dir_lower in ("south", "southbound") and direction != "Southbound":
                    continue
                if dir_lower in ("north", "northbound") and direction != "Northbound":
                    continue
            active_trip_ids[t["trip_id"]] = t

    # Collect stop_ids for station (parent + children)
    station_ids = {s["stop_id"] for s in stops if s["stop_id"] == station_id or s.get("parent_station") == station_id}
    station_ids.add(station_id)

    # Find departures
    current_min = now_minutes()
    departures = []
    for st in stop_times:
        if st["trip_id"] not in active_trip_ids:
            continue
        if st["stop_id"] not in station_ids:
            continue
        dep_min = time_to_minutes(st["departure_time"])
        if dep_min < current_min:
            continue
        trip = active_trip_ids[st["trip_id"]]
        departures.append({
            "trip_id": st["trip_id"],
            "depart": st["departure_time"],
            "dep_min": dep_min,
            "direction": get_direction(trip),
            "headsign": trip.get("trip_headsign", ""),
        })

    departures.sort(key=lambda x: x["dep_min"])
    limit = args.limit or 5

    dir_label = ""
    if args.direction:
        dir_label = f" ({args.direction.capitalize()}bound)" if "bound" not in args.direction.lower() else f" ({args.direction.capitalize()})"

    print(f"\nNext departures from {station_name}{dir_label}")
    print(f"Date: {date.strftime('%A, %B %d, %Y')}")
    now_fmt = datetime.now().strftime("%-I:%M %p")
    print(f"Current time: {now_fmt}\n")

    if not departures:
        print("No more departures today.")
        # Check tomorrow
        tomorrow = date + timedelta(days=1)
        tmrw_services = get_active_services(tomorrow, calendar, calendar_dates)
        if tmrw_services:
            tmrw_trips = {}
            for t in trips_data:
                if t["service_id"] in tmrw_services:
                    direction = get_direction(t)
                    if args.direction:
                        dir_lower = args.direction.lower()
                        if dir_lower in ("south", "southbound") and direction != "Southbound":
                            continue
                        if dir_lower in ("north", "northbound") and direction != "Northbound":
                            continue
                    tmrw_trips[t["trip_id"]] = t

            tmrw_deps = []
            for st in stop_times:
                if st["trip_id"] not in tmrw_trips or st["stop_id"] not in station_ids:
                    continue
                tmrw_deps.append({
                    "depart": st["departure_time"],
                    "dep_min": time_to_minutes(st["departure_time"]),
                })
            if tmrw_deps:
                tmrw_deps.sort(key=lambda x: x["dep_min"])
                print(f"First train tomorrow ({tomorrow.strftime('%A')}): {format_time(tmrw_deps[0]['depart'])}")
        return

    shown = departures[:limit]
    print(f"  {'#':<4} {'Depart':<10} {'Direction':<12} {'Headsign'}")
    print(f"  {'-'*4} {'-'*10} {'-'*12} {'-'*20}")
    for i, d in enumerate(shown, 1):
        dep_fmt = format_time(d["depart"])
        marker = " ← NEXT" if i == 1 else ""
        print(f"  {i:<4} {dep_fmt:<10} {d['direction']:<12} {d['headsign']}{marker}")

    remaining = len(departures) - limit
    if remaining > 0:
        print(f"\n  ({remaining} more departure(s) today)")


def main():
    parser = argparse.ArgumentParser(description="SMART Train schedule lookup")
    subparsers = parser.add_subparsers(dest="command", help="Command")

    # stations command
    subparsers.add_parser("stations", help="List all stations")

    # trips command
    trips_parser = subparsers.add_parser("trips", help="Show trips between two stations")
    trips_parser.add_argument("--from", dest="from_station", required=True, help="Departure station")
    trips_parser.add_argument("--to", dest="to_station", required=True, help="Arrival station")
    trips_parser.add_argument("--after", help="Show trips departing after this time (HH:MM)")
    trips_parser.add_argument("--before", help="Show trips departing before this time (HH:MM)")
    trips_parser.add_argument("--date", help="Date to check (YYYY-MM-DD, default today)")

    # next command
    next_parser = subparsers.add_parser("next", help="Show next departures from a station")
    next_parser.add_argument("--from", dest="from_station", required=True, help="Station name")
    next_parser.add_argument("--direction", help="Filter by direction (north/south)")
    next_parser.add_argument("--limit", type=int, default=5, help="Number of departures to show")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    if args.command == "stations":
        cmd_stations(args)
    elif args.command == "trips":
        cmd_trips(args)
    elif args.command == "next":
        cmd_next(args)


if __name__ == "__main__":
    main()
