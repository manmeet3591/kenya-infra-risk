"""Combine NASA POWER hazards, OSM infrastructure and county boundaries into dashboard data.

Outputs (docs/data/):
  counties.geojson  county polygons + hazard metrics, hazard ranks, asset exposure, yearly series
  assets.geojson    critical assets + hazard ranks of their grid cell + county
  lines.geojson     power lines (for display)
  grid.json         hazard grid cells (for the hazard raster layer)
  meta.json         thresholds, sources, build info
"""
import datetime
import json
import math
import pathlib

from geo import CountyIndex, centroid, haversine_km

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW, OUT = ROOT / "raw", ROOT / "docs" / "data"
YEARS = list(range(2001, 2025))
MISSING = -900

# Thresholds (MERRA-2 is ~50 km, so extremes are smoothed; thresholds are set accordingly)
WIND_T = 10.0   # m/s daily max 10 m wind
RAIN_T = 30.0   # mm/day
HEAT_T = 35.0   # deg C daily max temperature
DROUGHT_FRAC = 0.75  # season total below 75% of the long-term mean = failed season
RAIN_QC_MAX = 200.0  # mm/day; larger cell-mean values are known PRECTOTCORR artefacts -> treated as missing


def load_param(param, qc_max=None):
    """-> {(lon,lat): {year: [daily values]}}; values above qc_max become missing."""
    cells, dropped = {}, 0
    for y in YEARS:
        for c in json.loads((RAW / "power" / f"{param}_{y}.json").read_text()):
            v = c["v"]
            if qc_max is not None:
                dropped += sum(1 for x in v if x > qc_max)
                v = [MISSING - 1 if x > qc_max else x for x in v]
            cells.setdefault((c["lon"], c["lat"]), {})[y] = v
    if dropped:
        print(f"{param}: {dropped} daily values > {qc_max} set missing")
    return cells


def median(xs):
    s = sorted(xs)
    n = len(s)
    return (s[n // 2] + s[(n - 1) // 2]) / 2


def valid(vals):
    return [v for v in vals if v is not None and v > MISSING]


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def slope(ys):
    xs = list(range(len(ys)))
    mx, my = mean(xs), mean(ys)
    den = sum((x - mx) ** 2 for x in xs)
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den


def season_totals(daily, year):
    """MAM (long rains) and OND (short rains) totals; day-of-year based."""
    leap = year % 4 == 0
    o = 1 if leap else 0
    mam = sum(valid(daily[59 + o:151 + o]))
    ond = sum(valid(daily[273 + o:365 + o]))
    return mam, ond


def cell_metrics(wind, rain, tmax):
    m = {}
    w_annmax = [max(valid(wind[y])) for y in YEARS]
    m["wind_annmax"] = median(w_annmax)
    m["wind_days"] = mean([sum(v >= WIND_T for v in valid(wind[y])) for y in YEARS])
    r_annmax = [max(valid(rain[y])) for y in YEARS]
    m["rain_annmax"] = median(r_annmax)
    m["rain_days"] = mean([sum(v >= RAIN_T for v in valid(rain[y])) for y in YEARS])
    heat_days = [sum(v >= HEAT_T for v in valid(tmax[y])) for y in YEARS]
    m["heat_days"] = mean(heat_days)
    m["tmax_trend"] = slope([mean(valid(tmax[y])) for y in YEARS]) * 10  # deg C / decade
    seasons = [season_totals(rain[y], y) for y in YEARS]
    mam_mean, ond_mean = mean([s[0] for s in seasons]), mean([s[1] for s in seasons])
    fails = 0
    for mam, ond in seasons:
        fails += (mam < DROUGHT_FRAC * mam_mean) + (ond < DROUGHT_FRAC * ond_mean)
    m["season_fail"] = fails / (2 * len(YEARS))  # fraction of rainy seasons that failed
    m["rain_annual"] = mean([sum(valid(rain[y])) for y in YEARS])
    series = {"heat_days": heat_days, "wind_annmax": w_annmax,
              "rain_total": [sum(valid(rain[y])) for y in YEARS]}
    return m, series


def pct_rank(values):
    """Percentile rank (0..1) of each value within the list."""
    s = sorted(values)
    n = len(s)
    out = []
    for v in values:
        lo = sum(1 for x in s if x < v)
        eq = sum(1 for x in s if x == v)
        out.append((lo + 0.5 * eq) / n)
    return out


def r(x, d=2):
    return None if x is None else round(x, d)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    counties = json.loads((RAW / "counties.geojson").read_text())["features"]
    cidx = CountyIndex(counties)
    wind, rain, tmax = load_param("WS10M_MAX"), load_param("PRECTOTCORR", RAIN_QC_MAX), load_param("T2M_MAX")

    # --- per-cell metrics (only cells whose centre is in Kenya) ---------------------------
    cells = []
    for key in wind:
        lon, lat = key
        c = cidx.find(lon, lat)
        if c is None:
            continue
        m, series = cell_metrics(wind[key], rain[key], tmax[key])
        cells.append({"lon": lon, "lat": lat, "county": c["properties"]["name"], "m": m, "series": series})
    print(f"land cells: {len(cells)}")

    # hazard ranks across Kenya cells
    def ranks(metric):
        return pct_rank([c["m"][metric] for c in cells])

    rk = {k: ranks(k) for k in ["wind_annmax", "wind_days", "rain_annmax", "rain_days", "heat_days", "tmax_trend",
                                "season_fail"]}
    for i, c in enumerate(cells):
        c["h"] = {
            "wind": (rk["wind_annmax"][i] + rk["wind_days"][i]) / 2,
            "flood": (rk["rain_annmax"][i] + rk["rain_days"][i]) / 2,
            "heat": (rk["heat_days"][i] + rk["tmax_trend"][i]) / 2,
            "drought": rk["season_fail"][i],
        }

    def nearest_cell(lon, lat):
        return min(cells, key=lambda c: (c["lon"] - lon) ** 2 + (c["lat"] - lat) ** 2)

    # --- assets ---------------------------------------------------------------------------
    assets = json.loads((RAW / "assets.geojson").read_text())["features"]
    kept = []
    for a in assets:
        lon, lat = a["geometry"]["coordinates"]
        c = cidx.find(lon, lat)
        if c is None:
            continue
        cell = nearest_cell(lon, lat)
        a["properties"]["county"] = c["properties"]["name"]
        a["properties"]["h"] = {k: r(v, 3) for k, v in cell["h"].items()}
        kept.append(a)
    print(f"assets in Kenya: {len(kept)}")

    # --- power lines: length per county, by midpoint ------------------------------------
    lines = json.loads((RAW / "lines.geojson").read_text())["features"]
    line_km, hv_km = {}, {}
    for f in lines:
        co = f["geometry"]["coordinates"]
        try:
            kv = max(int(v) for v in (f["properties"].get("voltage") or "0").split(";") if v.strip().isdigit()) / 1000
        except ValueError:
            kv = 0
        f["properties"]["kv"] = kv
        for p, q in zip(co[:-1], co[1:]):
            c = cidx.find((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
            if c is None:
                continue
            n = c["properties"]["name"]
            d = haversine_km(p[0], p[1], q[0], q[1])
            line_km[n] = line_km.get(n, 0) + d
            if kv >= 132:
                hv_km[n] = hv_km.get(n, 0) + d

    # --- counties -------------------------------------------------------------------------
    cats = sorted({a["properties"]["cat"] for a in kept})
    for f in counties:
        name = f["properties"]["name"]
        mine = [c for c in cells if c["county"] == name]
        if not mine:
            mine = [nearest_cell(*centroid(f["geometry"]))]
        p = f["properties"]
        p["n_cells"] = len(mine)
        p["metrics"] = {k: r(mean([c["m"][k] for c in mine]), 3) for k in mine[0]["m"]}
        p["h"] = {k: r(mean([c["h"][k] for c in mine]), 3) for k in mine[0]["h"]}
        p["series"] = {k: [r(mean([c["series"][k][i] for c in mine]), 1) for i in range(len(YEARS))]
                       for k in mine[0]["series"]}
        p["assets"] = {cat: sum(1 for a in kept if a["properties"]["county"] == name and a["properties"]["cat"] == cat)
                       for cat in cats}
        p["line_km"] = r(line_km.get(name, 0), 1)
        p["hv_line_km"] = r(hv_km.get(name, 0), 1)

    # --- write ----------------------------------------------------------------------------
    def dump(name, obj):
        (OUT / name).write_text(json.dumps(obj, separators=(",", ":")))

    dump("counties.geojson", {"type": "FeatureCollection", "features": counties})
    dump("assets.geojson", {"type": "FeatureCollection", "features": kept})
    dump("lines.geojson", {"type": "FeatureCollection", "features": lines})
    dump("grid.json", [{"lon": c["lon"], "lat": c["lat"], "county": c["county"],
                        "h": {k: r(v, 3) for k, v in c["h"].items()},
                        "m": {k: r(v, 2) for k, v in c["m"].items()}} for c in cells])
    dump("meta.json", {
        "built": datetime.date.today().isoformat(), "years": [YEARS[0], YEARS[-1]],
        "thresholds": {"wind_ms": WIND_T, "rain_mm": RAIN_T, "heat_c": HEAT_T, "drought_frac": DROUGHT_FRAC},
        "grid_deg": [0.625, 0.5], "categories": cats,
        "sources": {
            "hazards": "NASA POWER daily (MERRA-2), 2001-2024: WS10M_MAX, PRECTOTCORR, T2M_MAX",
            "infrastructure": "OpenStreetMap contributors via Overpass API (ODbL)",
            "boundaries": "geoBoundaries gbOpen KEN ADM1 (CC BY 4.0)",
        },
    })
    for name in ["counties.geojson", "assets.geojson", "lines.geojson", "grid.json"]:
        print(f"{name}: {(OUT / name).stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
