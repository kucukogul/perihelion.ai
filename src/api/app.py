from __future__ import annotations

import os
import sys
from pathlib import Path

from flask import Flask, jsonify
from flask_cors import CORS

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from api.predict import predict_latest_from_csv  # noqa: E402

app = Flask(__name__)
CORS(app)


@app.route("/api/predict", methods=["GET", "POST"])
def api_predict():
    try:
        out = predict_latest_from_csv()
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 503
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(out)


@app.route("/predict", methods=["GET", "POST"])
def predict_legacy():
    return api_predict()


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5050"))
    app.run(host="0.0.0.0", port=port, debug=True)
