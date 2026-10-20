# Kenya Critical Infrastructure Risk

An interactive multi-hazard risk map of Kenya's critical energy and lifeline infrastructure: power plants, substations, transmission lines, fuel depots, ports, airports, hospitals, water works and telecom masts. It scores each county by wind, extreme rainfall, heat and drought hazard from the 2001–2024 climate record.

**Live dashboard:** https://manmeet3591.github.io/kenya-infra-risk/ (once GitHub Pages is enabled)

Prototype by the Disaster Science Operations Center. It is the first of a series of AI weather-to-impact tools for the energy sector; power outage and restoration-time prediction comes next.

## What it shows

- **Risk = √(Hazard × Exposure)** per county, 0–100.
- **Hazard**: the weighted mean of four hazard indices, each a percentile among Kenyan grid cells. You set the weights in the dashboard.
  - *Wind*: median annual max of daily max 10 m wind, and days ≥ 10 m/s.
  - *Extreme rain*: median annual max 1-day rainfall, and days ≥ 30 mm.
  - *Heat*: days with Tmax ≥ 35 °C, and the Tmax trend (°C/decade).
  - *Drought*: share of failed long-rains (MAM) and short-rains (OND) seasons, below 75% of the mean.
- **Exposure**: a weighted asset count plus HV (≥132 kV) line length, ranked across counties.
- Every asset is coloured by the hazard at its site. Click a county for its hazard profile, its 2001–2024 climate series and its most exposed key assets.

## Data

| Layer | Source | License |
|---|---|---|
| Hazards | [NASA POWER](https://power.larc.nasa.gov/) daily (MERRA-2, ~0.5°×0.625°): `WS10M_MAX`, `PRECTOTCORR`, `T2M_MAX` | Public |
| Infrastructure | [OpenStreetMap](https://www.openstreetmap.org/) via Overpass API | ODbL |
| County boundaries | [geoBoundaries](https://www.geoboundaries.org/) gbOpen KEN ADM1 | CC BY 4.0 |

Daily rainfall values above 200 mm in a ~55 km cell are treated as data artefacts. PRECTOTCORR has spurious 1000+ mm/day spikes over arid northeast Kenya.

## Rebuild the data

Pure Python 3 with `requests`; no numpy or GIS stack needed.

```bash
python3 pipeline/fetch_counties.py        # geoBoundaries
python3 pipeline/fetch_infrastructure.py  # OSM / Overpass (a few minutes)
python3 pipeline/fetch_hazards.py         # NASA POWER, 3 params x 24 years
cd pipeline && python3 build_risk.py      # -> docs/data/*
```

Preview locally:

```bash
python3 -m http.server -d docs 8000
```

## Roadmap

1. Replace MERRA-2 hazards with AI-downscaled 1 km fields (Aircast SR, and diffusion downscaling of CMIP6 for 2040/2060 scenarios).
2. Ingest utility asset registers (KPLC, KETRACO, KenGen, KPC) to fill OSM gaps.
3. Add flood depth, landslide susceptibility and lightning density.
4. Link to the outage and restoration-time prediction model, moving from static risk to event-based impact forecasts.

## Limitations

This is a screening tool, not an engineering assessment. OSM coverage is uneven across counties, and MERRA-2 resolution smooths local extremes. Coastal cells mix land and ocean, so coastal heat statistics (e.g. Mombasa's cooling Tmax trend) are suspect until station data or the 1 km fields replace them.
