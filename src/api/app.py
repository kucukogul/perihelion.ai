from __future__ import annotations

import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIR = ROOT / "frontend"

MODE = "calm"
# options: "calm", "storm"

# Tam fırtına / tam sakin arası geçiş süresi (MODE değişince, anlık sıçrama yok).
RAMP_SECONDS = 90.0

_SIM_T0 = time.monotonic()
_storm_weight = 0.0
_last_tick: float | None = None

app = Flask(__name__)
CORS(app)


def _frontend_exists() -> bool:
    return FRONTEND_DIR.is_dir() and (FRONTEND_DIR / "index.html").is_file()


@app.get("/")
def serve_index():
    if not _frontend_exists():
        return jsonify(
            {
                "message": "Frontend not found. Add frontend/ (see README) or use /api/predict.",
                "api": "/api/predict",
                "health": "/health",
            }
        ), 503
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/main.js")
def serve_main_js():
    if not _frontend_exists():
        return ("Not found", 404)
    return send_from_directory(
        FRONTEND_DIR, "main.js", mimetype="application/javascript; charset=utf-8"
    )


@app.get("/styles.css")
def serve_styles():
    if not _frontend_exists():
        return ("Not found", 404)
    return send_from_directory(FRONTEND_DIR, "styles.css", mimetype="text/css; charset=utf-8")


@app.get("/logo/<path:name>")
def serve_logo(name):
    if not _frontend_exists():
        return ("Not found", 404)
    return send_from_directory(FRONTEND_DIR / "logo", name)


@app.get("/assets/<path:name>")
def serve_assets(name):
    if not _frontend_exists():
        return ("Not found", 404)
    return send_from_directory(FRONTEND_DIR / "assets", name)


def _utc_time_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _smoothstep(u: float) -> float:
    u = max(0.0, min(1.0, u))
    return u * u * (3.0 - 2.0 * u)


def _metrics_calm(t: float, s: float, w: float) -> dict[str, float]:
    wind = 320.0 + 20.0 * s
    wind = max(300.0, min(340.0, wind))
    proton = 3.0 + 1.0 * math.sin(t * 0.11)
    proton = max(2.0, min(4.0, proton))
    kp = 1.5 + 0.45 * math.sin(t * 0.09)
    kp = max(1.0, min(2.0, kp))
    ai_kp = 1.48 + 0.42 * math.sin(t * 0.1 + 0.3)
    ai_kp = max(1.0, min(2.0, ai_kp))
    bz = 4.0 + 2.0 * math.sin(t * 0.14)
    bz = max(1.5, min(7.0, bz))
    electron = 1_200.0 + 1_800.0 * w
    return {
        "wind": wind,
        "proton": proton,
        "kp": kp,
        "ai_kp": ai_kp,
        "bz": bz,
        "electron": electron,
    }


def _metrics_storm(t: float, s: float, w: float) -> dict[str, float]:
    wind = 900.0 + 50.0 * s
    wind = max(850.0, min(950.0, wind))
    proton = 42.5 + 7.5 * math.sin(t * 0.11)
    proton = max(35.0, min(50.0, proton))
    kp = 8.5 + 0.45 * math.sin(t * 0.09)
    kp = max(8.0, min(9.0, kp))
    ai_kp = 8.55 + 0.4 * math.sin(t * 0.1 + 0.4)
    ai_kp = max(8.0, min(9.0, ai_kp))
    bz = -20.0 + 5.0 * math.sin(t * 0.13)
    bz = max(-28.0, min(-12.0, bz))
    electron = 900_000.0 + 350_000.0 * w
    return {
        "wind": wind,
        "proton": proton,
        "kp": kp,
        "ai_kp": ai_kp,
        "bz": bz,
        "electron": electron,
    }


def _predict_payload() -> dict:
    global _storm_weight, _last_tick

    now = time.monotonic()
    if _last_tick is None:
        dt = 0.0
    else:
        dt = min(max(now - _last_tick, 0.0), 3.0)
    _last_tick = now

    if MODE == "storm":
        _storm_weight = min(1.0, _storm_weight + dt / RAMP_SECONDS)
    else:
        _storm_weight = max(0.0, _storm_weight - dt / RAMP_SECONDS)

    alpha = _smoothstep(_storm_weight)

    t = now - _SIM_T0
    s = math.sin(t * 0.12)
    w = (s + 1) / 2
    calm = _metrics_calm(t, s, w)
    storm = _metrics_storm(t, s, w)

    o = 1.0 - alpha
    wind_speed = calm["wind"] * o + storm["wind"] * alpha
    proton_density = calm["proton"] * o + storm["proton"] * alpha
    kp_index = calm["kp"] * o + storm["kp"] * alpha
    ai_kp = calm["ai_kp"] * o + storm["ai_kp"] * alpha
    bz = calm["bz"] * o + storm["bz"] * alpha
    electron_flux = int(round(calm["electron"] * o + storm["electron"] * alpha))

    return {
        "time": _utc_time_iso(),
        "windSpeed": round(wind_speed, 2),
        "protonDensity": round(proton_density, 3),
        "kpIndex": round(kp_index, 2),
        "aiPredictionKp": round(ai_kp, 2),
        "bz": round(bz, 2),
        "electronFlux": electron_flux,
    }


@app.before_request
def _log_incoming_request():
    print(
        f"[api] MODE={MODE} {request.method} {request.path} from {request.remote_addr}"
    )


@app.get("/api/predict")
def api_predict():
    out = _predict_payload()
    print(
        f"[api/predict] MODE={MODE} intensity={_storm_weight:.3f}: "
        f"kp={out['kpIndex']} wind={out['windSpeed']}"
    )
    return jsonify(out)


@app.post("/api/mode")
def api_set_mode():
    global MODE
    data = request.get_json(silent=True) or {}
    m = data.get("mode")
    if m not in ("calm", "storm"):
        return (
            jsonify({"error": 'body must be JSON: {"mode": "calm"} or {"mode": "storm"}'}),
            400,
        )
    MODE = m
    print(f"[api/mode] MODE set to {MODE}")
    return jsonify({"ok": True, "mode": MODE})


@app.get("/predict")
def predict_legacy():
    return api_predict()


@app.get("/health")
def health():
    return jsonify(
        {"status": "ok", "mode": MODE, "intensity": round(_storm_weight, 4)}
    )


if __name__ == "__main__":
    print(f"[api] demo server; current MODE={MODE}")
    port = int(os.environ.get("PORT", "5050"))
    print(f"[api] starting Flask on http://0.0.0.0:{port} (reachable on LAN IP)")
    if _frontend_exists():
        print(f"[api] dashboard: http://127.0.0.1:{port}/ (same URL on your LAN IP)")
    app.run(host="0.0.0.0", port=port, debug=True)
