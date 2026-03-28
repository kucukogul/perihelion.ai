import json
import os
import sys
import warnings
from pathlib import Path

os.environ.setdefault("LOKY_MAX_CPU_COUNT", "8")
_mpl = Path(__file__).resolve().parent / ".mplconfig"
_mpl.mkdir(exist_ok=True)
os.environ.setdefault("MPLCONFIGDIR", str(_mpl))
warnings.filterwarnings(
    "ignore",
    message=".*physical cores.*",
    category=UserWarning,
)

import pandas as pd
from lightgbm import LGBMClassifier
from sklearn.metrics import classification_report
from sklearn.model_selection import train_test_split

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src"))

from api.predict import predict_storm, save_model_bundle  # noqa: E402

PROBA_THRESHOLD = 0.1

df = pd.read_csv("data/processed/features.csv")

_drop = [c for c in ("label", "time_tag", "flux") if c in df.columns]
X = df.drop(columns=_drop).select_dtypes(include=["number", "bool"])
y = df["label"]

X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, shuffle=True, stratify=y
)

print("=== Train — sınıf dağılımı (value_counts) ===")
print(y_train.value_counts().sort_index())
print()
print("=== Test — sınıf dağılımı (value_counts) ===")
print(y_test.value_counts().sort_index())
print()

for name, ys in [("y_train", y_train), ("y_test", y_test)]:
    if set(ys.unique()) != {0, 1}:
        raise ValueError(
            f"{name} hem 0 hem 1 içermeli; mevcut: {sorted(ys.unique().tolist())}"
        )

model = LGBMClassifier(
    class_weight="balanced",
    n_estimators=200,
    max_depth=8,
    num_leaves=48,
    min_child_samples=3,
    min_split_gain=0.0,
    learning_rate=0.05,
    subsample=0.9,
    colsample_bytree=0.9,
    reg_lambda=0.1,
    verbosity=-1,
    force_col_wise=True,
    random_state=42,
)
model.fit(X_train, y_train)

saved = save_model_bundle(model, list(X.columns))
print(f"=== Model kaydedildi: {saved} ===\n")

proba = model.predict_proba(X_test)[:, 1]
y_pred = (proba > PROBA_THRESHOLD).astype(int)

print(f"=== MODEL REPORT (tahmin eşiği P(storm) > {PROBA_THRESHOLD}) ===")
print(classification_report(y_test, y_pred))

sample = json.loads(X.iloc[[-1]].to_json(orient="records"))[0]
demo = predict_storm(sample)
print("=== Örnek tahmin (son özellik satırı, JSON) ===")
print(json.dumps(demo, indent=2))
