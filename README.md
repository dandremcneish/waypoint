# Waypoint — a trip planner that builds a real itinerary from real data, for anywhere in the world

**[Live demo](https://dandremcneish.github.io/waypoint/)**

Most trip planners hand you a wall of filters and hotel ads. Waypoint does the opposite: type any city on earth, and it hands back a day-by-day itinerary that's already grouped so you're not zig-zagging across town — built entirely from live, freely-licensed data. No API keys, no paid services, no login walls.

## How search works

Typing a city and hitting **Plan trip** runs a small pipeline live, in the browser, in a few seconds:

1. **Geocode** the city with [Nominatim](https://nominatim.org/) (OpenStreetMap's free geocoder).
2. **Pull named landmarks** — museums, monuments, parks, viewpoints, places of worship — near that point from the [Overpass API](https://overpass-api.de/) (OpenStreetMap's query engine), filtered to skip noise like zoo enclosures or unnamed nodes. Requests are spread across a few public Overpass mirrors with retry/backoff, since the free instances rate-limit heavily.
3. **Enrich** the most notable landmarks with a real description and photo from the [Wikipedia REST API](https://www.mediawiki.org/wiki/API:REST_API).
4. **Pull a live 7-day forecast** from [Open-Meteo](https://open-meteo.com/).
5. **Cluster** the landmarks into day-sized geographic groups with a small dependency-free k-means implementation, run 40 times with different random seeds and keeping whichever run produced the tightest (lowest-distance) clusters — a single k-means pass on a small point set is prone to lumping distant places together into one "day."
6. **Order each day's stops** with a nearest-neighbor walk from the cluster's centroid, so the day flows as an actual route instead of a random list.

A handful of cities (currently Paris) also ship pre-built in `data/*.json`, refreshed weekly by a GitHub Actions pipeline (`.github/workflows/refresh-data.yml`, `etl/`), so those load instantly with zero live API calls. Everything else is fetched live the moment you search for it — the same clustering code runs both as a Python offline job (`etl/build_itinerary.py`) and ported to JS in `app.js`, so a brand-new city gets the same quality itinerary without waiting on a pipeline run.

The frontend (`index.html` / `app.js` / `styles.css`) is a dependency-free single-page app: a day tab per cluster, a card per stop with its real photo and link, and native HTML5 drag-and-drop so you can reorder or swap stops by hand.

## Why it's built this way

This started as a personal trip-planning tool but the underlying shape is a genuine small data pipeline: geocode → collect → filter → enrich → cluster → publish, with the same "don't trust the first result" instinct as the rest of my data engineering work. Two examples that came up building this:

- **Overpass noise.** A naive bounding-box query for "everything tagged tourism" in a dense city returns hundreds of results — individual zoo enclosures, park benches, information boards — that drown out the landmarks people actually want. The query is scoped to specific tag values and requires a `name` tag, and known-noisy categories are excluded outright.
- **k-means on small point sets.** A single random initialization occasionally produces a day that groups Montmartre (far north Paris) with the Louvre (central), which is obviously not how anyone would walk the city. Running 40 seeds and keeping the tightest clustering fixes it — the same fix documented in this project's capstone-style validation work elsewhere in my portfolio.

## Repo layout

```
index.html, styles.css, app.js   # frontend + live client-side search pipeline
data/<destination>.json          # pre-built itinerary data for quick-pick cities
etl/
  fetch_destination.py           # geocode + enrich + weather, keyless APIs only
  build_itinerary.py             # k-means clustering + route ordering (Python, offline)
  main.py                        # orchestrator: fetch, then rebuild itineraries
  destinations.json              # landmark list per pre-built destination
.github/workflows/refresh-data.yml
```

## Adding a pre-built quick-pick city

Add an entry to `etl/destinations.json` (a label, a list of landmark names, and a center lat/lon), then either wait for the weekly Action or run it manually from the Actions tab. Add the matching entry to `QUICK_PICKS` in `app.js`. Everything else already works without this step — it's purely an instant-load convenience for a few cities.

## Running the pipeline locally

```bash
python3 etl/main.py
```

Requires only the Python standard library. Nominatim's usage policy caps requests at 1/second, so a full refresh takes a few seconds per destination — that's already handled by the script.
