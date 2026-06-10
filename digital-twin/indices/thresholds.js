/**
 * Calcolo delle soglie SWD dinamiche.
 *
 * Non è un indice agronomico in senso stretto, ma una funzione di servizio
 * usata dal motore degli alert per "risolvere" le soglie simboliche
 * (es. "SWD_warning") che appaiono nelle alert_rules dei crop config.
 *
 * Logica:
 *   TAW = (FC - WP) * profondità_radicale  [in mm, con profondità in m]
 *   SWD_warning = p * TAW       (soglia di allerta, frazione p di TAW depleted)
 *   SWD_critical = TAW          (oltre, stress severo)
 *
 * Il fattore p arriva dal crop config (stress_idrico.p_depletion).
 * Vite ~0.45, olivo ~0.65 (FAO-56 Tab.22).
 *
 * @module indices/thresholds
 */

import { isFiniteNumber } from "./_utils.js";

/**
 * Calcola le soglie SWD per un testbed.
 *
 * @param {Object} input
 * @param {number} input.fc - Field Capacity in mm/m (da soil config)
 * @param {number} input.wp - Wilting Point in mm/m (da soil config)
 * @param {number} input.profonditaRadicaleCm - Profondità radicale in cm (da crop config + override)
 * @param {number} input.pDepletion - Fattore p (da crop config stress_idrico.p_depletion)
 * @returns {Object} {TAW, SWD_warning, SWD_critical} tutti in mm
 */
export function computeSwdThresholds({ fc, wp, profonditaRadicaleCm, pDepletion }) {
  if (!isFiniteNumber(fc) || !isFiniteNumber(wp) || fc <= wp) {
    throw new Error("thresholds: FC e WP invalidi (FC deve essere > WP)");
  }
  if (!isFiniteNumber(profonditaRadicaleCm) || profonditaRadicaleCm <= 0) {
    throw new Error("thresholds: profondita_radicale_cm deve essere > 0");
  }
  if (!isFiniteNumber(pDepletion) || pDepletion <= 0 || pDepletion >= 1) {
    throw new Error("thresholds: pDepletion deve essere in (0, 1)");
  }

  const profonditaM = profonditaRadicaleCm / 100;
  const taw = (fc - wp) * profonditaM;
  const swdWarning = pDepletion * taw;
  const swdCritical = taw;

  return {
    TAW: Math.round(taw * 10) / 10,
    SWD_warning: Math.round(swdWarning * 10) / 10,
    SWD_critical: Math.round(swdCritical * 10) / 10,
    unit: "mm",
  };
}
