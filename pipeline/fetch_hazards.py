"""Download daily NASA POWER (MERRA-2 based, ~0.5 deg) grids over Kenya, 2001-2024."""
import json
import pathlib
import time

import requests

RAW = pathlib.Path(__file__).resolve().parent.parent / "raw" / "power"
PARAMS = ["WS10M_MAX", "PRECTOTCORR", "T2M_MAX"]
BBOX = dict(lonmin=33.5, lonmax=42.0, latmin=-5.0, latmax=5.0)  # regional API max 10x10 deg
YEARS = range(2001, 2025)


def fetch(param, year):
    out = RAW / f"{param}_{year}.json"
    if out.exists():
        return
    url = ("https://power.larc.nasa.gov/api/temporal/daily/regional"
           f"?parameters={param}&community=RE&longitude-min={BBOX['lonmin']}&longitude-max={BBOX['lonmax']}"
           f"&latitude-min={BBOX['latmin']}&latitude-max={BBOX['latmax']}&start={year}0101&end={year}1231&format=JSON")
    for i in range(5):
        try:
            r = requests.get(url, timeout=600)
            if r.status_code == 200:
                data = r.json()
                slim = [{"lon": f["geometry"]["coordinates"][0], "lat": f["geometry"]["coordinates"][1],
                         "v": list(f["properties"]["parameter"][param].values())} for f in data["features"]]
                out.write_text(json.dumps(slim))
                print(f"{param} {year}: {len(slim)} cells")
                return
            print(f"{param} {year}: HTTP {r.status_code}")
        except requests.RequestException as e:
            print(f"{param} {year}: {e}")
        time.sleep(20 * (i + 1))
    raise RuntimeError(f"failed {param} {year}")


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    for p in PARAMS:
        for y in YEARS:
            fetch(p, y)


if __name__ == "__main__":
    main()
