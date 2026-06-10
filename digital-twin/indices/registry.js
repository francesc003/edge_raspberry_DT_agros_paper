/**
 * Registry dei moduli indice del Digital Twin.
 *
 * Punto di registrazione unico: ogni nuovo indice creato deve essere
 * importato e aggiunto a questo array. L'engine itera su questo array per
 * decidere cosa è calcolabile dato il profilo hardware del testbed.
 *
 * Nota: `thresholds.js` NON è nel registry perché non è un indice agronomico
 * vero e proprio, ma una funzione di servizio chiamata direttamente
 * dall'engine per risolvere le soglie simboliche delle alert_rules.
 *
 * @module indices/registry
 */

import ET0_HS from "./et0_hargreaves.js";
import GDD from "./gdd.js";
import SWD from "./swd.js";
import STRESS_TERMICO from "./thermal_stress.js";

/**
 * Lista di tutti gli indici registrati.
 * L'ordine in questo array non conta: l'engine fa topological sort
 * basandosi sulle dipendenze dichiarate in `requires.indices`.
 */
export const REGISTRY = [ET0_HS, GDD, SWD, STRESS_TERMICO];

/**
 * Restituisce un indice per ID.
 * @param {string} id
 * @returns {Object|null}
 */
export function getIndexById(id) {
  return REGISTRY.find((idx) => idx.id === id) || null;
}
