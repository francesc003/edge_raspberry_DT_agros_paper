/**
 * Alert Engine: applica le `alert_rules` del crop config sui valori degli
 * indici calcolati e produce una lista di alert deterministici.
 *
 * Le regole vivono nei file crops/*.json (campo `alert_rules`). Sono
 * dichiarative: ogni regola ha {id, indice, operatore, soglia, livello,
 * messaggio}. Il motore le valuta una a una.
 *
 * La soglia può essere:
 *   - un numero letterale (es. 2.0 per il rischio gelata)
 *   - una stringa simbolica (es. "SWD_warning") risolta da `thresholds`
 *     calcolato dall'engine indici
 *
 * Il messaggio può contenere il placeholder `{valore}` che viene sostituito
 * con il valore effettivo dell'indice al momento dell'alert.
 *
 * NON fa I/O: riceve crop_config + indici + meteo previsti, ritorna alert.
 *
 * @module alerts/engine
 */

import { isFiniteNumber, max as maxOf, min as minOf } from "../indices/_utils.js";

/**
 * Risolve il valore di una soglia: se è un numero ritornalo, se è una
 * stringa simbolica, cercala nel dizionario thresholds.
 */
function resolveThreshold(soglia, thresholds) {
  if (isFiniteNumber(soglia)) return soglia;
  if (typeof soglia === "string" && thresholds && isFiniteNumber(thresholds[soglia])) {
    return thresholds[soglia];
  }
  return null;
}

/**
 * Estrae il valore numerico dell'indice di una regola.
 * Gestisce sia gli indici "standard" del computed map (es. "SWD" → computed.SWD.value)
 * sia gli indici "meteorologici previsti" (es. "T_min_previsto_7gg") che
 * vengono ricavati dal meteo_7gg.
 */
function resolveIndexValue(nomeIndice, computed, meteo7gg) {
  // Caso 1: indice presente nel computed map dell'engine
  if (computed[nomeIndice]?.value !== undefined) {
    return computed[nomeIndice].value;
  }

  // Caso 2: indici "meteo previsti" derivati al volo dalle previsioni 7gg
  if (Array.isArray(meteo7gg) && meteo7gg.length > 0) {
    if (nomeIndice === "T_min_previsto_7gg") {
      return minOf(meteo7gg.map((d) => d.t_min));
    }
    if (nomeIndice === "T_max_previsto_7gg") {
      return maxOf(meteo7gg.map((d) => d.t_max));
    }
    if (nomeIndice === "precipitazioni_previste_7gg") {
      const sum = meteo7gg
        .map((d) => d.precip_mm ?? d.precipitazioni ?? 0)
        .filter(isFiniteNumber)
        .reduce((a, b) => a + b, 0);
      return sum;
    }
  }

  return null;
}

/**
 * Confronta valore e soglia secondo l'operatore della regola.
 */
function applyOperator(valore, operatore, soglia) {
  switch (operatore) {
    case ">":  return valore >  soglia;
    case ">=": return valore >= soglia;
    case "<":  return valore <  soglia;
    case "<=": return valore <= soglia;
    case "==": return valore === soglia;
    default:
      throw new Error(`Operatore non supportato: ${operatore}`);
  }
}

/**
 * Sostituisce i placeholder nel messaggio (al momento solo {valore}).
 */
function formatMessage(template, valore) {
  if (!template) return "";
  const valStr = isFiniteNumber(valore)
    ? (Math.round(valore * 10) / 10).toString()
    : String(valore);
  return template.replace(/\{valore\}/g, valStr);
}

/**
 * Esegue tutte le regole di alert del crop config.
 *
 * @param {Object} input
 * @param {Object} input.cropConfig - oggetto crop config completo (vite/olivo)
 * @param {Object} input.computed - mappa indici da runEngine
 * @param {Object|null} input.thresholds - {SWD_warning, SWD_critical, TAW}
 * @param {Array} input.meteo7gg - previsioni meteo 7 giorni
 * @returns {Object} {alerts: [...], skipped: [...]}
 */
export function runAlertEngine({ cropConfig, computed, thresholds, meteo7gg }) {
  const rules = cropConfig?.alert_rules || [];
  const alerts = [];
  const skipped = [];

  for (const rule of rules) {
    // Pulisci eventuali commenti _comment
    const id = rule.id;
    const indiceName = rule.indice;
    const operatore = rule.operatore;
    const sogliaRaw = rule.soglia;
    const livello = rule.livello;
    const messaggio = rule.messaggio;

    // Risolvi soglia
    const soglia = resolveThreshold(sogliaRaw, thresholds);
    if (!isFiniteNumber(soglia)) {
      skipped.push({
        id,
        motivo: `soglia non risolvibile (${sogliaRaw})`,
      });
      continue;
    }

    // Risolvi valore dell'indice
    const valore = resolveIndexValue(indiceName, computed, meteo7gg);
    if (!isFiniteNumber(valore)) {
      skipped.push({
        id,
        motivo: `indice ${indiceName} non disponibile`,
      });
      continue;
    }

    // Applica operatore
    let triggered;
    try {
      triggered = applyOperator(valore, operatore, soglia);
    } catch (err) {
      skipped.push({ id, motivo: err.message });
      continue;
    }

    if (triggered) {
      alerts.push({
        id,
        livello,
        indice: indiceName,
        valore: Math.round(valore * 10) / 10,
        soglia,
        messaggio: formatMessage(messaggio, valore),
        triggered_at: new Date().toISOString(),
      });
    }
  }

  // Ordina per severità: critical → warning → info
  const severityRank = { critical: 0, warning: 1, info: 2 };
  alerts.sort(
    (a, b) => (severityRank[a.livello] ?? 99) - (severityRank[b.livello] ?? 99)
  );

  return { alerts, skipped };
}
