/*
 * Waypoint: client-side trip builder.
 *
 * Everything below runs live in the browser, no backend, no login:
 *   1. Geocode the typed city with Nominatim (OpenStreetMap), scoped to a
 *      country if the person picked one from the dropdown.
 *   2. Pull named landmarks/museums/parks near that point from Overpass
 *      (OpenStreetMap's query API), filtered to avoid noise like zoo
 *      enclosures or unnamed nodes. Fired at three public mirrors at once
 *      and the first one back wins, so one slow mirror can't stall a search.
 *   3. Enrich the top landmarks with a description and photo from Wikipedia,
 *      fetched in parallel.
 *   4. Pull a 7-day forecast from Open-Meteo.
 *   5. Cluster the landmarks into walkable days with the same k-means and
 *      nearest-neighbor routing used by the offline ETL (etl/build_itinerary.py),
 *      ported to JS here so a brand-new city doesn't need a pipeline run first.
 *   6. Build real, no-signup deep links to Google Flights, Google Hotels,
 *      Booking.com, and Airbnb for the chosen dates, so booking anything is
 *      one click to the real site, never inside this app.
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
let selectedPlace = null; // { lat, lon, label } once chosen from suggestions or geocoded

const els = {
  countrySelect: document.getElementById("country-select"),
  destInput: document.getElementById("dest-input"),
  suggestBox: document.getElementById("suggest-box"),
  checkinInput: document.getElementById("checkin-input"),
  checkoutInput: document.getElementById("checkout-input"),
  planBtn: document.getElementById("plan-btn"),
  quickPicks: document.getElementById("quick-picks"),
  statusLine: document.getElementById("status-line"),
  weatherStrip: document.getElementById("weather-strip"),
  bookStrip: document.getElementById("book-strip"),
  dayTabs: document.getElementById("day-tabs"),
  dayPanels: document.getElementById("day-panels"),
};

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function defaultDates() {
  const start = new Date();
  start.setDate(start.getDate() + 21); // three weeks out by default
  const end = new Date(start);
  end.setDate(end.getDate() + 4);
  return { start: fmtDate(start), end: fmtDate(end) };
}

function init() {
  // Country dropdown
  els.countrySelect.innerHTML = COUNTRY_LIST.map(
    ([name, code]) => `<option value="${code}">${name}</option>`
  ).join("");

  // Date defaults
  const { start, end } = defaultDates();
  els.checkinInput.value = start;
  els.checkoutInput.value = end;
  els.checkinInput.min = fmtDate(new Date());
  els.checkoutInput.min = start;
  els.checkinInput.addEventListener("change", () => {
    if (els.checkinInput.value) els.checkoutInput.min = els.checkinInput.value;
    if (els.checkoutInput.value && els.checkoutInput.value <= els.checkinInput.value) {
      const d = new Date(els.checkinInput.value + "T00:00:00");
      d.setDate(d.getDate() + 1);
      els.checkoutInput.value = fmtDate(d);
    }
  });

  els.quickPicks.innerHTML = QUICK_PICKS.map(
    (d) => `<button class="quick-pick" data-key="${d.key}" type="button">${d.label}</button>`
  ).join("");
  els.quickPicks.querySelectorAll(".quick-pick").forEach((btn) => {
    btn.addEventListener("click", () => {
      const d = QUICK_PICKS.find((q) => q.key === btn.dataset.key);
      els.destInput.value = d.label;
      selectedPlace = null;
      hideSuggestions();
      loadPrebuilt(d.file, d.label);
    });
  });

  els.planBtn.addEventListener("click", handleSearch);
  els.destInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      hideSuggestions();
      handleSearch();
    }
    if (e.key === "Escape") hideSuggestions();
  });
  els.destInput.addEventListener("input", onDestInput);
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-bar")) hideSuggestions();
  });

  // Load the seeded demo so the page isn't empty on first paint.
  els.destInput.value = "Paris, France";
  loadPrebuilt("data/paris.json", "Paris, France");
}

function setStatus(msg, isError) {
  els.statusLine.textContent = msg || "";
  els.statusLine.classList.toggle("error", !!isError);
}

/* ---------------- City suggestions (autocomplete dropdown) ---------------- */

let suggestTimer = null;
let suggestAbort = null;

function hideSuggestions() {
  els.suggestBox.classList.remove("open");
  els.suggestBox.innerHTML = "";
}

function onDestInput() {
  selectedPlace = null;
  const q = els.destInput.value.trim();
  clearTimeout(suggestTimer);
  if (q.length < 3) {
    hideSuggestions();
    return;
  }
  suggestTimer = setTimeout(() => fetchSuggestions(q), 300); // debounce
}

async function fetchSuggestions(q) {
  if (suggestAbort) suggestAbort.abort();
  suggestAbort = new AbortController();
  const cc = els.countrySelect.value;
  let url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&q=" +
    encodeURIComponent(q);
  if (cc) url += "&countrycodes=" + cc;

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: suggestAbort.signal });
    if (!res.ok) return;
    const rows = await res.json();
    if (els.destInput.value.trim() !== q) return; // stale response, input changed since
    if (!rows.length) {
      hideSuggestions();
      return;
    }
    els.suggestBox.innerHTML = rows
      .map((r, i) => {
        const label = r.display_name.split(",").slice(0, 3).join(",").trim();
        return `<div class="suggest-item" data-i="${i}">${label}</div>`;
      })
      .join("");
    els.suggestBox.classList.add("open");
    els.suggestBox.querySelectorAll(".suggest-item").forEach((item, i) => {
      item.addEventListener("click", () => {
        const r = rows[i];
        const label = r.display_name.split(",").slice(0, 2).join(",").trim();
        els.destInput.value = label;
        selectedPlace = { lat: parseFloat(r.lat), lon: parseFloat(r.lon), label };
        hideSuggestions();
      });
    });
  } catch (err) {
    // aborted or offline — no suggestions this keystroke, not fatal
  }
}

/* ---------------- Search orchestration ---------------- */

let searchInFlight = false;

async function handleSearch() {
  if (searchInFlight) return; // ignore double-clicks / double-Enter while a search is running
  const query = els.destInput.value.trim();
  if (!query) return;

  searchInFlight = true;
  els.planBtn.disabled = true;
  els.planBtn.textContent = "Planning…";
  try {
    const preset = QUICK_PICKS.find((d) => d.label.toLowerCase() === query.toLowerCase());
    if (preset && !selectedPlace) {
      await loadPrebuilt(preset.file, preset.label);
    } else {
      await planLiveTrip(query, selectedPlace);
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
    renderBookingLinks(label);
    setStatus(`${label}, ready to explore.`);
  } catch (err) {
    setStatus(`Couldn't load the pre-built demo for ${label}, searching live instead…`);
    await planLiveTrip(label, null);
  }
}

/* ---------------- Live pipeline ---------------- */

function tripDays() {
  const start = new Date(els.checkinInput.value + "T00:00:00");
  const end = new Date(els.checkoutInput.value + "T00:00:00");
  const diff = Math.round((end - start) / 86400000);
  return Math.min(Math.max(diff, 1), 10);
}

async function planLiveTrip(query, knownPlace) {
  els.dayPanels.innerHTML = "";
  els.dayTabs.innerHTML = "";
  els.weatherStrip.innerHTML = "";
  els.bookStrip.innerHTML = "";
  const days = tripDays();

  try {
    let place = knownPlace;
    if (!place) {
      setStatus(`Finding ${query}…`);
      place = await geocodeCity(query);
    }
    if (!place) {
      setStatus(`Couldn't find "${query}". Try a more specific name, like "Lisbon, Portugal".`, true);
      els.dayPanels.innerHTML = `<div class="empty-state">No results for "${query}".</div>`;
      return;
    }

    setStatus(`Pulling landmarks around ${place.label}…`);
    const rawPlaces = await fetchLandmarks(place.lat, place.lon);
    if (rawPlaces.length < 3) {
      setStatus(`Only found a handful of landmarks for ${place.label}, showing what's available.`);
    }

    setStatus(`Adding photos and descriptions (${rawPlaces.length} spots)…`);
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
    renderBookingLinks(place.label);
    setStatus(`${enriched.length} spots around ${place.label}, grouped into ${itinerary.length} walkable days.`);
  } catch (err) {
    console.error(err);
    const busy = /overpass|remark|timeout|abort/i.test(String(err && err.message));
    setStatus(
      busy
        ? "The map data service is busy right now, wait a few seconds and hit Plan trip again."
        : "Something went wrong pulling live data. Give it another try in a moment.",
      true
    );
    els.dayPanels.innerHTML = `<div class="empty-state">Couldn't build this trip right now. Try again in a moment.</div>`;
  }
}

async function geocodeCity(query) {
  const cc = els.countrySelect.value;
  let url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q=" +
    encodeURIComponent(query);
  if (cc) url += "&countrycodes=" + cc;
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
// park interiors flood Overpass with hundreds of un-name-worthy sub-nodes,
// animal enclosures, individual rides, that swamp real landmarks).
const INCLUDE_QUERY_PARTS = [
  '["tourism"~"attraction|museum|viewpoint|gallery|artwork"]["name"]',
  '["historic"~"castle|monument|memorial|church|ruins|archaeological_site|fort|tower|palace|city_gate|manor"]["name"]',
  '["leisure"="park"]["name"]',
  '["amenity"="place_of_worship"]["name"]',
];
const EXCLUDE_TOURISM = new Set(["information", "hotel", "guest_house", "hostel", "motel", "apartment", "camp_site", "caravan_site"]);

// Overpass's shared public instances rate-limit anonymous IPs fairly
// aggressively. Fire the same query at three known-good mirrors at once and
// take whichever answers first, instead of waiting on one at a time, so a
// single slow or queued mirror can't stall the whole search.
const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

async function queryOverpass(query) {
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), 15000);
  const attempt = (mirror) =>
    fetch(mirror, {
      method: "POST",
      body: "data=" + encodeURIComponent(query),
      signal: controller.signal,
    })
      .then((res) => res.text())
      .then((text) => {
        const data = JSON.parse(text); // mirrors return HTML/XML on rate-limit or error; this throws for those
        if (data.remark) throw new Error("overpass remark: " + data.remark);
        return data;
      });

  try {
    if (typeof Promise.any === "function") {
      return await Promise.any(OVERPASS_MIRRORS.map(attempt));
    }
    // Fallback for older browsers without Promise.any: race, but only
    // resolve on success, reject only once every mirror has failed.
    return await new Promise((resolve, reject) => {
      let failures = 0;
      OVERPASS_MIRRORS.forEach((mirror) =>
        attempt(mirror).then(resolve, () => {
          failures += 1;
          if (failures === OVERPASS_MIRRORS.length) reject(new Error("overpass failed: all mirrors busy"));
        })
      );
    });
  } catch (err) {
    if (typeof AggregateError !== "undefined" && err instanceof AggregateError) {
      throw new Error("overpass failed: all mirrors busy");
    }
    throw err;
  } finally {
    clearTimeout(killer);
  }
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
  // Fetched in parallel, not one at a time, so this stage takes roughly one
  // round trip instead of N.
  const results = await Promise.all(
    places.map(async (place) => {
      let title = place.wikipedia && place.wikipedia.includes(":") ? place.wikipedia.split(":").slice(1).join(":") : place.name;

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

      return {
        name: place.name,
        lat: place.lat,
        lon: place.lon,
        category: place.category,
        description,
        image,
        wiki_url: wikiUrl,
      };
    })
  );
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

/* ---------------- Real booking deep links (no API keys, no sign-in) ---------------- */
// These are the same public search URLs each site's own "share this search"
// link produces — they just take you straight to real results on the real
// site so booking always happens there, never inside this app.

function renderBookingLinks(cityLabel) {
  const city = cityLabel.split(",")[0].trim();
  const checkin = els.checkinInput.value;
  const checkout = els.checkoutInput.value;

  const links = [
    {
      ic: "✈️",
      name: "Google Flights",
      sub: `Flights to ${city}`,
      url: `https://www.google.com/travel/flights?q=${encodeURIComponent("Flights to " + city + " on " + checkin)}`,
    },
    {
      ic: "🏨",
      name: "Google Hotels",
      sub: `Stays in ${city}`,
      url: `https://www.google.com/travel/hotels/${encodeURIComponent(city)}?checkin=${checkin}&checkout=${checkout}`,
    },
    {
      ic: "🛏️",
      name: "Booking.com",
      sub: `${checkin} → ${checkout}`,
      url: `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(city)}&checkin=${checkin}&checkout=${checkout}`,
    },
    {
      ic: "🏡",
      name: "Airbnb",
      sub: `${checkin} → ${checkout}`,
      url: `https://www.airbnb.com/s/${encodeURIComponent(city)}/homes?checkin=${checkin}&checkout=${checkout}`,
    },
  ];

  els.bookStrip.innerHTML = links
    .map(
      (l) => `
    <a class="book-card" href="${l.url}" target="_blank" rel="noopener">
      <span class="ic">${l.ic}</span>
      <span>${l.name}<span class="sub">${l.sub}</span></span>
    </a>`
    )
    .join("");
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

/* ---------------- Rendering ---------------- */

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
