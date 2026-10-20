"""Download critical infrastructure for Kenya from OpenStreetMap via Overpass (ODbL)."""
import json
import pathlib
import time

import requests

RAW = pathlib.Path(__file__).resolve().parent.parent / "raw"
URL = "https://overpass-api.de/api/interpreter"
UA = {"User-Agent": "kenya-infra-risk/0.1 (research; github.com/manmeet3591)"}
AREA = 'area["ISO3166-1"="KE"][admin_level=2]->.k;'

# category -> Overpass selectors (nodes/ways/relations, returned as centroids)
CATEGORIES = {
    "power_plant": ['nwr["power"="plant"](area.k);'],
    "substation": ['nwr["power"="substation"](area.k);'],
    "hospital": ['nwr["amenity"="hospital"](area.k);'],
    "telecom": [
        'nwr["man_made"~"^(mast|tower)$"]["tower:type"="communication"](area.k);',
        'nwr["communication:mobile_phone"="yes"](area.k);',
    ],
    "fuel_depot": [
        'nwr["industrial"~"oil|fuel|petroleum"](area.k);',
        'nwr["man_made"="storage_tank"]["content"~"fuel|oil|petrol|diesel"](area.k);',
        'nwr["landuse"="industrial"]["name"~"Pipeline|Petroleum|Oil Depot|Fuel Depot|KPC",i](area.k);',
    ],
    "airport": ['nwr["aeroway"="aerodrome"]["iata"](area.k);', 'nwr["aeroway"="aerodrome"]["icao"](area.k);'],
    "port": ['nwr["harbour"="yes"](area.k);', 'nwr["industrial"="port"](area.k);', 'nwr["landuse"="port"](area.k);'],
    "water": ['nwr["man_made"~"^(water_works|wastewater_plant)$"](area.k);', 'nwr["waterway"="dam"]["name"](area.k);'],
}
KEEP_TAGS = ["name", "operator", "voltage", "plant:source", "plant:output:electricity", "healthcare",
             "beds", "iata", "icao", "substation", "content", "emergency"]


def overpass(query, tries=4):
    for i in range(tries):
        r = requests.post(URL, data={"data": query}, headers=UA, timeout=300)
        if r.status_code == 200:
            return r.json()["elements"]
        print(f"  overpass {r.status_code}, retry {i + 1}")
        time.sleep(30 * (i + 1))
    raise RuntimeError("overpass failed")


def fetch_points():
    feats, seen = [], set()
    for cat, sels in CATEGORIES.items():
        q = f"[out:json][timeout:240];{AREA}({''.join(sels)});out center tags;"
        els = overpass(q)
        n = 0
        for e in els:
            key = (e["type"], e["id"])
            if key in seen:
                continue
            seen.add(key)
            lon, lat = (e["lon"], e["lat"]) if "lon" in e else (e["center"]["lon"], e["center"]["lat"])
            tags = e.get("tags", {})
            props = {"cat": cat, "osm": f"{e['type']}/{e['id']}"}
            props.update({k: tags[k] for k in KEEP_TAGS if k in tags})
            feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]},
                          "properties": props})
            n += 1
        print(f"{cat}: {n}")
        time.sleep(5)
    return feats


def fetch_lines():
    q = f'[out:json][timeout:240];{AREA}way["power"="line"](area.k);out geom tags;'
    feats = []
    for e in overpass(q):
        coords = [[round(p["lon"], 4), round(p["lat"], 4)] for p in e.get("geometry", [])]
        if len(coords) < 2:
            continue
        tags = e.get("tags", {})
        feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords},
                      "properties": {"osm": f"way/{e['id']}", "voltage": tags.get("voltage"), "name": tags.get("name"),
                                     "operator": tags.get("operator")}})
    print(f"transmission line segments: {len(feats)}")
    return feats


def main():
    RAW.mkdir(exist_ok=True)
    pts = fetch_points()
    (RAW / "assets.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": pts}))
    lines = fetch_lines()
    (RAW / "lines.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": lines}))


if __name__ == "__main__":
    main()
