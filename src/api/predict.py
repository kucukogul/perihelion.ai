from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import joblib
import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parents[2]
MODEL_PATH = PROJECT_ROOT / "models" / "storm_lgbm.joblib"
FEATURES_CSV = PROJECT_ROOT / "data" / "processed" / "features.csv"
DROP_FOR_FEATURES = ("label", "time_tag")


def risk_status(proba: float) -> str:
    if proba > 0.6:
        return "HIGH RISK"
    if proba > 0.3:
        return "MEDIUM RISK"
    return "LOW RISK"


@lru_cache(maxsize=1)
def _load_bundle():
    if not MODEL_PATH.exists():
        raise FileNotFoundError(
            f"Model not found at {MODEL_PATH}. Run `python main.py` from the project root first."
        )
    return joblib.load(MODEL_PATH)


def predict_storm(features: dict) -> dict:
    bundle = _load_bundle()
    model = bundle["model"]
    feature_names = list(bundle["feature_names"])
    missing = [f for f in feature_names if f not in features]
    if missing:
        raise ValueError(f"Missing required features: {missing}")
    row = pd.DataFrame([[features[c] for c in feature_names]], columns=feature_names)
    proba = float(model.predict_proba(row)[0, 1])
    return {"storm_risk": proba, "status": risk_status(proba)}


def predict_latest_from_csv() -> dict:
    if not FEATURES_CSV.exists():
        raise FileNotFoundError(
            f"Features CSV not found at {FEATURES_CSV}. Run build_features first."
        )
    df = pd.read_csv(FEATURES_CSV)
    drop_cols = [c for c in DROP_FOR_FEATURES if c in df.columns]
    X = df.drop(columns=drop_cols).select_dtypes(include=["number", "bool"])
    if len(X) == 0:
        raise ValueError("No numeric/bool feature rows in features CSV")
    bundle = _load_bundle()
    model = bundle["model"]
    feature_names = list(bundle["feature_names"])
    missing = [c for c in feature_names if c not in X.columns]
    if missing:
        raise ValueError(f"CSV missing columns required by model: {missing}")
    row = X.iloc[[-1]][feature_names]
    proba = float(model.predict_proba(row)[0, 1])
    return {"storm_risk": proba, "status": risk_status(proba)}


def save_model_bundle(model, feature_names: list[str], path: Path | None = None) -> Path:
    path = path or MODEL_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"model": model, "feature_names": feature_names}, path)
    _load_bundle.cache_clear()
    return path
