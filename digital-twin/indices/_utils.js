/**
 * Funzioni di utilità matematica e helper condivise tra i moduli indice.
 *
 * Tutte le funzioni qui sono pure: input → output, senza I/O ed effetti collaterali.
 * Questo le rende facilmente testabili in isolamento.
 *
 * @module indices/_utils
 */

// ============================================================================
// COSTANTI ASTRONOMICHE E AGRONOMICHE
// ============================================================================

/** Costante solare (MJ m^-2 min^-1), usata nel calcolo della radiazione extraterrestre. */
export const SOLAR_CONSTANT = 0.0820;

// ============================================================================
// CALCOLI ASTRONOMICI (per ET0 Hargreaves-Samani)
// ============================================================================

/**
 * Converte una data nel giorno dell'anno (DOY, day of year).
 * 1 gennaio = 1, 31 dicembre = 365 (o 366 per anni bisestili).
 *
 * @param {Date} date - Data di interesse
 * @returns {number} DOY come intero
 */
export function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date - start;
  const oneDay = 1000 * 60 * 60 * 24;
  return Math.floor(diff / oneDay);
}

/**
 * Converte gradi in radianti.
 *
 * @param {number} degrees
 * @returns {number} valore in radianti
 */
export function deg2rad(degrees) {
  return (degrees * Math.PI) / 180;
}

/**
 * Calcola la radiazione extraterrestre Ra (MJ m^-2 day^-1) per una latitudine
 * e un giorno dell'anno specifici.
 *
 * È la radiazione solare che arriverebbe al suolo in assenza di atmosfera.
 * Funzione astronomica deterministica: non richiede sensori, solo lat e data.
 *
 * Formula da FAO-56 (Allen et al. 1998), Eq. 21.
 *
 * @param {number} latitudeDeg - Latitudine in gradi decimali (positiva = N, negativa = S)
 * @param {number} doy - Giorno dell'anno (1-366)
 * @returns {number} Ra in MJ m^-2 day^-1
 */
export function extraterrestrialRadiation(latitudeDeg, doy) {
  const phi = deg2rad(latitudeDeg);

  // Distanza relativa inversa Terra-Sole (Eq. 23 FAO-56)
  const dr = 1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365);

  // Declinazione solare in radianti (Eq. 24 FAO-56)
  const delta = 0.409 * Math.sin((2 * Math.PI * doy) / 365 - 1.39);

  // Angolo orario al tramonto (Eq. 25 FAO-56)
  const ws = Math.acos(-Math.tan(phi) * Math.tan(delta));

  // Radiazione extraterrestre (Eq. 21 FAO-56), risultato in MJ m^-2 day^-1
  const ra =
    ((24 * 60) / Math.PI) *
    SOLAR_CONSTANT *
    dr *
    (ws * Math.sin(phi) * Math.sin(delta) +
      Math.cos(phi) * Math.cos(delta) * Math.sin(ws));

  return ra;
}

// ============================================================================
// AGGREGATORI STATISTICI (per le letture sensori)
// ============================================================================

/**
 * Calcola la media aritmetica di un array di numeri.
 * Ignora valori non finiti (null, undefined, NaN, Infinity).
 *
 * @param {number[]} values
 * @returns {number|null} media, o null se l'array non contiene valori validi
 */
export function mean(values) {
  const valid = values.filter((v) => Number.isFinite(v));
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

/**
 * Massimo di un array di numeri, ignorando valori non finiti.
 *
 * @param {number[]} values
 * @returns {number|null}
 */
export function max(values) {
  const valid = values.filter((v) => Number.isFinite(v));
  if (valid.length === 0) return null;
  return Math.max(...valid);
}

/**
 * Minimo di un array di numeri, ignorando valori non finiti.
 *
 * @param {number[]} values
 * @returns {number|null}
 */
export function min(values) {
  const valid = values.filter((v) => Number.isFinite(v));
  if (valid.length === 0) return null;
  return Math.min(...valid);
}

// ============================================================================
// HELPER PER VERIFICA INPUT
// ============================================================================

/**
 * Verifica che un valore sia un numero finito (non null, undefined, NaN, Infinity).
 *
 * @param {*} v
 * @returns {boolean}
 */
export function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Clamp di un valore in un range [min, max].
 *
 * @param {number} value
 * @param {number} minVal
 * @param {number} maxVal
 * @returns {number}
 */
export function clamp(value, minVal, maxVal) {
  return Math.max(minVal, Math.min(maxVal, value));
}
