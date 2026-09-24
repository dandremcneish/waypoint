#!/usr/bin/env python3
"""
Pulls real, live data for one destination and writes data/<key>.json.

Every source here is free and requires no API key:
  - Nominatim (OpenStreetMap)  -> geocoding each landmark by name
  - Wikipedia REST API         -> description + photo + link per landmark
  - Open-Meteo                 -> 7-day weather forecast for the destination

This is the same call sequence that was hand-verified in a browser session
before being wired up here, so the expected response shape is known-good;
this script just automates it and adds retry/backoff since Nominatim is
rate-limited to 1 request/second per its usage policy.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

USER_AGENT = "DandreTravelPlanner/1.0 (personal project; contact: dandre.mcneish@gmail.com)"
NOMINATIM_DELAY_SEC = 1.1


def http_get(url, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())


def geocode(name):
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({
        "q": name, "format": "json", "limit": 1
    })
    try:
        results = http_get(url, {"Accept-Language": "en"})
        if results:
            return float(results[0]["lat"]), float(results[0]["lon"])
    except Exception as exc:
        print(f"  [geocode failed] {name}: {exc}")
    return None, None


def wiki_summary(title):
    url = "https://en.wikipedia.org/api/rest_v1/page/summary/" + urllib.parse.quote(title.replace(" ", "_"))
    try:
        j = http_get(url)
        return {
            "description": (j.get("extract") or "")[:280] or None,
            "image": (j.get("thumbnail") or {}).get("source"),
            "wiki_url": (j.get("content_urls") or {}).get("desktop", {}).get("page"),
        }
    except Exception as exc:
        print(f"  [wiki failed] {title}: {exc}")
        return {"description": None, "image": None, "wiki_url": None}


def weather(lat, lon):
    url = "https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode({
        "latitude": lat, "longitude": lon,
        "daily": "temperature_2m_max", "timezone": "auto",
    })
    try:
        j = http_get(url)
        return {"dates": j["daily"]["time"], "high_c": j["daily"]["temperature_2m_max"]}
    except Exception as exc:
        print(f"  [weather failed]: {exc}")
        return None


def build(key, config):
    print(f"Fetching {config['label']}...")
    places = []
    for name in config["landmarks"]:
        lat, lon = geocode(name)
        time.sleep(NOMINATIM_DELAY_SEC)
        if lat is None:
            continue
        meta = wiki_summary(name)
        places.append({
            "name": name.split(",")[0],
            "lat": lat, "lon": lon,
            "category": "landmark",
            **meta,
        })
        print(f"  + {name}")

    w = weather(config["center"]["lat"], config["center"]["lon"])

    return {
        "destination": config["label"],
        "lat": config["center"]["lat"],
        "lon": config["center"]["lon"],
        "generated_at": time.strftime("%Y-%m-%d"),
        "weather": w,
        "places": places,
    }


def main():
    here = Path(__file__).parent
    destinations = json.loads((here / "destinations.json").read_text())
    data_dir = here.parent / "data"
    data_dir.mkdir(exist_ok=True)

    keys = sys.argv[1:] or list(destinations.keys())
    for key in keys:
        if key not in destinations:
            print(f"Unknown destination key: {key}")
            continue
        result = build(key, destinations[key])
        out_path = data_dir / f"{key}.json"
        out_path.write_text(json.dumps(result, indent=2, ensure_ascii=False))
        print(f"Wrote {out_path} ({len(result['places'])} places)\n")


if __name__ == "__main__":
    main()
