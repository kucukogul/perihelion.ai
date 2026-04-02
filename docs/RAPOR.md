# Perihelion.ai — Proje Raporu (Jüri / Dokümantasyon)

**Özet:** Bu proje, NOAA Space Weather Prediction Center (SWPC) üzerinden yayınlanan **GOES birincil X-ışını** özet verisini kullanarak, kısa ufuklu **ikili sınıflandırma** (gelecekteki yüksek flux rejimi) denemesi ve buna paralel **etkileşimli demo API** sunar. Jeomanyetik sunum için kök dizinde **Streamlit** tabanlı **Wind Storm Early Detection** arayüzü vardır; canlı sürüm: [https://perihelionai.streamlit.app/](https://perihelionai.streamlit.app/).

---

## 1. Problem

Güneşteki yoğun X-ışını aktivitesi, uydu ve iletişim sistemleri için operasyonel ilgi taşır. Zaman serisinde, **erken sinyal** üretmek için makine öğrenmesi ile **yardımcı bir gösterge** oluşturmak amaçlanmıştır. Bu çalışma bir **operasyonel uyarı sistemi iddiası değildir**; eğitim ve hackathon kapsamında metodoloji ve ürünleştirme pratiğini göstermeyi hedefler.

---

## 2. Çözüm (yüksek seviye)

1. **Veri çekme:** SWPC JSON endpoint → tablo → CSV.  
2. **Özellik üretimi:** Zaman gecikmeleri, oranlar, hareketli ortalamalar; sızıntıyı azaltmak için eğitim özelliklerinde anlık `flux` çıkarılır.  
3. **Etiket:** Gelecekteki birkaç zaman adımı sonrası flux, veri içinden seçilen bir eşiğin üstünde mi?  
4. **Model:** LightGBM, dengesiz sınıflar için `class_weight="balanced"`.  
5. **Sunum (API):** Flask + CORS; senkron demo için **sakin / fırtına** modları ve **yumuşak geçiş rampası** (`RAMP_SECONDS`).  
6. **Sunum (arayüz):** `app.py` — Streamlit; rüzgâr / proton / Bz / Kp girdileriyle **heuristik** Kp ve risk tahmini (X-ışını ML modelinden ayrı ürün yüzeyi). Yayın: [perihelionai.streamlit.app](https://perihelionai.streamlit.app/).

---

## 3. Veri kaynağı

- **Kaynak:** `https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json`  
- **İçerik:** Kısa süreli özetlenmiş X-ışını flux zaman serisi (ham dosya: `data/raw/xray_flux.csv`).  
- **Not:** “NASA” ile karıştırılmamalıdır; operasyonel ürün **NOAA SWPC / GOES** ekosistemindedir.

---

## 4. Model ve değerlendirme

- Eğitim: `main.py` → `models/storm_lgbm.joblib` + özellik isimleri.  
- Tahmin yardımcıları: `src/api/predict.py` (`predict_storm`, `predict_latest_from_csv`).  
- **Dürüst sınır:** Etiket, veri dağılımına göre seçilen bir eşiğe göredir; fiziksel M/X sınıfı tanımı veya Kp eşlemesi bu repoda varsayılan olarak yapılmamıştır.  
- **Gelecek iyileştirme:** Zaman bazlı train/test bölmesi, sabit fiziksel eşik, jeomanyetik hedef (Kp) için ek veri hatları (ör. DSCOVR/ACE) değerlendirilebilir.

---

## 5. Demo API, Streamlit ve gerçek model ayrımı

| Bileşen | Açıklama |
|---------|-----------|
| `/api/predict` (Flask demo) | Rüzgar, Kp, `bz`, elektron akısı: **sunum simülasyonu**; `POST /api/mode` ile senaryo değişir, değerler rampayla geçer. |
| **Streamlit** (`app.py`) | Form ve isteğe bağlı CSV; **heuristik** Kp/risk/güven — hackathon demo ile uyumlu mantık; [canlı](https://perihelionai.streamlit.app/). |
| ML hattı | `fetch` → `features` → `train` → joblib; `predict_storm` X-ışını özellikleriyle çalışır; Flask demo JSON’u ile otomatik bağlı değildir. |

Bu ayrım, jüri önünde **bilimsel doğruluk** ile **UI etkisi**nin karışmaması için bilinçlidir.

---

## 6. Teknik yığın

- Python 3, pandas, scikit-learn, LightGBM, joblib  
- Flask, flask-cors  
- Streamlit (Wind Storm arayüzü; kök `requirements.txt` ile dağıtım)  
- SSL için `certifi` (fetch)

---

## 7. Sonuç

Proje; **gerçek uzay hava verisi** ile uçtan uca bir ML iskeleti ve **hackathon demo** için tutarlı bir API yüzeyi sunar. Rapor, modelin neyi tahmin ettiğini ve neyi tahmin etmediğini şeffaf biçimde çerçeveler.

---

## 8. Kaynakça

- NOAA SWPC JSON hizmetleri: https://www.swpc.noaa.gov/  
- GOES X-ışını ürünleri hakkında genel bilgi: SWPC dokümantasyonu ve ilgili veri sayfaları.

---

*Bu belge, repo kökündeki `README.md` ile birlikte jüri ve ekip içi hizalayici doküman olarak kullanılmak üzere hazırlanmıştır.*
