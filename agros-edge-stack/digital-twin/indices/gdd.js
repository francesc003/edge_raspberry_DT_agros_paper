/**
 * Indice: GDD (Growing Degree Days)
 *
 * Misura l'accumulo termico utile alla crescita della pianta. Sopra la
 * temperatura base T_base (specifica per coltura), ogni °C contribuisce
 * alla maturazione. È usato sia come indicatore descrittivo (a che punto
 * della stagione siamo?) sia come driver fenologico (in v2, per calcolare
 * la fase corrente dal GDD invece che dal calendario).
 *
 * Formula:
 *   GDD_giorno = max(0, (Tmax + Tmin)/2 - T_base)
 *   GDD_cumulato = GDD_cumulato_ieri + GDD_giorno
 *
 * Il cumulo si azzera al 1° gennaio di ogni anno (convenzione standard
 * per colture temperate; per olivo si potrebbe usare convenzione diversa
 * ma per coerenza e semplicità manteniamo 1 gennaio).
 *
 * @module indices/gdd
 */

import { isFiniteNumber } from "./_utils.js";

export default {
  id: "GDD",
  nome: "Growing Degree Days cumulato",
  unita: "°C·day",

  requires: {
    sensors: ["air_temp"],
    weather: [],
    config: ["T_base_GDD"],
    history: ["GDD_cumulato_ieri"],
  },

  /**
   * Calcola GDD giornaliero e aggiornato il cumulato.
   *
   * @param {Object} input
   * @param {number} input.tMax - Temperatura massima giornaliera (°C)
   * @param {number} input.tMin - Temperatura minima giornaliera (°C)
   * @param {number} input.tBase - Temperatura base per la coltura (°C)
   * @param {number|null} input.gddCumulatoIeri - GDD cumulato del giorno precedente
   *        (null se è il primo giorno di calcolo o se è il 1° gennaio)
   * @param {Date} input.date - Data corrente (per gestire il reset di anno)
   * @param {Date|null} input.dateIeri - Data del valore cumulato precedente
   *        (per detectare il cambio di anno)
   * @returns {Object} risultato con value (cumulato), daily, unit, method
   */
  compute({ tMax, tMin, tBase, gddCumulatoIeri, date, dateIeri }) {
    if (!isFiniteNumber(tMax) || !isFiniteNumber(tMin)) {
      throw new Error("GDD: tMax e tMin devono essere numeri finiti");
    }
    if (!isFiniteNumber(tBase)) {
      throw new Error("GDD: tBase richiesta dalla configurazione coltura");
    }

    // GDD giornaliero: contributo termico di oggi
    const tMean = (tMax + tMin) / 2;
    const gddDaily = Math.max(0, tMean - tBase);

    // Gestione reset annuale: se l'anno è cambiato rispetto al cumulato
    // precedente, riparti da zero.
    let startCumulato = 0;
    if (
      isFiniteNumber(gddCumulatoIeri) &&
      dateIeri instanceof Date &&
      dateIeri.getFullYear() === date.getFullYear()
    ) {
      startCumulato = gddCumulatoIeri;
    }

    const gddCumulato = startCumulato + gddDaily;

    return {
      value: Math.round(gddCumulato * 10) / 10,
      daily: Math.round(gddDaily * 10) / 10,
      unit: "°C·day",
      method: "tmean_minus_tbase",
      confidence: "high",
      since: new Date(date.getFullYear(), 0, 1).toISOString().slice(0, 10),
      inputs_used: { tMax, tMin, tMean, tBase },
    };
  },
};
