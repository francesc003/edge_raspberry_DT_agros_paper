/**
 * Fetcher meteo da Open-Meteo (API gratuita, nessuna chiave richiesta).
 *
 * Resilienza offline: se la rete non è disponibile (es. 4G assente sul campo),
 * la chiamata fallisce in modo controllato e il DT prosegue usando solo i dati
 * contestuali dei sensori, senza meteo. Gli indici/alert che dipendono dal
 * meteo verranno semplicemente marcati come non disponibili dall'engine.
 *
 * Una piccola cache evita di chiamare l'API a ogni singolo burst: il meteo
 * cambia lentamente, una chiamata ogni `CACHE_TTL_MIN` minuti è sufficiente.
 *
 * @module fetcher/weather
 */

const CACHE_TTL_MIN = Number(process.env.WEATHER_CACHE_TTL_MIN ?? 30);
const FETCH_TIMEOUT_MS = Number(process.env.WEATHER_TIMEOUT_MS ?? 5000);

// Cache in memoria: { key, data, fetchedAt }
let _cache = null;

/**
 * Recupera il meteo per una posizione. Ritorna sempre un oggetto valido:
 * in caso di errore di rete, ritorna un meteo "vuoto" con source che indica
 * il fallback, senza lanciare eccezioni.
 *
 * @param {Object} args
 * @param {number} args.lat
 * @param {number} args.lon
 * @returns {Promise<{today, meteo_7gg, source, online}>}
 */
export async function fetchWeather({ lat, lon }) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const now = Date.now();

  // Cache valida?
  if (_cache && _cache.key === key && (now - _cache.fetchedAt) < CACHE_TTL_MIN * 60 * 1000) {
    return { ..._cache.data, source: "cache", online: true };
  }

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,shortwave_radiation_sum` +
    `&forecast_days=7&timezone=auto`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const data = normalizeOpenMeteo(json);

    _cache = { key, data, fetchedAt: now };
    return { ...data, source: "open-meteo", online: true };
  } catch (err) {
    // Offline o errore: degradazione graceful.
    // Se abbiamo una cache vecchia, la riusiamo (meglio di niente);
    // altrimenti meteo vuoto.
    if (_cache && _cache.key === key) {
      return { ..._cache.data, source: "cache_stale_offline", online: false, error: err.message };
    }
    return {
      today: {},
      meteo_7gg: [],
      source: "offline_no_data",
      online: false,
      error: err.message,
    };
  }
}

/**
 * Traduce la risposta Open-Meteo nello schema interno del DT.
 */
function normalizeOpenMeteo(json) {
  const d = json.daily;
  if (!d || !Array.isArray(d.time)) {
    return { today: {}, meteo_7gg: [] };
  }

  const meteo_7gg = d.time.map((data, i) => ({
    data,
    t_min: d.temperature_2m_min?.[i] ?? null,
    t_max: d.temperature_2m_max?.[i] ?? null,
    precip_mm: d.precipitation_sum?.[i] ?? 0,
    wind_max: d.wind_speed_10m_max?.[i] ?? null,
    radiation: d.shortwave_radiation_sum?.[i] ?? null,
  }));

  const today = meteo_7gg[0]
    ? {
        precipitazioni: meteo_7gg[0].precip_mm,
        t_min: meteo_7gg[0].t_min,
        t_max: meteo_7gg[0].t_max,
        wind_max: meteo_7gg[0].wind_max,
        shortwave: meteo_7gg[0].radiation,
      }
    : {};

  return { today, meteo_7gg };
}
