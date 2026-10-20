"""Download Kenya county (ADM1) boundaries from geoBoundaries (CC BY 4.0)."""
import json
import pathlib

import requests

RAW = pathlib.Path(__file__).resolve().parent.parent / "raw"


def main():
    meta = requests.get("https://www.geoboundaries.org/api/current/gbOpen/KEN/ADM1/", timeout=60).json()
    gj = requests.get(meta["simplifiedGeometryGeoJSON"], timeout=120).json()
    for f in gj["features"]:
        f["properties"] = {"name": f["properties"].get("shapeName"), "id": f["properties"].get("shapeID")}
    RAW.mkdir(exist_ok=True)
    (RAW / "counties.geojson").write_text(json.dumps(gj))
    print(f"counties: {len(gj['features'])}")


if __name__ == "__main__":
    main()
