/**
 * Indice: ET0 (Evapotraspirazione di riferimento) con metodo Hargreaves-Samani.
 *
 * Calcola la quantità di acqua che evaporerebbe da una superficie di riferimento
 * (prato bagnato) in condizioni standard. È la base per stimare il consumo idrico
 * di una coltura specifica: ETc = Kc * ET0.
 *
 * Hargreaves-Samani è la formula semplificata raccomandata da FAO quando non si
 * dispone di tutti i dati per Penman-Monteith (vento, radiazione netta, umidità).
 * Richiede solo temperature massima e minima dell'aria + latitudine + data.
 *
 * Formula (FAO-56, Eq. 52):
 *   ET0 = 0.0023 * Ra * (Tmean + 17.8) * sqrt(Tmax - Tmin)
 *
 * Dove:
 *   - Ra: radiazione extraterrestre (MJ m^-2 day^-1), calcolata da lat e DOY
 *   - Tmean = (Tmax + Tmin) / 2 (°C)
 *   - Tmax, Tmin: temperature giornaliere (°C)
 *
 * @module indices/et0_hargreaves
 */

import { extraterrestrialRadiation, dayOfYear, isFiniteNumber } from "./_utils.js";

export default {
  id: "ET0_HS",
  nome: "Evapotraspirazione di riferimento (Hargreaves-Samani)",
  unita: "mm/day",

  /**
   * Dichiarazione delle capability richieste.
   * L'engine userà questo oggetto per decidere se questo indice è calcolabile
   * dato l'hardware_profile del testbed e i dati disponibili.
   */
  requires: {
    sensors: ["air_temp"],
    weather: [],
    config: ["latitudine"],
    history: [],
  },

  /**
   * Gestione delle alternative: questo indice è una "versione" del concetto
   * generico ET0. Se è disponibile una versione a priorità più alta (es. ET0_PM),
   * l'engine sceglierà quella.
   */
  alternative_di: "ET0",
  priority: 2,

  /**
   * Calcola ET0 con Hargreaves-Samani.
   *
   * @param {Object} input
   * @param {number} input.tMax - Temperatura massima giornaliera (°C)
   * @param {number} input.tMin - Temperatura minima giornaliera (°C)
   * @param {number} input.latitude - Latitudine del campo (gradi decimali)
   * @param {Date} input.date - Data per cui calcolare (per il DOY)
   * @returns {Object} risultato con value, unit, method, confidence
   */
  compute({ tMax, tMin, latitude, date }) {
    // Verifica input
    if (!isFiniteNumber(tMax) || !isFiniteNumber(tMin)) {
      throw new Error("ET0_HS: tMax e tMin devono essere numeri finiti");
    }
    if (tMax < tMin) {
      throw new Error(`ET0_HS: tMax (${tMax}) non può essere minore di tMin (${tMin})`);
    }
    if (!isFiniteNumber(latitude)) {
      throw new Error("ET0_HS: latitude richiesta");
    }
    if (!(date instanceof Date) || isNaN(date.getTime())) {
      throw new Error("ET0_HS: date deve essere un oggetto Date valido");
    }

    const tMean = (tMax + tMin) / 2;
    const doy = dayOfYear(date);
    const raMj = extraterrestrialRadiation(latitude, doy); // MJ m^-2 day^-1

    // Hargreaves-Samani richiede Ra in mm/day di evapotraspirazione equivalente.
    // Conversione: 1 MJ/m²/day = 0.408 mm/day (fattore di conversione FAO-56,
    // pari al reciproco del calore latente di evaporazione dell'acqua ~2.45 MJ/kg).
    const ra = raMj * 0.408;

    // Formula Hargreaves-Samani (FAO-56 Eq. 52):
    //   ET0 [mm/day] = 0.0023 * Ra[mm/day] * (Tmean + 17.8) * sqrt(Tmax - Tmin)
    const et0 = 0.0023 * ra * (tMean + 17.8) * Math.sqrt(tMax - tMin);

    return {
      value: Math.round(et0 * 100) / 100, // arrotonda a 2 decimali
      unit: "mm/day",
      method: "hargreaves_samani",
      confidence: "medium",
      inputs_used: {
        tMax,
        tMin,
        tMean,
        latitude,
        doy,
        ra_MJ_per_m2_day: Math.round(raMj * 100) / 100,
        ra_mm_per_day: Math.round(ra * 100) / 100,
      },
    };
  },
};
