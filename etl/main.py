#!/usr/bin/env python3
"""Orchestrator: refresh every destination's raw data, then rebuild its itinerary."""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent


def main():
    subprocess.run([sys.executable, str(HERE / "fetch_destination.py")], check=True)

    destinations = json.loads((HERE / "destinations.json").read_text())
    for key in destinations:
        data_path = HERE.parent / "data" / f"{key}.json"
        if not data_path.exists():
            print(f"Skipping itinerary for {key}: no data file")
            continue
        subprocess.run(
            [sys.executable, str(HERE / "build_itinerary.py"), str(data_path), "4"],
            check=True,
        )


if __name__ == "__main__":
    main()
