from __future__ import annotations

import os
import sys
from pathlib import Path

from flask import Flask, jsonify, request

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from api.predict import predict_storm  # noqa: E402

app = Flask(__name__)


@app.route("/predict", methods=["POST"])
def predict():
    if not request.is_json:
        return jsonify({"error": "Expected Content-Type: application/json"}), 400
    body = request.get_json(silent=True)
    if body is None:
        return jsonify({"error": "Invalid or empty JSON body"}), 400
    if not isinstance(body, dict):
        return jsonify({"error": "JSON body must be a JSON object"}), 400
    try:
        out = predict_storm(body)
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 503
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(out)


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5050"))
    app.run(host="0.0.0.0", port=port, debug=True)
