"""
San Diego Temperature vs The World: data pipeline
=================================================
Pulls monthly near-surface air temperature (tas) from the public CMIP6 archive
on Google Cloud (the course's CMIP6 source), for 5 climate models, and writes
one small JSON file the D3 site loads.

Best place to run it: Google Colab (Google Cloud access works there).
    !pip install -q gcsfs zarr xarray pandas dask
    !python fetch_cmip6.py
It takes roughly 10-25 minutes (it streams a few GB from Google Cloud).

Output: data/cities.json
    For every city (plus a "Global average"), and for every model:
      - yearly temperature change vs that model's 1850-1900 average (deg C)
        historical 1850-2014, then SSP2-4.5 and SSP5-8.5 for 2015-2100
      - the model's 1850-1900 average temperature in deg C (absolute)
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import xarray as xr

CATALOG = "https://storage.googleapis.com/cmip6/pangeo-cmip6.csv"
EXPERIMENTS = ["historical", "ssp245", "ssp585"]
# Tried in order until 5 models with all three experiments are found
MODEL_PREFERENCE = [
    "CESM2", "GFDL-ESM4", "MPI-ESM1-2-LR", "UKESM1-0-LL", "IPSL-CM6A-LR",
    "MIROC6", "CanESM5", "ACCESS-CM2", "NorESM2-LM", "MRI-ESM2-0",
]
N_MODELS = 5
BASELINE = (1850, 1900)

CITIES = [  # name, country, lat, lon
    ("San Diego", "USA", 32.72, -117.16),
    ("Los Angeles", "USA", 34.05, -118.24),
    ("Phoenix", "USA", 33.45, -112.07),
    ("Chicago", "USA", 41.88, -87.63),
    ("New York", "USA", 40.71, -74.01),
    ("Toronto", "Canada", 43.65, -79.38),
    ("Mexico City", "Mexico", 19.43, -99.13),
    ("Lima", "Peru", -12.05, -77.04),
    ("São Paulo", "Brazil", -23.55, -46.63),
    ("Buenos Aires", "Argentina", -34.60, -58.38),
    ("London", "UK", 51.51, -0.13),
    ("Paris", "France", 48.86, 2.35),
    ("Moscow", "Russia", 55.76, 37.62),
    ("Cairo", "Egypt", 30.04, 31.24),
    ("Lagos", "Nigeria", 6.52, 3.38),
    ("Nairobi", "Kenya", -1.29, 36.82),
    ("Dubai", "UAE", 25.20, 55.27),
    ("Mumbai", "India", 19.08, 72.88),
    ("Delhi", "India", 28.61, 77.21),
    ("Singapore", "Singapore", 1.35, 103.82),
    ("Beijing", "China", 39.90, 116.40),
    ("Seoul", "South Korea", 37.57, 126.98),
    ("Tokyo", "Japan", 35.68, 139.69),
    ("Sydney", "Australia", -33.87, 151.21),
]

OUT = Path(__file__).resolve().parent.parent / "data" / "cities.json"
if not OUT.parent.exists():          # e.g. running the file alone in Colab
    OUT = Path("cities.json")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def pick_models(cat):
    """Choose 5 models that have monthly tas for all experiments with one shared member."""
    tas = cat[(cat.table_id == "Amon") & (cat.variable_id == "tas")]
    chosen = []
    for model in MODEL_PREFERENCE:
        sub = tas[tas.source_id == model]
        members = None
        for exp in EXPERIMENTS:
            m = set(sub[sub.experiment_id == exp].member_id)
            members = m if members is None else members & m
        if not members:
            log(f"  {model}: missing an experiment, skipped")
            continue
        # prefer r1i1p1f1, then any r1, then the first alphabetically
        member = sorted(members, key=lambda s: (s != "r1i1p1f1", not s.startswith("r1i"), s))[0]
        stores = {}
        for exp in EXPERIMENTS:
            rows = sub[(sub.experiment_id == exp) & (sub.member_id == member)]
            rows = rows.sort_values("version") if "version" in rows else rows
            stores[exp] = rows.zstore.iloc[-1]
        chosen.append((model, member, stores))
        log(f"  {model} ({member}) selected")
        if len(chosen) == N_MODELS:
            break
    if len(chosen) < N_MODELS:
        log(f"Only found {len(chosen)} models; continuing with those.")
    return chosen


def open_tas(zstore):
    ds = xr.open_zarr(zstore, consolidated=True, storage_options={"token": "anon"})
    da = ds["tas"]
    # standardize coordinate names
    ren = {c: n for c, n in [("latitude", "lat"), ("longitude", "lon")] if c in da.dims}
    return da.rename(ren)


def annual(da):
    """Monthly -> calendar-year mean, indexed by integer year."""
    out = da.groupby("time.year").mean("time")
    return out


def city_points(da):
    lons = np.array([c[3] for c in CITIES])
    if float(da.lon.max()) > 180:      # model uses 0..360
        lons = np.mod(lons, 360)
    lat_i = xr.DataArray([c[2] for c in CITIES], dims="city")
    lon_i = xr.DataArray(lons, dims="city")
    return da.sel(lat=lat_i, lon=lon_i, method="nearest")


def global_mean(da):
    w = np.cos(np.deg2rad(da.lat))
    return da.weighted(w).mean(("lat", "lon"))


def main():
    log("Reading the CMIP6 catalog...")
    cat = pd.read_csv(CATALOG)
    models = pick_models(cat)
    if not models:
        sys.exit("No models found. Check the catalog URL / internet access.")

    result = {
        "source": "CMIP6 via Google Cloud public archive (pangeo-cmip6), variable tas, table Amon",
        "baseline": list(BASELINE),
        "scenarios": {"ssp245": "SSP2-4.5 (middle of the road)", "ssp585": "SSP5-8.5 (high emissions)"},
        "models": [m for m, _, _ in models],
        "members": {m: mem for m, mem, _ in models},
        "years_hist": list(range(1850, 2015)),
        "years_ssp": list(range(2015, 2101)),
        "cities": [{"name": n, "country": c, "lat": la, "lon": lo,
                    "base": {}, "historical": {}, "ssp245": {}, "ssp585": {}}
                   for n, c, la, lo in CITIES]
                  + [{"name": "Global average", "country": "", "lat": None, "lon": None,
                      "base": {}, "historical": {}, "ssp245": {}, "ssp585": {}}],
    }

    for model, member, stores in models:
        base_by_city = None
        for exp in EXPERIMENTS:
            log(f"{model} {exp}: downloading...")
            da = open_tas(stores[exp])
            pts = annual(city_points(da)).transpose("city", "year")
            glob = annual(global_mean(da))
            import dask
            pts, glob = dask.compute(pts, glob)            # one pass over the data
            vals = np.vstack([pts.values, glob.values[None, :]]) - 273.15  # K -> deg C, (city, year)
            years = pts.year.values.astype(int)
            if exp == "historical":
                mask = (years >= BASELINE[0]) & (years <= BASELINE[1])
                base_by_city = vals[:, mask].mean(axis=1)
                want = result["years_hist"]
            else:
                want = result["years_ssp"]
            idx = {int(y): i for i, y in enumerate(years)}
            for ci, city in enumerate(result["cities"]):
                series = [None if y not in idx or np.isnan(vals[ci, idx[y]])
                          else round(float(vals[ci, idx[y]] - base_by_city[ci]), 3) for y in want]
                city[exp][model] = series
                if exp == "historical":
                    city["base"][model] = round(float(base_by_city[ci]), 2)
            log(f"{model} {exp}: done")

    OUT.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    log(f"Wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")

    # quick summary: warming by 2081-2100 under SSP2-4.5, model average
    rows = []
    yrs = result["years_ssp"]
    late = [i for i, y in enumerate(yrs) if y >= 2081]
    for c in result["cities"]:
        per_model = [np.nanmean([c["ssp245"][m][i] for i in late if c["ssp245"][m][i] is not None])
                     for m in result["models"]]
        rows.append((c["name"], float(np.mean(per_model))))
    print("\nWarming by 2081-2100 vs 1850-1900, SSP2-4.5, 5-model average:")
    for n, v in sorted(rows, key=lambda r: r[1]):
        print(f"  {n:16s} {v:+.2f} C")


if __name__ == "__main__":
    main()
