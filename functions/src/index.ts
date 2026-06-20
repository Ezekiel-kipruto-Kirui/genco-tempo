/**
 * Genco Export — Firebase Cloud Functions (HTTP triggers)
 *
 * All data access goes through these functions.
 * Client NEVER reads/writes RTDB directly.
 *
 * Features:
 *  - LRU memory cache for frequently accessed collections
 *  - 304 Not Modified support (version-based)
 *  - Programme filtering at server level
 *  - Write endpoints (create, update, delete)
 *  - Pagination support
 *  - Robust CORS handling with error catching
 */

import * as admin from "firebase-admin";
import * as functions from "firebase-functions";
import * as path from "path";
import { Request, Response } from "express";

// ─── CORS (manual — never drops headers even on thrown errors) ──────────────
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:8080",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:8080",
  "https://genco-export.web.app",
  "https://genco-export.firebaseapp.com",
];

const corsHeaders = (req: Request): Record<string, string> => {
  const origin = req.headers.origin || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Requested-With",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
  };
};

/** Wraps any handler so CORS headers are ALWAYS set, even on errors. */
const withCors = (
  handler: (req: Request, res: Response) => Promise<void> | void,
) => async (req: Request, res: Response) => {
  // Handle preflight
  if (req.method === "OPTIONS") {
    res.set(corsHeaders(req)).status(204).send("");
    return;
  }

  // Set CORS headers on every response
  res.set(corsHeaders(req));

  try {
    await handler(req, res);
  } catch (err: any) {
    console.error("Unhandled function error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message || "Internal server error" });
    }
  }
};

// ─── Lazy Admin Init ────────────────────────────────────────────────────────
let _initialized = false;
const ensureAdmin = () => {
  if (_initialized) return;
  try {
    const saPath = path.join(__dirname, "genco-company-firebase-adminsdk-fbsvc-f39677b198.json");
    admin.initializeApp({
      credential: admin.credential.cert(require(saPath)),
      databaseURL: "https://genco-export-default-rtdb.firebaseio.com",
    });
    _initialized = true;
  } catch (err) {
    console.error("Firebase admin init failed:", err);
    throw new Error("Server initialization failed");
  }
};

// ─── Auth ───────────────────────────────────────────────────────────────────
const verifyUser = async (authHeader: string | undefined) => {
  if (!authHeader?.startsWith("Bearer ")) return null;
  ensureAdmin();
  try {
    return await admin.auth().verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
};

// ─── LRU Memory Cache ───────────────────────────────────────────────────────
const CACHE_MAX_ENTRIES = 200;
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

interface CacheEntry<T = unknown> {
  data: T;
  version: number;
  ts: number;
}

class MemoryCache {
  private store = new Map<string, CacheEntry>();
  private accessOrder = new Set<string>();

  get<T = unknown>(key: string): CacheEntry<T> | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      this.store.delete(key);
      this.accessOrder.delete(key);
      return null;
    }
    // LRU: move to most-recently-used
    this.accessOrder.delete(key);
    this.accessOrder.add(key);
    return entry as CacheEntry<T>;
  }

  set<T = unknown>(key: string, data: T, version: number): void {
    // Evict oldest if at capacity
    if (this.store.size >= CACHE_MAX_ENTRIES && !this.store.has(key)) {
      const oldest = this.accessOrder.values().next().value;
      if (oldest) {
        this.store.delete(oldest);
        this.accessOrder.delete(oldest);
      }
    }
    this.store.set(key, { data, version, ts: Date.now() });
    this.accessOrder.delete(key);
    this.accessOrder.add(key);
  }

  delete(key: string): void {
    this.store.delete(key);
    this.accessOrder.delete(key);
  }

  invalidateByPrefix(prefix: string): void {
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        this.accessOrder.delete(key);
      }
    }
  }

  get size(): number {
    return this.store.size;
  }
}

const cache = new MemoryCache();

// ─── Utility: Snapshot to records ───────────────────────────────────────────
const snapToRecords = (snap: admin.database.DataSnapshot): Record<string, any>[] => {
  if (!snap.exists()) return [];
  const v = snap.val();
  if (typeof v !== "object" || v === null) return [];
  return Object.entries(v).map(([id, val]) => ({ id, ...(val as Record<string, any>) }));
};

// ─── Utility: Version hash ──────────────────────────────────────────────────
const computeVersion = (records: Record<string, any>[]): number => {
  let h = 0;
  for (const r of records) {
    const json = JSON.stringify(r);
    for (let i = 0; i < json.length; i++) {
      h = ((h << 5) - h + json.charCodeAt(i)) | 0;
    }
  }
  return Math.abs(h);
};

// ─── Utility: Programme filter on server ────────────────────────────────────
const filterByProgramme = (records: Record<string, any>[], programme?: string): Record<string, any>[] => {
  if (!programme) return records;
  const upper = programme.trim().toUpperCase();
  return records.filter((r) => {
    const p1 = String(r.programme || "").trim().toUpperCase();
    const p2 = String(r.Programme || "").trim().toUpperCase();
    return p1 === upper || p2 === upper;
  });
};

// ─── Utility: Get RTDB reference ────────────────────────────────────────────
const getDb = () => {
  ensureAdmin();
  return admin.database();
};

// ═══════════════════════════════════════════════════════════════════════════════
// READ ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/data — Cached collection read
 *
 * Query params:
 *   path          (required)  — RTDB collection path
 *   programme     (optional)  — filter by programme field
 *   sinceVersion  (optional)  — returns 304 if version unchanged
 *   page          (optional)  — page number (1-based), default 1
 *   limit         (optional)  — items per page, default all
 *   orderBy       (optional)  — field to order by
 */
export const data = functions.https.onRequest(
  withCors(async (req, res) => {
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const user = await verifyUser(req.headers.authorization);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const collectionPath = req.query.path as string;
    if (!collectionPath) {
      res.status(400).json({ error: "Missing 'path'" });
      return;
    }

    const programme = req.query.programme as string | undefined;
    const sinceVersion = req.query.sinceVersion ? parseInt(req.query.sinceVersion as string, 10) : null;
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 0;
    const orderBy = req.query.orderBy as string | undefined;

    const cacheKey = `${collectionPath}:${programme || "all"}:${orderBy || "none"}:${user.uid}`;

    // Check cache (skip pagination check — cache the full filtered set)
    const cached = cache.get<{ version: number; count: number; data: Record<string, any>[] }>(cacheKey);
    if (cached) {
      if (sinceVersion !== null && cached.data.version === sinceVersion) {
        res.status(304).send("");
        return;
      }
      // Apply pagination to cached data
      let result = cached.data.data;
      if (limit > 0) {
        const start = (page - 1) * limit;
        result = result.slice(start, start + limit);
      }
      res.json({ ...cached.data, data: result, page, limit: limit || result.length });
      return;
    }

    // Fetch from RTDB
    const db = getDb();
    let records: Record<string, any>[];

    if (programme || orderBy) {
      // Use server-side query
      const orderField = orderBy || "programme";
      try {
        let q: any = db.ref(collectionPath).orderByChild(orderField);
        if (programme) {
          q = q.equalTo(programme);
        }
        const snap = await q.once("value");
        records = snapToRecords(snap);
        // Also try with uppercase Programme field
        if (programme) {
          const snap2 = await db.ref(collectionPath)
            .orderByChild(orderField === "programme" ? "Programme" : orderField)
            .equalTo(programme)
            .once("value")
            .catch(() => null);
          if (snap2?.exists()) {
            const records2 = snapToRecords(snap2);
            const existingIds = new Set(records.map((r) => r.id));
            records2.forEach((r) => { if (!existingIds.has(r.id)) records.push(r); });
          }
        }
      } catch (err) {
        // Fallback: fetch all and filter client-side
        const snap = await db.ref(collectionPath).once("value");
        records = snapToRecords(snap);
        if (programme) records = filterByProgramme(records, programme);
      }
    } else {
      const snap = await db.ref(collectionPath).once("value");
      records = snapToRecords(snap);
    }

    const version = computeVersion(records);
    const responseData = { version, count: records.length, data: records };

    // Cache the full result
    cache.set(cacheKey, responseData, version);

    // Apply pagination for response
    let responseRecords = records;
    if (limit > 0) {
      const start = (page - 1) * limit;
      responseRecords = records.slice(start, start + limit);
    }

    res.json({
      version,
      count: records.length,
      data: responseRecords,
      page,
      limit: limit || responseRecords.length,
    });
  }),
);

/**
 * GET /api/record — Read a single record by path
 *
 * Query params:
 *   path  (required) — Full RTDB path to the record (e.g. "requisitions/abc123")
 */
export const record = functions.https.onRequest(
  withCors(async (req, res) => {
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const user = await verifyUser(req.headers.authorization);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const recordPath = req.query.path as string;
    if (!recordPath) {
      res.status(400).json({ error: "Missing 'path'" });
      return;
    }

    const cacheKey = `record:${recordPath}:${user.uid}`;
    const cached = cache.get<Record<string, any>>(cacheKey);
    if (cached) {
      res.json(cached.data);
      return;
    }

    const db = getDb();
    const snap = await db.ref(recordPath).once("value");

    if (!snap.exists()) {
      res.status(404).json({ error: "Record not found" });
      return;
    }

    const data = { id: snap.key, ...(snap.val() as Record<string, any>) };
    cache.set(cacheKey, data, computeVersion([data]));
    res.json(data);
  }),
);

/**
 * POST /api/query — Run a filtered query (replaces onValue/query/orderByChild/equalTo)
 *
 * Body:
 *   path        (required) — Collection path
 *   filters     (optional) — [{ field, operator, value }]
 *   programmes  (optional) — string[] — shorthand for programme OR filter
 *   orderBy     (optional) — string — field to order by
 */
export const queryEndpoint = functions.https.onRequest(
  withCors(async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const user = await verifyUser(req.headers.authorization);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { path: collectionPath, programmes, orderBy } = req.body || {};

    if (!collectionPath) {
      res.status(400).json({ error: "Missing 'path'" });
      return;
    }

    // Build cache key
    const cacheKey = `query:${collectionPath}:${JSON.stringify(programmes || [])}:${orderBy || "none"}:${user.uid}`;
    const cached = cache.get<Record<string, any>[]>(cacheKey);
    if (cached) {
      res.json(cached.data);
      return;
    }

    const db = getDb();
    let records: Record<string, any>[];

    if (programmes && programmes.length > 0) {
      // Fetch all and filter by programmes (most flexible)
      const snap = await db.ref(collectionPath).once("value");
      records = snapToRecords(snap);
      const upperSet = new Set((programmes as string[]).map((p) => p.trim().toUpperCase()));
      records = records.filter((r) => {
        const p1 = String(r.programme || "").trim().toUpperCase();
        const p2 = String(r.Programme || "").trim().toUpperCase();
        return upperSet.has(p1) || upperSet.has(p2);
      });
    } else {
      const snap = await db.ref(collectionPath).once("value");
      records = snapToRecords(snap);
    }

    // Sort if requested
    if (orderBy) {
      records.sort((a, b) => {
        const va = a[orderBy];
        const vb = b[orderBy];
        if (va < vb) return -1;
        if (va > vb) return 1;
        return 0;
      });
    }

    cache.set(cacheKey, records, computeVersion(records));
    res.json(records);
  }),
);

/**
 * GET /api/auth-verify — Verify ID token and return user info
 */
export const authVerify = functions.https.onRequest(
  withCors(async (req, res) => {
    const user = await verifyUser(req.headers.authorization);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.json({
      uid: user.uid,
      email: user.email,
      name: user.name,
      customClaims: user.customClaims || {},
    });
  }),
);

/**
 * POST /api/analysis-summary — Dashboard analytics summary (cached)
 */
export const analysisSummary = functions.https.onRequest(
  withCors(async (req, res) => {
    if (req.method !== "POST" && req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const user = await verifyUser(req.headers.authorization);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const body = req.method === "POST" ? (req.body || {}) : (req.query || {});
    const scope = (body.scope as string) || "overview";
    const programme = body.programme as string | undefined;

    const cacheKey = `analysis-summary:${scope}:${programme || "all"}:${user.uid}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      res.json(cached.data);
      return;
    }

    const db = getDb();
    const [farmersSnap, offtakesSnap, trainingSnap, animalHealthSnap] = await Promise.all([
      db.ref("farmers").once("value"),
      db.ref("offtakes").once("value"),
      db.ref("capacityBuilding").once("value"),
      db.ref("AnimalHealthActivities").once("value"),
    ]);

    const farmers = snapToRecords(farmersSnap);
    const offtakes = snapToRecords(offtakesSnap);
    const training = snapToRecords(trainingSnap);
    const animalHealth = snapToRecords(animalHealthSnap);

    // Filter by programme if specified
    const filteredFarmers = programme ? filterByProgramme(farmers, programme) : farmers;
    const filteredOfftakes = programme ? filterByProgramme(offtakes, programme) : offtakes;
    const filteredTraining = programme ? filterByProgramme(training, programme) : training;
    const filteredAnimalHealth = programme ? filterByProgramme(animalHealth, programme) : animalHealth;

    const result = {
      totalFarmers: filteredFarmers.length,
      maleFarmers: filteredFarmers.filter((f) => String(f.gender || "").toLowerCase() === "male").length,
      femaleFarmers: filteredFarmers.filter((f) => String(f.gender || "").toLowerCase() === "female").length,
      totalAnimals: filteredFarmers.reduce((s, f) => s + (Number(f.goats?.total) || Number(f.goats) || Number(f.sheep) || 0), 0),
      totalGoatsPurchased: filteredOfftakes.reduce((s, o) => s + (Number(o.goats_purchased) || Number(o.goatsPurchased) || 0), 0),
      totalTrainedFarmers: 0,
      totalOfftakes: filteredOfftakes.length,
      totalTraining: filteredTraining.length,
      totalAnimalHealth: filteredAnimalHealth.length,
    };

    // Compute trained farmers from capacity building beneficiaries
    const trainedSet = new Set<string>();
    filteredTraining.forEach((t) => {
      const benes = t.beneficiaries;
      if (Array.isArray(benes)) benes.forEach((b: any) => { if (b.id) trainedSet.add(b.id); });
    });
    result.totalTrainedFarmers = trainedSet.size;

    cache.set(cacheKey, result, computeVersion([result as any]));
    res.json(result);
  }),
);

/**
 * GET /api/analysis-core — Full analytics data for dashboard (cached, heavy)
 */
export const analysisCore = functions.https.onRequest(
  withCors(async (req, res) => {
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const user = await verifyUser(req.headers.authorization);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const cacheKey = `analysis-core:${user.uid}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      res.json(cached.data);
      return;
    }

    const db = getDb();
    const [farmersSnap, offtakesSnap, trainingSnap, animalHealthSnap, activitiesSnap] = await Promise.all([
      db.ref("farmers").once("value"),
      db.ref("offtakes").once("value"),
      db.ref("capacityBuilding").once("value"),
      db.ref("AnimalHealthActivities").once("value"),
      db.ref("activities").once("value"),
    ]);

    const result = {
      farmers: snapToRecords(farmersSnap),
      offtakes: snapToRecords(offtakesSnap),
      capacity: snapToRecords(trainingSnap),
      animalHealth: snapToRecords(animalHealthSnap),
      activities: snapToRecords(activitiesSnap),
    };

    cache.set(cacheKey, result, computeVersion([result as any]));
    res.json(result);
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// WRITE ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

/** Invalidate cache entries matching a collection path */
const invalidateCacheForPath = (collectionPath: string) => {
  cache.invalidateByPrefix(collectionPath);
  cache.invalidateByPrefix("query:" + collectionPath);
};

/**
 * POST /api/create — Push a new record to a collection
 */
export const create = functions.https.onRequest(
  withCors(async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const user = await verifyUser(req.headers.authorization);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { path: collectionPath, data } = req.body || {};
    if (!collectionPath || !data) {
      res.status(400).json({ error: "Missing 'path' or 'data'" });
      return;
    }

    const db = getDb();
    const newRef = db.ref(collectionPath).push();
    await newRef.set({ ...data, createdAt: admin.database.ServerValue.TIMESTAMP });

    // Invalidate cache
    invalidateCacheForPath(collectionPath);

    res.json({ id: newRef.key });
  }),
);

/**
 * POST /api/update — Update an existing record
 */
export const update = functions.https.onRequest(
  withCors(async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const user = await verifyUser(req.headers.authorization);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { path: recordPath, data } = req.body || {};
    if (!recordPath || !data) {
      res.status(400).json({ error: "Missing 'path' or 'data'" });
      return;
    }

    const db = getDb();
    await db.ref(recordPath).update(data);

    // Invalidate caches related to this collection
    const collectionPath = recordPath.split("/").slice(0, -1).join("/") || recordPath;
    invalidateCacheForPath(collectionPath);
    cache.delete(`record:${recordPath}:`);

    res.json({ success: true });
  }),
);

/**
 * POST /api/set — Overwrite a record (set)
 */
export const setRecord = functions.https.onRequest(
  withCors(async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const user = await verifyUser(req.headers.authorization);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { path: recordPath, data } = req.body || {};
    if (!recordPath || data === undefined) {
      res.status(400).json({ error: "Missing 'path' or 'data'" });
      return;
    }

    const db = getDb();
    await db.ref(recordPath).set(data);

    const collectionPath = recordPath.split("/").slice(0, -1).join("/") || recordPath;
    invalidateCacheForPath(collectionPath);
    cache.delete(`record:${recordPath}:`);

    res.json({ success: true });
  }),
);

/**
 * DELETE /api/delete — Remove a record
 */
export const remove = functions.https.onRequest(
  withCors(async (req, res) => {
    if (req.method !== "DELETE" && req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const user = await verifyUser(req.headers.authorization);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const recordPath = (req.method === "DELETE" ? req.query.path : req.body?.path) as string;
    if (!recordPath) {
      res.status(400).json({ error: "Missing 'path'" });
      return;
    }

    const db = getDb();
    await db.ref(recordPath).remove();

    const collectionPath = recordPath.split("/").slice(0, -1).join("/") || recordPath;
    invalidateCacheForPath(collectionPath);
    cache.delete(`record:${recordPath}:`);

    res.json({ success: true });
  }),
);

/**
 * POST /api/batch-delete — Remove multiple records
 */
export const batchDelete = functions.https.onRequest(
  withCors(async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const user = await verifyUser(req.headers.authorization);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { paths } = req.body || {};
    if (!Array.isArray(paths) || paths.length === 0) {
      res.status(400).json({ error: "Missing 'paths' array" });
      return;
    }

    const db = getDb();
    const updates: Record<string, null> = {};
    const collectionsToInvalidate = new Set<string>();

    for (const p of paths) {
      updates[p] = null;
      collectionsToInvalidate.add(p.split("/").slice(0, -1).join("/") || p);
    }

    await db.ref().update(updates);

    for (const col of collectionsToInvalidate) {
      invalidateCacheForPath(col);
    }

    res.json({ success: true, deleted: paths.length });
  }),
);

/**
 * GET /api/cache-stats — Debug: view cache status
 */
export const cacheStats = functions.https.onRequest(
  withCors(async (req, res) => {
    const user = await verifyUser(req.headers.authorization);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.json({
      entries: cache.size,
      maxEntries: CACHE_MAX_ENTRIES,
      ttlMs: CACHE_TTL_MS,
    });
  }),
);

/**
 * GET /api/health — Health check (no auth required)
 */
export const health = functions.https.onRequest(
  withCors(async (_req, res) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      cacheEntries: cache.size,
    });
  }),
);
