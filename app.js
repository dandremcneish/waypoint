/*
 * Waypoint — client-side trip builder.
 *
 * Everything below runs live in the browser, no backend, no API keys:
 *   1. Geocode the typed city with Nominatim (OpenStreetMap).
 *   2. Pull named landmarks/museums/parks near that point from Overpass
 *      (OpenStreetMap's query API), filtered to avoid noise like zoo
 *      enclosures or unnamed nodes.
 *   3. Enrich the top landmarks with a description + photo from Wikipedia.
 *   4. Pull a 7-day forecast from Open-Meteo.
 *   5. Cluster the landmarks into walkable days with the same k-means +
 *      nearest-neighbor routing used by the offline ETL (etl/build_itinerary.py),
 *      ported to JS here so a brand-new city doesn't need a pipeline run first.
 *
 * A handful of cities ship pre-built in data/*.json (populated by the GitHub
 * Actions pipeline in etl/) so the demo loads instantly; anything else is
 * fetched live the moment you search for it.
 */

const QUICK_PICKS = [
  { key: "paris", label: "Paris, France", file: "data/paris.json" },
];

let tripState = null; // { destination, weather, itinerary: [{day, stops, walking_km}] }
let activeDay = 1;

const els = {
  destInput: document.getElementById("dest-input"),
  daysSelect: document.getElementById("days-select"),
  planBtn: document.getElementById("plan-btn"),
  quickPicks: document.getElementById("quick-picks"),
  statusLine: document.getElementById("status-line"),
  weatherStrip: document.getElementById("weather-strip"),
  dayTabs: document.getElementById("day-tabs"),
  dayPanels: document.getElementById("day-panels"),
};

function init() {
  els.quickPicks.innerHTML = QUICK_PICKS.map(
    (d) => `<button class="quick-pick" data-key="${d.key}" type="button">${d.label}</button>`
  ).join("");
  els.quickPicks.querySelectorAll(".quick-pick").forEach((btn) => {
    btn.addEventListener("click", () => {
      const d = QUICK_PICKS.find((q) => q.key === btn.dataset.key);
      els.destInput.value = d.label;
      loadPrebuilt(d.file, d.label);
    });
  });

  els.planBtn.addEventListener("click", handleSearch);
  els.destInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSearch();
  });

  // Load the seeded demo so the page isn't empty on first paint.
  els.destInput.value = "Paris, France";
  loadPrebuilt("data/paris.json", "Paris, France");
}

function setStatus(msg, isError) {
  els.statusLine.textContent = msg || "";
  els.statusLine.classList.toggle("error", !!isError);
}

let searchInFlight = false;

async function handleSearch() {
  if (searchInFlight) return; // ignore double-clicks / double-Enter while a search is running
  const query = els.destInput.value.trim();
  if (!query) return;
  const days = parseInt(els.daysSelect.value, 10) || 4;

  searchInFlight = true;
  els.planBtn.disabled = true;
  els.planBtn.textContent = "Planning…";
  try {
    // If it's one of the quick-pick cities, use the pre-built file — instant.
    const preset = QUICK_PICKS.find((d) => d.label.toLowerCase() === query.toLowerCase());
    if (preset) {
      await loadPrebuilt(preset.file, preset.label);
    } else {
      await planLiveTrip(query, days);
    }
  } finally {
    searchInFlight = false;
    els.planBtn.disabled = false;
    els.planBtn.textContent = "Plan trip";
  }
}

async function loadPrebuilt(file, label) {
  els.dayPanels.innerHTML = `<div class="empty-state">Loading ${label}…</div>`;
  setStatus("");
  try {
    const res = await fetch(file);
    if (!res.ok) throw new Error("not found");
    const data = await res.json();
    tripState = data;
    activeDay = 1;
    renderWeather(data.weather);
    renderDayTabs(data.itinerary);
    renderDayPanels(data.itinerary);
  } catch (err) {
    setStatus(`Couldn't load the pre-built demo for ${label} — searching live instead…`);
    await planLiveTrip(label, 4);
  }
}

/* ---------------- Live pipeline ---------------- */

async function planLiveTrip(query, days) {
  els.dayPanels.innerHTML = "";
  els.dayTabs.innerHTML = "";
  els.weatherStrip.innerHTML = "";

  try {
    setStatus(`Finding ${query}…`);
    const place = await geocodeCity(query);
    if (!place) {
      setStatus(`Couldn't find "${query}". Try a more specific name, like "Lisbon, Portugal".`, true);
      els.dayPanels.innerHTML = `<div class="empty-state">No results for "${query}".</div>`;
      return;
    }

    setStatus(`Pulling landmarks around ${place.label}…`);
    const rawPlaces = await fetchLandmarks(place.lat, place.lon);
    if (rawPlaces.length < 3) {
      setStatus(`Only found a handful of landmarks for ${place.label} — showing what's available.`);
    }

    setStatus(`Adding photos & descriptions (${rawPlaces.length} spots)…`);
    const enriched = await enrichWithWikipedia(rawPlaces);

    setStatus(`Checking the forecast…`);
    const weather = await fetchWeather(place.lat, place.lon);

    setStatus(`Building your ${days}-day route…`);
    const itinerary = buildItinerary(enriched, days);

    tripState = {
      destination: place.label,
      generated_at: new Date().toISOString().slice(0, 10),
      weather,
      days,
      itinerary,
    };
    activeDay = 1;
    renderWeather(weather);
    renderDayTabs(itinerary);
    renderDayPanels(itinerary);
    setStatus(`${enriched.length} spots around ${place.label}, grouped into ${itinerary.length} walkable days.`);
  } catch (err) {
    console.error(err);
    const busy = /overpass|remark|timeout/i.test(String(err && err.message));
    setStatus(
      busy
        ? "The map data service is busy right now — wait a few seconds and hit Plan trip again."
        : "Something went wrong pulling live data. Give it another try in a moment.",
      true
    );
    els.dayPanels.innerHTML = `<div class="empty-state">Couldn't build this trip right now. Try again in a moment.</div>`;
  }
}

async function geocodeCity(query) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q=" +
    encodeURIComponent(query);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const rows = await res.json();
  if (!rows.length) return null;
  const r = rows[0];
  return {
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    label: r.display_name.split(",").slice(0, 2).join(",").trim() || query,
    boundingbox: r.boundingbox ? r.boundingbox.map(Number) : null,
  };
}

// Tags we consider worth a stop, and tags we explicitly exclude (zoo/theme
// park interiors flood Overpass with hundreds of un-name-worthy sub-nodes —
// animal enclosures, individual rides — that swamp real landmarks).
const INCLUDE_QUERY_PARTS = [
  '["tourism"~"attraction|museum|viewpoint|gallery|artwork"]["name"]',
  '["historic"~"castle|monument|memorial|church|ruins|archaeological_site|fort|tower|palace|city_gate|manor"]["name"]',
  '["leisure"="park"]["name"]',
  '["amenity"="place_of_worship"]["name"]',
];
const EXCLUDE_TOURISM = new Set(["information", "hotel", "guest_house", "hostel", "motel", "apartment", "camp_site", "caravan_site"]);

// Overpass's shared public instance rate-limits anonymous IPs fairly
// aggressively. Spread requests across a few known-good mirrors and retry
// with backoff so one throttled/slow mirror doesn't sink the whole search.
const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

async function queryOverpass(query, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    const mirror = OVERPASS_MIRRORS[i % OVERPASS_MIRRORS.length];
    const controller = new AbortController();
    const killer = setTimeout(() => controller.abort(), 12000); // don't let one slow/queued mirror stall the whole search
    try {
      const res = await fetch(mirror, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        signal: controller.signal,
      });
      const text = await res.text();
      const data = JSON.parse(text); // mirrors return HTML/XML on rate-limit or error; this throws for those
      if (data.remark) throw new Error("overpass remark: " + data.remark);
      return data;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    } finally {
      clearTimeout(killer);
    }
  }
  throw lastErr || new Error("overpass failed");
}

async function fetchLandmarks(lat, lon) {
  const radius = 6000; // meters
  const filters = INCLUDE_QUERY_PARTS.map((f) => `nwr(around:${radius},${lat},${lon})${f};`).join("\n");
  const query = `[out:json][timeout:20];(\n${filters}\n);out center tags 80;`;
  const data = await queryOverpass(query);

  const seen = new Set();
  const places = [];
  for (const el of data.elements || []) {
    const tags = el.tags || {};
    const name = tags.name;
    if (!name) continue;
    if (tags.tourism && EXCLUDE_TOURISM.has(tags.tourism)) continue;

    const latVal = el.lat ?? (el.center && el.center.lat);
    const lonVal = el.lon ?? (el.center && el.center.lon);
    if (latVal == null || lonVal == null) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    places.push({
      name,
      lat: latVal,
      lon: lonVal,
      category: tags.tourism || tags.historic || tags.leisure || tags.amenity || "landmark",
      wikipedia: tags.wikipedia || null, // "en:Some Title" when present
      wikidata: tags.wikidata || null,
      prominent: !!(tags.wikipedia || tags.wikidata), // has an actual encyclopedia entry
    });
  }

  // Prominent (has a wikipedia/wikidata tag) places first, then cap the list
  // so we don't hammer Wikipedia with 100 lookups for a single search.
  places.sort((a, b) => Number(b.prominent) - Number(a.prominent));
  return places.slice(0, 18);
}

async function enrichWithWikipedia(places) {
  const results = [];
  for (const place of places) {
    let title = null;
    if (place.wikipedia && place.wikipedia.includes(":")) {
      title = place.wikipedia.split(":").slice(1).join(":");
    } else {
      title = place.name;
    }

    let description = null;
    let image = null;
    let wikiUrl = null;
    try {
      const res = await fetch(
        "https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title),
        { headers: { Accept: "application/json" } }
      );
      if (res.ok) {
        const summary = await res.json();
        if (summary.type !== "disambiguation") {
          description = summary.extract || null;
          image = (summary.thumbnail && summary.thumbnail.source) || null;
          wikiUrl = (summary.content_urls && summary.content_urls.desktop && summary.content_urls.desktop.page) || null;
        }
      }
    } catch (err) {
      // No Wikipedia match — the stop still shows with just its OSM name/category.
    }

    results.push({
      name: place.name,
      lat: place.lat,
      lon: place.lon,
      category: place.category,
      description,
      image,
      wiki_url: wikiUrl,
    });
  }
  return results;
}

async function fetchWeather(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=temperature_2m_max&forecast_days=7&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.daily) return null;
  return { dates: data.daily.time, high_c: data.daily.temperature_2m_max };
}

/* ---------------- Client-side day clustering (JS port of etl/build_itinerary.py) ---------------- */

function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function () {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function kmeansCluster(places, k, seed) {
  if (k >= places.length) return places.map((_, i) => i);
  const rand = seededRandom(seed + 1);

  for (let attempt = 0; attempt < 6; attempt++) {
    const idxPool = places.map((_, i) => i);
    for (let i = idxPool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [idxPool[i], idxPool[j]] = [idxPool[j], idxPool[i]];
    }
    let centroids = idxPool.slice(0, k).map((i) => ({ lat: places[i].lat, lon: places[i].lon }));
    let assignments = new Array(places.length).fill(0);
    let empty = false;

    for (let iter = 0; iter < 25; iter++) {
      for (let i = 0; i < places.length; i++) {
        let best = 0;
        let bestDist = Infinity;
        for (let c = 0; c < k; c++) {
          const d = haversineKm(places[i], centroids[c]);
          if (d < bestDist) {
            bestDist = d;
            best = c;
          }
        }
        assignments[i] = best;
      }
      const sums = Array.from({ length: k }, () => ({ lat: 0, lon: 0, n: 0 }));
      assignments.forEach((c, i) => {
        sums[c].lat += places[i].lat;
        sums[c].lon += places[i].lon;
        sums[c].n += 1;
      });
      empty = sums.some((s) => s.n === 0);
      if (empty) break;
      centroids = sums.map((s) => ({ lat: s.lat / s.n, lon: s.lon / s.n }));
    }
    if (!empty) return assignments;
  }
  return places.map((_, i) => i % k);
}

function orderByNearestNeighbor(places) {
  if (!places.length) return [];
  const avgLat = places.reduce((s, p) => s + p.lat, 0) / places.length;
  const avgLon = places.reduce((s, p) => s + p.lon, 0) / places.length;
  const centroid = { lat: avgLat, lon: avgLon };
  const remaining = places.slice();
  remaining.sort((a, b) => haversineKm(a, centroid) - haversineKm(b, centroid));
  const route = [remaining.shift()];
  while (remaining.length) {
    const last = route[route.length - 1];
    remaining.sort((a, b) => haversineKm(a, last) - haversineKm(b, last));
    route.push(remaining.shift());
  }
  return route;
}

function bestOfNClusters(places, k, tries) {
  let best = null;
  let bestScore = Infinity;
  for (let seed = 0; seed < tries; seed++) {
    const assignments = kmeansCluster(places, k, seed);
    const groups = {};
    places.forEach((p, i) => {
      const c = assignments[i];
      (groups[c] = groups[c] || []).push(p);
    });
    let score = 0;
    Object.values(groups).forEach((members) => {
      if (members.length < 2) return;
      const avgLat = members.reduce((s, p) => s + p.lat, 0) / members.length;
      const avgLon = members.reduce((s, p) => s + p.lon, 0) / members.length;
      const centroid = { lat: avgLat, lon: avgLon };
      score += members.reduce((s, p) => s + haversineKm(p, centroid), 0);
    });
    if (score < bestScore) {
      bestScore = score;
      best = assignments;
    }
  }
  return best;
}

function buildItinerary(places, days) {
  if (!places.length) return [];
  const k = Math.min(days, places.length);
  const assignments = bestOfNClusters(places, k, 40);

  const groups = {};
  places.forEach((p, i) => {
    const c = assignments[i];
    (groups[c] = groups[c] || []).push(p);
  });

  let itinerary = Object.values(groups).map((members) => {
    const ordered = orderByNearestNeighbor(members);
    let totalKm = 0;
    for (let i = 0; i < ordered.length - 1; i++) totalKm += haversineKm(ordered[i], ordered[i + 1]);
    return { stops: ordered, walking_km: Math.round(totalKm * 10) / 10 };
  });

  itinerary.sort((a, b) => b.stops.length - a.stops.length);
  itinerary = itinerary.map((d, i) => ({ day: i + 1, stops: d.stops, walking_km: d.walking_km }));
  return itinerary;
}

/* ---------------- Rendering (unchanged from the pre-built-only version) ---------------- */

function renderWeather(weather) {
  if (!weather) {
    els.weatherStrip.innerHTML = "";
    return;
  }
  els.weatherStrip.innerHTML = weather.dates
    .map((date, i) => {
      const d = new Date(date + "T00:00:00");
      const label = d.toLocaleDateString(undefined, { weekday: "short" });
      const temp = Math.round(weather.high_c[i]);
      return `<div class="weather-chip"><div class="d">${label}</div><div class="t">${temp}°C</div></div>`;
    })
    .join("");
}

function renderDayTabs(itinerary) {
  els.dayTabs.innerHTML = itinerary
    .map(
      (d) =>
        `<button class="day-tab ${d.day === activeDay ? "active" : ""}" data-day="${d.day}">
      Day ${d.day} <span class="km">${d.walking_km} km</span>
    </button>`
    )
    .join("");
  els.dayTabs.querySelectorAll(".day-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeDay = parseInt(btn.dataset.day, 10);
      els.dayTabs.querySelectorAll(".day-tab").forEach((b) => b.classList.toggle("active", parseInt(b.dataset.day, 10) === activeDay));
      els.dayPanels.querySelectorAll(".day-panel").forEach((p) => p.classList.toggle("active", parseInt(p.dataset.day, 10) === activeDay));
    });
  });
}

function stopCardHTML(stop, index) {
  const img = stop.image
    ? `<div class="stop-img" style="background-image:url('${stop.image}')"></div>`
    : `<div class="stop-img noimg">No photo yet</div>`;
  const desc = stop.description ? `<p>${stop.description}</p>` : "";
  const link = stop.wiki_url ? `<a class="stop-link" href="${stop.wiki_url}" target="_blank" rel="noopener">Learn more →</a>` : "";
  return `
    <div class="stop-card" draggable="true" data-index="${index}">
      <div class="stop-num"></div>
      ${img}
      <div class="stop-body">
        <h3>${stop.name}</h3>
        ${desc}
        <div class="stop-tags">
          ${stop.category ? `<span class="tag">${String(stop.category).replace("_", " ")}</span>` : ""}
          ${link}
        </div>
      </div>
      <div class="drag-handle">⋮⋮</div>
    </div>`;
}

function renderDayPanels(itinerary) {
  els.dayPanels.innerHTML = itinerary
    .map(
      (d) => `
    <div class="day-panel ${d.day === activeDay ? "active" : ""}" data-day="${d.day}">
      <div class="day-summary">${d.stops.length} stops &middot; about ${d.walking_km} km of walking &middot; drag cards to reorder</div>
      <div class="stop-list" data-day="${d.day}">
        ${d.stops.map((s, i) => stopCardHTML(s, i)).join("")}
      </div>
    </div>
  `
    )
    .join("");
  enableDragReorder();
}

function enableDragReorder() {
  document.querySelectorAll(".stop-list").forEach((list) => {
    let dragEl = null;

    list.addEventListener("dragstart", (e) => {
      dragEl = e.target.closest(".stop-card");
      if (!dragEl) return;
      dragEl.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });

    list.addEventListener("dragend", () => {
      if (dragEl) dragEl.classList.remove("dragging");
      list.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      dragEl = null;
      syncOrderToState(list);
    });

    list.addEventListener("dragover", (e) => {
      e.preventDefault();
      const target = e.target.closest(".stop-card");
      if (!target || target === dragEl) return;
      list.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      target.classList.add("drag-over");
      const rect = target.getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      list.insertBefore(dragEl, before ? target : target.nextSibling);
    });
  });
}

function syncOrderToState(list) {
  const day = parseInt(list.dataset.day, 10);
  const dayObj = tripState.itinerary.find((d) => d.day === day);
  const cards = [...list.querySelectorAll(".stop-card")];
  const newOrderIndices = cards.map((el) => parseInt(el.dataset.index, 10));
  dayObj.stops = newOrderIndices.map((i) => dayObj.stops[i]);
  cards.forEach((el, i) => {
    el.dataset.index = i;
  });
}

init();
