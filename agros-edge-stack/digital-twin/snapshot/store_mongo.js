/**
 * Store MongoDB per il container Digital Twin.
 *
 * Persiste tre artefatti:
 *   - dt_snapshots:   stato corrente (uno per testbed, sovrascritto)
 *   - dt_history:     serie storica indici (uno per testbed/giorno, upsert)
 *   - irrigation_log: log delle decisioni di irrigazione (append)
 *
 * @module snapshot/store_mongo
 */

import { COLLECTIONS } from "../fetcher/mongo.js";
import { extractHistoryRecord } from "./builder.js";

/**
 * Persiste snapshot, record history e (opzionale) decisione irrigazione.
 *
 * @param {Object} args
 * @param {import('mongodb').Db} args.db
 * @param {Object} args.snapshot          - output di buildSnapshot
 * @param {Object} [args.irrigation]      - output di evaluateIrrigation
 * @returns {Promise<void>}
 */
export async function persistSnapshotMongo({ db, snapshot, irrigation }) {
  if (!snapshot?.testbed_id) throw new Error("store_mongo: snapshot senza testbed_id");

  // 1. Snapshot corrente (una entry per testbed, sovrascritta)
  await db.collection(COLLECTIONS.DT_SNAPSHOTS).replaceOne(
    { testbed_id: snapshot.testbed_id },
    snapshot,
    { upsert: true }
  );

  // 2. History (una entry per testbed/giorno, idempotente)
  const historyRecord = extractHistoryRecord(snapshot);
  await db.collection(COLLECTIONS.DT_HISTORY).replaceOne(
    { testbed_id: historyRecord.testbed_id, date: historyRecord.date },
    historyRecord,
    { upsert: true }
  );

  // 3. Log irrigazione (append, una entry per valutazione)
  if (irrigation) {
    await db.collection(COLLECTIONS.IRRIGATION_LOG).insertOne({
      testbed_id: snapshot.testbed_id,
      timestamp: snapshot.timestamp,
      date: snapshot.date,
      ...irrigation,
      registrato_at: new Date().toISOString(),
    });
  }
}
