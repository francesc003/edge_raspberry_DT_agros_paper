/**
 * Advisor per l'irrigazione — euristica rule-based (Livello 2).
 *
 * Decide SE e QUANDO attivare l'irrigazione combinando due assi:
 *
 *   ASSE 1 — Necessità idrica (basata su SWD vs soglie del DT):
 *     - SWD < warning            -> nessun bisogno
 *     - warning <= SWD < critical -> bisogno moderato (ottimizzabile)
 *     - SWD >= critical           -> bisogno urgente
 *
 *   ASSE 2 — Efficienza del momento (modula la fascia "moderata"):
 *     - ora del giorno: irrigare in fascia fresca (notte/prima mattina)
 *       riduce le perdite per evaporazione
 *     - pioggia prevista: se sono attese precipitazioni significative
 *       nelle prossime 24h, conviene rimandare (acqua "gratis")
 *
 * Regola di sintesi:
 *   - sotto warning              -> NON_IRRIGARE
 *   - fascia warning-critical:
 *       . se finestra efficiente E niente pioggia  -> IRRIGA
 *       . altrimenti                               -> RIMANDA
 *   - sopra critical             -> IRRIGA_SUBITO  (l'urgenza vince sull'efficienza)
 *
 * L'output è strutturato e tracciabile: ogni decisione riporta il motivo.
 * Per un attuatore reale, il campo `irrigare` (boolean) pilota la pompa;
 * il resto è diagnostica utile per log e analisi.
 *
 * Nessuna previsione o simulazione: usa solo lo stato presente (SWD, ora)
 * e il meteo già disponibile nel DT. Coerente con il Livello 2.
 *
 * @module irrigation/advisor
 */

/**
 * @typedef {Object} IrrigationDecision
 * @property {string} decisione        - NON_IRRIGARE | IRRIGA | RIMANDA | IRRIGA_SUBITO
 * @property {boolean} irrigare        - true se l'attuatore deve attivarsi ora
 * @property {string} urgenza          - nessuna | moderata | urgente
 * @property {string} motivo           - spiegazione leggibile della decisione
 * @property {Object} dettagli         - valori usati nella valutazione
 */

const DEFAULTS = {
  // Fascia oraria efficiente per irrigare (ore locali). Notte + prima mattina.
  oraInizioEfficiente: 22,
  oraFineEfficiente: 8,
  // Pioggia (mm) prevista nelle prossime 24h sopra cui conviene rimandare
  sogliaPioggiaRimando_mm: 5,
  // Durata suggerita dell'irrigazione quando si attiva (minuti)
  durataIrrigazione_min: 30,
};

/**
 * Determina se l'ora corrente cade nella finestra efficiente.
 * La finestra attraversa la mezzanotte (es. 22 -> 8), quindi va gestita
 * come unione di due intervalli.
 */
function isFinestraEfficiente(ora, inizio, fine) {
  if (inizio <= fine) {
    // finestra "diurna" classica (non è il nostro caso di default)
    return ora >= inizio && ora < fine;
  }
  // finestra che attraversa la mezzanotte (es. 22..24 e 0..8)
  return ora >= inizio || ora < fine;
}

/**
 * Somma la pioggia prevista nelle prossime `oreOrizzonte` ore a partire
 * dal meteo a 7 giorni. Il meteo è giornaliero, quindi consideriamo il
 * giorno corrente e l'indomani come orizzonte ~24-48h.
 */
function pioggiaPrevista24h(meteo7gg) {
  if (!Array.isArray(meteo7gg) || meteo7gg.length === 0) return 0;
  // Primo giorno = oggi. Sommiamo oggi (resto della giornata) come proxy 24h.
  // Per semplicità e robustezza, prendiamo il massimo tra oggi e domani:
  // se anche solo uno dei due porta pioggia significativa, ha senso rimandare.
  const oggi = meteo7gg[0]?.precip_mm ?? 0;
  const domani = meteo7gg[1]?.precip_mm ?? 0;
  return Math.max(oggi, domani);
}

/**
 * Valuta la decisione di irrigazione.
 *
 * @param {Object} args
 * @param {Object} args.swd            - risultato indice SWD ({value, ...})
 * @param {Object} args.thresholds     - {SWD_warning, SWD_critical, TAW}
 * @param {Object[]} args.meteo7gg     - previsione (per la pioggia)
 * @param {Date} args.referenceDate    - momento della valutazione (per l'ora)
 * @param {Object} [args.options]      - override dei parametri DEFAULTS
 * @returns {IrrigationDecision}
 */
export function evaluateIrrigation({ swd, thresholds, meteo7gg, referenceDate, options = {} }) {
  const cfg = { ...DEFAULTS, ...options };

  // Se SWD non è calcolabile, non possiamo decidere in sicurezza: non irrigare
  if (!swd || typeof swd.value !== "number" || !Number.isFinite(swd.value)) {
    return {
      decisione: "NON_IRRIGARE",
      irrigare: false,
      urgenza: "nessuna",
      motivo: "SWD non disponibile: impossibile valutare il bisogno idrico in sicurezza",
      dettagli: {},
    };
  }

  const swdVal = swd.value;
  const warning = thresholds?.SWD_warning;
  const critical = thresholds?.SWD_critical;

  if (typeof warning !== "number" || typeof critical !== "number") {
    return {
      decisione: "NON_IRRIGARE",
      irrigare: false,
      urgenza: "nessuna",
      motivo: "Soglie SWD non disponibili: impossibile valutare",
      dettagli: { swd: swdVal },
    };
  }

  const ora = referenceDate.getUTCHours();
  const finestraEfficiente = isFinestraEfficiente(ora, cfg.oraInizioEfficiente, cfg.oraFineEfficiente);
  const pioggia24h = pioggiaPrevista24h(meteo7gg);
  const pioggiaInArrivo = pioggia24h >= cfg.sogliaPioggiaRimando_mm;

  const dettagli = {
    swd: Number(swdVal.toFixed(1)),
    soglia_warning: Number(warning.toFixed(1)),
    soglia_critical: Number(critical.toFixed(1)),
    ora_valutazione: ora,
    finestra_efficiente: finestraEfficiente,
    pioggia_prevista_24h_mm: Number(pioggia24h.toFixed(1)),
    pioggia_in_arrivo: pioggiaInArrivo,
  };

  // --- ASSE 1: necessità ---

  // Caso 1: sotto la soglia warning -> acqua sufficiente
  if (swdVal < warning) {
    return {
      decisione: "NON_IRRIGARE",
      irrigare: false,
      urgenza: "nessuna",
      motivo: `SWD (${swdVal.toFixed(1)}mm) sotto la soglia di allerta (${warning.toFixed(1)}mm): il suolo ha acqua sufficiente`,
      dettagli,
    };
  }

  // Caso 3: sopra il critical -> urgenza, l'efficienza passa in secondo piano
  if (swdVal >= critical) {
    return {
      decisione: "IRRIGA_SUBITO",
      irrigare: true,
      urgenza: "urgente",
      motivo: `SWD (${swdVal.toFixed(1)}mm) ha raggiunto la soglia critica (${critical.toFixed(1)}mm): irrigazione necessaria indipendentemente dall'ora`,
      durata_min: cfg.durataIrrigazione_min,
      dettagli,
    };
  }

  // Caso 2: fascia warning-critical -> ottimizziamo il momento

  // 2a: pioggia in arrivo -> rimanda (acqua gratis)
  if (pioggiaInArrivo) {
    return {
      decisione: "RIMANDA",
      irrigare: false,
      urgenza: "moderata",
      motivo: `SWD (${swdVal.toFixed(1)}mm) in fascia di allerta, ma sono previsti ${pioggia24h.toFixed(1)}mm di pioggia nelle prossime 24h: conviene attendere`,
      dettagli,
    };
  }

  // 2b: fuori dalla finestra efficiente -> rimanda al momento fresco
  if (!finestraEfficiente) {
    return {
      decisione: "RIMANDA",
      irrigare: false,
      urgenza: "moderata",
      motivo: `SWD (${swdVal.toFixed(1)}mm) in fascia di allerta, ma l'ora attuale (${ora}:00) non è efficiente: si attende la fascia fresca (${cfg.oraInizioEfficiente}:00-${cfg.oraFineEfficiente}:00) per ridurre l'evaporazione`,
      dettagli,
    };
  }

  // 2c: bisogno moderato + finestra efficiente + niente pioggia -> irriga
  return {
    decisione: "IRRIGA",
    irrigare: true,
    urgenza: "moderata",
    motivo: `SWD (${swdVal.toFixed(1)}mm) in fascia di allerta, finestra oraria efficiente e nessuna pioggia in arrivo: momento ottimale per irrigare`,
    durata_min: cfg.durataIrrigazione_min,
    dettagli,
  };
}
