import numpy as np
import pandas as pd
from pathlib import Path

RAW_PATH = Path("data/raw/xray_flux.csv")
PROCESSED_PATH = Path("data/processed/features.csv")

FUTURE_STEPS = 3

_QUANTILE_CANDIDATES = [
    0.95, 0.90, 0.85, 0.80, 0.75, 0.70, 0.65, 0.60, 0.55, 0.50,
    0.45, 0.40, 0.35, 0.30, 0.25, 0.20, 0.15, 0.10, 0.05,
]
_STD_MULTIPLIERS = [2.0, 1.5, 1.0, 0.5, 0.0, -0.5, -1.0]


def _both_binary_classes(labels: pd.Series) -> bool:
    vc = labels.value_counts()
    return 0 in vc.index and 1 in vc.index


def _threshold_from_flux(flux: pd.Series) -> tuple[float, str]:
    flux = flux.dropna()
    if flux.empty:
        raise ValueError("flux boş; eşik seçilemez")

    for q in _QUANTILE_CANDIDATES:
        t = float(flux.quantile(q))
        y = (flux > t).astype(int)
        if _both_binary_classes(y):
            return t, f"flux.quantile({q})"

    mu = float(flux.mean())
    sig = float(flux.std())
    if sig > 0:
        for k in _STD_MULTIPLIERS:
            t = mu + k * sig
            y = (flux > t).astype(int)
            if _both_binary_classes(y):
                return t, f"mean + {k} * std"

    uniq = sorted(flux.unique())
    if len(uniq) < 2:
        raise ValueError(
            "flux tek değere yakın; 'flux > eşik' ile iki sınıf oluşturulamıyor"
        )
    mid = len(uniq) // 2
    t = float(uniq[mid])
    y = (flux > t).astype(int)
    if _both_binary_classes(y):
        return t, "median benzersiz değer (yedek)"

    t = float((uniq[mid - 1] + uniq[mid]) / 2)
    y = (flux > t).astype(int)
    if _both_binary_classes(y):
        return t, "iki benzersiz değerin ortası (yedek)"

    raise ValueError("İki sınıf için uygun eşik bulunamadı")


def build_features():
    df = pd.read_csv(RAW_PATH)

    df["time_tag"] = pd.to_datetime(df["time_tag"])
    df = df.sort_values("time_tag")

    if "flux" not in df.columns:
        raise ValueError("Flux column not found!")

    print("=== flux — temel istatistikler (ham, tüm satırlar) ===")
    print(df["flux"].describe())
    print()

    df["flux_lag1"] = df["flux"].shift(1)
    df["flux_lag3"] = df["flux"].shift(3)
    df["flux_ratio"] = df["flux_lag1"] / (df["flux_lag3"] + 1e-9)
    df["flux_lag6"] = df["flux"].shift(6)
    df["rolling_mean_3"] = df["flux"].rolling(3).mean()
    df["rolling_mean_6"] = df["flux"].rolling(6).mean()
    df["flux_diff"] = df["flux"].diff()

    future_flux = df["flux"].shift(-FUTURE_STEPS)
    threshold, method = _threshold_from_flux(future_flux.dropna())

    print(f"=== gelecek flux (t+{FUTURE_STEPS}) — temel istatistikler (eşik için kullanılan) ===")
    print(future_flux.dropna().describe())
    print()

    df["label"] = np.where(
        future_flux.notna(),
        (future_flux > threshold).astype(int),
        np.nan,
    )

    df = df.dropna()
    df["label"] = df["label"].astype(int)

    print(f"=== eşik (gelecek flux > eşik → label=1) ===\n{threshold:.6e}  (yöntem: {method})\n")

    print("=== hedef (label) dağılımı — value_counts ===")
    print(df["label"].value_counts().sort_index())
    print("normalize:")
    print(df["label"].value_counts(normalize=True).sort_index())
    print()

    assert _both_binary_classes(df["label"]), "Beklenmeyen: yalnızca tek sınıf kaldı"

    df = df.drop(columns=["flux"])

    PROCESSED_PATH.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(PROCESSED_PATH, index=False)

    print(f"✅ Features saved to {PROCESSED_PATH} (flux sütunu çıkarıldı)")
    print(df.head())


if __name__ == "__main__":
    build_features()
