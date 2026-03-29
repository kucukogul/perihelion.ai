(() => {
    const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
    const lerp = (a, b, t) => a + (b - a) * t;
    const predictUrl = () => {
        if (typeof window.__PERIHELION_PREDICT_URL__ === "string" && window.__PERIHELION_PREDICT_URL__) {
            return window.__PERIHELION_PREDICT_URL__;
        }
        const storedBase = typeof localStorage !== "undefined" && localStorage.getItem("perihelion_api_base");
        if (storedBase) {
            return `${String(storedBase).replace(/\/$/, "")}/api/predict`;
        }
        try {
            const u = new URL(window.location.href);
            if (u.protocol !== "http:" && u.protocol !== "https:") {
                throw new Error("unsupported protocol");
            }
            const port = u.port || (u.protocol === "https:" ? "443" : "80");
            const staticDevPorts = new Set([ "8080", "8081", "8082", "3000", "5173", "5500", "4173", "5005", "8888" ]);
            if (staticDevPorts.has(port)) {
                const h = u.hostname.includes(":") ? `[${u.hostname}]` : u.hostname;
                return `${u.protocol}//${h}:5050/api/predict`;
            }
            return `${u.protocol}//${u.host}/api/predict`;
        } catch (_) {}
        return "http://127.0.0.1:5050/api/predict";
    };
    const BACKEND_URL = predictUrl();
    const EARTH_DISTANCE_KM = 15e5;
    const TIMELINE_STORM_THRESHOLD = 500;
    const CHART_WINDOW_POINTS = 60;
    const CHART_MAX_HISTORY_POINTS = 1800;
    const TIMELINE_MIN_RATE = .003;
    const TIMELINE_MAX_RATE = .028;
    const ui = {
        dashboard: document.querySelector(".dashboard"),
        windValue: document.getElementById("wind-speed-value"),
        windFill: document.getElementById("wind-speed-fill"),
        protonValue: document.getElementById("proton-density-value"),
        protonFill: document.getElementById("proton-density-fill"),
        bzValue: document.getElementById("bz-value"),
        electronFluxValue: document.getElementById("electron-flux-value"),
        kpValue: document.getElementById("kp-value"),
        kpPredictionValue: document.getElementById("kp-prediction-value"),
        kpCard: document.getElementById("kp-card"),
        kpFill: document.getElementById("kp-fill"),
        kpScale: document.getElementById("kp-scale"),
        alertCard: document.getElementById("alert-card"),
        alarmLevel: document.getElementById("alarm-level"),
        alarmMessage: document.getElementById("alarm-message"),
        alarmWindow: document.getElementById("alarm-window"),
        aiConfidenceValue: document.getElementById("ai-confidence-value"),
        statusTitle: document.getElementById("status-title"),
        telemetryChart: document.getElementById("telemetry-chart"),
        telemetryUploadState: document.getElementById("telemetry-upload-state"),
        telemetryChartWrap: document.getElementById("telemetry-chart-wrap"),
        connectSystemBtn: document.getElementById("connect-system-btn"),
        connectionError: document.getElementById("connection-error"),
        aiTerminalLog: document.getElementById("ai-terminal-log"),
        pauseIndicator: document.getElementById("pause-indicator"),
        hudLegend: document.querySelector(".hud-legend"),
        stormTimeline: document.getElementById("storm-timeline"),
        timelineLineActive: document.getElementById("timeline-line-active"),
        timelineTracker: document.getElementById("timeline-tracker"),
        timelineEarthEta: document.getElementById("timeline-earth-eta"),
        timelineCriticalAlert: document.getElementById("timeline-critical-alert"),
        impactIonoValue: document.getElementById("impact-iono-value"),
        impactOrbitValue: document.getElementById("impact-orbit-value"),
        impactGicValue: document.getElementById("impact-gic-value")
    };
    const sim = {
        paused: false,
        hasData: false,
        connected: false,
        pollingId: null,
        aiPredictionKp: null,
        stormIntensity: 0,
        wind: 388,
        proton: 1.8,
        kp: 2,
        bz: 1.2,
        electronFlux: 900,
        timelineProgress: 0,
        timelineRate: TIMELINE_MIN_RATE,
        arrivalRemainingSec: null,
        aiConfidence: 95,
        lastConfidenceTick: 0,
        isFetching: false
    };
    const setRiskClass = (node, level) => {
        if (!node) {
            return;
        }
        node.classList.remove("risk-low", "risk-medium", "risk-critical");
        node.classList.add(`risk-${level}`);
    };
    const updateAiConfidence = (now = performance.now()) => {
        if (!ui.aiConfidenceValue) {
            return;
        }
        if (!sim.hasData) {
            ui.aiConfidenceValue.textContent = "--%";
            return;
        }
        if (now - sim.lastConfidenceTick >= 850) {
            const drift = (Math.random() - .5) * 1.3;
            sim.aiConfidence = clamp(sim.aiConfidence + drift, 92, 98);
            sim.lastConfidenceTick = now;
        }
        ui.aiConfidenceValue.textContent = `${sim.aiConfidence.toFixed(1)}%`;
    };
    const calculateArrivalSecondsFromWind = windSpeed => {
        const safeWind = clamp(Number(windSpeed) || 0, 1, 3e3);
        return EARTH_DISTANCE_KM / safeWind;
    };
    const formatCountdown = seconds => {
        if (!Number.isFinite(seconds) || seconds < 0) {
            return "--:--:--";
        }
        const total = Math.floor(seconds);
        const hours = String(Math.floor(total / 3600)).padStart(2, "0");
        const minutes = String(Math.floor(total % 3600 / 60)).padStart(2, "0");
        const secs = String(total % 60).padStart(2, "0");
        return `${hours}:${minutes}:${secs}`;
    };
    const applyTimelineFromWind = windSpeed => {
        const stormActive = Number(windSpeed) >= TIMELINE_STORM_THRESHOLD;
        if (!stormActive) {
            sim.arrivalRemainingSec = null;
            sim.timelineRate = 0;
            sim.timelineProgress = 0;
            return;
        }
        const recalculatedArrival = calculateArrivalSecondsFromWind(windSpeed);
        if (!Number.isFinite(sim.arrivalRemainingSec)) {
            sim.arrivalRemainingSec = recalculatedArrival;
        } else {
            sim.arrivalRemainingSec = lerp(sim.arrivalRemainingSec, recalculatedArrival, .45);
        }
        const speedNorm = clamp((windSpeed - TIMELINE_STORM_THRESHOLD) / 500, 0, 1);
        sim.timelineRate = lerp(TIMELINE_MIN_RATE, TIMELINE_MAX_RATE, speedNorm);
    };
    const tickTimeline = deltaSeconds => {
        if (!sim.hasData) {
            return;
        }
        if (Number.isFinite(sim.arrivalRemainingSec)) {
            sim.arrivalRemainingSec = Math.max(0, sim.arrivalRemainingSec - deltaSeconds);
        }
        sim.timelineProgress = clamp(sim.timelineProgress + sim.timelineRate * deltaSeconds, 0, 1);
    };
    const updateTimelineUI = () => {
        const stormActive = sim.hasData && sim.wind >= TIMELINE_STORM_THRESHOLD;
        if (ui.stormTimeline) {
            ui.stormTimeline.style.setProperty("--timeline-progress", sim.hasData ? sim.timelineProgress.toFixed(4) : "0");
            ui.stormTimeline.classList.toggle("critical", stormActive);
        }
        if (ui.timelineTracker) {
            const progress = stormActive ? sim.timelineProgress : 0;
            ui.timelineTracker.style.left = `${(2.5 + progress * 95).toFixed(2)}%`;
            const trackerDot = ui.timelineTracker.querySelector(".dot");
            const trackerLabel = ui.timelineTracker.querySelector("span:last-child");
            if (trackerDot) {
                if (stormActive) {
                    trackerDot.style.borderColor = "rgba(255, 234, 196, 0.9)";
                    trackerDot.style.background = "radial-gradient(circle at 35% 35%, #fff4d2 0%, #ffd37f 55%, #f5aa49 100%)";
                    trackerDot.style.boxShadow = "0 0 12px rgba(255, 191, 109, 0.75), 0 0 24px rgba(255, 176, 84, 0.35)";
                } else {
                    trackerDot.style.borderColor = "rgba(168, 187, 210, 0.75)";
                    trackerDot.style.background = "radial-gradient(circle at 35% 35%, #dce7f4 0%, #a9bfd9 62%, #7f95ad 100%)";
                    trackerDot.style.boxShadow = "0 0 6px rgba(115, 145, 176, 0.26)";
                }
            }
            if (trackerLabel) {
                trackerLabel.style.color = stormActive ? "#f4d9ad" : "#b8c8da";
                trackerLabel.style.textShadow = stormActive ? "0 0 8px rgba(255, 197, 122, 0.3)" : "none";
            }
        }
        if (ui.timelineLineActive) {
            if (stormActive) {
                ui.timelineLineActive.style.background = "linear-gradient(90deg, rgba(255, 190, 112, 0.45) 0%, rgba(255, 152, 64, 0.9) 60%, rgba(255, 216, 162, 0.98) 100%)";
                ui.timelineLineActive.style.boxShadow = "0 0 10px rgba(255, 167, 84, 0.7), 0 0 20px rgba(255, 167, 84, 0.38)";
            } else {
                ui.timelineLineActive.style.background = "linear-gradient(90deg, rgba(130, 156, 182, 0.22) 0%, rgba(130, 156, 182, 0.45) 100%)";
                ui.timelineLineActive.style.boxShadow = "none";
            }
        }
        const timelineNode1Title = ui.stormTimeline?.querySelector(".timeline-event h2");
        if (timelineNode1Title) {
            timelineNode1Title.textContent = stormActive ? "GÜNEŞ PATLAMASI (CME Tespit Edildi)" : "NORMAL AKIŞ (Fırtına Yok)";
        }
        if (ui.timelineEarthEta) {
            const etaText = stormActive ? formatCountdown(sim.arrivalRemainingSec) : "--:--:--";
            ui.timelineEarthEta.textContent = `Tahmini Varış: ${etaText}`;
        }
        if (ui.timelineCriticalAlert) {
            ui.timelineCriticalAlert.textContent = stormActive ? "AKTİF KRİZ" : "";
        }
    };
    const setKpScale = level => {
        if (!ui.kpScale) {
            return;
        }
        const nodes = ui.kpScale.querySelectorAll("[data-kp-level]");
        nodes.forEach(node => {
            node.classList.toggle("active", Number(node.dataset.kpLevel) === level);
        });
    };
    const setAlarmState = () => {
        if (!sim.hasData) {
            if (ui.alertCard) {
                ui.alertCard.classList.remove("red-alert");
            }
            if (ui.statusTitle) {
                ui.statusTitle.classList.remove("red");
            }
            if (ui.alarmLevel) {
                ui.alarmLevel.textContent = "BEKLEME";
                ui.alarmLevel.classList.remove("active-analysis");
            }
            if (ui.alarmMessage) {
                ui.alarmMessage.textContent = "Canlı AI verisi bekleniyor";
            }
            if (ui.alarmWindow) {
                ui.alarmWindow.textContent = "Etki penceresi: Veri bekleniyor";
            }
            return;
        }
        const red = sim.kp >= 7;
        const yellow = sim.kp >= 5 && sim.kp < 7;
        if (ui.alertCard) {
            ui.alertCard.classList.toggle("red-alert", red);
        }
        if (ui.statusTitle) {
            ui.statusTitle.classList.toggle("red", red);
        }
        if (ui.alarmLevel) {
            ui.alarmLevel.textContent = "AKTİF ANALİZ";
            ui.alarmLevel.classList.add("active-analysis");
        }
        if (ui.alarmMessage) {
            ui.alarmMessage.textContent = red ? "AI modeli yüksek jeomanyetik etkilenme saptadı" : yellow ? "AI modeli orta seviye etki olasılığı raporluyor" : "AI modeli düşük seviye etki ve nominal akış raporluyor";
        }
        if (ui.alarmWindow) {
            ui.alarmWindow.textContent = red ? "Etki penceresi: Şimdi" : yellow ? "Etki penceresi: T-9 saat" : "Etki penceresi: Düşük risk";
        }
    };
    const getPredictedKp = () => {
        if (!sim.hasData) {
            return 0;
        }
        if (Number.isFinite(sim.aiPredictionKp)) {
            return clamp(Math.round(sim.aiPredictionKp), 1, 9);
        }
        const windRisk = clamp((sim.wind - 420) / 520, 0, 1);
        const protonRisk = clamp((sim.proton - 2.8) / 7.5, 0, 1);
        const bzRisk = clamp(-sim.bz / 14, 0, 1);
        const modeled = sim.kp + .6 + windRisk * 1.4 + protonRisk * 1.1 + bzRisk * 1.25;
        return clamp(Math.round(modeled), 1, 9);
    };
    const getPredictedWind = () => {
        if (!sim.hasData) {
            return 0;
        }
        const kpDelta = getPredictedKp() - sim.kp;
        const stormBias = clamp((sim.kp - 4) / 5, 0, 1) * 78;
        return clamp(sim.wind + kpDelta * 64 + stormBias + 18, 0, 1e3);
    };
    const formatTimeLabel = raw => {
        if (typeof raw === "string" && /^\d{2}:\d{2}:\d{2}$/.test(raw.trim())) {
            return raw.trim();
        }
        const d = raw ? new Date(raw) : new Date;
        if (Number.isNaN(d.getTime())) {
            return (new Date).toLocaleTimeString("tr-TR", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit"
            });
        }
        return d.toLocaleTimeString("tr-TR", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        });
    };
    const setWaitingState = (waiting, errorMessage = "") => {
        if (ui.dashboard) {
            ui.dashboard.classList.toggle("waiting-data", waiting);
        }
        if (ui.telemetryUploadState) {
            ui.telemetryUploadState.style.display = waiting ? "flex" : "none";
        }
        if (ui.telemetryChartWrap) {
            ui.telemetryChartWrap.classList.remove("is-hidden");
            ui.telemetryChartWrap.classList.toggle("is-waiting", waiting);
        }
        if (ui.connectionError) {
            ui.connectionError.textContent = errorMessage;
        }
    };
    const writeAiLog = message => {
        if (ui.aiTerminalLog) {
            ui.aiTerminalLog.textContent = message;
        }
    };
    const applyDataPoint = point => {
        if (!point || typeof point !== "object") {
            console.error("[DATA] Payload null/undefined:", point);
            return false;
        }
        try {
            const windRaw = Number(point?.windSpeed ?? point?.wind ?? sim.wind);
            const protonRaw = Number(point?.protonDensity ?? point?.proton ?? sim.proton);
            const kpRaw = Number(point?.kpIndex ?? point?.kp ?? sim.kp);
            const bzRaw = Number(point?.bz ?? sim.bz);
            const fluxRaw = Number(point?.electronFlux ?? point?.flux ?? sim.electronFlux);
            if (!Number.isFinite(windRaw) || !Number.isFinite(protonRaw) || !Number.isFinite(kpRaw) || !Number.isFinite(bzRaw) || !Number.isFinite(fluxRaw)) {
                console.error("[DATA] NaN/Infinity detected:", {
                    wind: windRaw,
                    proton: protonRaw,
                    kp: kpRaw,
                    bz: bzRaw,
                    flux: fluxRaw
                });
                return false;
            }
            sim.wind = clamp(windRaw, 0, 1e3);
            sim.proton = clamp(protonRaw, 0, 20);
            sim.kp = clamp(kpRaw, 0, 9);
            sim.bz = clamp(bzRaw, -30, 30);
            sim.electronFlux = clamp(fluxRaw, 0, 3e4);
            sim.aiPredictionKp = Number.isFinite(Number(point?.aiPredictionKp)) ? Number(point.aiPredictionKp) : null;
            applyTimelineFromWind(sim.wind);
            const windIntensity = clamp((sim.wind - 420) / 520, 0, 1);
            const kpIntensity = clamp((sim.kp - 4) / 5, 0, 1);
            const protonIntensity = clamp((sim.proton - 3) / 7, 0, 1);
            const bzIntensity = clamp(-sim.bz / 12, 0, 1);
            sim.stormIntensity = clamp((windIntensity + kpIntensity + protonIntensity + bzIntensity) / 4, 0, 1);
            return true;
        } catch (err) {
            console.error("[DATA] applyDataPoint exception:", err, "Payload:", point);
            return false;
        }
    };
    let telemetryChart = null;
    let chartAutoFollow = true;
    const initTelemetryChart = () => {
        if (!ui.telemetryChart || typeof Chart === "undefined") {
            console.warn("[CHART] Chart.js yok veya canvas bulunamadı");
            return;
        }
        let zoomOk = false;
        const zoomPlugin = window.chartjsPluginZoom?.default || window.ChartZoom || window.zoomPlugin;
        if (zoomPlugin && typeof Chart.register === "function") {
            try {
                Chart.register(zoomPlugin);
                zoomOk = true;
            } catch (e) {
                console.warn("[CHART] Zoom eklentisi kaydedilemedi, grafik zoomsuz:", e);
            }
        }
        const pluginZoomOptions = zoomOk ? {
            zoom: {
                pan: {
                    enabled: true,
                    mode: "x",
                    threshold: 4,
                    onPanStart: () => {
                        chartAutoFollow = false;
                    }
                },
                zoom: {
                    wheel: {
                        enabled: false
                    },
                    pinch: {
                        enabled: false
                    },
                    drag: {
                        enabled: false
                    },
                    mode: "x"
                }
            }
        } : {};
        telemetryChart = new Chart(ui.telemetryChart, {
            type: "line",
            data: {
                labels: [],
                datasets: [ {
                    label: "Gerçek rüzgar (SW)",
                    data: [],
                    borderColor: "#6eb8ff",
                    borderWidth: 2.5,
                    borderDash: [ 14, 7 ],
                    pointRadius: 0,
                    pointBackgroundColor: "#6eb8ff",
                    tension: .24,
                    fill: false
                }, {
                    label: "AI tahmini rüzgar",
                    data: [],
                    borderColor: "#ffb266",
                    borderWidth: 2.2,
                    borderDash: [ 6, 5 ],
                    pointRadius: 0,
                    fill: false,
                    tension: .3
                } ]
            },
            options: {
                animation: false,
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: "index",
                    intersect: false
                },
                scales: {
                    x: {
                        min: 0,
                        max: CHART_WINDOW_POINTS - 1,
                        ticks: {
                            color: "rgba(190, 206, 222, 0.76)",
                            maxTicksLimit: 6,
                            autoSkip: true,
                            minRotation: 0,
                            maxRotation: 0,
                            font: {
                                size: 9
                            }
                        },
                        grid: {
                            color: "rgba(255,255,255,0.05)"
                        },
                        border: {
                            color: "rgba(255,255,255,0.05)"
                        }
                    },
                    y: {
                        min: 0,
                        max: 1e3,
                        ticks: {
                            color: "rgba(190, 206, 222, 0.76)",
                            stepSize: 200,
                            font: {
                                size: 9
                            }
                        },
                        grid: {
                            color: "rgba(255,255,255,0.05)"
                        },
                        border: {
                            color: "rgba(255,255,255,0.05)"
                        }
                    }
                },
                plugins: {
                    legend: {
                        labels: {
                            color: "rgba(212, 227, 244, 0.9)",
                            boxWidth: 10,
                            boxHeight: 2,
                            font: {
                                size: 10,
                                weight: 600
                            }
                        }
                    },
                    tooltip: {
                        enabled: false
                    },
                    ...pluginZoomOptions
                }
            }
        });
        requestAnimationFrame(() => {
            if (telemetryChart) {
                telemetryChart.resize();
            }
        });
        if (ui.telemetryChartWrap && typeof ResizeObserver !== "undefined") {
            const ro = new ResizeObserver(() => {
                if (telemetryChart) {
                    telemetryChart.resize();
                }
            });
            ro.observe(ui.telemetryChartWrap);
        }
    };
    const pushTelemetryToChart = (label, wind, predicted) => {
        if (!telemetryChart) {
            console.warn("[CHART] telemetryChart yoktu, atlanıyor");
            return;
        }
        try {
            const validWind = Number.isFinite(wind) ? wind : null;
            const validPredicted = Number.isFinite(predicted) ? predicted : null;
            if (validWind === null || validPredicted === null) {
                console.error("[CHART] Geçersiz veri algılandı (NaN/Infinity), atlanıyor:", {
                    wind: wind,
                    predicted: predicted,
                    validWind: validWind,
                    validPredicted: validPredicted
                });
                return;
            }
            if (!telemetryChart?.data?.datasets?.[0] || !telemetryChart?.data?.datasets?.[1]) {
                console.error("[CHART] Chart dataset structure eksik");
                return;
            }
            telemetryChart.data.labels.push(formatTimeLabel(label));
            telemetryChart.data.datasets[0].data.push(validWind);
            telemetryChart.data.datasets[1].data.push(validPredicted);
            const total = telemetryChart.data.labels.length;
            if (total > CHART_MAX_HISTORY_POINTS) {
                const overflow = total - CHART_MAX_HISTORY_POINTS;
                telemetryChart.data.labels.splice(0, overflow);
                telemetryChart.data.datasets[0].data.splice(0, overflow);
                telemetryChart.data.datasets[1].data.splice(0, overflow);
                const xScale = telemetryChart.options.scales.x;
                if (typeof xScale.min === "number") {
                    xScale.min = Math.max(0, xScale.min - overflow);
                }
                if (typeof xScale.max === "number") {
                    xScale.max = Math.max(0, xScale.max - overflow);
                }
            }
            const latestIndex = telemetryChart.data.labels.length - 1;
            const windowStart = Math.max(0, latestIndex - (CHART_WINDOW_POINTS - 1));
            if (chartAutoFollow) {
                telemetryChart.options.scales.x.min = windowStart;
                telemetryChart.options.scales.x.max = Math.max(0, latestIndex);
            }
            if (telemetryChart.data.datasets[0].data.length >= 2) {
                const len = telemetryChart.data.datasets[0].data.length;
                const prevWind = telemetryChart.data.datasets[0].data[len - 2];
                const currWind = telemetryChart.data.datasets[0].data[len - 1];
                const windChange = Math.abs(currWind - prevWind);
                if (windChange > 50) {
                    telemetryChart.data.datasets[0].pointRadius = 3;
                    telemetryChart.data.datasets[0].pointBackgroundColor = windChange > 100 ? "#ff7a3d" : "#6eb8ff";
                } else {
                    telemetryChart.data.datasets[0].pointRadius = 0;
                }
            }
            try {
                telemetryChart.update("none");
                if (telemetryChart.canvas) {
                    const {width: width, height: height} = telemetryChart.canvas.getBoundingClientRect();
                    if (width < 2 || height < 2) {
                        telemetryChart.resize();
                    }
                }
            } catch (updateErr) {
                console.error("[CHART] update() hatası:", updateErr);
            }
        } catch (err) {
            console.error("[CHART] pushTelemetryToChart exception:", err, {
                label: label,
                wind: wind,
                predicted: predicted
            });
        }
    };
    const clearTelemetryChart = () => {
        if (!telemetryChart) {
            return;
        }
        telemetryChart.data.labels = [];
        telemetryChart.data.datasets[0].data = [];
        telemetryChart.data.datasets[1].data = [];
        telemetryChart.options.scales.x.min = 0;
        telemetryChart.options.scales.x.max = CHART_WINDOW_POINTS - 1;
        chartAutoFollow = true;
        telemetryChart.update("none");
    };
    const fetchRealtimeData = async () => {
        if (sim.isFetching) {
            console.debug("[FETCH] İstek devam ediyor, yeni fetch atlanıyor");
            return;
        }
        sim.isFetching = true;
        try {
            const hadData = sim.hasData;
            const fetchStartTime = Date.now();
            const response = await fetch(BACKEND_URL, {
                method: "GET",
                cache: "no-store",
                headers: {
                    Accept: "application/json"
                },
                signal: AbortSignal.timeout ? AbortSignal.timeout(8e3) : undefined
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            const payload = await response.json();
            const fetchTime = Date.now() - fetchStartTime;
            if (!payload || typeof payload !== "object") {
                console.error("[FETCH] Boş payload:", payload);
                throw new Error("Backend boş veri döndü");
            }
            const dataApplied = applyDataPoint(payload);
            if (!dataApplied) {
                throw new Error("Veri işleme başarısız - geçersiz format");
            }
            sim.hasData = true;
            setWaitingState(false, "");
            const label = payload?.time ? String(payload.time) : (new Date).toLocaleTimeString("tr-TR", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit"
            });
            pushTelemetryToChart(label, sim.wind, getPredictedWind());
            writeAiLog(`[SYS] OK (${fetchTime}ms) | SW:${Math.round(sim.wind)} km/s | Kp:${sim.kp?.toFixed(1) ?? "?"}`);
            updateUI();
            console.log("[FETCH] CME reset kontrolü:", {
                hadData: hadData,
                sceneReady: sceneReady,
                resetCmeIsFunction: typeof resetCME === "function",
                willReset: !hadData && sceneReady && typeof resetCME === "function"
            });
            if (!hadData && sceneReady && typeof resetCME === "function") {
                try {
                    console.log("[FETCH] CALLING resetCME()...");
                    resetCME();
                    console.log("[FETCH] CME reset başarılı");
                } catch (e) {
                    console.error("[FETCH] resetCME() exception:", e);
                }
            } else if (!hadData && !sceneReady) {
                console.warn("[FETCH] Scene hazır değil - resetCME() çağrılmadı");
            }
        } catch (error) {
            sim.hasData = false;
            setWaitingState(true, "Bağlantı Hatası: AI Sunucusu Çevrimdışı");
            console.error("[FETCH] Detaylı hata:", {
                message: error?.message || "Bilinmeyen",
                type: error?.name || "Error",
                url: BACKEND_URL,
                timestamp: (new Date).toISOString()
            });
            writeAiLog(`[ERR] ${error?.message ?? "Backend offline"}`);
            updateUI();
        } finally {
            sim.isFetching = false;
        }
    };
    const startBackendPolling = () => {
        if (sim.pollingId) {
            console.warn("[POLL] Backend polling zaten aktif, atlanıyor");
            return;
        }
        try {
            sim.connected = true;
            sim.isFetching = false;
            if (ui.connectSystemBtn) {
                ui.connectSystemBtn.disabled = true;
                ui.connectSystemBtn.textContent = "BAĞLANTI AKTİF";
            }
            writeAiLog("[SYS] Sinir Ağı'na bağlanıyor...");
            setWaitingState(true, "");
            clearTelemetryChart();
            fetchRealtimeData();
            sim.pollingId = window.setInterval(() => {
                if (sim.connected && !sim.isFetching) {
                    fetchRealtimeData();
                }
            }, 2e3);
            console.log("[POLL] Backend polling başlatıldı, Interval ID:", sim.pollingId);
        } catch (err) {
            console.error("[POLL] startBackendPolling hatası:", err);
            sim.pollingId = null;
            setWaitingState(true, "Bağlantı başlatılırken hata");
        }
    };
    if (ui.connectSystemBtn) {
        ui.connectSystemBtn.addEventListener("click", startBackendPolling);
    }
    const updateUI = () => {
        const windRounded = sim.hasData ? Math.round(sim.wind) : null;
        const protonRounded = sim.hasData ? sim.proton.toFixed(1) : null;
        const kpRounded = sim.hasData ? Math.round(sim.kp) : null;
        const predictedKp = sim.hasData ? getPredictedKp() : 0;
        if (ui.windValue) {
            ui.windValue.textContent = windRounded === null ? "--" : String(windRounded);
        }
        if (ui.protonValue) {
            ui.protonValue.textContent = protonRounded === null ? "--" : protonRounded;
        }
        if (ui.kpValue) {
            ui.kpValue.textContent = kpRounded === null ? "-- / 9" : `${kpRounded} / 9`;
        }
        if (ui.kpPredictionValue) {
            ui.kpPredictionValue.textContent = sim.hasData ? `${predictedKp} / 9` : "-- / 9";
        }
        if (ui.windFill) {
            ui.windFill.style.width = sim.hasData ? `${(clamp((sim.wind - 350) / 600, 0, 1) * 100).toFixed(1)}%` : "0%";
        }
        if (ui.protonFill) {
            ui.protonFill.style.width = sim.hasData ? `${(clamp((sim.proton - 2) / 8, 0, 1) * 100).toFixed(1)}%` : "0%";
        }
        if (ui.kpFill) {
            ui.kpFill.style.width = sim.hasData ? `${(clamp((sim.kp - 1) / 8, 0, 1) * 100).toFixed(1)}%` : "0%";
        }
        if (ui.kpCard) {
            ui.kpCard.classList.remove("kp-low", "kp-medium", "kp-critical");
            if (sim.hasData) {
                if (sim.kp >= 7) {
                    ui.kpCard.classList.add("kp-critical");
                } else if (sim.kp >= 5) {
                    ui.kpCard.classList.add("kp-medium");
                } else {
                    ui.kpCard.classList.add("kp-low");
                }
            }
        }
        if (ui.bzValue) {
            ui.bzValue.textContent = sim.hasData ? `${sim.bz.toFixed(1)} nT` : "-- nT";
        }
        if (ui.electronFluxValue) {
            ui.electronFluxValue.textContent = sim.hasData ? `${(sim.electronFlux / 1e3).toFixed(1)}e3` : "--";
        }
        setKpScale(kpRounded ?? 0);
        setAlarmState();
        updateAiConfidence();
        const operationalKp = Math.max(sim.kp, predictedKp);
        if (ui.impactIonoValue) {
            if (!sim.hasData || operationalKp <= 4) {
                ui.impactIonoValue.textContent = "Düşük";
                setRiskClass(ui.impactIonoValue, "low");
            } else if (operationalKp <= 6) {
                ui.impactIonoValue.textContent = "Orta";
                setRiskClass(ui.impactIonoValue, "medium");
            } else {
                ui.impactIonoValue.textContent = "Kritik";
                setRiskClass(ui.impactIonoValue, "critical");
            }
        }
        if (ui.impactOrbitValue) {
            if (!sim.hasData || operationalKp <= 4) {
                ui.impactOrbitValue.textContent = "Nominal";
                setRiskClass(ui.impactOrbitValue, "low");
            } else if (operationalKp <= 6) {
                ui.impactOrbitValue.textContent = "Koruma Modu";
                setRiskClass(ui.impactOrbitValue, "medium");
            } else {
                ui.impactOrbitValue.textContent = "Kritik Manevra";
                setRiskClass(ui.impactOrbitValue, "critical");
            }
        }
        if (ui.impactGicValue) {
            if (sim.hasData && sim.kp > 7) {
                ui.impactGicValue.textContent = "KRİTİK - Acil Müdahale";
                setRiskClass(ui.impactGicValue, "critical");
            } else if (!sim.hasData || operationalKp <= 4) {
                ui.impactGicValue.textContent = "Düşük";
                setRiskClass(ui.impactGicValue, "low");
            } else if (operationalKp <= 6) {
                ui.impactGicValue.textContent = "Orta";
                setRiskClass(ui.impactGicValue, "medium");
            } else {
                ui.impactGicValue.textContent = "Kritik";
                setRiskClass(ui.impactGicValue, "critical");
            }
        }
        updateTimelineUI();
    };
    const setPauseIndicator = () => {
        if (ui.pauseIndicator) {
            ui.pauseIndicator.classList.toggle("show", sim.paused);
        }
    };
    const revealHudLegend = (durationMs = 2200) => {
        if (!ui.hudLegend) {
            return;
        }
        ui.hudLegend.classList.add("is-visible");
        ui.hudLegend.classList.remove("is-dim");
        window.clearTimeout(revealHudLegend.timeoutId);
        revealHudLegend.timeoutId = window.setTimeout(() => {
            ui.hudLegend.classList.remove("is-visible");
            ui.hudLegend.classList.add("is-dim");
        }, durationMs);
    };
    const externalScriptCache = new Map;
    const loadExternalScript = src => {
        if (externalScriptCache.has(src)) {
            return externalScriptCache.get(src);
        }
        const promise = new Promise(resolve => {
            const script = document.createElement("script");
            script.src = src;
            script.async = true;
            script.onload = () => resolve(true);
            script.onerror = () => resolve(false);
            document.head.appendChild(script);
        });
        externalScriptCache.set(src, promise);
        return promise;
    };
    const loadOrbitControls = async () => {
        if (THREE.OrbitControls) {
            return;
        }
        await loadExternalScript("https://cdn.jsdelivr.net/gh/mrdoob/three.js@r152/examples/js/controls/OrbitControls.js");
    };
    const loadPostProcessing = async () => {
        if (THREE.EffectComposer && THREE.RenderPass && THREE.UnrealBloomPass) {
            return;
        }
        const postFxScripts = [ "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r152/examples/js/postprocessing/Pass.js", "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r152/examples/js/postprocessing/EffectComposer.js", "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r152/examples/js/postprocessing/RenderPass.js", "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r152/examples/js/postprocessing/ShaderPass.js", "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r152/examples/js/postprocessing/MaskPass.js", "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r152/examples/js/shaders/CopyShader.js", "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r152/examples/js/shaders/LuminosityHighPassShader.js", "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r152/examples/js/postprocessing/UnrealBloomPass.js" ];
        for (const src of postFxScripts) {
            await loadExternalScript(src);
        }
    };
    const init3D = async () => {
        const sceneArea = document.querySelector(".scene-area");
        if (!sceneArea || typeof THREE === "undefined") {
            return;
        }
        await loadOrbitControls();
        const setTextureColorSpace = (texture, srgb = true) => {
            if (!texture) {
                return;
            }
            if ("colorSpace" in texture && THREE.SRGBColorSpace) {
                texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
            } else if ("encoding" in texture) {
                texture.encoding = srgb ? THREE.sRGBEncoding : THREE.LinearEncoding;
            }
        };
        const createSolidTexture = (r, g, b) => {
            const data = new Uint8Array([ r, g, b, 255 ]);
            const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
            texture.needsUpdate = true;
            setTextureColorSpace(texture, true);
            return texture;
        };
        const loadTextureWithFallback = async (paths, opts = {}) => {
            const loader = new THREE.TextureLoader;
            loader.setCrossOrigin("anonymous");
            for (const path of paths) {
                try {
                    const texture = await new Promise((resolve, reject) => {
                        loader.load(path, resolve, undefined, reject);
                    });
                    setTextureColorSpace(texture, opts.srgb !== false);
                    texture.anisotropy = opts.anisotropy || 1;
                    texture.wrapS = opts.wrapS || THREE.RepeatWrapping;
                    texture.wrapT = opts.wrapT || THREE.RepeatWrapping;
                    return texture;
                } catch (error) {
                    continue;
                }
            }
            return null;
        };
        const scene = new THREE.Scene;
        scene.background = new THREE.Color(0);
        scene.fog = new THREE.FogExp2(66314, 28e-5);
        const sceneOffsetX = -6;
        const earthWorldPosition = new THREE.Vector3(sceneOffsetX, 0, 0);
        const camera = new THREE.PerspectiveCamera(48, 1, .1, 400);
        camera.position.set(sceneOffsetX + .8, 6, 26);
        camera.lookAt(sceneOffsetX, 0, 0);
        const renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: true
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        if ("outputColorSpace" in renderer && THREE.SRGBColorSpace) {
            renderer.outputColorSpace = THREE.SRGBColorSpace;
        } else {
            renderer.outputEncoding = THREE.sRGBEncoding;
        }
        renderer.physicallyCorrectLights = true;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.56;
        renderer.setClearColor(0, 1);
        sceneArea.appendChild(renderer.domElement);
        let controls = null;
        if (THREE.OrbitControls) {
            controls = new THREE.OrbitControls(camera, renderer.domElement);
            controls.enableDamping = true;
            controls.dampingFactor = .032;
            controls.rotateSpeed = .42;
            controls.zoomSpeed = .55;
            controls.panSpeed = .45;
            controls.minDistance = 8;
            controls.maxDistance = 40;
            controls.enablePan = true;
            controls.target.set(sceneOffsetX, 0, 0);
        }
        const maxAniso = Math.max(renderer.capabilities.getMaxAnisotropy(), 1);
        const deepSpaceTexture = await loadTextureWithFallback([ "assets/8k_stars_milky_way.jpg" ], {
            srgb: true,
            anisotropy: maxAniso,
            wrapS: THREE.ClampToEdgeWrapping,
            wrapT: THREE.ClampToEdgeWrapping
        });
        if (deepSpaceTexture) {
            const spaceDome = new THREE.Mesh(new THREE.SphereGeometry(320, 96, 96), new THREE.MeshBasicMaterial({
                map: deepSpaceTexture,
                side: THREE.BackSide,
                transparent: false
            }));
            spaceDome.rotation.y = Math.PI * .25;
            scene.add(spaceDome);
        }
        const earthTiltGroup = new THREE.Group;
        earthTiltGroup.position.copy(earthWorldPosition);
        earthTiltGroup.rotation.z = THREE.MathUtils.degToRad(23.5);
        scene.add(earthTiltGroup);
        const fallbackDayTex = createSolidTexture(87, 128, 168);
        const fallbackNightTex = createSolidTexture(18, 23, 35);
        const earthMaterial = new THREE.ShaderMaterial({
            uniforms: {
                uDayMap: {
                    value: fallbackDayTex
                },
                uNightMap: {
                    value: fallbackNightTex
                },
                uLightDir: {
                    value: new THREE.Vector3(1, 0, 0)
                },
                uTime: {
                    value: 0
                }
            },
            vertexShader: `\n        varying vec2 vUv;\n        varying vec3 vWorldNormal;\n\n        void main() {\n          vUv = uv;\n          vec4 worldPos = modelMatrix * vec4(position, 1.0);\n          vWorldNormal = normalize(mat3(modelMatrix) * normal);\n          gl_Position = projectionMatrix * viewMatrix * worldPos;\n        }\n      `,
            fragmentShader: `\n        uniform sampler2D uDayMap;\n        uniform sampler2D uNightMap;\n        uniform vec3 uLightDir;\n        uniform float uTime;\n\n        varying vec2 vUv;\n        varying vec3 vWorldNormal;\n\n        void main() {\n          vec3 normal = normalize(vWorldNormal);\n          float ndl = dot(normal, normalize(uLightDir));\n\n          vec3 dayColor = texture2D(uDayMap, vUv).rgb;\n          vec3 nightColor = texture2D(uNightMap, vUv).rgb;\n\n          float daylight = smoothstep(-0.22, 0.22, ndl);\n          vec3 dayBoost = dayColor * 1.2;\n          vec3 nightBoost = nightColor * 1.4;\n\n          vec3 color = mix(nightBoost + dayColor * 0.3, dayBoost, daylight);\n\n          float twilight = smoothstep(-0.12, 0.08, ndl) - smoothstep(0.08, 0.28, ndl);\n          color += vec3(0.13, 0.17, 0.23) * twilight;\n          color *= 1.08;\n\n          float subtlePulse = 0.99 + sin(uTime * 0.22) * 0.01;\n          gl_FragColor = vec4(color * subtlePulse, 1.0);\n        }\n      `
        });
        const earth = new THREE.Mesh(new THREE.SphereGeometry(5, 128, 128), earthMaterial);
        earth.rotation.y = 4.35;
        earthTiltGroup.add(earth);
        const earthClouds = new THREE.Mesh(new THREE.SphereGeometry(5.06, 128, 128), new THREE.MeshPhongMaterial({
            color: 12834799,
            transparent: true,
            opacity: .31,
            blending: THREE.NormalBlending,
            depthWrite: false,
            shininess: 12
        }));
        earthClouds.rotation.y = 4.42;
        earthTiltGroup.add(earthClouds);
        const sunTexture = await loadTextureWithFallback([ "assets/8k_sun.jpg" ], {
            srgb: true,
            anisotropy: maxAniso,
            wrapS: THREE.ClampToEdgeWrapping,
            wrapT: THREE.ClampToEdgeWrapping
        });
        const sun = new THREE.Mesh(new THREE.SphereGeometry(30, 64, 64), new THREE.MeshBasicMaterial({
            map: sunTexture || createSolidTexture(252, 176, 76),
            color: 16777215
        }));
        sun.position.set(sceneOffsetX + 52, 1.5, -27);
        scene.add(sun);
        const sunLight = new THREE.PointLight(16777198, 3, 460, 1.2);
        sunLight.position.copy(sun.position);
        scene.add(sunLight);
        const dayTexturePromise = loadTextureWithFallback([ "assets/8k_earth_daymap.jpg" ], {
            srgb: true,
            anisotropy: maxAniso
        });
        const nightTexturePromise = loadTextureWithFallback([ "assets/8k_earth_nightmap.jpg" ], {
            srgb: true,
            anisotropy: maxAniso
        });
        const cloudTexturePromise = loadTextureWithFallback([ "assets/8k_earth_clouds.jpg" ], {
            srgb: true,
            anisotropy: maxAniso
        });
        Promise.all([ dayTexturePromise, nightTexturePromise, cloudTexturePromise ]).then(([dayMap, nightMap, cloudMap]) => {
            if (dayMap) {
                earth.material.uniforms.uDayMap.value = dayMap;
            }
            if (nightMap) {
                earth.material.uniforms.uNightMap.value = nightMap;
            }
            if (cloudMap) {
                earthClouds.material.map = cloudMap;
                earthClouds.material.alphaMap = cloudMap;
                earthClouds.material.needsUpdate = true;
            }
        });
        const magnetosphereGroup = new THREE.Group;
        magnetosphereGroup.position.copy(earthWorldPosition);
        magnetosphereGroup.visible = false;
        scene.add(magnetosphereGroup);
        const bowShockGeometry = new THREE.IcosahedronGeometry(11.2, 6);
        const bowShockMaterial = new THREE.ShaderMaterial({
            uniforms: {
                uTime: {
                    value: 0
                },
                uStormIntensity: {
                    value: 0
                },
                uWindSpeed: {
                    value: 400
                }
            },
            vertexShader: `\n        uniform float uTime;\n        uniform float uStormIntensity;\n        uniform float uWindSpeed;\n        varying vec3 vNormal;\n        varying vec3 vPosition;\n        varying float vIntensity;\n\n        void main() {\n          vNormal = normalize(normal);\n          vPosition = position;\n          \n          float compression = 0.92 - uStormIntensity * 0.12;\n          vec3 compressed = position;\n          compressed.x *= compression;\n          \n          float speedNorm = clamp((uWindSpeed - 350.0) / 600.0, 0.0, 1.0);\n          float pulse = 0.992 + sin(uTime * (1.2 + speedNorm * 1.8) + position.y) * 0.015;\n          \n          vIntensity = length(position);\n          \n          gl_Position = projectionMatrix * viewMatrix * vec4(compressed * pulse, 1.0);\n        }\n      `,
            fragmentShader: `\n        uniform float uStormIntensity;\n        uniform float uWindSpeed;\n        varying vec3 vNormal;\n        varying float vIntensity;\n\n        void main() {\n          float fresnel = pow(1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0))), 3.0);\n          \n          vec3 baseColor = mix(vec3(0.42, 0.62, 0.85), vec3(0.55, 0.75, 0.95), fresnel);\n          \n          float intensity = mix(0.05, 0.22, uStormIntensity) * fresnel;\n          float alpha = intensity * (0.4 + fresnel * 0.6);\n          \n          gl_FragColor = vec4(baseColor, alpha);\n        }\n      `,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.BackSide
        });
        const bowShock = new THREE.Mesh(bowShockGeometry, bowShockMaterial);
        bowShock.visible = false;
        magnetosphereGroup.add(bowShock);
        const shieldMaterials = [];
        [ {
            radius: 6.9,
            tube: .022,
            opacity: .09,
            tilt: 0
        }, {
            radius: 7.45,
            tube: .019,
            opacity: .07,
            tilt: .12
        } ].forEach(cfg => {
            const mat = new THREE.MeshBasicMaterial({
                color: 8173823,
                transparent: true,
                opacity: cfg.opacity,
                blending: THREE.AdditiveBlending,
                depthWrite: false
            });
            const ring = new THREE.Mesh(new THREE.TorusGeometry(cfg.radius, cfg.tube, 14, 120), mat);
            ring.rotation.y = Math.PI * .5;
            ring.rotation.z = cfg.tilt;
            magnetosphereGroup.add(ring);
            shieldMaterials.push(mat);
        });
        let composer = null;
        const earthToSunDirection = new THREE.Vector3;
        const cmeCount = 3600;
        const cmePos = new Float32Array(cmeCount * 3);
        const cmeVel = new Float32Array(cmeCount * 3);
        const cmeCol = new Float32Array(cmeCount * 3);
        const cmeSeed = new Float32Array(cmeCount);
        const cmeAge = new Float32Array(cmeCount);
        const cmeLife = new Float32Array(cmeCount);
        const cmeSize = new Float32Array(cmeCount);
        const cmeAlpha = new Float32Array(cmeCount);
        const cmeLane = new Float32Array(cmeCount);
        const cPlasmaCore = new THREE.Color(16753920);
        const cPlasmaMid = new THREE.Color(16742973);
        const cPlasmaEdge = new THREE.Color(11033146);
        const cAmbient = new THREE.Color(16750950);
        const cCool = new THREE.Color(14252634);
        const cWeak = new THREE.Color(8018506);
        const cmeWorkColor = new THREE.Color;
        const sunToEarth = (new THREE.Vector3).subVectors(earthWorldPosition, sun.position).normalize();
        const axisHint = Math.abs(sunToEarth.y) > .88 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
        const streamRight = (new THREE.Vector3).crossVectors(sunToEarth, axisHint).normalize();
        const streamUp = (new THREE.Vector3).crossVectors(streamRight, sunToEarth).normalize();
        const resetCMEParticle = (i, windSpeed = 500) => {
            const i3 = i * 3;
            const theta = Math.random() * Math.PI * 2;
            const radial = Math.pow(Math.random(), 1.7);
            const coneRadius = lerp(.12, 2, radial);
            const offsetY = Math.cos(theta) * coneRadius;
            const offsetZ = Math.sin(theta) * coneRadius;
            const spawnOffset = 35 + Math.random() * 4;
            cmePos[i3] = sun.position.x + sunToEarth.x * spawnOffset;
            cmePos[i3 + 1] = sun.position.y + sunToEarth.y * spawnOffset + streamRight.y * offsetY + streamUp.y * offsetZ;
            cmePos[i3 + 2] = sun.position.z + sunToEarth.z * spawnOffset + streamRight.z * offsetY + streamUp.z * offsetZ;
            const speed = lerp(.047, .078, 1 - radial) + Math.random() * .006;
            const spread = lerp(.0014, .009, radial);
            cmeVel[i3] = sunToEarth.x * speed + (streamRight.x * Math.cos(theta) + streamUp.x * Math.sin(theta)) * spread;
            cmeVel[i3 + 1] = sunToEarth.y * speed + (streamRight.y * Math.cos(theta) + streamUp.y * Math.sin(theta)) * spread;
            cmeVel[i3 + 2] = sunToEarth.z * speed + (streamRight.z * Math.cos(theta) + streamUp.z * Math.sin(theta)) * spread;
            cmeSeed[i] = Math.random() * Math.PI * 2;
            cmeAge[i] = 0;
            const windNorm = clamp((windSpeed - 350) / 600, 0, 1);
            cmeLife[i] = lerp(5.2, 10.6, Math.random()) * lerp(.6, 1.8, windNorm);
            cmeLane[i] = radial;
            cmeSize[i] = lerp(2.3, 1, radial) * (.9 + Math.random() * .2);
            cmeAlpha[i] = .08;
            cmeWorkColor.copy(cPlasmaCore).lerp(cPlasmaMid, .48 + Math.random() * .22).lerp(cAmbient, .18 + Math.random() * .24).lerp(cPlasmaEdge, Math.random() * .25);
            cmeCol[i3] = cmeWorkColor.r;
            cmeCol[i3 + 1] = cmeWorkColor.g;
            cmeCol[i3 + 2] = cmeWorkColor.b;
        };
        for (let i = 0; i < cmeCount; i += 1) {
            resetCMEParticle(i, 500);
        }
        const cmeGeom = new THREE.BufferGeometry;
        cmeGeom.setAttribute("position", new THREE.BufferAttribute(cmePos, 3));
        cmeGeom.setAttribute("color", new THREE.BufferAttribute(cmeCol, 3));
        cmeGeom.setAttribute("aSize", new THREE.BufferAttribute(cmeSize, 1));
        cmeGeom.setAttribute("aAlpha", new THREE.BufferAttribute(cmeAlpha, 1));
        const createCmeMaterial = (sizeBoost, alphaScale, haloBoost, useAdditive) => new THREE.ShaderMaterial({
            vertexColors: true,
            transparent: true,
            blending: useAdditive ? THREE.AdditiveBlending : THREE.NormalBlending,
            depthTest: true,
            depthWrite: false,
            defines: {
                USE_VOLUMETRIC_GLOW: 1
            },
            uniforms: {
                uPixelRatio: {
                    value: Math.min(window.devicePixelRatio || 1, 2)
                },
                uSizeBoost: {
                    value: sizeBoost
                },
                uAlphaScale: {
                    value: alphaScale
                },
                uHaloBoost: {
                    value: haloBoost
                },
                uTime: {
                    value: 0
                },
                uNoiseScale: {
                    value: 2.8
                }
            },
            vertexShader: `\n        attribute float aSize;\n        attribute float aAlpha;\n        varying vec3 vColor;\n        varying float vAlpha;\n        varying vec3 vPosition;\n        uniform float uPixelRatio;\n        uniform float uSizeBoost;\n        uniform float uAlphaScale;\n        uniform float uTime;\n\n        void main() {\n          vColor = color;\n          vAlpha = aAlpha * uAlphaScale;\n          vPosition = position;\n\n          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);\n          float depthScale = clamp(160.0 / max(-mvPosition.z, 35.0), 0.35, 2.2);\n          gl_PointSize = aSize * uSizeBoost * depthScale * uPixelRatio;\n          gl_Position = projectionMatrix * mvPosition;\n        }\n      `,
            fragmentShader: `\n        varying vec3 vColor;\n        varying float vAlpha;\n        varying vec3 vPosition;\n        uniform float uHaloBoost;\n        uniform float uTime;\n\n        float noise(vec3 p) {\n          vec3 i = floor(p);\n          vec3 f = fract(p);\n          f = f * f * (3.0 - 2.0 * f);\n          return mix(\n            mix(mix(sin(i.x * 12.9898 + i.y * 78.233 + i.z * 45.164) * 0.5 + 0.5,\n                    sin((i.x + 1.0) * 12.9898 + i.y * 78.233 + i.z * 45.164) * 0.5 + 0.5, f.x),\n                mix(sin(i.x * 12.9898 + (i.y + 1.0) * 78.233 + i.z * 45.164) * 0.5 + 0.5,\n                    sin((i.x + 1.0) * 12.9898 + (i.y + 1.0) * 78.233 + i.z * 45.164) * 0.5 + 0.5, f.x), f.y),\n            mix(mix(sin(i.x * 12.9898 + i.y * 78.233 + (i.z + 1.0) * 45.164) * 0.5 + 0.5,\n                    sin((i.x + 1.0) * 12.9898 + i.y * 78.233 + (i.z + 1.0) * 45.164) * 0.5 + 0.5, f.x),\n                mix(sin(i.x * 12.9898 + (i.y + 1.0) * 78.233 + (i.z + 1.0) * 45.164) * 0.5 + 0.5,\n                    sin((i.x + 1.0) * 12.9898 + (i.y + 1.0) * 78.233 + (i.z + 1.0) * 45.164) * 0.5 + 0.5, f.x), f.y), f.z);\n        }\n\n        void main() {\n          vec2 uv = gl_PointCoord - vec2(0.5);\n          float d = length(uv);\n\n          // Organic noise-driven edge behavior for plasma\n          float noiseInflu = noise(vPosition * 1.2 + uTime * 0.4) * 0.25;\n          \n          float core = smoothstep(0.38 + noiseInflu, -0.08, d);\n          \n          float glowFalloff = exp(-d * d * 4.8);\n          float halo = glowFalloff * (0.28 + uHaloBoost * 0.75);\n          \n          float alpha = clamp((core * 0.82 + halo * 0.58), 0.0, 1.0) * vAlpha;\n          \n          // if (alpha < 0.008) {\n          // }\n\n          vec3 colorCore = mix(vColor, vec3(1.0), core * 0.15);\n          \n          float finalAlpha = max(alpha, 0.1);  // Minimum 0.1 alpha to force visibility\n          gl_FragColor = vec4(colorCore, finalAlpha);\n        }\n      `
        });
        cmeCoreMat = createCmeMaterial(1.03, 1.12, 0, false);
        cmeHaloMat = createCmeMaterial(2.2, .48, .22, true);
        cmeCorePoints = new THREE.Points(cmeGeom, cmeCoreMat);
        cmeCorePoints.frustumCulled = false;
        cmeCorePoints.visible = false;
        scene.add(cmeCorePoints);
        cmeHaloPoints = new THREE.Points(cmeGeom, cmeHaloMat);
        cmeHaloPoints.frustumCulled = false;
        cmeHaloPoints.visible = false;
        scene.add(cmeHaloPoints);
        const resize = () => {
            const rect = sceneArea.getBoundingClientRect();
            const width = Math.max(rect.width, 1);
            const height = Math.max(rect.height, 1);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            renderer.setSize(width, height, false);
            if (composer) {
                composer.setSize(width, height);
            }
            const px = Math.min(window.devicePixelRatio || 1, 2);
            cmeCoreMat.uniforms.uPixelRatio.value = px;
            cmeHaloMat.uniforms.uPixelRatio.value = px;
        };
        window.addEventListener("resize", resize);
        resize();
        const initPostProcessing = async () => {
            await loadPostProcessing();
            if (!THREE.EffectComposer || !THREE.RenderPass || !THREE.UnrealBloomPass) {
                return;
            }
            composer = new THREE.EffectComposer(renderer);
            const renderPass = new THREE.RenderPass(scene, camera);
            composer.addPass(renderPass);
            const bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.2, .4, .85);
            composer.addPass(bloomPass);
        };
        initPostProcessing();
        const createFieldLines = () => {
            const fieldGroup = new THREE.Group;
            fieldGroup.position.copy(earthWorldPosition);
            const lineMaterial = new THREE.LineBasicMaterial({
                color: 7048655,
                transparent: true,
                opacity: .35,
                linewidth: 1.5,
                blending: THREE.AdditiveBlending,
                depthWrite: false
            });
            for (let arcIdx = 0; arcIdx < 3; arcIdx++) {
                const arcPoints = [];
                const arcSegments = 48;
                const baseRadius = 8.2 + arcIdx * 1.4;
                const tiltAngle = Math.PI / 6 + arcIdx * (Math.PI / 12);
                for (let i = 0; i < arcSegments; i++) {
                    const angle = i / (arcSegments - 1) * Math.PI;
                    const x = -Math.cos(angle) * baseRadius;
                    const y = Math.sin(angle) * baseRadius * Math.sin(tiltAngle);
                    const z = Math.sin(angle) * baseRadius * Math.cos(tiltAngle);
                    arcPoints.push(new THREE.Vector3(x, y, z));
                }
                const arcGeom = (new THREE.BufferGeometry).setFromPoints(arcPoints);
                const line = new THREE.Line(arcGeom, lineMaterial.clone());
                fieldGroup.add(line);
            }
            fieldGroup.visible = false;
            return fieldGroup;
        };
        const magnetosphereFieldLines = createFieldLines();
        magnetosphereGroup.add(magnetosphereFieldLines);
        resetCME = () => {
            console.log("[RESET] CME particles resetting, wind:", sim.wind || 500, "sceneReady:", sceneReady);
            for (let i = 0; i < cmeCount; i += 1) {
                resetCMEParticle(i, sim.wind || 500);
            }
            for (let i = 0; i < cmeCount; i++) {
                cmeAlpha[i] = .12;
            }
            const posAttr = cmeGeom.getAttribute("position");
            const colAttr = cmeGeom.getAttribute("color");
            const sizeAttr = cmeGeom.getAttribute("aSize");
            const alphaAttr = cmeGeom.getAttribute("aAlpha");
            posAttr.needsUpdate = true;
            colAttr.needsUpdate = true;
            sizeAttr.needsUpdate = true;
            alphaAttr.needsUpdate = true;
            console.log("[RESET] CME update complete. Particle alpha values:", {
                alpha0: cmeAlpha[0],
                alpha100: cmeAlpha[100],
                alpha3599: cmeAlpha[3599],
                totalCount: cmeCount
            });
        };
        let last = performance.now();
        const animate3D = now => {
            const delta = Math.min((now - last) / 1e3, .05);
            last = now;
            const t = now * .001;
            const stormRatio = sim.hasData ? sim.stormIntensity : 0;
            const kpRatio = sim.hasData ? clamp((sim.kp - 5) / 4, 0, 1) : 0;
            const isStormActive = sim.hasData && sim.kp >= 5;
            const stormVisual = isStormActive ? clamp(Math.max(stormRatio, .45 + kpRatio * .55), .45, 1) : 0;
            const speedRatio = clamp((sim.wind - 350) / 600, 0, 1);
            const speedScale = lerp(.45, 2.8, speedRatio);
            const baseEmissionRate = lerp(1, 2.4, speedRatio);
            if (cmeCorePoints && cmeHaloPoints && cmeCoreMat && cmeHaloMat) {
                const posAttr = cmeGeom.getAttribute("position");
                const colAttr = cmeGeom.getAttribute("color");
                const sizeAttr = cmeGeom.getAttribute("aSize");
                const alphaAttr = cmeGeom.getAttribute("aAlpha");
                cmeCorePoints.visible = isStormActive;
                cmeHaloPoints.visible = isStormActive;
                cmeCoreMat.uniforms.uTime.value = t;
                cmeHaloMat.uniforms.uTime.value = t;
                cmeCoreMat.uniforms.uAlphaScale.value = isStormActive ? lerp(1.25, 2.1, stormVisual) : 0;
                cmeHaloMat.uniforms.uAlphaScale.value = isStormActive ? lerp(.7, 1.45, stormVisual) : 0;
                if (isStormActive) {
                    for (let i = 0; i < cmeCount; i += 1) {
                        const i3 = i * 3;
                        cmeAge[i] += delta * baseEmissionRate * (1 + speedScale * .62);
                        const lifeProgress = cmeAge[i] / cmeLife[i];
                        if (lifeProgress >= 1) {
                            resetCMEParticle(i, sim.wind);
                            continue;
                        }
                        const laneSpeed = 1 + (1 - cmeLane[i]) * .28;
                        const driftAdvance = speedScale * laneSpeed * 60 * delta;
                        cmePos[i3] += cmeVel[i3] * driftAdvance;
                        cmePos[i3 + 1] += cmeVel[i3 + 1] * driftAdvance;
                        cmePos[i3 + 2] += cmeVel[i3 + 2] * driftAdvance;
                        const swirl = (.0015 + lifeProgress * .007) * (.7 + stormVisual * .35);
                        cmePos[i3 + 1] += Math.sin(t * 1.9 + cmeSeed[i]) * swirl;
                        cmePos[i3 + 2] += Math.cos(t * 1.65 + cmeSeed[i] * 1.2) * swirl;
                        const dx = cmePos[i3] - earthWorldPosition.x;
                        const dy = cmePos[i3 + 1] - earthWorldPosition.y;
                        const dz = cmePos[i3 + 2] - earthWorldPosition.z;
                        const distSq = dx * dx + dy * dy + dz * dz;
                        const dist = Math.sqrt(distSq);
                        if (dist < 9 && dist > 1e-4) {
                            const pushStrength = (9 - dist) * .055;
                            const invDist = 1 / dist;
                            cmePos[i3] += dx * invDist * pushStrength;
                            cmePos[i3 + 1] += dy * invDist * pushStrength;
                            cmePos[i3 + 2] += dz * invDist * pushStrength;
                        }
                        if (dist < 5.6) {
                            cmeAlpha[i] *= .22;
                            cmeSize[i] *= .9;
                            if (Math.random() < .06) {
                                resetCMEParticle(i, sim.wind);
                                continue;
                            }
                        }
                        if (cmePos[i3] < -160 || Math.abs(cmePos[i3 + 1]) > 120 || Math.abs(cmePos[i3 + 2]) > 120) {
                            resetCMEParticle(i, sim.wind);
                            continue;
                        }
                        const head = clamp(1 - lifeProgress * 1.2, 0, 1);
                        const envelope = Math.sin(lifeProgress * Math.PI);
                        cmeWorkColor.copy(cPlasmaCore).lerp(cPlasmaMid, .55).lerp(cAmbient, 1 - head).lerp(cCool, lifeProgress * .35).lerp(cPlasmaEdge, lifeProgress * .25);
                        cmeCol[i3] = cmeWorkColor.r;
                        cmeCol[i3 + 1] = cmeWorkColor.g;
                        cmeCol[i3 + 2] = cmeWorkColor.b;
                        cmeAlpha[i] = clamp((.085 + envelope * (.17 + (1 - cmeLane[i]) * .11)) * stormVisual, .01, .26);
                        cmeSize[i] = lerp(2.3, 1, cmeLane[i]) * (.92 + envelope * .28) * (1 + stormVisual * .24);
                    }
                    posAttr.needsUpdate = true;
                    colAttr.needsUpdate = true;
                    sizeAttr.needsUpdate = true;
                    alphaAttr.needsUpdate = true;
                }
            }
            earth.rotation.y += .0013;
            earthClouds.rotation.y += .00192;
            earthToSunDirection.subVectors(sun.position, earthWorldPosition).normalize();
            earth.material.uniforms.uLightDir.value.copy(earthToSunDirection);
            earth.material.uniforms.uTime.value = t;
            sun.rotation.y += 55e-5;
            if (sim.hasData) {
                const stormRatioMag = sim.stormIntensity;
                const shieldCompression = lerp(1.02, .82, stormRatioMag);
                magnetosphereGroup.scale.set(shieldCompression, lerp(1, 1.05, stormRatioMag), lerp(1, 1.08, stormRatioMag));
                magnetosphereGroup.visible = true;
                shieldMaterials.forEach(mat => {
                    mat.transparent = true;
                });
                const showBowShock = sim.wind >= 450 && sim.kp >= 5;
                bowShock.visible = showBowShock;
                magnetosphereFieldLines.visible = stormRatioMag > .35;
                const fieldLineOpacity = lerp(.18, .52, stormRatioMag);
                magnetosphereFieldLines.children.forEach(line => {
                    line.material.opacity = fieldLineOpacity;
                });
                bowShockMaterial.uniforms.uStormIntensity.value = stormRatioMag;
                bowShockMaterial.uniforms.uWindSpeed.value = sim.wind;
                bowShockMaterial.uniforms.uTime.value = t;
                const shieldPulse = .94 + Math.sin(t * 1.4) * .06;
                shieldMaterials.forEach((mat, idx) => {
                    const base = lerp(.03, .14, stormRatioMag);
                    mat.opacity = Math.max((base - idx * .016) * shieldPulse, .01);
                });
            } else {
                magnetosphereGroup.visible = false;
                bowShock.visible = false;
            }
            if (controls) {
                controls.update();
            }
            if (composer) {
                if (t < .2) {
                    console.log("[PRERENDER] Scene state:", {
                        cmeCoreVisible: cmeCorePoints.visible,
                        cmeHaloVisible: cmeHaloPoints.visible,
                        hasData: sim.hasData,
                        stormIntensity: sim.stormIntensity,
                        sceneDirty: scene.children.some(c => c.visible)
                    });
                }
                composer.render();
            } else {
                renderer.render(scene, camera);
            }
            requestAnimationFrame(animate3D);
        };
        requestAnimationFrame(animate3D);
        sceneReady = true;
        console.log("[3D] Scene initialized - particles ready to render");
    };
    let resetCME = null;
    let sceneReady = false;
    let cmeCorePoints = null;
    let cmeHaloPoints = null;
    let cmeCoreMat = null;
    let cmeHaloMat = null;
    window.addEventListener("keydown", event => {
        if (event.code === "Space") {
            event.preventDefault();
            sim.paused = !sim.paused;
            setPauseIndicator();
            revealHudLegend();
            return;
        }
        if (event.code === "KeyR") {
            sim.paused = false;
            sim.timelineProgress = 0;
            sim.arrivalRemainingSec = null;
            setPauseIndicator();
            clearTelemetryChart();
            if (typeof resetCME === "function") {
                resetCME();
            }
            writeAiLog("[SYS] Visual state reset. Live stream continues.");
            revealHudLegend();
            return;
        }
    });
    let lastUI = performance.now();
    const animateUI = now => {
        const delta = Math.min((now - lastUI) / 1e3, .1);
        lastUI = now;
        if (!sim.paused) {
            tickTimeline(delta);
            updateUI();
        }
        requestAnimationFrame(animateUI);
    };
    setWaitingState(true, "");
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            initTelemetryChart();
            updateUI();
        });
    });
    revealHudLegend(8e3);
    requestAnimationFrame(animateUI);
    init3D();
})();