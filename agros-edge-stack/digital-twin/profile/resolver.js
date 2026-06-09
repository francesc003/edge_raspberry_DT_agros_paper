/**
 * Resolver: costruisce il "profilo completo" del testbed unendo le quattro
 * sorgenti di configurazione.
 *
 * Input:
 *   - client_profile da MongoDB (chi è, dove sta, cosa coltiva)
 *   - hardware_profile da MongoDB (sensori installati)
 *   - crop config da filesystem (parametri agronomici della coltura)
 *   - soil config da filesystem (parametri idrologici del suolo)
 *
 * Output:
 *   Un singolo oggetto "profile" piatto e pronto all'uso per engine/alerts.
 *
 * Il resolver è il punto in cui i `*_ref` simbolici (es. "vite") vengono
 * tradotti in dati reali. Applica anche gli `overrides` del client_profile
 * sui parametri default della coltura/suolo.
 *
 * NON fa I/O direttamente: riceve i 4 oggetti già caricati, il caricamento
 * è responsabilità di chi chiama (pipeline). Questo lo rende puro e testabile.
 *
 * @module profile/resolver
 */

import { isFiniteNumber } from "../indices/_utils.js";

/**
 * Pulisce un oggetto dai campi `_comment*` (convenzione dei nostri JSON
 * per documentare i valori in linea senza usare commenti veri).
 * Ricorsiva su oggetti annidati.
 */
function stripComments(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripComments);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("_comment")) continue;
    out[k] = stripComments(v);
  }
  return out;
}

/**
 * Determina la fase fenologica corrente in base al `fenologia_mode` del
 * client_profile.
 *
 * Modalità supportate:
 *   - "calendar": usa le date in fenologia_calendar (o calendar_default del crop)
 *   - "manual": usa manual_phenology_override
 *   - "gdd": v2, lascia il caso non implementato per ora
 *
 * @param {Object} clientProfile
 * @param {Object} cropConfig
 * @param {Date} date - data per cui determinare la fase
 * @returns {string} nome della fase corrente
 */
export function resolvePhenologyStage(clientProfile, cropConfig, date) {
  const mode = clientProfile.fenologia_mode || "calendar";

  if (mode === "manual" && clientProfile.manual_phenology_override) {
    return clientProfile.manual_phenology_override;
  }

  if (mode === "gdd") {
    // v2: non implementato, fallback a calendar
    // (qui in futuro: dato GDD cumulato, scorre GDD_soglie e trova la fase)
  }

  // Modalità calendar: cerca la fase più recente tra quelle iniziate
  // Costruisce una lista di {fase, dataInizio} ordinata per data, poi
  // trova l'ultima fase il cui inizio è <= date.
  const customCal = clientProfile.fenologia_calendar || {};
  const defaultCal = cropConfig.fenologia?.calendar_default || {};

  const fasiOrdinate = cropConfig.fenologia?.fasi || [];
  const eventi = [];
  for (const fase of fasiOrdinate) {
    let dataInizio = null;

    // Custom (date complete tipo "2026-05-18") ha precedenza
    if (customCal[fase]) {
      dataInizio = new Date(customCal[fase]);
    } else if (defaultCal[fase]) {
      // Default è MM-DD: applica l'anno corrente o l'anno precedente se
      // la data risultante è nel futuro rispetto a `date`
      const [mm, dd] = defaultCal[fase].split("-");
      dataInizio = new Date(date.getFullYear(), Number(mm) - 1, Number(dd));
      if (dataInizio > date) {
        dataInizio.setFullYear(date.getFullYear() - 1);
      }
    }

    if (dataInizio && !isNaN(dataInizio.getTime())) {
      eventi.push({ fase, dataInizio });
    }
  }

  // Cerca la fase più recente con dataInizio <= date
  const eventiPassati = eventi
    .filter((e) => e.dataInizio <= date)
    .sort((a, b) => b.dataInizio - a.dataInizio);

  if (eventiPassati.length > 0) {
    return eventiPassati[0].fase;
  }

  // Fallback: prima fase nell'ordine
  return fasiOrdinate[0] || "sconosciuta";
}

/**
 * Costruisce il profilo completo unendo le 4 sorgenti.
 *
 * @param {Object} clientProfile - documento da MongoDB
 * @param {Object} hardwareProfile - documento da MongoDB
 * @param {Object} cropConfig - JSON caricato da crops/<nome>.json
 * @param {Object} soilConfig - JSON caricato da soils/<nome>.json
 * @param {Date} [date] - data corrente, default Date.now()
 * @returns {Object} profilo completo pronto per engine e alerts
 */
export function resolveProfile(
  clientProfile,
  hardwareProfile,
  cropConfig,
  soilConfig,
  date = new Date()
) {
  // Pulisce i commenti da tutti gli input
  const cp = stripComments(clientProfile);
  const hp = stripComments(hardwareProfile);
  const crop = stripComments(cropConfig);
  const soil = stripComments(soilConfig);

  // Override profondità radicale (se presente in client_profile.overrides)
  const profonditaCm =
    cp.overrides?.radici?.profondita_default_cm ??
    crop.radici?.profondita_default_cm;

  // Risolvi la fase fenologica corrente
  const fase = resolvePhenologyStage(cp, crop, date);

  // Kc corrente in base alla fase
  const kcCorrente = crop.Kc_per_fase?.[fase] ?? null;

  // Soglia stress termico (estratta dalle alert_rules del crop config)
  const sogliaStressTermico = findAlertThreshold(crop, "stress_termico");

  // Soglia gelata (anche se usata dal motore alert, la includiamo nel profile
  // per uniformità)
  const sogliaGelata = findAlertThreshold(crop, "rischio_gelata");

  // Lista dei tipi di sensori attivi (deduplicata da tutti i nodi)
  const sensoriAttivi = collectActiveSensorTypes(hp);

  return {
    testbed_id: cp.testbed_id,
    date,

    // Cliente e localizzazione
    cliente: cp.cliente,
    localizzazione: cp.localizzazione,
    campo: cp.campo,

    // Coltura (parametri risolti, accesso piatto per i moduli)
    crop: {
      nome: crop.meta?.nome,
      nome_esteso: crop.meta?.nome_esteso,
      varieta: cp.coltura_dettagli?.varieta,
      fase_corrente: fase,
      kc_corrente: isFiniteNumber(kcCorrente) ? kcCorrente : null,
      fenologia: {
        T_base_GDD: crop.fenologia?.T_base_GDD,
        fasi_ordinate: crop.fenologia?.fasi,
      },
      stress_idrico: {
        p_depletion: crop.stress_idrico?.p_depletion,
      },
      soglia_T_max: sogliaStressTermico,
      soglia_T_min: sogliaGelata,
      // Riferimento completo per i moduli che vogliono ispezionare di più
      _full_crop_config: crop,
    },

    // Suolo
    soil: {
      nome: soil.meta?.nome,
      tessitura: soil.tessitura?.categoria,
      idrologia: {
        FC_mm_per_m: soil.idrologia?.FC_mm_per_m,
        WP_mm_per_m: soil.idrologia?.WP_mm_per_m,
      },
      _full_soil_config: soil,
    },

    // Radici (con override applicato)
    radici: {
      profondita_cm: profonditaCm,
    },

    // Irrigazione
    irrigazione: cp.irrigazione,

    // Hardware
    hardware: {
      nodi: hp.nodi || [],
      sensori_attivi: sensoriAttivi,
      aggregazione: hp.aggregazione,
    },

    // Metadata di risoluzione
    _meta_resolve: {
      resolved_at: new Date().toISOString(),
      fenologia_mode: cp.fenologia_mode || "calendar",
      had_overrides: Object.keys(cp.overrides || {}).length > 0,
    },
  };
}

/**
 * Estrae da un crop config il valore numerico della soglia di un alert.
 * Es: findAlertThreshold(crop, "stress_termico") → 35 per vite, 38 per olivo.
 *
 * @param {Object} cropConfig
 * @param {string} alertId
 * @returns {number|null}
 */
function findAlertThreshold(cropConfig, alertId) {
  const rules = cropConfig.alert_rules || [];
  const rule = rules.find((r) => r.id === alertId);
  if (!rule) return null;
  return isFiniteNumber(rule.soglia) ? rule.soglia : null;
}

/**
 * Scansiona l'hardware_profile e ritorna l'insieme deduplicato dei tipi
 * di sensore attivi, considerando tutti i nodi.
 *
 * @param {Object} hardwareProfile
 * @returns {string[]} es. ["air_temp", "soil_moisture", ...]
 */
function collectActiveSensorTypes(hardwareProfile) {
  const tipi = new Set();
  for (const node of hardwareProfile.nodi || []) {
    for (const sensore of node.sensori || []) {
      if (sensore.attivo) tipi.add(sensore.tipo);
    }
  }
  return [...tipi];
}
