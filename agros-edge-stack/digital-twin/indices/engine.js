/**
 * Engine (orchestratore) dei moduli indice.
 *
 * Riceve in input il profilo completo del testbed (risolto) e i dati grezzi
 * raccolti dal fetcher, e produce in output la mappa degli indici calcolati
 * + la lista degli indici non calcolabili (con motivo) + le soglie dinamiche.
 *
 * NON fa I/O: niente Mongo, niente API, niente filesystem. Riceve i dati
 * già pronti, restituisce un oggetto. Questo lo rende testabile in isolamento.
 *
 * Pipeline interna in 6 fasi:
 *   A) Capability detection: cosa è disponibile (sensori, meteo, config, history)
 *   B) Filter: quali indici nel registry hanno tutti i requires soddisfatti
 *   C) Alternative resolution: tra indici con stesso `alternative_di`,
 *      tieni quello con priority numericamente più bassa
 *   D) Topological sort: ordina per dipendenze tra indici (es. SWD dopo ET0)
 *   E) Execute: chiama compute() di ogni indice, in ordine, con input estratto
 *   F) Assemble: produce l'oggetto di output strutturato
 *
 * @module indices/engine
 */

import { REGISTRY } from "./registry.js";
import { computeSwdThresholds } from "./thresholds.js";
import { mean, max, min, isFiniteNumber } from "./_utils.js";

// ============================================================================
// FASE A — CAPABILITY DETECTION
// ============================================================================

/**
 * Analizza profilo + dati grezzi e produce un set di capability disponibili.
 *
 * Le capability sono divise per "provider":
 *   - sensors: tipi di sensore con almeno una lettura valida nelle ultime 24h
 *   - weather: campi meteo presenti nel payload (precipitazioni, ecc.)
 *   - config: parametri config richiesti (latitudine, T_base_GDD, ecc.)
 *   - history: valori storici disponibili (SWD_ieri, GDD_cumulato_ieri)
 *
 * @param {Object} profile - profilo completo (output del resolver)
 * @param {Object} rawData - dati grezzi raccolti dal fetcher
 * @returns {Object} { sensors: Set, weather: Set, config: Set, history: Set }
 */
function detectCapabilities(profile, rawData) {
  const capabilities = {
    sensors: new Set(),
    weather: new Set(),
    config: new Set(),
    history: new Set(),
  };

  // Sensori: estrai i tipi di sensore attivi con almeno una lettura valida
  const sensorReadings = rawData.sensorReadings || {};
  for (const [tipo, readings] of Object.entries(sensorReadings)) {
    if (Array.isArray(readings) && readings.some((r) => isFiniteNumber(r.value))) {
      capabilities.sensors.add(tipo);
    }
  }

  // Weather: campi presenti e finiti nei dati meteo di oggi
  const weatherToday = rawData.weather?.today || {};
  for (const [campo, val] of Object.entries(weatherToday)) {
    if (isFiniteNumber(val)) capabilities.weather.add(campo);
  }

  // Config: campi presenti nel profilo (estratti con accesso safe)
  if (isFiniteNumber(profile.localizzazione?.lat)) {
    capabilities.config.add("latitudine");
  }
  if (isFiniteNumber(profile.crop?.fenologia?.T_base_GDD)) {
    capabilities.config.add("T_base_GDD");
  }
  if (
    isFiniteNumber(profile.soil?.idrologia?.FC_mm_per_m) &&
    isFiniteNumber(profile.soil?.idrologia?.WP_mm_per_m)
  ) {
    capabilities.config.add("FC");
    capabilities.config.add("WP");
  }
  if (isFiniteNumber(profile.radici?.profondita_cm)) {
    capabilities.config.add("profondita_radicale_cm");
  }
  if (isFiniteNumber(profile.crop?.kc_corrente)) {
    capabilities.config.add("Kc_corrente");
  }
  if (isFiniteNumber(profile.crop?.soglia_T_max)) {
    capabilities.config.add("soglia_T_max");
  }

  // History: valori storici presenti nell'ultimo record
  const last = rawData.lastHistoryRecord || {};
  if (isFiniteNumber(last.SWD)) capabilities.history.add("SWD_ieri");
  if (isFiniteNumber(last.GDD)) capabilities.history.add("GDD_cumulato_ieri");

  return capabilities;
}

// ============================================================================
// FASE B — FILTER (verifica requires)
// ============================================================================

/**
 * Verifica se un indice ha tutti i suoi `requires` ESTERNI soddisfatti
 * (sensori, meteo, config). Le `requires.indices` (dipendenze tra indici)
 * sono gestite separatamente dopo, nella propagateDependencies, perché
 * vanno verificate solo dopo aver capito quali indici sono "esternamente
 * calcolabili".
 *
 * @param {Object} indexModule - modulo indice dal registry
 * @param {Object} capabilities - output di detectCapabilities
 * @returns {{ok: boolean, missing: Array<{type: string, name: string}>}}
 */
function checkExternalRequires(indexModule, capabilities) {
  const missing = [];
  const req = indexModule.requires || {};

  for (const s of req.sensors || []) {
    if (!capabilities.sensors.has(s)) missing.push({ type: "sensor", name: s });
  }
  for (const w of req.weather || []) {
    if (!capabilities.weather.has(w)) missing.push({ type: "weather", name: w });
  }
  for (const c of req.config || []) {
    if (!capabilities.config.has(c)) missing.push({ type: "config", name: c });
  }
  // requires.history è "soft": i moduli gestiscono internamente il caso
  // di valore storico mancante con un default ragionevole.
  // requires.indices è gestito da propagateDependencies.

  return { ok: missing.length === 0, missing };
}

/**
 * Propaga le dipendenze inter-indice: dato un set di indici "esternamente
 * calcolabili", scarta quelli che dipendono da indici non presenti nel set.
 * Itera finché non converge (es. A → B → C, se C è fuori, anche B e poi A).
 *
 * @param {Array<Object>} indices - indici esternamente calcolabili
 * @returns {{kept: Array<Object>, dropped: Array<{idx, missing}>}}
 */
function propagateDependencies(indices) {
  let kept = [...indices];
  const dropped = [];

  let changed = true;
  while (changed) {
    changed = false;
    const keptLogicalIds = new Set(
      kept.map((i) => i.alternative_di || i.id)
    );
    keptLogicalIds.add(...kept.map((i) => i.id)); // anche per ID concreto

    const survivors = [];
    for (const idx of kept) {
      const deps = idx.requires?.indices || [];
      const missingDeps = deps.filter((d) => !keptLogicalIds.has(d));
      if (missingDeps.length === 0) {
        survivors.push(idx);
      } else {
        dropped.push({
          idx,
          missing: missingDeps.map((d) => ({ type: "index", name: d })),
        });
        changed = true;
      }
    }
    kept = survivors;
  }

  return { kept, dropped };
}

// ============================================================================
// FASE C — ALTERNATIVE RESOLUTION
// ============================================================================

/**
 * Tra indici con stesso `alternative_di`, tieni solo quello con priority
 * numericamente più bassa (= priorità più alta).
 *
 * @param {Array<Object>} indices - lista di indici calcolabili
 * @returns {Array<Object>} lista filtrata
 */
function resolveAlternatives(indices) {
  const byGroup = new Map();
  const standalone = [];

  for (const idx of indices) {
    if (idx.alternative_di) {
      const current = byGroup.get(idx.alternative_di);
      if (!current || (idx.priority ?? 99) < (current.priority ?? 99)) {
        byGroup.set(idx.alternative_di, idx);
      }
    } else {
      standalone.push(idx);
    }
  }

  return [...standalone, ...byGroup.values()];
}

// ============================================================================
// FASE D — TOPOLOGICAL SORT
// ============================================================================

/**
 * Ordina gli indici in modo che ogni indice venga calcolato dopo i suoi
 * `requires.indices`. Usa l'ID logico (`alternative_di` se presente, altrimenti `id`)
 * per il matching delle dipendenze, perché un indice che dipende da "ET0"
 * deve essere soddisfatto sia da ET0_HS che da un futuro ET0_PM.
 *
 * @param {Array<Object>} indices
 * @returns {Array<Object>} indices ordinati
 * @throws se c'è un ciclo nel grafo delle dipendenze
 */
function topologicalSort(indices) {
  const logicalId = (idx) => idx.alternative_di || idx.id;
  const byLogical = new Map(indices.map((idx) => [logicalId(idx), idx]));

  const sorted = [];
  const visited = new Set();
  const visiting = new Set();

  function visit(idx) {
    const lid = logicalId(idx);
    if (visited.has(lid)) return;
    if (visiting.has(lid)) {
      throw new Error(`Ciclo nelle dipendenze degli indici, su: ${lid}`);
    }
    visiting.add(lid);

    const deps = idx.requires?.indices || [];
    for (const depLid of deps) {
      const depIdx = byLogical.get(depLid);
      if (depIdx) visit(depIdx);
      // se depIdx non c'è, l'indice corrente sarebbe stato già filtrato
      // a monte da checkRequires, quindi qui non dovrebbe accadere
    }

    visiting.delete(lid);
    visited.add(lid);
    sorted.push(idx);
  }

  for (const idx of indices) visit(idx);
  return sorted;
}

// ============================================================================
// FASE E — INPUT EXTRACTION (per ogni indice prima del compute)
// ============================================================================

/**
 * Estrae dal payload di dati grezzi gli input nel formato atteso da un
 * modulo indice specifico.
 *
 * Per ogni indice c'è una "rule" di estrazione. Quando aggiungerai nuovi
 * indici, aggiungerai qui una nuova rule. Questo è il punto di traduzione
 * tra il formato grezzo (array di letture sensori) e il formato canonico
 * dei moduli (`{tMax, tMin, ...}`).
 *
 * @param {Object} indexModule
 * @param {Object} profile
 * @param {Object} rawData
 * @param {Object} computedSoFar - indici già calcolati in questo ciclo
 * @returns {Object} input pronto per il compute
 */
function extractInputFor(indexModule, profile, rawData, computedSoFar) {
  const today = rawData.date || new Date();

  // Aggregati di temperatura aria dall'array di letture
  const airTempReadings = (rawData.sensorReadings?.air_temp || [])
    .map((r) => r.value)
    .filter(isFiniteNumber);
  const tMax = max(airTempReadings);
  const tMin = min(airTempReadings);

  // Aggregato di umidità suolo (media volumetrica %)
  const soilMoistureReadings = (rawData.sensorReadings?.soil_moisture || [])
    .map((r) => r.value)
    .filter(isFiniteNumber);
  const soilMoisturePct = mean(soilMoistureReadings);

  // Switch per ID indice
  switch (indexModule.id) {
    case "ET0_HS":
      return {
        tMax,
        tMin,
        latitude: profile.localizzazione.lat,
        date: today,
      };

    case "GDD": {
      const last = rawData.lastHistoryRecord || {};
      return {
        tMax,
        tMin,
        tBase: profile.crop.fenologia.T_base_GDD,
        gddCumulatoIeri: isFiniteNumber(last.GDD) ? last.GDD : null,
        date: today,
        dateIeri: last.date ? new Date(last.date) : null,
      };
    }

    case "SWD": {
      const last = rawData.lastHistoryRecord || {};
      const et0Computed = computedSoFar.ET0;
      return {
        swdIeri: isFiniteNumber(last.SWD) ? last.SWD : null,
        et0: et0Computed?.value, // dal computeSoFar
        kc: profile.crop.kc_corrente,
        precipitazioni: rawData.weather?.today?.precipitazioni ?? 0,
        irrigazione: rawData.irrigazione_oggi ?? 0,
        fc: profile.soil.idrologia.FC_mm_per_m,
        wp: profile.soil.idrologia.WP_mm_per_m,
        profonditaRadicaleCm: profile.radici.profondita_cm,
        soilMoisturePct, // null se non disponibile
      };
    }

    case "STRESS_TERMICO":
      return {
        tMaxHistory: rawData.tMaxHistory7d || [],
        sogliaTMax: profile.crop.soglia_T_max,
      };

    default:
      throw new Error(`extractInputFor: nessuna rule di estrazione per ${indexModule.id}`);
  }
}

// ============================================================================
// FASE F — RUN ENGINE (orchestrazione completa)
// ============================================================================

/**
 * Esegue l'engine completo: capability detection, filter, alternative
 * resolution, topological sort, execution.
 *
 * @param {Object} profile - profilo completo del testbed (dal resolver)
 * @param {Object} rawData - dati grezzi (dal fetcher)
 * @returns {Object} {
 *   computed: Object,        // indici calcolati per ID logico (ET0, GDD, SWD, ...)
 *   not_computed: Array,     // indici non calcolabili, con motivo
 *   thresholds: Object,      // soglie SWD dinamiche, se calcolabili
 *   errors: Array,           // errori di esecuzione (non bloccano gli altri)
 *   capabilities: Object,    // diagnostico: cosa era disponibile
 * }
 */
export function runEngine(profile, rawData) {
  // FASE A
  const capabilities = detectCapabilities(profile, rawData);

  // FASE B — Filter per requirements ESTERNI (sensori, meteo, config)
  const calcolabili = [];
  const non_calcolabili = [];

  for (const idx of REGISTRY) {
    const check = checkExternalRequires(idx, capabilities);
    if (check.ok) {
      calcolabili.push(idx);
    } else {
      non_calcolabili.push({
        id: idx.id,
        nome: idx.nome,
        missing: check.missing,
      });
    }
  }

  // FASE B2 — Propaga dipendenze inter-indice
  const { kept: dopoDipendenze, dropped: scartatiPerDipendenze } =
    propagateDependencies(calcolabili);
  for (const { idx, missing } of scartatiPerDipendenze) {
    non_calcolabili.push({
      id: idx.id,
      nome: idx.nome,
      missing,
    });
  }

  // FASE C — Alternative resolution
  const dopoAlternative = resolveAlternatives(dopoDipendenze);

  // Aggiorna non_calcolabili: gli indici scartati per alternative finiscono qui
  const tenutiSet = new Set(dopoAlternative.map((i) => i.id));
  for (const idx of dopoDipendenze) {
    if (!tenutiSet.has(idx.id)) {
      non_calcolabili.push({
        id: idx.id,
        nome: idx.nome,
        missing: [
          {
            type: "alternative",
            name: `superato da ${idx.alternative_di} di priorità più alta`,
          },
        ],
      });
    }
  }

  // FASE D — topological sort.
  // Ricalcolo dei requires.indices: dopo alternative resolution potremmo
  // aver scelto un indice (ET0_HS) che soddisfa una dipendenza logica (ET0).
  // L'engine considera già la dipendenza logica nel topological sort,
  // quindi nessuna modifica ai requires originali.
  let ordinati;
  try {
    ordinati = topologicalSort(dopoAlternative);
  } catch (err) {
    return {
      computed: {},
      not_computed: non_calcolabili,
      thresholds: null,
      errors: [{ phase: "topological_sort", message: err.message }],
      capabilities: serializeCapabilities(capabilities),
    };
  }

  // FASE E — esecuzione
  const computed = {};
  const computedIds = new Set();
  const errors = [];
  for (const idx of ordinati) {
    try {
      const input = extractInputFor(idx, profile, rawData, computed);
      const result = idx.compute(input);
      const logicalId = idx.alternative_di || idx.id;
      computed[logicalId] = { ...result, source_module: idx.id };
      computedIds.add(logicalId);
      computedIds.add(idx.id);
    } catch (err) {
      errors.push({ phase: "compute", index: idx.id, message: err.message });
      non_calcolabili.push({
        id: idx.id,
        nome: idx.nome,
        missing: [{ type: "runtime_error", name: err.message }],
      });
    }
  }

  // Soglie dinamiche SWD (se i parametri sono presenti)
  let thresholds = null;
  try {
    if (
      capabilities.config.has("FC") &&
      capabilities.config.has("WP") &&
      capabilities.config.has("profondita_radicale_cm") &&
      isFiniteNumber(profile.crop?.stress_idrico?.p_depletion)
    ) {
      thresholds = computeSwdThresholds({
        fc: profile.soil.idrologia.FC_mm_per_m,
        wp: profile.soil.idrologia.WP_mm_per_m,
        profonditaRadicaleCm: profile.radici.profondita_cm,
        pDepletion: profile.crop.stress_idrico.p_depletion,
      });
    }
  } catch (err) {
    errors.push({ phase: "thresholds", message: err.message });
  }

  return {
    computed,
    not_computed: non_calcolabili,
    thresholds,
    errors,
    capabilities: serializeCapabilities(capabilities),
  };
}

/**
 * Trasforma i Set in array per facilitare JSON serialization.
 */
function serializeCapabilities(capabilities) {
  return {
    sensors: [...capabilities.sensors],
    weather: [...capabilities.weather],
    config: [...capabilities.config],
    history: [...capabilities.history],
  };
}
