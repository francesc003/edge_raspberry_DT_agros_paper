/**
 * Indice: SWD (Soil Water Deficit)
 *
 * Bilancio idrico del suolo, l'indice più direttamente interpretabile per
 * l'agricoltore. Misura quanti millimetri di acqua mancano al suolo rispetto
 * alla capacità di campo. SWD=0 significa suolo a capacità di campo (massima
 * acqua disponibile), SWD=TAW significa pianta in stress severo.
 *
 * Formula ricorsiva (FAO-56, semplificata):
 *   SWD(oggi) = SWD(ieri) + ET0 * Kc - precipitazioni - irrigazione
 *
 * Con clamp a [0, TAW]:
 *   - non scende sotto 0 (l'acqua in eccesso drena via, non si accumula
 *     come "credito idrico")
 *   - non sale sopra TAW (oltre, la pianta non può prelevare comunque,
 *     entriamo in stress severo)
 *
 * Ricalibratura opzionale con sensore umidità suolo:
 *   Se è disponibile una lettura affidabile del sensore di umidità suolo,
 *   il modulo "ancora" il calcolo al valore osservato tramite media pesata.
 *   Questo evita la deriva del bilancio puramente teorico nel tempo, che
 *   accumula errori di stima di precipitazioni, ET0 e parametri suolo.
 *
 * @module indices/swd
 */

import { isFiniteNumber, clamp } from "./_utils.js";

/**
 * Peso della ricalibratura sensore vs formula teorica.
 * 0.3 = il sensore conta per il 30%, la formula per il 70%.
 * Compromesso: il sensore è più "vero" ma puntuale (un solo punto del campo),
 * la formula è più rappresentativa dell'intero campo.
 */
const SENSOR_RECALIBRATION_WEIGHT = 0.3;

export default {
  id: "SWD",
  nome: "Soil Water Deficit",
  unita: "mm",

  requires: {
    sensors: [], // nessun sensore obbligatorio: SWD si basa su bilancio idrico teorico
    weather: ["precipitazioni"],
    config: ["Kc_corrente", "FC", "WP", "profondita_radicale_cm"],
    history: ["SWD_ieri"],
    indices: ["ET0"], // dipende da ET0, l'engine garantisce ordine corretto
  },

  /**
   * Sensori che, se presenti, migliorano la qualità del calcolo
   * (ricalibratura via media pesata). Informativo, non bloccante.
   */
  optional_sensors: ["soil_moisture"],

  /**
   * Calcola SWD aggiornato.
   *
   * @param {Object} input
   * @param {number} input.swdIeri - SWD del giorno precedente in mm (null = primo giorno)
   * @param {number} input.et0 - ET0 di oggi in mm/day (dal modulo ET0)
   * @param {number} input.kc - Coefficiente colturale corrente (dalla fase fenologica)
   * @param {number} input.precipitazioni - Pioggia di oggi in mm
   * @param {number} input.irrigazione - Irrigazione di oggi in mm (0 se assente)
   * @param {number} input.fc - Field Capacity del suolo in mm/m
   * @param {number} input.wp - Wilting Point del suolo in mm/m
   * @param {number} input.profonditaRadicaleCm - Profondità radicale effettiva in cm
   * @param {number|null} input.soilMoisturePct - Lettura sensore umidità suolo in % volumetrica
   *        (opzionale, abilita la ricalibratura)
   * @returns {Object} risultato con value, status, trend, unit, method
   */
  compute({
    swdIeri,
    et0,
    kc,
    precipitazioni,
    irrigazione = 0,
    fc,
    wp,
    profonditaRadicaleCm,
    soilMoisturePct = null,
  }) {
    // Validazione input critici
    if (!isFiniteNumber(et0) || et0 < 0) {
      throw new Error("SWD: et0 deve essere un numero finito >= 0");
    }
    if (!isFiniteNumber(kc) || kc <= 0) {
      throw new Error("SWD: kc deve essere > 0 (coefficiente colturale)");
    }
    if (!isFiniteNumber(fc) || !isFiniteNumber(wp) || fc <= wp) {
      throw new Error("SWD: parametri suolo invalidi (FC deve essere > WP)");
    }
    if (!isFiniteNumber(profonditaRadicaleCm) || profonditaRadicaleCm <= 0) {
      throw new Error("SWD: profondita_radicale_cm deve essere > 0");
    }

    // Calcolo TAW (Total Available Water) in mm:
    // (FC - WP) in mm/m * profondità in m
    const profonditaM = profonditaRadicaleCm / 100;
    const taw = (fc - wp) * profonditaM;

    // Inizializzazione: se non c'è SWD di ieri, assumiamo suolo a capacità
    // di campo (SWD=0). Approssimazione conservativa; in v2 potremmo
    // inizializzare dal sensore umidità suolo.
    const swdStart = isFiniteNumber(swdIeri) ? swdIeri : 0;

    // Consumo idrico della coltura ETc = Kc * ET0
    const etc = kc * et0;

    const precip = isFiniteNumber(precipitazioni) ? precipitazioni : 0;
    const irr = isFiniteNumber(irrigazione) ? irrigazione : 0;

    // Bilancio idrico
    let swdTheoretical = swdStart + etc - precip - irr;
    swdTheoretical = clamp(swdTheoretical, 0, taw);

    // Ricalibratura opzionale con sensore umidità suolo
    let swdFinal = swdTheoretical;
    let recalibrated = false;
    if (isFiniteNumber(soilMoisturePct)) {
      // Converti % volumetrica in mm/m (1% vol = 10 mm/m)
      const soilMoistureMmPerM = soilMoisturePct * 10;
      // SWD osservato = (FC - umidità_osservata) * profondità
      const swdObserved = clamp(
        (fc - soilMoistureMmPerM) * profonditaM,
        0,
        taw
      );
      // Media pesata: ancora il valore teorico verso l'osservazione
      swdFinal =
        swdTheoretical * (1 - SENSOR_RECALIBRATION_WEIGHT) +
        swdObserved * SENSOR_RECALIBRATION_WEIGHT;
      recalibrated = true;
    }

    // Status semantico (utile per ChatBot e dashboard)
    // Soglie indicative; quelle vere arrivano dal motore alert
    let status;
    const ratio = swdFinal / taw;
    if (ratio < 0.5) status = "ok";
    else if (ratio < 0.8) status = "warning";
    else status = "critical";

    // Trend rispetto a ieri (solo se abbiamo il valore precedente)
    let trend = null;
    if (isFiniteNumber(swdIeri)) {
      trend = Math.round((swdFinal - swdIeri) * 10) / 10;
    }

    return {
      value: Math.round(swdFinal * 10) / 10,
      unit: "mm",
      taw: Math.round(taw * 10) / 10,
      status,
      trend_1d: trend,
      method: recalibrated
        ? "water_balance_with_sensor_recalibration"
        : "water_balance_pure",
      confidence: recalibrated ? "high" : "medium",
      inputs_used: {
        swdStart,
        etc: Math.round(etc * 100) / 100,
        precip,
        irrigazione: irr,
        soilMoisturePct,
      },
    };
  },
};
