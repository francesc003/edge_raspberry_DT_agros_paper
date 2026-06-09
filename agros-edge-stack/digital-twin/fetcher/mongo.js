/**
 * Fetcher MongoDB per il container Digital Twin.
 *
 * Legge le letture dei sensori dalla collection `sensor_readings` di MongoDB,
 * popolata dal container simulatore. Schema completo: una riga per
 * (nodo, sensore, istante), con i tipi sensore separati.
 *
 * Schema atteso di un documento sensor_readings:
 *   {
 *     testbed_id: "campo_raspberry_01",
 *     node_id:    "campo_raspberry_01_node_03",
 *     sensor_id:  "N03_AT",
 *     tipo:       "air_temp",
 *     value:      24.3,
 *     unit:       "C",
 *     timestamp:  ISODate(...),
 *     burst_id:   "2026-05-25T06:00:00Z"   // raggruppa un burst di trasmissione
 *   }
 *
 * @module fetcher/mongo
 */

export const COLLECTIONS = {
  SENSOR_READINGS: "sensor_readings",
  DT_SNAPSHOTS: "dt_snapshots",
  DT_HISTORY: "dt_history",
  IRRIGATION_LOG: "irrigation_log",
};

/**
 * Restituisce il timestamp del burst più recente per un testbed, oppure null
 * se non ci sono letture. Usato dal loop event-driven per capire se è
 * arrivato un nuovo burst da elaborare.
 *
 * @param {Object} args
 * @param {import('mongodb').Db} args.db
 * @param {string} args.testbedId
 * @returns {Promise<Date|null>}
 */
export async function getLatestBurstTimestamp({ db, testbedId }) {
  const doc = await db
    .collection(COLLECTIONS.SENSOR_READINGS)
    .find({ testbed_id: testbedId })
    .sort({ timestamp: -1 })
    .limit(1)
    .next();
  return doc ? new Date(doc.timestamp) : null;
}

/**
 * Legge le letture sensori in una finestra temporale e le raggruppa per tipo,
 * nel formato atteso dall'engine del DT.
 *
 * @param {Object} args
 * @param {import('mongodb').Db} args.db
 * @param {string} args.testbedId
 * @param {Date} args.referenceDate  - estremo superiore della finestra
 * @param {number} [args.windowHours=24]
 * @returns {Promise<{sensorReadings, sensorReadings7d}>}
 */
export async function fetchRawDataMongo({ db, testbedId, referenceDate, windowHours = 24 }) {
  const since24h = new Date(referenceDate.getTime() - windowHours * 3600 * 1000);
  const since7d = new Date(referenceDate.getTime() - 7 * 24 * 3600 * 1000);

  const coll = db.collection(COLLECTIONS.SENSOR_READINGS);

  // Una sola query sui 7 giorni, poi filtriamo in memoria le 24h
  const docs = await coll
    .find({
      testbed_id: testbedId,
      timestamp: { $gte: since7d, $lte: referenceDate },
    })
    .sort({ timestamp: 1 })
    .toArray();

  const within24h = docs.filter((d) => new Date(d.timestamp) >= since24h);

  return {
    sensorReadings: groupByTipo(within24h),
    sensorReadings7d: groupByTipo(docs),
  };
}

function groupByTipo(docs) {
  const grouped = {};
  for (const d of docs) {
    if (!d.tipo || typeof d.value !== "number" || !Number.isFinite(d.value)) continue;
    if (!grouped[d.tipo]) grouped[d.tipo] = [];
    grouped[d.tipo].push({
      value: d.value,
      timestamp: new Date(d.timestamp),
      node_id: d.node_id,
      sensor_id: d.sensor_id,
    });
  }
  return grouped;
}

/**
 * Legge l'ultimo record di dt_history STRETTAMENTE precedente a referenceDate,
 * per inizializzare gli indici ricorsivi (SWD, GDD).
 *
 * @returns {Promise<Object|null>}
 */
export async function fetchLastHistoryRecord({ db, testbedId, referenceDate }) {
  const refDateStr = referenceDate.toISOString().slice(0, 10);
  const doc = await db
    .collection(COLLECTIONS.DT_HISTORY)
    .find({ testbed_id: testbedId, date: { $lt: refDateStr } })
    .sort({ date: -1 })
    .limit(1)
    .next();
  if (!doc) return null;
  return { date: doc.date, ...(doc.indici || {}) };
}

/**
 * Costruisce la serie giornaliera tMax/tMin (per STRESS_TERMICO) dalle letture
 * 7gg di temperatura aria.
 */
export function aggregateDailyTemps(airTempReadings7d) {
  if (!Array.isArray(airTempReadings7d)) return [];
  const byDay = new Map();
  for (const r of airTempReadings7d) {
    if (typeof r.value !== "number" || !Number.isFinite(r.value)) continue;
    const day = new Date(r.timestamp);
    day.setUTCHours(0, 0, 0, 0);
    const key = day.toISOString().slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, { date: day, valori: [] });
    byDay.get(key).valori.push(r.value);
  }
  return [...byDay.values()]
    .map(({ date, valori }) => ({ date, tMax: Math.max(...valori), tMin: Math.min(...valori) }))
    .sort((a, b) => a.date - b.date);
}
