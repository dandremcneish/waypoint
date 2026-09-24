#!/usr/bin/env python3
"""
Turns a flat list of geocoded places into a day-by-day itinerary.

Approach:
1. Cluster places into N groups (N = number of days) using a simple
   k-means over lat/lon, so each day covers one walkable part of the city
   instead of zig-zagging across town.
2. Within each day's cluster, order stops with a nearest-neighbor walk
   starting from the cluster's most "central" point, so the day flows
   as a sensible route rather than a random order.

This is intentionally dependency-free (no numpy/sklearn) so it runs as-is
inside a GitHub Actions runner with nothing but the standard library.
"""
import json
import math
import random
import sys
from pathlib import Path


def haversine_km(a, b):
    lat1, lon1 = math.radians(a["lat"]), math.radians(a["lon"])
    lat2, lon2 = math.radians(b["lat"]), math.radians(b["lon"])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def kmeans_cluster(places, k, iterations=25, seed=42):
    """Minimal k-means over (lat, lon). Returns a list of cluster indices,
    one per place, and re-runs with re-seeded centroids if a cluster goes
    empty (small-N k-means is prone to that)."""
    rng = random.Random(seed)
    if k >= len(places):
        return list(range(len(places)))

    centroids = [(-1, -1)] * k
    for attempt in range(6):
        centroids = [(p["lat"], p["lon"]) for p in rng.sample(places, k)]
        assignments = [0] * len(places)
        for _ in range(iterations):
            for i, p in enumerate(places):
                dists = [haversine_km(p, {"lat": c[0], "lon": c[1]}) for c in centroids]
                assignments[i] = dists.index(min(dists))

            new_centroids = []
            empty = False
            for c_idx in range(k):
                members = [places[i] for i in range(len(places)) if assignments[i] == c_idx]
                if not members:
                    empty = True
                    break
                avg_lat = sum(m["lat"] for m in members) / len(members)
                avg_lon = sum(m["lon"] for m in members) / len(members)
                new_centroids.append((avg_lat, avg_lon))
            if empty:
                break
            centroids = new_centroids
        else:
            return assignments
        # empty cluster hit -> retry with a different seed
        continue
    # fallback: round-robin assignment if k-means kept collapsing
    return [i % k for i in range(len(places))]


def order_by_nearest_neighbor(places):
    if not places:
        return []
    # start from the place closest to the group's centroid (a sensible "first stop")
    avg_lat = sum(p["lat"] for p in places) / len(places)
    avg_lon = sum(p["lon"] for p in places) / len(places)
    centroid = {"lat": avg_lat, "lon": avg_lon}
    remaining = places[:]
    remaining.sort(key=lambda p: haversine_km(p, centroid))
    route = [remaining.pop(0)]
    while remaining:
        last = route[-1]
        remaining.sort(key=lambda p: haversine_km(p, last))
        route.append(remaining.pop(0))
    return route


def best_of_n_clusters(places, k, tries=40):
    """Small-N k-means is sensitive to its random start (a bad seed can
    lump geographically distant places into one day). Run it `tries` times
    with different seeds and keep the assignment with the lowest total
    distance from each place to its own cluster's centroid, rather than
    trusting whichever seed happened to run first."""
    best_assignments, best_score = None, None
    for seed in range(tries):
        assignments = kmeans_cluster(places, k, seed=seed)
        groups = {}
        for p, c in zip(places, assignments):
            groups.setdefault(c, []).append(p)
        score = 0.0
        for members in groups.values():
            if len(members) < 2:
                continue
            avg_lat = sum(m["lat"] for m in members) / len(members)
            avg_lon = sum(m["lon"] for m in members) / len(members)
            centroid = {"lat": avg_lat, "lon": avg_lon}
            score += sum(haversine_km(m, centroid) for m in members)
        if best_score is None or score < best_score:
            best_score, best_assignments = score, assignments
    return best_assignments


def build_itinerary(data, days):
    places = data["places"]
    assignments = best_of_n_clusters(places, days)

    day_groups = {d: [] for d in range(days)}
    for place, cluster in zip(places, assignments):
        day_groups[cluster].append(place)

    itinerary = []
    for d in range(days):
        ordered = order_by_nearest_neighbor(day_groups[d])
        total_km = sum(
            haversine_km(ordered[i], ordered[i + 1]) for i in range(len(ordered) - 1)
        )
        itinerary.append({
            "day": d + 1,
            "stops": ordered,
            "walking_km": round(total_km, 1),
        })

    # sort days so Day 1 starts near the city centroid (nice default ordering)
    itinerary.sort(key=lambda d: len(d["stops"]), reverse=True)
    for i, d in enumerate(itinerary):
        d["day"] = i + 1

    return itinerary


def main():
    if len(sys.argv) < 2:
        print("Usage: build_itinerary.py <data.json> [days]")
        sys.exit(1)

    path = Path(sys.argv[1])
    days = int(sys.argv[2]) if len(sys.argv) > 2 else 4

    data = json.loads(path.read_text())
    itinerary = build_itinerary(data, days)

    out = {
        "destination": data["destination"],
        "generated_at": data.get("generated_at"),
        "weather": data.get("weather"),
        "days": days,
        "itinerary": itinerary,
    }

    # Overwrite the same file in place with the itinerary-shaped JSON the
    # frontend actually consumes (safe: the raw data was already fully read
    # into `data` above before this write happens).
    path.write_text(json.dumps(out, indent=2))
    print(f"Wrote {path} ({sum(len(d['stops']) for d in itinerary)} stops across {days} days)")


if __name__ == "__main__":
    main()
