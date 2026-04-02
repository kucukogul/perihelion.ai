# Perihelion.ai — Teknik Rapor

Bu belge, **perihelion** deposunun mimarisini, veri hattını, makine öğrenmesi bileşenlerini, sunucu API’sini ve Streamlit arayüzünü teknik düzeyde özetler. Son güncelleme: `frontend/` kaldırılmış, kök `app.py` ve [Streamlit Cloud](https://perihelionai.streamlit.app/) ile uyumludur.

---

## 1. Amaç ve kapsam

**Amaç:** NOAA SWPC üzerinden erişilen GOES X-ışını (flux) zaman serisinden türetilen özelliklerle, **gelecekteki kısa ufukta yüksek flux rejimini** ikili sınıflandırma ile tahmin etmeye yönelik bir **LightGBM** modeli eğitmek; hackathon ve demo için **Flask** üzerinden senkronize edilebilen bir **simülasyon API** ve **Streamlit** ile jeomanyetik senaryo için sade bir **Wind Storm** arayüzü ([canlı](https://perihelionai.streamlit.app/)) sunmak.

**Kapsam dışı (bilinçli):** Operasyonel uzay hava uyarısı ürünü; jeomanyetik Kp veya tam fiziksel fırtına tanımı ile bire bir hizalama; üretim ölçeğinde izleme veya resmi doğrulama süreçleri.

---

## 2. Depo yapısı

| Yol | Rol |
|-----|-----|
| `src/data/fetch.py` | SWPC JSON → `data/raw/xray_flux.csv` |
| `src/features/build_features.py` | Ham CSV → özellikler + etiket → `data/processed/features.csv` |
| `main.py` | Eğitim betiği; model + özellik isimleri → `models/storm_lgbm.joblib` |
| `src/api/predict.py` | Joblib yükleme, `predict_storm`, `predict_latest_from_csv` |
| `src/api/app.py` | Flask: demo API, CORS; kök `GET /` için statik dosya yok (503) |
| `app.py` | Streamlit: Wind Storm Early Detection (form, CSV, heuristik tahmin) |
| `Makefile` | `fetch`, `features`, `train`, `api`, `pipeline` hedefleri |
| `requirements.txt` | Kök: Streamlit + pandas (UI); train/API için ek paketler README’de |
| `docs/RAPOR.md` | Kısa jüri / proje özeti |
| `docs/TEKNIK_RAPOR.md` | Bu teknik rapor |

---

## 3. Mimari genel bakış

```mermaid
flowchart TB
  subgraph ingest [Veri alımı]
    SWPC[NOAA SWPC JSON]
    RAW[(xray_flux.csv)]
    SWPC --> RAW
  end
  subgraph features [Özellik üretimi]
    FEAT[build_features.py]
    PROC[(features.csv)]
    RAW --> FEAT --> PROC
  end
  subgraph ml [Makine öğrenmesi]
    TRAIN[main.py LightGBM]
    JOB[(storm_lgbm.joblib)]
    PROC --> TRAIN --> JOB
  end
  subgraph runtime [Çalışma zamanı demo]
    FLASK[Flask src/api/app.py]
    ST[Streamlit app.py]
    CLOUD[Streamlit Cloud]
    FLASK -->|JSON simülasyon| API_CLIENT[İstemci curl / başka UI]
    ST -->|heuristik Kp/risk| USER[Operatör]
    CLOUD -.->|dağıtım| ST
    JOB -.->|şu an bağlı değil| FLASK
  end
```

**Önemli ayrım:** Flask `/api/predict` **simüle telemetri** döndürür. `predict.py` içindeki LightGBM **X-ışını özellikleri** ile eğitilmiştir; Streamlit `app.py` ise **ayrı heuristik** (rüzgâr / Kp / Bz) ile Kp/risk üretir — üçüncü bir ürün yüzeyi. Entegrasyon için ayrı endpoint veya bayrak gerekir.

---

## 4. Veri alımı (`src/data/fetch.py`)

- **Uç nokta:** `https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json`
- **İletişim:** `urllib.request` + `ssl.create_default_context(cafile=certifi.where())` (kurumsal/proxy ortamlarında CA güveni için `certifi`).
- **Çıktı:** Proje köküne göre `data/raw/xray_flux.csv`; JSON kayıtları `pandas.DataFrame` ile düzleştirilir.
- **Zaman:** `time_tag` sütunu varsa UTC’ye çevrilir.

Ham dosyada en azından **`flux`** ve **`time_tag`** sütunları, özellik betiği tarafından beklenir.

---

## 5. Özellik mühendisliği ve etiket (`src/features/build_features.py`)

### 5.1 Zaman sırası

CSV okunur, `time_tag` datetime yapılır, **zamana göre sıralanır**.

### 5.2 Girdi türevleri (ham `flux` üzerinden)

| Özellik | Tanım |
|---------|--------|
| `flux_lag1`, `flux_lag3`, `flux_lag6` | Gecikmeli flux |
| `flux_ratio` | `flux_lag1 / (flux_lag3 + 1e-9)` |
| `rolling_mean_3`, `rolling_mean_6` | Hareketli ortalamalar |
| `flux_diff` | Birinci fark |

### 5.3 Hedef değişken (etiket)

- `FUTURE_STEPS = 3` → `future_flux = flux.shift(-3)` (t+3 adımındaki flux).
- Eşik `threshold`, **gelecek flux** serisi üzerinde veri-içi bir kural ile seçilir:
  - Önce bir dizi **quantile** adayı; her biri için `(future_flux > t)` ikili sınıfının hem 0 hem 1 içermesi aranır.
  - Gerekirse **mean + k·std** adayları, son çare olarak benzersiz değer tabanlı bölme.
- `label = 1` iff `future_flux > threshold` (geçerli satırlarda); son satırlarda gelecek yoksa `dropna` ile elenir.

### 5.4 Sızıntı (leakage) notu

Eğitim matrisinden **`flux`** sütunu çıkarılır; model doğrudan anlık ham flux ile etiketi “görmemeli” şekilde tasarlanmıştır. Gelecek bilgisi yalnızca **etiket tanımında** kullanılır; özellik vektörü geçmiş/gecikme tabanlıdır.

### 5.5 Çıktı

`data/processed/features.csv`: `time_tag`, sayısal özellikler, `label`; **`flux` yok**.

---

## 6. Model eğitimi (`main.py`)

### 6.1 Veri hazırlığı

- `label`, `time_tag` ve varsa `flux` düşülür; kalan **sayısal/bool** sütunlar `X`, `y = label`.

### 6.2 Bölme stratejisi

- `train_test_split(..., test_size=0.2, shuffle=True, stratify=y)`  
- **Zaman serisi doğruluğu açısından:** Rastgele karıştırma, zamansal otokorelasyon ve “geleceği görme” riski açısından ideal değildir; geliştirme ve hackathon hızı için seçilmiştir. Üretim değerlendirmesi için **zaman bazlı bölme** önerilir.

### 6.3 Sınıflandırıcı

`LGBMClassifier` — özet hiperparametreler:

- `class_weight="balanced"` (sınıf dengesizliği)
- `n_estimators=200`, `max_depth=8`, `num_leaves=48`
- `learning_rate=0.05`, `subsample=0.9`, `colsample_bytree=0.9`
- `reg_lambda=0.1`, `random_state=42`, `verbosity=-1`

### 6.4 Değerlendirme ve eşik

- Test kümesinde `predict_proba` pozitif sınıfı; tahmin `PROBA_THRESHOLD = 0.1` ile ikilileştirilir.
- `classification_report` yazdırılır.

### 6.5 Kalıcılık

`save_model_bundle` (`predict.py`): `{"model", "feature_names"}` → `models/storm_lgbm.joblib`.

---

## 7. Çıkarım modülü (`src/api/predict.py`)

- **`_load_bundle()`:** `lru_cache` ile tek yükleme.
- **`predict_storm(features: dict)`:** Sözlükteki özellikler `feature_names` ile hizalanır; eksik anahtar `ValueError`. Çıktı: `storm_risk` (olasılık), `status` (`HIGH` / `MEDIUM` / `LOW` — eşikler 0.6 ve 0.3).
- **`predict_latest_from_csv()`:** İşlenmiş CSV’nin son satırı üzerinden aynı çıktı. `DROP_FOR_FEATURES = ("label", "time_tag")`.
- **`save_model_bundle`:** Eğitim sonrası kayıt ve önbellek temizliği.

---

## 8. Flask uygulaması (`src/api/app.py`)

### 8.1 Genel

- `Flask(__name__)`, `CORS(app)` — farklı origin’lerden istemci için.
- `FRONTEND_DIR = ROOT / "frontend"` — depoda **frontend klasörü yok**; kök `GET /` **503** + JSON yönlendirmesi döner. Statik dashboard kaldırıldı; arayüz için [Streamlit Cloud](https://perihelionai.streamlit.app/) veya yerel `streamlit run app.py` kullanılır.

### 8.2 Kök rota

| Rota | İçerik |
|------|--------|
| `GET /` | `frontend/` yoksa **503** + JSON (`/api/predict` veya Streamlit önerisi) |

### 8.3 Demo simülasyon mantığı

- Global **`MODE`:** `"calm"` veya `"storm"` (`POST /api/mode` ile değişir).
- **`_storm_weight`:** Her istekte `dt` ile güncellenir; `MODE == "storm"` iken 0→1, `calm` iken 1→0 yönlü; tam geçiş süresi yaklaşık **`RAMP_SECONDS` (90 s)**.
- **`_smoothstep`:** Ağırlık 0–1 arasında yumuşak geçiş.
- İki profil: **`_metrics_calm`** (ör. rüzgar 300–340, Kp 1–2, pozitif `bz`, düşük elektron akısı) ve **`_metrics_storm`** (ör. 850–950 km/s, Kp 8–9, negatif `bz`, yüksek akı).
- Çıktı JSON alanları: `time` (UTC ISO), `windSpeed`, `protonDensity`, `kpIndex`, `aiPredictionKp`, `bz`, `electronFlux`.

### 8.4 Diğer uç noktalar

- `GET /api/predict` — yukarıdaki yük.
- `POST /api/mode` — gövde `{"mode":"calm"|"storm"}`.
- `GET /health` — `status`, `mode`, `intensity` (`_storm_weight`).
- `GET /predict` — `/api/predict` ile aynı.

### 8.5 Çalıştırma

- `host="0.0.0.0"`, `port=int(os.environ.get("PORT", "5050"))`, `debug=True` (geliştirme; çift süreç / yeniden yükleyici davranışına dikkat).

---

## 9. Streamlit arayüzü (`app.py`)

### 9.1 Amaç ve dağıtım

- **Başlık:** Wind Storm Early Detection System — mühendis odaklı minimal form; animasyon ve hackathon görsel teması yok.
- **Canlı:** [https://perihelionai.streamlit.app/](https://perihelionai.streamlit.app/) (Streamlit Community Cloud; repo kökündeki `app.py` + `requirements.txt` ile hizalanır).
- **Yerel:** `streamlit run app.py`

### 9.2 Girdi ve çıktı

- **Girdi (sayısal):** Güneş rüzgârı hızı (km/s), proton yoğunluğu (p/cm³), Bz (nT), elektron akısı, gözlemlenen Kp; isteğe bağlı model Kp geçersizlemesi; isteğe bağlı CSV (sütun adları `wind` / `wind_km_s`, `proton` / `proton_cm3`, `bz`, `kp` vb. ile eşleştirilebilir).
- **Çıktı:** Risk düzeyi (Low / Medium / High, tahmini Kp’ye göre), tahmini Kp (1–9), güven skoru (yüzde), bileşen riskleri için `st.bar_chart`, CSV toplu çalıştırmada `st.line_chart` (tahmini Kp serisi).

### 9.3 Tahmin mantığı

- **`predict_wind_storm()`** kök modülde; Flask veya joblib **çağrılmaz**.
- Heuristik, eski demo ile uyumlu: rüzgâr / proton / Bz bileşen riskleri ve gözlemlenen Kp üzerinden yuvarlanmış Kp tahmini; isteğe bağlı `ai_kp_override` ile doğrudan Kp seçimi.
- Bu, **GOES X-ışını LightGBM** modelinden bağımsız bir ürün yüzeyidir; bilimsel eğitim hattı `src/api/predict.py` ile karıştırılmamalıdır.

---

## 10. Operasyon ve yapılandırma

| Değişken / komut | Açıklama |
|------------------|----------|
| `PORT` | Flask dinleme portu (varsayılan 5050) |
| `make pipeline` | `fetch` → `features` → `train` |
| `make api` | `python src/api/app.py` |
| Streamlit Cloud | Repo bağlantısı; ana giriş noktası `app.py` |
| `LOKY_MAX_CPU_COUNT` | `main.py` içinde joblib/lightgbm için (opsiyonel sınır) |
| `MPLCONFIGDIR` | Matplotlib uyarıları için yerel `.mplconfig` |

---

## 11. Güvenlik ve sınırlamalar

- Flask **geliştirme sunucusu** üretim için uygun değildir.
- CORS geniş açık; üretimde origin kısıtlaması düşünülmelidir.
- Demo telemetri **gerçek ölçüm değildir**; yalnızca sunum amaçlıdır.
- Model etiketi **veri-içi eşik** ile tanımlıdır; fiziksel flare sınıfları veya Kp ile otomatik eşdeğer değildir.
- Zaman serisi için rastgele `train_test_split` metrikleri iyimser veya yanıltıcı olabilir.

---

## 12. Geliştirme yönleri

1. `/api/predict/live` veya bayrak ile **CSV son satırı + `predict_storm`** yanıtı; demo ile gerçek modeli birlikte veya ayrı sunma.
2. Streamlit üzerinde **canlı veri** veya Flask `/api/predict` ile isteğe bağlı bağlantı (şu an zorunlu değil).
3. **Zaman bazlı doğrulama** (walk-forward, son N gün test).
4. Sabit veya fizik tabanlı eşik (ör. belirli flux seviyesi) ve raporlama.
5. ACE/DSCOVR, Kp indeksi gibi ek kanallarla **jeomanyetik** hedefler (ayrı model).
6. Üretim WSGI (gunicorn/uvicorn + proxy), HTTPS, rate limit.

---

## 13. Kaynakça

- NOAA Space Weather Prediction Center: https://www.swpc.noaa.gov/
- GOES X-ışını JSON örneği: `https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json`
- Streamlit: https://streamlit.io/ — Community Cloud: https://streamlit.io/cloud
- LightGBM, scikit-learn, Flask resmi dokümantasyonları.

---

*Bu rapor, kod tabanıyla tutarlılık için periyodik güncellenmelidir.*
