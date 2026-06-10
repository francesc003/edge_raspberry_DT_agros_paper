#!/usr/bin/env node
/**
 * Container Simulatore Nodi — simula 10 nodi che trasmettono via LoRa.
 *
 * A intervalli regolari ("burst"), ogni nodo invia le sue letture sensori,
 * che vengono scritte nella collection `sensor_readings` di MongoDB.
 *
 * Modello temporale:
 *   - Tempo SIMULATO: ogni burst avanza l'orologio simulato di SIM_STEP_MIN
 *     minuti. Questo permette di "vivere" giorni simulati in pochi minuti
 *     reali, così SWD/GDD evolvono e il trigger di irrigazione reagisce.
 *   - Tempo REALE: tra un burst e l'altro passano BURST_INTERVAL_SEC secondi.
 *
 * Modello climatico: stagionale (come il generatore offline), con temperatura
 * crescente verso l'estate, ciclo giorno/notte, suolo che si asciuga
 * progressivamente. Deterministico via seed.
 *
 * Variabili ambiente:
 *   MONGO_URL          default mongodb://mongo:27017
 *   MONGO_DB           default agros
 *   TESTBED_ID         default campo_raspberry_01
 *   N_NODI             default 10
 *   BURST_INTERVAL_SEC default 10   (secondi reali tra burst)
 *   SIM_STEP_MIN       default 60   (minuti simulati per burst)
 *   SIM_START_DATE     default 2026-05-20
 *   DT_SEED            default 42
 *   RESET_ON_START     default true (svuota sensor_readings all'avvio)
 *
 * @module simulator
 */

import { MongoClient } from "mongodb";

const MONGO_URL = process.env.MONGO_URL || "mongodb://mongo:27017";
const MONGO_DB = process.env.MONGO_DB || "agros";
const TESTBED_ID = process.env.TESTBED_ID || "campo_raspberry_01";
const N_NODI = Number(process.env.N_NODI ?? 10);
const BURST_INTERVAL_SEC = Number(process.env.BURST_INTERVAL_SEC ?? 10);
const SIM_STEP_MIN = Number(process.env.SIM_STEP_MIN ?? 60);
const SIM_START_DATE = new Date((process.env.SIM_START_DATE || "2026-05-20") + "T00:00:00Z");
// Modalità tempo reale: se true, ogni burst usa l'ora corrente (new Date())
// invece dell'orologio simulato accelerato. Per misure di consumo realistiche.
const REAL_TIME = (process.env.REAL_TIME ?? "false") === "true";
const SEED = Number(process.env.DT_SEED ?? 42);
const RESET_ON_START = (process.env.RESET_ON_START ?? "true") === "true";

// PRNG deterministico
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(SEED);
function gauss(sigma) {
  return Math.sqrt(-2 * Math.log(rng())) * Math.cos(2 * Math.PI * rng()) * sigma;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = (v) => Math.round(v * 10) / 10;

function dayOfYear(date) {
  const start = new Date(date.getUTCFullYear(), 0, 0);
  return Math.floor((date - start) / 86400000);
}
function seasonalBaseMax(doy) {
  return 20 + 13 * Math.exp(-Math.pow((doy - 205) / 55, 2));
}
const isDaytime = (h) => h >= 6 && h <= 20;
function dayCurve(h) {
  if (!isDaytime(h)) return 0;
  return clamp(Math.cos(((h - 13) / 14) * Math.PI), 0, 1);
}

// Quali nodi hanno i sensori ambientali completi (i primi 3, come nel profilo)
function nodeHasFullSensors(i) {
  return i <= 3;
}

// Stato persistente del suolo tra i burst (si asciuga nel tempo)
let soilMoisture = 32;

/**
 * Genera i documenti di un burst per tutti i nodi a un dato istante simulato.
 */
function generateBurst(simTime) {
  const doy = dayOfYear(simTime);
  const hour = simTime.getUTCHours();
  const baseMax = seasonalBaseMax(doy);
  const baseMin = baseMax - 11;
  const mean = (baseMin + baseMax) / 2;
  const amp = (baseMax - baseMin) / 2;

  // Il suolo si asciuga solo a fine giornata (quando hour===0 nuovo giorno)
  // Per semplicità: applichiamo una piccola perdita ad ogni step proporzionale
  const perditaStep = (1.0 + (baseMax - 20) * 0.12) * (SIM_STEP_MIN / (24 * 60));
  soilMoisture = clamp(soilMoisture - perditaStep, 10, 40);

  const burstId = simTime.toISOString();
  const docs = [];

  for (let i = 1; i <= N_NODI; i++) {
    const nodeId = `${TESTBED_ID}_node_${String(i).padStart(2, "0")}`;
    const prefix = `N${String(i).padStart(2, "0")}`;

    const airTemp = mean - amp * Math.cos(((hour - 5) / 24) * 2 * Math.PI) + gauss(0.4);
    const soilTemp = mean - amp * 0.4 * Math.cos(((hour - 8) / 24) * 2 * Math.PI) + gauss(0.2);
    const airRh = clamp(65 + 20 * Math.cos(((hour - 5) / 24) * 2 * Math.PI) + gauss(2), 20, 100);

    const base = { testbed_id: TESTBED_ID, node_id: nodeId, timestamp: simTime, burst_id: burstId };

    docs.push({ ...base, sensor_id: `${prefix}_AT`, tipo: "air_temp", value: round1(airTemp), unit: "C" });
    docs.push({ ...base, sensor_id: `${prefix}_RH`, tipo: "air_rh", value: round1(airRh), unit: "%" });
    docs.push({ ...base, sensor_id: `${prefix}_ST`, tipo: "soil_temp", value: round1(soilTemp), unit: "C" });
    docs.push({ ...base, sensor_id: `${prefix}_SM`, tipo: "soil_moisture", value: round1(soilMoisture + gauss(0.3)), unit: "%" });
    docs.push({ ...base, sensor_id: `${prefix}_BAT`, tipo: "battery_voltage", value: round1(clamp(3.9 + gauss(0.05), 3.5, 4.2)), unit: "V" });

    if (nodeHasFullSensors(i)) {
      docs.push({ ...base, sensor_id: `${prefix}_EC`, tipo: "soil_ec", value: round1(clamp(1.3 + gauss(0.1), 0.5, 3.0)), unit: "dS/m" });
      docs.push({ ...base, sensor_id: `${prefix}_ALS`, tipo: "ambient_light", value: Math.round(isDaytime(hour) ? clamp(40000 * dayCurve(hour) + gauss(2000), 0, 90000) : 0), unit: "lux" });
      docs.push({ ...base, sensor_id: `${prefix}_UVI`, tipo: "uv_index", value: round1(isDaytime(hour) ? clamp(7 * dayCurve(hour) + gauss(0.3), 0, 11) : 0), unit: "index" });
      docs.push({ ...base, sensor_id: `${prefix}_UVA`, tipo: "uva_radiation", value: round1(isDaytime(hour) ? clamp(35 * dayCurve(hour) + gauss(2), 0, 60) : 0), unit: "W/m2" });
      docs.push({ ...base, sensor_id: `${prefix}_SOL`, tipo: "solar_panel_voltage", value: round1(isDaytime(hour) ? clamp(5.5 + gauss(0.3), 0, 6.5) : 0), unit: "V" });
    }
  }
  return docs;
}

async function main() {
  console.log("=".repeat(64));
  console.log("AGROS Node Simulator — 10 nodi LoRa (simulati) su MongoDB");
  console.log("=".repeat(64));
  console.log(`Mongo:        ${MONGO_URL} / db ${MONGO_DB}`);
  console.log(`Testbed:      ${TESTBED_ID}`);
  console.log(`Nodi:         ${N_NODI}`);
  console.log(`Burst:        ogni ${BURST_INTERVAL_SEC}s reali = ${SIM_STEP_MIN}min simulati`);
  console.log(`Start sim:    ${SIM_START_DATE.toISOString()}`);
  console.log("");

  const client = new MongoClient(MONGO_URL);
  let retries = 10;
  while (retries > 0) {
    try {
      await client.connect();
      await client.db(MONGO_DB).command({ ping: 1 });
      break;
    } catch (err) {
      retries--;
      console.log(`[startup] Mongo non pronto, riprovo (${retries})... ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (retries === 0) {
    console.error("Impossibile connettersi a MongoDB. Esco.");
    process.exit(1);
  }

  const db = client.db(MONGO_DB);
  const coll = db.collection("sensor_readings");

  if (RESET_ON_START) {
    await coll.deleteMany({ testbed_id: TESTBED_ID });
    await db.collection("dt_history").deleteMany({ testbed_id: TESTBED_ID });
    await db.collection("dt_snapshots").deleteMany({ testbed_id: TESTBED_ID });
    await db.collection("irrigation_log").deleteMany({ testbed_id: TESTBED_ID });
    console.log("[startup] collezioni azzerate (RESET_ON_START=true)");
  }
  // Indice per query veloci
  await coll.createIndex({ testbed_id: 1, timestamp: -1 });

  console.log("[startup] connesso. Inizio a trasmettere burst...\n");

  let simTime = new Date(SIM_START_DATE);
  let burstCount = 0;

  let running = true;
  const shutdown = async () => {
    running = false;
    console.log("\n[shutdown] chiusura simulatore...");
    await client.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    // In modalità tempo reale il timestamp è l'ora corrente; altrimenti
    // si usa l'orologio simulato accelerato.
    const burstTime = REAL_TIME ? new Date() : simTime;

    const docs = generateBurst(burstTime);
    await coll.insertMany(docs);
    burstCount++;
    console.log(
      `[burst ${burstCount}] ${burstTime.toISOString().replace("T", " ").slice(0, 16)} ` +
      `${REAL_TIME ? "(tempo reale)" : "simulato"}: ${docs.length} letture da ${N_NODI} nodi (soil~${soilMoisture.toFixed(1)}%)`
    );

    // In modalità simulata avanza l'orologio; in tempo reale non serve
    if (!REAL_TIME) {
      simTime = new Date(simTime.getTime() + SIM_STEP_MIN * 60 * 1000);
    }

    await new Promise((r) => setTimeout(r, BURST_INTERVAL_SEC * 1000));
  }
}

main().catch((err) => {
  console.error("Errore fatale simulatore:", err);
  process.exit(1);
});
