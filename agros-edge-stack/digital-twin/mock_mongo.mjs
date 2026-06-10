/**
 * Mock in-memory del driver MongoDB, sufficiente per testare fetcher/mongo.js
 * e store_mongo.js senza un server reale. Implementa solo i metodi e i pattern
 * di query effettivamente usati dal codice del DT.
 *
 * NON è un Mongo completo: è un doppio di test.
 */

function matchDoc(doc, query) {
  for (const [key, cond] of Object.entries(query)) {
    const val = doc[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      // operatori di confronto
      for (const [op, operand] of Object.entries(cond)) {
        if (op === "$gte" && !(val >= operand)) return false;
        if (op === "$lte" && !(val <= operand)) return false;
        if (op === "$gt" && !(val > operand)) return false;
        if (op === "$lt" && !(val < operand)) return false;
      }
    } else {
      if (val !== cond) return false;
    }
  }
  return true;
}

function compareVals(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

class Cursor {
  constructor(docs) {
    this._docs = docs;
  }
  sort(spec) {
    const [[key, dir]] = Object.entries(spec);
    this._docs = [...this._docs].sort((a, b) => compareVals(a[key], b[key]) * dir);
    return this;
  }
  limit(n) {
    this._docs = this._docs.slice(0, n);
    return this;
  }
  async next() {
    return this._docs.length > 0 ? this._docs[0] : null;
  }
  async toArray() {
    return this._docs;
  }
}

class Collection {
  constructor() {
    this.docs = [];
  }
  find(query = {}) {
    return new Cursor(this.docs.filter((d) => matchDoc(d, query)));
  }
  async insertOne(doc) {
    this.docs.push({ ...doc });
    return { insertedId: this.docs.length };
  }
  async insertMany(docs) {
    for (const d of docs) this.docs.push({ ...d });
    return { insertedCount: docs.length };
  }
  async replaceOne(filter, doc, opts = {}) {
    const idx = this.docs.findIndex((d) => matchDoc(d, filter));
    if (idx >= 0) {
      this.docs[idx] = { ...doc };
      return { matchedCount: 1, modifiedCount: 1 };
    }
    if (opts.upsert) {
      this.docs.push({ ...doc });
      return { matchedCount: 0, upsertedCount: 1 };
    }
    return { matchedCount: 0, modifiedCount: 0 };
  }
  async deleteMany(filter) {
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => !matchDoc(d, filter));
    return { deletedCount: before - this.docs.length };
  }
  async countDocuments(query = {}) {
    return this.docs.filter((d) => matchDoc(d, query)).length;
  }
  async createIndex() {
    return "mock_index";
  }
}

class Db {
  constructor() {
    this._collections = new Map();
  }
  collection(name) {
    if (!this._collections.has(name)) this._collections.set(name, new Collection());
    return this._collections.get(name);
  }
  async command() {
    return { ok: 1 };
  }
}

export function makeMockDb() {
  return new Db();
}
