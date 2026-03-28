from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.request
from pathlib import Path

import certifi
import pandas as pd

XRAY_URL = "https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json"


def _project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def fetch_xray_flux(url: str = XRAY_URL) -> pd.DataFrame:
    req = urllib.request.Request(url, headers={"User-Agent": "perihelion-data-fetch/1.0"})
    ctx = ssl.create_default_context(cafile=certifi.where())
    with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
        raw = resp.read()
    records = json.loads(raw.decode("utf-8"))
    df = pd.DataFrame(records)
    if "time_tag" in df.columns:
        df["time_tag"] = pd.to_datetime(df["time_tag"], utc=True)
    return df


def save_xray_flux_csv(
    df: pd.DataFrame,
    out_path: Path | None = None,
) -> Path:
    root = _project_root()
    path = out_path or (root / "data" / "raw" / "xray_flux.csv")
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False)
    return path


def main() -> None:
    try:
        df = fetch_xray_flux()
    except (urllib.error.URLError, json.JSONDecodeError, ValueError) as e:
        raise SystemExit(f"Veri alınamadı: {e}") from e
    out = save_xray_flux_csv(df)
    print(f"Kaydedildi: {out} ({len(df)} satır)")


if __name__ == "__main__":
    main()
