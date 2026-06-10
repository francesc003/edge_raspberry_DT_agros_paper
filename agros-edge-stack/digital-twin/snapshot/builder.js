/**
 * Snapshot Builder: assembla il JSON finale dello snapshot del DT, unendo:
 *   - stato attuale (letture sensori più recenti, aggregate)
 *   - indici calcolati (dall'engine indici)
 *   - indici non calcolabili (con motivo)
 *   - soglie SWD dinamiche
 *   - meteo previsto 7 giorni
 *   - alert generati
 *   - metadata di qualità dei dati e versioning
 *
 * Lo snapshot è il "contratto" con il ChatBot e la dashboard: è il documento
 * che leggeranno per rispondere a "come sta il campo adesso?".
 *
 * NON fa I/O: riceve tutti gli input già pronti, produce un oggetto JSON.
 *
 * @module snapshot/builder
 */

import { isFiniteNumber, mean } from "../indices/_utils.js";

const SNAPSHOT_VERSION = "1.0";

/**
 * Aggrega le letture sensori delle ultime 24h in valori "stato attuale".
 *
 * Per ogni tipo di sensore disponibile, calcola una rappresentazione
 * sintetica:
 *   - air_temp:      ultima lettura + min/max
 *   - soil_moisture: media
 *   - soil_temp:     media
 *   - air_rh:        ultima lettura
 *   - soil_ec:       media
 *   - uv_index:      max
 *   - altri:         ultima lettura
 */
function aggregateCurrentState(sensorReadings) {
  const state = {};

  for (const [tipo, readings] of Object.entries(sensorReadings || {})) {
    if (!Array.isArray(readings) || readings.length === 0) continue;
    const valori = readings.map((r) => r.value).filter(isFiniteNumber);
    if (valori.length === 0) continue;

    // Ultima lettura per timestamp
    const sortedByTime = [...readings]
      .filter((r) => r.timestamp && isFiniteNumber(r.value))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const ultima = sortedByTime[0]?.value;

    const stat = {
      valore: isFiniteNumber(ultima)
        ? round1(ultima)
        : round1(mean(valori)),
      ultima_lettura: sortedByTime[0]?.timestamp,
      letture_24h: valori.length,
    };

    // Per air_temp aggiungiamo anche min e max
    if (tipo === "air_temp") {
      stat.min_24h = round1(Math.min(...valori));
      stat.max_24h = round1(Math.max(...valori));
      stat.media_24h = round1(mean(valori));
    }

    state[tipo] = stat;
  }

  return state;
}

function round1(x) {
  return isFiniteNumber(x) ? Math.round(x * 10) / 10 : null;
}

/**
 * Calcola un indicatore di qualità dei dati: quanti sensori previsti sono
 * effettivamente attivi e con letture, vs quanti dichiarati nell'hardware.
 */
function computeDataQuality(profile, sensorReadings) {
  const sensoriDichiarati = profile.hardware?.sensori_attivi || [];
  const sensoriConDati = Object.keys(sensorReadings || {}).filter(
    (tipo) =>
      Array.isArray(sensorReadings[tipo]) &&
      sensorReadings[tipo].some((r) => isFiniteNumber(r.value))
  );

  return {
    sensori_dichiarati: sensoriDichiarati.length,
    sensori_con_dati: sensoriConDati.length,
    sensori_offline: sensoriDichiarati.filter(
      (s) => !sensoriConDati.includes(s)
    ),
    percentuale_copertura:
      sensoriDichiarati.length > 0
        ? Math.round((sensoriConDati.length / sensoriDichiarati.length) * 100)
        : 0,
  };
}

/**
 * Costruisce lo snapshot finale.
 *
 * @param {Object} args
 * @param {Object} args.profile - profile completo dal resolver
 * @param {Object} args.sensorReadings - letture sensori 24h (dal fetcher)
 * @param {Object} args.engineResult - output di runEngine
 * @param {Object} args.alertsResult - output di runAlertEngine
 * @param {Array} args.meteo7gg - previsioni meteo 7 giorni
 * @returns {Object} snapshot strutturato pronto per essere persistito
 */
export function buildSnapshot({
  profile,
  sensorReadings,
  engineResult,
  alertsResult,
  meteo7gg,
}) {
  // Data "del dato": è la data di riferimento della pipeline (profile.date),
  // impostata dal resolver. In esecuzione normale coincide con oggi; in
  // esecuzione simulata/batch è la data simulata. Lo snapshot DEVE essere
  // datato con questa, non con l'ora di sistema, altrimenti gli indici
  // ricorsivi (SWD, GDD) leggerebbero lo stato sbagliato.
  const referenceDate =
    profile.date instanceof Date ? profile.date : new Date();
  // Ora reale di esecuzione: usata solo per tracciare quando lo snapshot
  // è stato fisicamente prodotto.
  const generatedAt = new Date();

  const stato_attuale = aggregateCurrentState(sensorReadings);

  // Mappa indici → struttura più "leggibile" per il consumatore
  // (rimuove inputs_used dal payload principale, lo tiene in un campo diagnostico)
  const indici = {};
  for (const [id, idx] of Object.entries(engineResult.computed || {})) {
    const { inputs_used, source_module, ...rest } = idx;
    indici[id] = rest;
  }

  // Diagnostica completa (separata dal payload principale per non appesantire)
  const diagnostica = {
    indici_inputs_used: Object.fromEntries(
      Object.entries(engineResult.computed || {}).map(([id, idx]) => [
        id,
        idx.inputs_used,
      ])
    ),
    capabilities: engineResult.capabilities,
    engine_errors: engineResult.errors,
    alert_engine_skipped: alertsResult.skipped,
  };

  const data_quality = computeDataQuality(profile, sensorReadings);

  return {
    // Identificazione
    testbed_id: profile.testbed_id,
    timestamp: referenceDate.toISOString(),
    date: referenceDate.toISOString().slice(0, 10),

    // Profilo sintetico (per RAG: ChatBot deve sapere che pianta/suolo è)
    profilo_sintetico: {
      cliente: profile.cliente?.nome,
      coltura: profile.crop?.nome_esteso || profile.crop?.nome,
      varieta: profile.crop?.varieta,
      fase_fenologica: profile.crop?.fase_corrente,
      suolo: profile.soil?.nome,
      localizzazione: profile.localizzazione,
    },

    // Stato attuale del campo (aggregato delle ultime 24h)
    stato_attuale,

    // Indici calcolati
    indici,

    // Indici NON calcolati, con motivo (utile per il ChatBot e per
    // suggerire al cliente upgrade hardware)
    indici_non_calcolabili: engineResult.not_computed || [],

    // Soglie dinamiche (riferimento per il ChatBot quando parla di SWD)
    soglie: engineResult.thresholds,

    // Meteo previsto
    meteo_7gg: meteo7gg || [],

    // Alert deterministici (DT autoritativo, non LLM)
    alerts: alertsResult.alerts || [],

    // Metadata
    metadata: {
      snapshot_version: SNAPSHOT_VERSION,
      generated_at: generatedAt.toISOString(),
      data_quality,
    },

    // Diagnostica (utile per debug, non per il ChatBot)
    diagnostica,
  };
}

/**
 * Estrae da uno snapshot completo un sottoinsieme "history" — leggero,
 * con solo gli indici essenziali — da appendere a dt_history come time series.
 *
 * Lo storico serve per i grafici della dashboard e per la futura calibrazione
 * AquaCrop; non ha senso ripetere meteo, alert, stato_attuale per ogni giorno.
 *
 * @param {Object} snapshot
 * @returns {Object} record snello per time series
 */
export function extractHistoryRecord(snapshot) {
  const indiciSnelli = {};
  for (const [id, idx] of Object.entries(snapshot.indici || {})) {
    indiciSnelli[id] = idx.value;
  }

  return {
    testbed_id: snapshot.testbed_id,
    date: snapshot.date,
    timestamp: snapshot.timestamp,
    indici: indiciSnelli,
    fase_fenologica: snapshot.profilo_sintetico?.fase_fenologica,
    alerts_count_by_level: countAlertsByLevel(snapshot.alerts || []),
  };
}

function countAlertsByLevel(alerts) {
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const a of alerts) {
    if (counts[a.livello] !== undefined) counts[a.livello]++;
  }
  return counts;
}
