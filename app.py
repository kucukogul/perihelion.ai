"""
Wind Storm Early Detection System — minimal Streamlit arayüzü.
Tahmin mantığı, önceki demo (getPredictedKp heuristiği) ile uyumludur.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from statistics import pstdev
from typing import Any

import pandas as pd
import streamlit as st


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


@dataclass(frozen=True)
class PredictionResult:
    risk_level: str
    kp_predicted: int
    kp_observed: float
    confidence: float


def _component_risks(
    wind_km_s: float, proton_cm3: float, bz_nt: float
) -> tuple[float, float, float]:
    wind_risk = _clamp((wind_km_s - 420.0) / 520.0, 0.0, 1.0)
    proton_risk = _clamp((proton_cm3 - 2.8) / 7.5, 0.0, 1.0)
    bz_risk = _clamp(-bz_nt / 14.0, 0.0, 1.0)
    return wind_risk, proton_risk, bz_risk


def _confidence_from_risks(wind_r: float, proton_r: float, bz_r: float) -> float:
    """Sinyallerin uyumu: düşük sapma, daha yüksek güven (0–1)."""
    vals = (wind_r, proton_r, bz_r)
    spread = pstdev(vals) if len(vals) > 1 else 0.0
    raw = 0.72 + 0.26 * (1.0 - spread)
    return _clamp(raw, 0.55, 0.99)


def predict_wind_storm(features: dict[str, Any]) -> PredictionResult:
    """
    Heliyosferik girdilere göre Kp tahmini ve risk sınıfı.
    features: wind_km_s, proton_cm3, bz_nt, electron_flux, kp_observed,
              ai_kp_override (opsiyonel; varsa doğrudan yuvarlanır).
    """
    wind = float(features["wind_km_s"])
    proton = float(features["proton_cm3"])
    bz = float(features["bz_nt"])
    kp_obs = float(features["kp_observed"])
    override = features.get("ai_kp_override")

    wind_r, proton_r, bz_r = _component_risks(wind, proton, bz)

    if override is not None and str(override).strip() != "":
        kp_pred = int(round(_clamp(float(override), 1.0, 9.0)))
    else:
        modeled = (
            kp_obs
            + 0.6
            + wind_r * 1.4
            + proton_r * 1.1
            + bz_r * 1.25
        )
        kp_pred = int(round(_clamp(modeled, 1.0, 9.0)))

    if kp_pred < 5:
        risk = "Low"
    elif kp_pred < 7:
        risk = "Medium"
    else:
        risk = "High"

    conf = _confidence_from_risks(wind_r, proton_r, bz_r)
    return PredictionResult(
        risk_level=risk,
        kp_predicted=kp_pred,
        kp_observed=kp_obs,
        confidence=conf,
    )


def _normalize_row(row: pd.Series) -> dict[str, Any] | None:
    def pick(*names: str, default: float | None = None) -> float | None:
        for n in names:
            if n in row.index and pd.notna(row[n]):
                try:
                    return float(row[n])
                except (TypeError, ValueError):
                    continue
        return default

    wind = pick("wind_km_s", "windSpeed", "wind", "sw")
    proton = pick("proton_cm3", "protonDensity", "proton", "pr")
    bz = pick("bz", "Bz")
    kp = pick("kp_observed", "kpIndex", "kp", default=2.0)
    flux = pick("electron_flux", "electronFlux", "flux", default=0.0)

    if wind is None or proton is None or bz is None:
        return None
    override = pick("ai_kp_override", "aiPredictionKp", default=None)
    out: dict[str, Any] = {
        "wind_km_s": wind,
        "proton_cm3": proton,
        "bz_nt": bz,
        "electron_flux": float(flux),
        "kp_observed": float(kp),
    }
    if override is not None:
        out["ai_kp_override"] = override
    return out


def main() -> None:
    st.set_page_config(page_title="Wind Storm Early Detection", layout="centered")

    st.title("Wind Storm Early Detection System")
    st.markdown(
        "L1 uydu ve yer istasyonlarından gelen plazma ile manyetik alan ölçümlerini kullanarak "
        "jeomanyetik aktiviteyi (Kp) ve fırtına riskini tahmin eder. "
        "Bu arayüz, operasyonel izleme için tek noktadan giriş ve toplu CSV değerlendirmesi sunar."
    )

    st.subheader("Girdiler")
    c1, c2 = st.columns(2)
    with c1:
        wind = st.number_input(
            "Güneş rüzgârı hızı (km/s)",
            min_value=0.0,
            max_value=3000.0,
            value=441.0,
            step=1.0,
        )
        proton = st.number_input(
            "Proton yoğunluğu (p/cm³)",
            min_value=0.0,
            max_value=100.0,
            value=3.3,
            step=0.1,
        )
    with c2:
        bz = st.number_input(
            "Bz (nT)",
            min_value=-50.0,
            max_value=50.0,
            value=-3.4,
            step=0.1,
        )
        electron_flux = st.number_input(
            "Elektron akışı (birim: sayı; örn. 1.8e3 → 1800)",
            min_value=0.0,
            max_value=1.0e7,
            value=1800.0,
            step=10.0,
        )

    kp_obs = st.slider("Gözlemlenen Kp (0–9)", 0.0, 9.0, 4.0, 0.5)
    override = st.text_input(
        "İsteğe bağlı: model Kp geçersizlemesi (1–9, boş bırakılabilir)",
        value="",
        help="Backend’den gelen aiPredictionKp değeri buraya girilebilir.",
    )

    uploaded = st.file_uploader(
        "İsteğe bağlı CSV (satır başına tahmin)",
        type=["csv"],
        help="Sütun örnekleri: wind_km_s veya wind, proton_cm3 veya proton, bz, kp veya kpIndex.",
    )

    if st.button("Run Prediction"):
        feats = {
            "wind_km_s": wind,
            "proton_cm3": proton,
            "bz_nt": bz,
            "electron_flux": electron_flux,
            "kp_observed": kp_obs,
            "ai_kp_override": override.strip() or None,
        }
        try:
            if feats["ai_kp_override"] is not None:
                feats["ai_kp_override"] = float(feats["ai_kp_override"])
        except ValueError:
            st.error("Geçersiz Kp geçersizlemesi; sayı veya boş olmalı.")
            return

        res = predict_wind_storm(feats)
        st.subheader("Çıktı")
        st.write(f"**Risk düzeyi:** {res.risk_level}")
        st.write(f"**Tahmini Kp:** {res.kp_predicted} / 9")
        st.write(f"**Gözlemlenen Kp:** {res.kp_observed:g}")
        st.write(f"**Güven skoru:** {res.confidence * 100:.1f}%")

        wr, pr, br = _component_risks(wind, proton, bz)
        chart_df = pd.DataFrame(
            {
                "bileşen": ["wind_risk", "proton_risk", "bz_risk"],
                "değer": [wr, pr, br],
            }
        ).set_index("bileşen")
        st.caption("Bileşen risk skorları (0–1, bar grafiği)")
        st.bar_chart(chart_df)

        if uploaded is not None:
            df = pd.read_csv(io.BytesIO(uploaded.getvalue()))
            rows_out = []
            for _, row in df.iterrows():
                norm = _normalize_row(row)
                if norm is None:
                    continue
                r = predict_wind_storm(norm)
                rows_out.append(
                    {
                        "kp_predicted": r.kp_predicted,
                        "risk": r.risk_level,
                        "confidence": round(r.confidence, 4),
                        **{k: v for k, v in norm.items() if k != "ai_kp_override"},
                    }
                )
            if rows_out:
                batch = pd.DataFrame(rows_out)
                st.subheader("CSV toplu sonuç")
                st.dataframe(batch, use_container_width=True)
                st.line_chart(batch["kp_predicted"])
            else:
                st.warning("CSV’de gerekli sütunlar bulunamadı veya satır yok.")


if __name__ == "__main__":
    main()
