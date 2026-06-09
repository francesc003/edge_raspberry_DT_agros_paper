#!/usr/bin/env node
/**
 * Container Digital Twin — entry point event-driven.
 *
 * Architettura:
 *   - si connette al MongoDB locale (popolato dal container simulatore)
 *   - fa polling per rilevare nuovi burst di letture
 *   - a ogni nuovo burst: esegue la pipeline DT completa e valuta l'irrigazione
 *   - persiste snapshot/history su Mongo e scrive la decisione su stdout + file di log
 *
 * Variabili ambiente:
 *   MONGO_URL        default mongodb://mongo:27017
 *   MONGO_DB         default agros
 *   TESTBED_ID       default campo_raspberry_01
 *   POLL_INTERVAL_MS default 3000 (ogni quanto controllare nuovi burst)
 *   LOG_FILE         default /app/logs/irrigation.log
 *
 * @module index_mongo
 */

import { MongoClient } from "mongodb";
import { readFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { resolveProfile } from "./profile/resolver.js";
import { runEngine } from "./indices/engine.js";
import { runAlertEngine } from "./alerts/engine.js";
import { buildSnapshot } from "./snapshot/builder.js";
import { persistSnapshotMongo } from "./snapshot/store_mongo.js";
import { evaluateIrrigation } from "./irrigation/advisor.js";
import { fetchWeather } from "./fetcher/weather.js";
import {
  getLatestBurstTimestamp,
  fetchRawDataMongo,
  fetchLastHistoryRecord,
  aggregateDailyTemps,
} from "./fetcher/mongo.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MONGO_URL = process.env.MONGO_URL || "mongodb://mongo:27017";
const MONGO_DB = process.env.MONGO_DB || "agros";
const TESTBED_ID = process.env.TESTBED_ID || "campo_raspberry_01";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 3000);
const LOG_FILE = process.env.LOG_FILE || join(__dirname, "logs", "irrigation.log");

const CONFIG_ROOT = join(__dirname, "config");
const PROFILES_ROOT = join(__dirname, "profiles");

// Cache config (file statici)
const _configCache = new Map();
async function loadConfigCached(relativePath) {
  if (_configCache.has(relativePath)) return _configCache.get(relativePath);
  const parsed = JSON.parse(await readFile(join(CONFIG_ROOT, relativePath), "utf8"));
  _configCache.set(relativePath, parsed);
  return parsed;
}

async function loadProfiles(testbedId) {
  const client = JSON.parse(
    await readFile(join(PROFILES_ROOT, `client_profile_${testbedId}.json`), "utf8")
  );
  const hardware = JSON.parse(
    await readFile(join(PROFILES_ROOT, `hardware_profile_${testbedId}.json`), "utf8")
  );
  return { client, hardware };
}

async function logDecision(line) {
  console.log(line);
  try {
    const dir = dirname(LOG_FILE);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await appendFile(LOG_FILE, line + "\n", "utf8");
  } catch (err) {
    console.error(`[warn] impossibile scrivere il log file: ${err.message}`);
  }
}

/**
 * Esegue un ciclo completo del DT per un dato burst (referenceDate).
 */
async function runCycle({ db, profiles, referenceDate }) {
  const { client, hardware } = profiles;

  const cropConfig = await loadConfigCached(`crops/${client.coltura_ref}.json`);
  const soilConfig = await loadConfigCached(`soils/${client.suolo_ref}.json`);

  const profile = resolveProfile(client, hardware, cropConfig, soilConfig, referenceDate);

  const raw = await fetchRawDataMongo({ db, testbedId: TESTBED_ID, referenceDate });
  const lastHistory = await fetchLastHistoryRecord({ db, testbedId: TESTBED_ID, referenceDate });

  // Meteo da Open-Meteo (API gratuita). In caso di assenza di rete (4G giù),
  // fetchWeather degrada con grazia: ritorna meteo vuoto e online=false, e il
  // DT prosegue con i soli dati contestuali dei sensori.
  const lat = client.localizzazione?.lat;
  const lon = client.localizzazione?.lon;
  const weather = await fetchWeather({ lat, lon });

  // precipitazioni "oggi": dal meteo se online, altrimenti 0 (nessun dato)
  const precipOggi = weather.today?.precipitazioni ?? 0;

  const rawData = {
    date: referenceDate,
    sensorReadings: raw.sensorReadings,
    weather: { today: { precipitazioni: precipOggi } },
    lastHistoryRecord: lastHistory,
    tMaxHistory7d: aggregateDailyTemps(raw.sensorReadings7d?.air_temp),
    irrigazione_oggi: 0,
  };

  const engineResult = runEngine(profile, rawData);

  // Meteo a 7 giorni per alert e advisor (vuoto se offline)
  const meteo7gg = weather.meteo_7gg || [];

  const alertsResult = runAlertEngine({
    cropConfig,
    computed: engineResult.computed,
    thresholds: engineResult.thresholds,
    meteo7gg,
  });

  const snapshot = buildSnapshot({
    profile,
    sensorReadings: raw.sensorReadings,
    engineResult,
    alertsResult,
    meteo7gg,
  });
  snapshot.metadata.execution_mode = "edge-container";
  snapshot.metadata.weather_source = weather.source;
  snapshot.metadata.weather_online = weather.online;

  // --- Trigger irrigazione ---
  const irrigation = evaluateIrrigation({
    swd: engineResult.computed?.SWD,
    thresholds: engineResult.thresholds,
    meteo7gg,
    referenceDate,
  });

  await persistSnapshotMongo({ db, snapshot, irrigation });

  return { snapshot, irrigation, engineResult, weather };
}

async function main() {
  console.log("=".repeat(64));
  console.log("AGROS Digital Twin — Container (event-driven su MongoDB)");
  console.log("=".repeat(64));
  console.log(`Mongo:    ${MONGO_URL} / db ${MONGO_DB}`);
  console.log(`Testbed:  ${TESTBED_ID}`);
  console.log(`Polling:  ogni ${POLL_INTERVAL_MS}ms`);
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
  console.log("[startup] connesso a MongoDB");

  const db = client.db(MONGO_DB);
  const profiles = await loadProfiles(TESTBED_ID);
  console.log(`[startup] profili caricati: ${profiles.hardware.nodi.length} nodi`);
  console.log("[startup] in attesa di burst di dati...\n");

  let lastProcessed = null;

  // Shutdown pulito
  let running = true;
  const shutdown = async () => {
    running = false;
    console.log("\n[shutdown] chiusura connessione Mongo...");
    await client.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Loop di polling event-driven
  while (running) {
    try {
      const latest = await getLatestBurstTimestamp({ db, testbedId: TESTBED_ID });

      if (latest && (!lastProcessed || latest > lastProcessed)) {
        const t0 = Date.now();
        const { snapshot, irrigation, engineResult, weather } = await runCycle({
          db,
          profiles,
          referenceDate: latest,
        });
        const dt = Date.now() - t0;

        const swd = engineResult.computed?.SWD?.value;
        const ts = latest.toISOString().replace("T", " ").slice(0, 16);
        const meteoTag = weather.online ? `meteo:${weather.source}` : `OFFLINE(${weather.source})`;
        await logDecision(
          `[${ts}] SWD=${swd != null ? swd.toFixed(1) : "n/d"}mm ` +
          `-> ${irrigation.decisione} (irrigare=${irrigation.irrigare}) | ${meteoTag} | ${irrigation.motivo} [${dt}ms]`
        );

        lastProcessed = latest;
      }
    } catch (err) {
      console.error(`[loop] errore: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error("Errore fatale:", err);
  process.exit(1);
});
