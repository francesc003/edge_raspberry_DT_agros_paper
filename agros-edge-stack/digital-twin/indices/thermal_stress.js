/**
 * Indice: Stress Termico (giorni)
 *
 * Conta quanti giorni nella finestra recente (default 7 giorni) hanno
 * superato una soglia di temperatura massima critica per la coltura.
 * Sopra questa soglia la pianta entra in stress termico (blocco fotosintetico,
 * disidratazione, danni a fiori/frutti).
 *
 * La soglia è specifica per coltura (configurata in crops/<coltura>.json
 * sotto alert_rules → stress_termico → soglia). Vite tipicamente 35°C,
 * olivo 38°C.
 *
 * @module indices/thermal_stress
 */

import { isFiniteNumber } from "./_utils.js";

export default {
  id: "STRESS_TERMICO",
  nome: "Giorni di stress termico (finestra)",
  unita: "giorni",

  requires: {
    sensors: ["air_temp"],
    weather: [],
    config: ["soglia_T_max"],
    history: [],
  },

  /**
   * Conta i giorni con T_max sopra soglia.
   *
   * @param {Object} input
   * @param {Array<{date: Date, tMax: number}>} input.tMaxHistory
   *        Serie di temperature massime giornaliere (tipicamente 7gg).
   * @param {number} input.sogliaTMax - Soglia di stress termico (°C), dalla config coltura
   * @returns {Object} risultato con value (count), unit, window
   */
  compute({ tMaxHistory, sogliaTMax }) {
    if (!Array.isArray(tMaxHistory)) {
      throw new Error("STRESS_TERMICO: tMaxHistory deve essere un array");
    }
    if (!isFiniteNumber(sogliaTMax)) {
      throw new Error("STRESS_TERMICO: sogliaTMax richiesta dalla config coltura");
    }

    const giorni = tMaxHistory.filter(
      (d) => isFiniteNumber(d.tMax) && d.tMax > sogliaTMax
    );

    return {
      value: giorni.length,
      unit: "giorni",
      window: `${tMaxHistory.length}d`,
      soglia_C: sogliaTMax,
      method: "count_threshold_exceedance",
      confidence: "high",
      giorni_oltre_soglia: giorni.map((d) => ({
        date: d.date instanceof Date ? d.date.toISOString().slice(0, 10) : d.date,
        tMax: d.tMax,
      })),
    };
  },
};
