/**
 * Test end-to-end dello stack (senza Docker, con Mongo in-memory).
 * Verifica: simulatore -> Mongo -> DT -> decisione irrigazione.
 *
 * Simula manualmente la sequenza che nei container avviene via polling:
 *  1. genera alcuni burst a ore simulate diverse
 *  2. per ognuno esegue un ciclo del DT
 *  3. stampa la decisione di irrigazione
 */

import { makeMockDb } from "./mock_mongo.mjs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveProfile } from "./profile/resolver.js";
import { runEngine } from "./indices/engine.js";
import { runAlertEngine } from "./alerts/engine.js";
import { buildSnapshot } from "./snapshot/builder.js";
import { persistSnapshotMongo } from "./snapshot/store_mongo.js";
import { evaluateIrrigation } from "./irrigation/advisor.js";
import {
  fetchRawDataMongo,
  fetchLastHistoryRecord,
  aggregateDailyTemps,
} from "./fetcher/mongo.js";

const TESTBED = "campo_raspberry_01";
const ROOT = process.cwd();

// PRNG + helper (replica minimale del simulatore per il test)
function makeRng(seed){let s=seed>>>0;return()=>{s=(s+0x6d2b79f5)>>>0;let t=s;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}
const rng = makeRng(42);
const gauss = (sig) => Math.sqrt(-2*Math.log(rng()))*Math.cos(2*Math.PI*rng())*sig;
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const r1=(v)=>Math.round(v*10)/10;
const isDay=(h)=>h>=6&&h<=20;
const dayCurve=(h)=>isDay(h)?clamp(Math.cos(((h-13)/14)*Math.PI),0,1):0;

let soil = 32;
function burstDocs(simTime) {
  const doy = Math.floor((simTime - new Date(simTime.getUTCFullYear(),0,0))/86400000);
  const h = simTime.getUTCHours();
  const baseMax = 20 + 13*Math.exp(-Math.pow((doy-205)/55,2));
  const baseMin = baseMax-11, mean=(baseMin+baseMax)/2, amp=(baseMax-baseMin)/2;
  soil = clamp(soil - (1.0+(baseMax-20)*0.12)*(60/(24*60)), 10, 40);
  const docs=[];
  for(let i=1;i<=10;i++){
    const node=`${TESTBED}_node_${String(i).padStart(2,"0")}`, p=`N${String(i).padStart(2,"0")}`;
    const base={testbed_id:TESTBED,node_id:node,timestamp:simTime,burst_id:simTime.toISOString()};
    docs.push({...base,sensor_id:`${p}_AT`,tipo:"air_temp",value:r1(mean-amp*Math.cos(((h-5)/24)*2*Math.PI)+gauss(0.4)),unit:"C"});
    docs.push({...base,sensor_id:`${p}_RH`,tipo:"air_rh",value:r1(clamp(65+20*Math.cos(((h-5)/24)*2*Math.PI),20,100)),unit:"%"});
    docs.push({...base,sensor_id:`${p}_ST`,tipo:"soil_temp",value:r1(mean-amp*0.4*Math.cos(((h-8)/24)*2*Math.PI)+gauss(0.2)),unit:"C"});
    docs.push({...base,sensor_id:`${p}_SM`,tipo:"soil_moisture",value:r1(soil+gauss(0.3)),unit:"%"});
    docs.push({...base,sensor_id:`${p}_BAT`,tipo:"battery_voltage",value:r1(clamp(3.9+gauss(0.05),3.5,4.2)),unit:"V"});
    if(i<=3){
      docs.push({...base,sensor_id:`${p}_EC`,tipo:"soil_ec",value:r1(clamp(1.3+gauss(0.1),0.5,3)),unit:"dS/m"});
      docs.push({...base,sensor_id:`${p}_ALS`,tipo:"ambient_light",value:Math.round(isDay(h)?clamp(40000*dayCurve(h),0,90000):0),unit:"lux"});
      docs.push({...base,sensor_id:`${p}_UVI`,tipo:"uv_index",value:r1(isDay(h)?clamp(7*dayCurve(h),0,11):0),unit:"index"});
      docs.push({...base,sensor_id:`${p}_UVA`,tipo:"uva_radiation",value:r1(isDay(h)?clamp(35*dayCurve(h),0,60):0),unit:"W/m2"});
      docs.push({...base,sensor_id:`${p}_SOL`,tipo:"solar_panel_voltage",value:r1(isDay(h)?clamp(5.5,0,6.5):0),unit:"V"});
    }
  }
  return docs;
}

const _cfg = new Map();
async function loadCfg(rel){ if(_cfg.has(rel))return _cfg.get(rel); const p=JSON.parse(await readFile(join(ROOT,"config",rel),"utf8")); _cfg.set(rel,p); return p; }

async function runCycle(db, profiles, referenceDate) {
  const crop = await loadCfg(`crops/${profiles.client.coltura_ref}.json`);
  const soilC = await loadCfg(`soils/${profiles.client.suolo_ref}.json`);
  const profile = resolveProfile(profiles.client, profiles.hardware, crop, soilC, referenceDate);
  const raw = await fetchRawDataMongo({ db, testbedId: TESTBED, referenceDate });
  const lastH = await fetchLastHistoryRecord({ db, testbedId: TESTBED, referenceDate });
  const rawData = {
    date: referenceDate,
    sensorReadings: raw.sensorReadings,
    weather: { today: { precipitazioni: 0 } },
    lastHistoryRecord: lastH,
    tMaxHistory7d: aggregateDailyTemps(raw.sensorReadings7d?.air_temp),
    irrigazione_oggi: 0,
  };
  const engine = runEngine(profile, rawData);
  const alerts = runAlertEngine({ cropConfig: crop, computed: engine.computed, thresholds: engine.thresholds, meteo7gg: [] });
  const snap = buildSnapshot({ profile, sensorReadings: raw.sensorReadings, engineResult: engine, alertsResult: alerts, meteo7gg: [] });
  const irr = evaluateIrrigation({ swd: engine.computed?.SWD, thresholds: engine.thresholds, meteo7gg: [], referenceDate });
  await persistSnapshotMongo({ db, snapshot: snap, irrigation: irr });
  return { engine, irr };
}

async function main() {
  console.log("Avvio Mongo mock in-memory per il test...");
  const db = makeMockDb();
  console.log("Mongo mock pronto.\n");

  const profiles = {
    client: JSON.parse(await readFile(join(ROOT, "profiles", `client_profile_${TESTBED}.json`), "utf8")),
    hardware: JSON.parse(await readFile(join(ROOT, "profiles", `hardware_profile_${TESTBED}.json`), "utf8")),
  };
  console.log(`Profili: ${profiles.hardware.nodi.length} nodi\n`);

  const coll = db.collection("sensor_readings");
  await coll.createIndex({ testbed_id: 1, timestamp: -1 });

  // Simuliamo una progressione di burst su ~6 giorni simulati, ogni 6 ore,
  // per far evolvere SWD e attraversare diverse fasce orarie.
  let simTime = new Date("2026-05-20T00:00:00Z");
  console.log("Burst | data/ora sim     | SWD     | decisione irrigazione");
  console.log("-".repeat(90));
  let n = 0;
  for (let step = 0; step < 60; step++) {
    const docs = burstDocs(simTime);
    await coll.insertMany(docs);
    n++;
    const { engine, irr } = await runCycle(db, profiles, simTime);
    const swd = engine.computed?.SWD?.value;
    const ora = simTime.toISOString().replace("T"," ").slice(0,16);
    console.log(
      `${String(n).padStart(5)} | ${ora} | ${(swd!=null?swd.toFixed(1):"n/d").padStart(6)} | ${irr.decisione} (irrigare=${irr.irrigare})`
    );
    // Avanza di 6 ore simulate
    simTime = new Date(simTime.getTime() + 6 * 3600 * 1000);
  }

  console.log("\nVerifica collezioni Mongo:");
  for (const c of ["sensor_readings", "dt_snapshots", "dt_history", "irrigation_log"]) {
    const cnt = await db.collection(c).countDocuments();
    console.log(`  ${c}: ${cnt} documenti`);
  }

  console.log("\nTest completato.");
}

main().catch((e) => { console.error("ERRORE TEST:", e); process.exit(1); });
