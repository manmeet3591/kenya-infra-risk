/* Kenya Critical Infrastructure Risk dashboard */
(() => {
  const HAZARDS = [
    { key: "wind", label: "Wind" },
    { key: "flood", label: "Extreme rain" },
    { key: "heat", label: "Heat" },
    { key: "drought", label: "Drought" },
  ];
  const CATS = {
    power_plant: { label: "Power plants", g: "P", w: 5, r: 6 },
    substation: { label: "Substations", g: "S", w: 3, r: 5 },
    fuel_depot: { label: "Fuel depots", g: "F", w: 4, r: 6 },
    port: { label: "Ports", g: "⚓", w: 4, r: 6 },
    airport: { label: "Airports", g: "A", w: 3, r: 5 },
    hospital: { label: "Hospitals", g: "H", w: 2, r: 4 },
    water: { label: "Water works / dams", g: "W", w: 2, r: 4 },
    telecom: { label: "Telecom masts", g: "T", w: 1, r: 3 },
  };
  const HV_KM_PER_UNIT = 50;
  const MODES = {
    risk: "√(hazard × exposure). High where severe hazards meet many critical assets.",
    hazard: "Weighted multi-hazard score from the sliders, independent of assets.",
    exposure: "Weighted count of critical assets and HV line length, ranked across counties.",
  };

  const state = {
    weights: Object.fromEntries(HAZARDS.map(h => [h.key, 1])),
    mode: "risk",
    cats: Object.fromEntries(Object.keys(CATS).map(k => [k, !["telecom", "hospital"].includes(k)])),
    selected: null,
  };

  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const ramp = () => ["--r0", "--r1", "--r2", "--r3", "--r4", "--r5"].map(css);
  const colorFor = v => {
    if (v == null || isNaN(v)) return css("--nodata");
    const r = ramp();
    return r[Math.min(r.length - 1, Math.floor(v * r.length))];
  };
  const pct = v => (v == null ? "–" : Math.round(v * 100));
  const fmt = (v, d = 0) => (v == null ? "–" : Number(v).toFixed(d));
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  let data, map, countyLayer, assetLayer, lineLayer, gridLayer;

  // ---------- scoring ----------
  function hazardScore(h) {
    let s = 0, w = 0;
    for (const { key } of HAZARDS) { s += state.weights[key] * (h[key] ?? 0); w += state.weights[key]; }
    return w ? s / w : 0;
  }
  function pctRank(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return values.map(v => {
      const lo = sorted.filter(x => x < v).length, eq = sorted.filter(x => x === v).length;
      return (lo + 0.5 * eq) / sorted.length;
    });
  }
  function score() {
    const fs = data.counties.features;
    const raw = fs.map(f => {
      const p = f.properties;
      let e = Object.entries(p.assets).reduce((s, [c, n]) => s + (CATS[c]?.w ?? 0) * n, 0);
      e += p.hv_line_km / HV_KM_PER_UNIT;
      return e;
    });
    const er = pctRank(raw);
    fs.forEach((f, i) => {
      const p = f.properties;
      p._exposureRaw = raw[i];
      p._exposure = er[i];
      p._hazard = hazardScore(p.h);
      p._risk = Math.sqrt(p._hazard * p._exposure);
    });
  }
  const valueOf = p => (state.mode === "risk" ? p._risk : state.mode === "hazard" ? p._hazard : p._exposure);

  // ---------- map ----------
  function initMap() {
    map = L.map("map", { preferCanvas: true, zoomSnap: 0.25, attributionControl: true }).setView([0.3, 37.9], 6.25);
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const esri = s => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${s}/MapServer/tile/{z}/{y}/{x}`;
    L.tileLayer(esri(dark ? "World_Dark_Gray_Base" : "World_Light_Gray_Base"), {
      attribution: "Basemap &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors", maxZoom: 16,
    }).addTo(map);
    map.createPane("labels").style.zIndex = 450;
    map.getPane("labels").style.pointerEvents = "none";
    L.tileLayer(esri(dark ? "World_Dark_Gray_Reference" : "World_Light_Gray_Reference"), {
      pane: "labels", maxZoom: 16,
    }).addTo(map);

    countyLayer = L.geoJSON(data.counties, {
      style: styleCounty,
      onEachFeature: (f, l) => {
        l.on({
          mouseover: () => { l.setStyle({ weight: 2.5, color: css("--ink") }); l.bringToFront(); lineLayer?.bringToFront(); },
          mouseout: () => countyLayer.resetStyle(l),
          click: () => selectCounty(f.properties.name),
        });
        l.bindTooltip(() => countyTip(f.properties), { className: "tt", sticky: true, direction: "top", offset: [0, -8] });
      },
    }).addTo(map);
    map.fitBounds(countyLayer.getBounds(), { padding: [10, 10] });

    lineLayer = L.geoJSON(data.lines, {
      style: f => ({ color: css("--line"), weight: f.properties.kv >= 220 ? 2 : f.properties.kv >= 132 ? 1.4 : 0.7, opacity: 0.8 }),
      interactive: false,
    }).addTo(map);

    assetLayer = L.layerGroup().addTo(map);
    map.createPane("grid").style.zIndex = 350;  // below county outlines, lines and assets
    gridLayer = L.layerGroup();
  }

  function styleCounty(f) {
    const p = f.properties;
    const sel = state.selected === p.name;
    return { fillColor: colorFor(valueOf(p)), fillOpacity: 0.78, color: sel ? css("--ink") : css("--surface"), weight: sel ? 3 : 1 };
  }

  function countyTip(p) {
    return `<b>${esc(p.name)}</b><span class="m">Risk ${pct(p._risk)} · Hazard ${pct(p._hazard)} · Exposure ${pct(p._exposure)}</span>`;
  }

  function drawAssets() {
    assetLayer.clearLayers();
    for (const f of data.assets.features) {
      const p = f.properties, c = CATS[p.cat];
      if (!c || !state.cats[p.cat]) continue;
      const [lon, lat] = f.geometry.coordinates;
      const hz = hazardScore(p.h);
      L.circleMarker([lat, lon], {
        radius: c.r, fillColor: colorFor(hz), fillOpacity: 1, color: css("--ink"), weight: 1,
      }).bindTooltip(
        `<b>${esc(p.name || c.label.replace(/s$/, ""))}</b><span class="m">${esc(c.label.replace(/s$/, ""))} · ${esc(p.county)}</span><br>` +
        `Hazard at site ${pct(hz)}` + HAZARDS.map(h => ` · ${h.label} ${pct(p.h[h.key])}`).join("") +
        (p.operator ? `<br><span class="m">Operator: ${esc(p.operator)}</span>` : "") +
        (p["plant:source"] ? `<br><span class="m">Source: ${esc(p["plant:source"])}</span>` : "") +
        (p.voltage ? `<br><span class="m">Voltage: ${esc(p.voltage)} V</span>` : ""),
        { className: "tt", direction: "top", offset: [0, -6] }
      ).addTo(assetLayer);
    }
  }

  let gridRenderer;
  function drawGrid() {
    gridRenderer = gridRenderer || L.canvas({ pane: "grid" });
    gridLayer.clearLayers();
    const [dx, dy] = data.meta.grid_deg;
    for (const c of data.grid) {
      const hz = hazardScore(c.h);
      L.rectangle([[c.lat - dy / 2, c.lon - dx / 2], [c.lat + dy / 2, c.lon + dx / 2]], {
        fillColor: colorFor(hz), fillOpacity: 0.85, stroke: false, interactive: true,
        pane: "grid", renderer: gridRenderer,
      }).bindTooltip(
        `<b>Cell ${c.lat.toFixed(2)}, ${c.lon.toFixed(2)}</b><span class="m">${esc(c.county)}</span>` +
        `Hazard ${pct(hz)}<br>Annual max wind ${fmt(c.m.wind_annmax, 1)} m/s · Max 1-day rain ${fmt(c.m.rain_annmax)} mm<br>` +
        `Heat days ${fmt(c.m.heat_days)}/yr · Tmax trend ${fmt(c.m.tmax_trend, 2)} °C/dec · Failed seasons ${pct(c.m.season_fail)}%`,
        { className: "tt", sticky: true }
      ).addTo(gridLayer);
    }
  }

  function drawLegend() {
    const label = { risk: "Risk score", hazard: "Hazard score", exposure: "Exposure rank" }[state.mode];
    document.getElementById("legend").innerHTML =
      `<div>${label} (counties) · hazard at site (assets)</div><div class="bar">${ramp().map(c => `<i style="background:${c}"></i>`).join("")}</div>` +
      `<div class="ends"><span>Low 0</span><span>100 High</span></div>`;
  }

  // ---------- side panels ----------
  function sparkline(series, label, unit, digits = 0) {
    const vals = series.filter(v => v != null);
    if (!vals.length) return "";
    const [y0, y1] = data.meta.years;
    const W = 280, H = 40, min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
    const pts = series.map((v, i) => [(i / (series.length - 1)) * W, H - ((v - min) / span) * (H - 4) - 2]);
    const last = pts[pts.length - 1];
    const id = "sp" + Math.random().toString(36).slice(2, 7);
    return `<div class="spark"><div class="t"><span>${label}</span><span id="${id}">${fmt(series[series.length - 1], digits)} ${unit} in ${y1}</span></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" data-series='${JSON.stringify(series)}' data-y0="${y0}" data-out="${id}" data-unit="${unit}" data-d="${digits}">
        <line class="bl" x1="0" x2="${W}" y1="${H}" y2="${H}"/>
        <polyline class="ln" points="${pts.map(p => p.join(",")).join(" ")}"/>
        <circle class="dot" r="4" cx="${last[0]}" cy="${last[1]}"/>
      </svg></div>`;
  }
  function wireSparks(root) {
    root.querySelectorAll(".spark svg").forEach(svg => {
      const s = JSON.parse(svg.dataset.series), y0 = +svg.dataset.y0, out = document.getElementById(svg.dataset.out);
      const dot = svg.querySelector(".dot"), poly = svg.querySelector(".ln").getAttribute("points").split(" ").map(p => p.split(",").map(Number));
      const reset = out.textContent;
      svg.addEventListener("mousemove", e => {
        const r = svg.getBoundingClientRect(), i = Math.round(((e.clientX - r.left) / r.width) * (s.length - 1));
        const j = Math.max(0, Math.min(s.length - 1, i));
        dot.setAttribute("cx", poly[j][0]); dot.setAttribute("cy", poly[j][1]);
        out.textContent = `${fmt(s[j], +svg.dataset.d)} ${svg.dataset.unit} in ${y0 + j}`;
      });
      svg.addEventListener("mouseleave", () => {
        const l = poly[poly.length - 1]; dot.setAttribute("cx", l[0]); dot.setAttribute("cy", l[1]); out.textContent = reset;
      });
    });
  }

  function renderCounty() {
    const el = document.getElementById("county");
    const f = data.counties.features.find(f => f.properties.name === state.selected);
    if (!f) { el.innerHTML = `<p class="empty">Click a county to see its hazard profile, assets and climate record.</p>`; return; }
    const p = f.properties, m = p.metrics;
    const rank = [...data.counties.features].sort((a, b) => b.properties._risk - a.properties._risk).findIndex(x => x === f) + 1;
    const assets = data.assets.features.filter(a => a.properties.county === p.name && ["power_plant", "substation", "fuel_depot", "port", "airport"].includes(a.properties.cat))
      .map(a => ({ ...a.properties, hz: hazardScore(a.properties.h) }))
      .sort((a, b) => (CATS[b.cat].w * b.hz) - (CATS[a.cat].w * a.hz)).slice(0, 5);
    el.innerHTML = `<div class="cty">
      <h3>${esc(p.name)}</h3>
      <div class="score">Risk <b>${pct(p._risk)}</b> · rank ${rank} of ${data.counties.features.length} · Hazard ${pct(p._hazard)} · Exposure ${pct(p._exposure)}</div>
      ${HAZARDS.map(h => `<div class="hbar"><span>${h.label}</span><div class="track"><div class="fill" style="width:${pct(p.h[h.key])}%"></div></div><span class="v">${pct(p.h[h.key])}</span></div>`).join("")}
      <div class="facts">
        <div><span>Annual max wind (median)</span><b>${fmt(m.wind_annmax, 1)} m/s</b></div>
        <div><span>Max 1-day rain (median annual)</span><b>${fmt(m.rain_annmax)} mm</b></div>
        <div><span>Days ≥ ${data.meta.thresholds.heat_c} °C</span><b>${fmt(m.heat_days)} /yr</b></div>
        <div><span>Tmax trend</span><b>${m.tmax_trend >= 0 ? "+" : ""}${fmt(m.tmax_trend, 2)} °C/decade</b></div>
        <div><span>Failed rainy seasons</span><b>${pct(m.season_fail)}%</b></div>
        <div><span>Assets mapped</span><b>${Object.values(p.assets).reduce((a, b) => a + b, 0)}</b></div>
        <div><span>HV lines (≥132 kV)</span><b>${fmt(p.hv_line_km)} km</b></div>
      </div>
      ${sparkline(p.series.heat_days, `Days ≥ ${data.meta.thresholds.heat_c} °C per year`, "days")}
      ${sparkline(p.series.rain_total, "Annual rainfall", "mm")}
      ${sparkline(p.series.wind_annmax, "Annual max wind", "m/s", 1)}
      <h2 class="mt">Most exposed key assets</h2>
      ${assets.length ? `<ol class="top-assets">${assets.map(a => `<li>${esc(a.name || CATS[a.cat].label)} <span class="m" style="color:var(--muted)">· ${esc(CATS[a.cat].label.replace(/s$/, ""))} · hazard ${pct(a.hz)}</span></li>`).join("")}</ol>` : `<p class="empty">No plants, substations, fuel depots, ports or airports mapped in OSM.</p>`}
    </div>`;
    wireSparks(el);
  }

  function renderRank() {
    const fs = [...data.counties.features].sort((a, b) => valueOf(b.properties) - valueOf(a.properties)).slice(0, 10);
    const ol = document.getElementById("rank");
    ol.innerHTML = fs.map(f => `<li data-n="${esc(f.properties.name)}">${esc(f.properties.name)}<span class="s">${pct(valueOf(f.properties))}</span></li>`).join("");
    ol.querySelectorAll("li").forEach(li => li.addEventListener("click", () => selectCounty(li.dataset.n, true)));
    document.querySelector(".mt + .rank")?.previousElementSibling &&
      (document.querySelector("#rank").previousElementSibling.textContent = `Highest ${state.mode} counties`);
  }

  function renderKpis() {
    const fs = data.counties.features;
    const nAssets = data.assets.features.length;
    const keyCats = ["power_plant", "substation", "fuel_depot"];
    const cellScores = data.grid.map(c => hazardScore(c.h)).sort((a, b) => a - b);
    const q75 = cellScores[Math.floor(cellScores.length * 0.75)];
    const keyHigh = data.assets.features.filter(a => keyCats.includes(a.properties.cat) && hazardScore(a.properties.h) >= q75).length;
    const keyAll = data.assets.features.filter(a => keyCats.includes(a.properties.cat)).length;
    const hvKm = fs.reduce((s, f) => s + f.properties.hv_line_km, 0);
    document.getElementById("kpis").innerHTML = `
      <div class="kpi"><b>${nAssets.toLocaleString()}</b><span>critical assets mapped</span></div>
      <div class="kpi"><b>${Math.round(hvKm).toLocaleString()} km</b><span>HV lines ≥132 kV</span></div>
      <div class="kpi"><b>${keyHigh}</b><span>of ${keyAll} plants, substations, depots in the top-quartile hazard cells</span></div>
      <div class="kpi"><b>${fs.filter(f => f.properties._risk >= 0.67).length}</b><span>counties with risk ≥ 67</span></div>`;
  }

  const SORTS = { key: "_risk", dir: -1 };
  function renderTable() {
    const cols = [
      ["name", "County", v => esc(v)], ["_risk", "Risk", pct], ["_hazard", "Hazard", pct], ["_exposure", "Exposure", pct],
      ...HAZARDS.map(h => [`h.${h.key}`, h.label, pct]),
      ["m.heat_days", "Heat days/yr", v => fmt(v)], ["m.tmax_trend", "Tmax °C/dec", v => fmt(v, 2)],
      ["m.rain_annmax", "Max 1-day mm", v => fmt(v)], ["m.wind_annmax", "Max wind m/s", v => fmt(v, 1)],
      ["m.season_fail", "Failed seasons %", pct],
      ...Object.keys(CATS).map(c => [`a.${c}`, CATS[c].label, v => fmt(v)]), ["hv_line_km", "HV km", v => fmt(v)],
    ];
    const get = (p, k) => k.startsWith("h.") ? p.h[k.slice(2)] : k.startsWith("m.") ? p.metrics[k.slice(2)] : k.startsWith("a.") ? p.assets[k.slice(2)] ?? 0 : p[k];
    const rows = [...data.counties.features].map(f => f.properties).sort((a, b) => {
      const x = get(a, SORTS.key), y = get(b, SORTS.key);
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * SORTS.dir;
    });
    const t = document.getElementById("tbl");
    t.innerHTML = `<thead><tr>${cols.map(([k, l]) => `<th data-k="${k}">${l}${SORTS.key === k ? (SORTS.dir < 0 ? " ↓" : " ↑") : ""}</th>`).join("")}</tr></thead>` +
      `<tbody>${rows.map(p => `<tr>${cols.map(([k, , f]) => `<td>${f(get(p, k))}</td>`).join("")}</tr>`).join("")}</tbody>`;
    t.querySelectorAll("th").forEach(th => th.addEventListener("click", () => {
      SORTS.dir = SORTS.key === th.dataset.k ? -SORTS.dir : -1; SORTS.key = th.dataset.k; renderTable();
    }));
  }

  // ---------- controls ----------
  function initControls() {
    const wEl = document.getElementById("weights");
    wEl.innerHTML = HAZARDS.map(h => `<div class="w"><label for="w-${h.key}">${h.label}<output id="o-${h.key}">1.0</output></label>
      <input type="range" id="w-${h.key}" min="0" max="3" step="0.25" value="1"></div>`).join("");
    HAZARDS.forEach(h => document.getElementById(`w-${h.key}`).addEventListener("input", e => {
      state.weights[h.key] = +e.target.value; document.getElementById(`o-${h.key}`).textContent = (+e.target.value).toFixed(1); refresh();
    }));
    document.getElementById("resetW").addEventListener("click", () => {
      HAZARDS.forEach(h => { state.weights[h.key] = 1; document.getElementById(`w-${h.key}`).value = 1; document.getElementById(`o-${h.key}`).textContent = "1.0"; });
      refresh();
    });

    const counts = {};
    data.assets.features.forEach(a => counts[a.properties.cat] = (counts[a.properties.cat] || 0) + 1);
    document.getElementById("cats").innerHTML = Object.entries(CATS).map(([k, c]) =>
      `<label class="chk"><input type="checkbox" data-cat="${k}" ${state.cats[k] ? "checked" : ""}><span class="glyph" aria-hidden="true">${c.g}</span>${c.label}<span class="n">${(counts[k] || 0).toLocaleString()}</span></label>`).join("");
    document.querySelectorAll("[data-cat]").forEach(cb => cb.addEventListener("change", e => { state.cats[e.target.dataset.cat] = e.target.checked; drawAssets(); }));

    document.getElementById("showLines").addEventListener("change", e => e.target.checked ? lineLayer.addTo(map) : map.removeLayer(lineLayer));
    document.getElementById("showGrid").addEventListener("change", e => {
      if (e.target.checked) { drawGrid(); gridLayer.addTo(map); countyLayer.setStyle(f => ({ ...styleCounty(f), fillOpacity: 0 })); }
      else { map.removeLayer(gridLayer); countyLayer.setStyle(styleCounty); }
    });

    document.querySelectorAll("#mode button").forEach(b => b.addEventListener("click", () => {
      document.querySelectorAll("#mode button").forEach(x => x.classList.toggle("on", x === b));
      state.mode = b.dataset.mode; refresh();
    }));

    document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach(x => x.setAttribute("aria-selected", x === b));
      const v = b.dataset.view;
      document.getElementById("view-map").classList.toggle("hidden", v !== "map");
      document.querySelector(".detail").classList.toggle("hidden", v !== "map");
      document.getElementById("view-table").classList.toggle("hidden", v !== "table");
      document.getElementById("view-method").classList.toggle("hidden", v !== "method");
      if (v === "map") map.invalidateSize();
      if (v === "table") renderTable();
    }));
  }

  function selectCounty(name, zoom) {
    state.selected = name;
    countyLayer.setStyle(document.getElementById("showGrid").checked ? f => ({ ...styleCounty(f), fillOpacity: 0 }) : styleCounty);
    if (zoom) countyLayer.eachLayer(l => l.feature.properties.name === name && map.fitBounds(l.getBounds(), { maxZoom: 8, padding: [30, 30] }));
    renderCounty();
  }

  function refresh() {
    score();
    document.getElementById("modeHint").textContent = MODES[state.mode];
    countyLayer.setStyle(document.getElementById("showGrid").checked ? f => ({ ...styleCounty(f), fillOpacity: 0 }) : styleCounty);
    drawAssets();
    if (map.hasLayer(gridLayer)) drawGrid();
    drawLegend(); renderRank(); renderKpis(); renderCounty();
    if (!document.getElementById("view-table").classList.contains("hidden")) renderTable();
  }

  async function load() {
    const get = n => fetch(`data/${n}`).then(r => r.json());
    const [counties, assets, lines, grid, meta] = await Promise.all(
      ["counties.geojson", "assets.geojson", "lines.geojson", "grid.json", "meta.json"].map(get));
    data = { counties, assets, lines, grid, meta };
    document.getElementById("yrs").textContent = `${meta.years[0]}–${meta.years[1]}`;
    document.getElementById("built").textContent = meta.built;
    document.querySelector(".t-wind").textContent = meta.thresholds.wind_ms;
    document.querySelector(".t-rain").textContent = meta.thresholds.rain_mm;
    document.querySelector(".t-heat").textContent = meta.thresholds.heat_c;
    document.querySelector(".t-dro").textContent = Math.round(meta.thresholds.drought_frac * 100);
    document.getElementById("sources").innerHTML = Object.entries(meta.sources).map(([k, v]) => `<li><b>${k}</b>: ${esc(v)}</li>`).join("");
    score();
    initMap();
    initControls();
    refresh();
  }
  load();
})();
