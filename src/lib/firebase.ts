/**
 * Genco Firebase Client — HTTP-only data access layer.
 *
 * The React app NEVER reads/writes Firebase RTDB directly.
 * All operations go through Firebase Cloud Functions via HTTP.
 *
 * Only `firebase/auth` is used client-side (for sign-in & ID tokens).
 */

import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getAnalytics } from "firebase/analytics";
import {
  cacheKey,
  installStorageQuotaGuard,
  readCachedValue,
  reclaimStorageForCriticalWrites,
  removeCachedValue,
  writeCachedValue,
} from "@/lib/data-cache";
import { getProgrammeQueryValues } from "@/lib/programme-access";

// --- Types ---

export type DatabaseRecord<T> = T & { id: string };

/** Fake snapshot for onValue callback compatibility */
interface FakeSnapshot {
  exists: () => boolean;
  val: () => Record<string, any> | null;
  key: string | null;
}

// --- Config (Auth only — NO database URL needed on client) ---

const firebaseConfig = {
  apiKey: import.meta.env.VITE_API_KEY,
  authDomain: import.meta.env.VITE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_PROJECT_ID,
  // databaseURL removed — client never accesses RTDB directly
  storageBucket: import.meta.env.VITE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_APP_ID,
  measurementId: import.meta.env.VITE_MEASUREMENT_ID,
};

// --- Auth-only Initialization ---

installStorageQuotaGuard();
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
export const auth = getAuth(app);

reclaimStorageForCriticalWrites();

const secondaryApp = initializeApp(firebaseConfig, "Secondary");
export const secondaryAuth = getAuth(secondaryApp);

export const analytics =
  typeof window !== "undefined" && typeof import.meta.env.VITE_MEASUREMENT_ID !== "undefined"
    ? getAnalytics(app)
    : null;

// --- Functions URL ---

const FUNCTIONS_URL = import.meta.env.VITE_API_BASE_URL ||
  "https://us-central1-genco-export.cloudfunctions.net";

// --- HTTP Helpers ---

const getIdToken = async (): Promise<string> => {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error("Not authenticated");
  return token;
};

const apiGet = async <T = any>(endpoint: string, params?: Record<string, string>): Promise<T> => {
  const token = await getIdToken();
  const url = new URL(`${FUNCTIONS_URL}${endpoint}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (res.status === 304) throw new Error("NOT_MODIFIED");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
};

const apiPost = async <T = any>(endpoint: string, body: any): Promise<T> => {
  const token = await getIdToken();
  const res = await fetch(`${FUNCTIONS_URL}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `HTTP ${res.status}`);
  }
  return res.json();
};

const apiDelete = async (endpoint: string, params: Record<string, string>): Promise<void> => {
  const token = await getIdToken();
  const url = new URL(`${FUNCTIONS_URL}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `HTTP ${res.status}`);
  }
};

// --- Server data proxy (with version-based 304 support) ---

interface ServerDataResponse {
  version: number;
  count: number;
  data: any[];
}

const serverVersions = new Map<string, number>();

const fetchFromServer = async (
  collectionPath: string,
  programme?: string,
): Promise<ServerDataResponse | null> => {
  try {
    const params: Record<string, string> = { path: collectionPath };
    if (programme) params.programme = programme;

    const lastVersion = serverVersions.get(collectionPath);
    if (lastVersion) params.sinceVersion = String(lastVersion);

    const result = await apiGet<ServerDataResponse>("/api/data", params);
    if (result?.version) serverVersions.set(collectionPath, result.version);
    return result;
  } catch (err) {
    if (err instanceof Error && err.message === "NOT_MODIFIED") return null;
    console.error(`Server fetch failed for ${collectionPath}:`, err);
    return null;
  }
};

// --- Client-side Cache ---

const COLLECTION_CACHE_TTL_MS = 5 * 60 * 1000;
const SERVER_CACHE_TTL_MS = 3 * 60 * 1000;
const inFlightRequests = new Map<string, Promise<DatabaseRecord<any>[]>>();

const buildCacheKey = (path: string, scope = "all") =>
  cacheKey("collection", auth.currentUser?.uid || "anon", path, scope);

const serverResponseToRecords = <T = Record<string, any>>(
  response: ServerDataResponse,
): DatabaseRecord<T>[] =>
  (response.data || []).map((item: any) => ({
    id: item.id,
    ...item,
  })) as DatabaseRecord<T>[];

// --- Public API: Collection Fetchers (replace direct RTDB reads) ---

/** Track cache hits for debugging */
const _cacheDebug = {
  hits: 0,
  misses: 0,
};

/**
 * Fetch a full collection via Cloud Functions (cache-first).
 * Replaces the old direct `get(ref(db, path))` pattern.
 */
export const fetchCollection = async <T = Record<string, any>>(
  path: string,
  ttlMs = COLLECTION_CACHE_TTL_MS,
): Promise<DatabaseRecord<T>[]> => {
  const cacheName = buildCacheKey(path);
  const cached = readCachedValue<DatabaseRecord<T>[]>(cacheName, ttlMs);
  if (cached) {
    _cacheDebug.hits++;
    console.log(`[Genco Cache HIT] ${path} (${_cacheDebug.hits} total hits)`);
    return cached;
  }

  _cacheDebug.misses++;
  console.log(`[Genco Cache MISS] ${path} — fetching from server (${_cacheDebug.misses} total misses)`);

  const inFlight = inFlightRequests.get(cacheName);
  if (inFlight) return inFlight as Promise<DatabaseRecord<T>[]>;

  const request = (async () => {
    // Go through Cloud Functions
    const serverResult = await fetchFromServer(path);
    if (serverResult) {
      const records = serverResponseToRecords<T>(serverResult);
      writeCachedValue(cacheName, records);
      console.log(`[Genco Cache WRITE] ${path} → ${records.length} records stored in localStorage`);
      return records;
    }
    throw new Error(`Failed to fetch collection: ${path}`);
  })();

  inFlightRequests.set(cacheName, request);
  try {
    return await request;
  } finally {
    inFlightRequests.delete(cacheName);
  }
};

/**
 * Fetch collection filtered by programme via Cloud Functions.
 */
export const fetchCollectionByProgramme = async <T = Record<string, any>>(
  path: string,
  programme: string,
  ttlMs = COLLECTION_CACHE_TTL_MS,
): Promise<DatabaseRecord<T>[]> => {
  const normalized = programme.trim().toUpperCase();
  if (!normalized) return [];

  const cacheName = buildCacheKey(path, `programme:${normalized}`);
  const cached = readCachedValue<DatabaseRecord<T>[]>(cacheName, ttlMs);
  if (cached) {
    _cacheDebug.hits++;
    console.log(`[Genco Cache HIT] ${path}?programme=${normalized} (${_cacheDebug.hits} total hits)`);
    return cached;
  }

  _cacheDebug.misses++;
  console.log(`[Genco Cache MISS] ${path}?programme=${normalized} — fetching from server`);

  const inFlight = inFlightRequests.get(cacheName);
  if (inFlight) return inFlight as Promise<DatabaseRecord<T>[]>;

  const request = (async () => {
    const serverResult = await fetchFromServer(path, normalized);
    if (serverResult) {
      const records = serverResponseToRecords<T>(serverResult);
      writeCachedValue(cacheName, records);
      console.log(`[Genco Cache WRITE] ${path}?programme=${normalized} → ${records.length} records`);
      return records;
    }
    throw new Error(`Failed to fetch programme collection: ${path}`);
  })();

  inFlightRequests.set(cacheName, request);
  try {
    return await request;
  } finally {
    inFlightRequests.delete(cacheName);
  }
};

/**
 * Fetch collection filtered by multiple programmes via Cloud Functions.
 */
export const fetchCollectionByProgrammes = async <T = Record<string, any>>(
  path: string,
  programmes: readonly string[],
  ttlMs = COLLECTION_CACHE_TTL_MS,
): Promise<DatabaseRecord<T>[]> => {
  const normalized = Array.from(
    new Set(programmes.map((p) => p.trim().toUpperCase()).filter(Boolean)),
  );
  if (normalized.length === 0) return [];
  if (normalized.length === 1) return fetchCollectionByProgramme<T>(path, normalized[0], ttlMs);

  const cacheName = buildCacheKey(path, `programmes:${normalized.join("|")}`);
  const cached = readCachedValue<DatabaseRecord<T>[]>(cacheName, ttlMs);
  if (cached) return cached;

  const inFlight = inFlightRequests.get(cacheName);
  if (inFlight) return inFlight as Promise<DatabaseRecord<T>[]>;

  const request = (async () => {
    // Fetch all (no programme filter) — server returns everything, we can let it handle it
    // or fetch per programme and merge
    const allProgrammes = ["KPMD", "RANGE", "KPMD 2"];
    const isAll = allProgrammes.every((p) => normalized.includes(p));

    if (isAll) {
      const serverResult = await fetchFromServer(path);
      if (serverResult) {
        const records = serverResponseToRecords<T>(serverResult);
        writeCachedValue(cacheName, records);
        return records;
      }
    }

    const results = await Promise.all(
      normalized.map((p) => fetchCollectionByProgramme<T>(path, p, ttlMs)),
    );
    const merged = new Map<string, DatabaseRecord<T>>();
    results.flat().forEach((r) => merged.set(r.id, r));
    const records = Array.from(merged.values());
    writeCachedValue(cacheName, records);
    return records;
  })();

  inFlightRequests.set(cacheName, request);
  try {
    return await request;
  } finally {
    inFlightRequests.delete(cacheName);
  }
};

// --- Public API: Subscription (polling-based, replaces onValue) ---

const activePollers = new Map<string, { interval: ReturnType<typeof setInterval>; active: boolean }>();

/**
 * Polling-based subscribe: replaces `onValue()` realtime listener.
 * Polls the Cloud Function every 15 seconds instead of using a websocket.
 */
export const subscribeCollectionByProgramme = <T = Record<string, any>>(
  path: string,
  programme: string,
  onRecords: (records: Record<string, T>) => void,
  onError?: (error: Error) => void,
): (() => void) => {
  const pollerKey = `sub:${path}:${programme}`;
  const normalized = programme.trim().toUpperCase();
  if (!normalized) {
    onRecords({});
    return () => {};
  }

  let active = true;
  const poll = async () => {
    if (!active) return;
    try {
      const records = await fetchCollectionByProgramme<T>(path, normalized, 10_000);
      if (!active) return;
      const map: Record<string, T> = {};
      records.forEach((r) => { map[r.id] = r as unknown as T; });
      onRecords(map);
    } catch (err) {
      if (active && onError) onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  // Initial fetch
  poll();

  // Poll every 30 seconds (reduced from 15s to reduce server load + network traffic)
  const interval = setInterval(poll, 30_000);
  activePollers.set(pollerKey, { interval, active: true });

  return () => {
    active = false;
    clearInterval(interval);
    activePollers.delete(pollerKey);
  };
};

export const subscribeCollectionByProgrammes = <T = Record<string, any>>(
  path: string,
  programmes: readonly string[],
  onRecords: (records: Record<string, T>) => void,
  onError?: (error: Error) => void,
): (() => void) => {
  const normalized = Array.from(
    new Set(programmes.map((p) => p.trim().toUpperCase()).filter(Boolean)),
  );
  if (normalized.length === 0) {
    onRecords({});
    return () => {};
  }

  const unsubs = normalized.map((p) =>
    subscribeCollectionByProgramme<T>(path, p, (records) => {
      // Merge into parent callback
      mergedByProgramme.current.set(p, records);
      const all: Record<string, T> = {};
      mergedByProgramme.current.forEach((v) => Object.assign(all, v));
      onRecords(all);
    }, onError),
  );

  const mergedByProgramme = { current: new Map<string, Record<string, T>>() };

  return () => {
    unsubs.forEach((u) => u());
  };
};

// --- Public API: Cache Invalidation ---

export const invalidateCollectionCache = (path: string): void => {
  // Clear client cache
  const prefixes = [
    buildCacheKey(path),
    buildCacheKey(path, "programme:"),
    buildCacheKey(path, "programmes:"),
  ];
  prefixes.forEach((prefix) => {
    inFlightRequests.forEach((_, key) => { if (key.startsWith(prefix)) inFlightRequests.delete(key); });
    removeCachedValue(prefix);
  });
  // Clear server version so next fetch gets fresh data
  serverVersions.delete(path);
};

// --- RTDB-compatible wrapper exports ---
// These let pages keep their existing code patterns (ref, set, push, update, remove, get, onValue)
// but route all operations through Cloud Functions HTTP endpoints.

/** Dummy db — not used for direct access, kept for API compatibility */
export const db = null as unknown as any;

/**
 * ref() — Returns a path string (NOT an RTDB Reference).
 * Usage: ref(db, "requisitions/abc123") → "requisitions/abc123"
 */
export const ref = (_db: any, pathOrRef: string): string => pathOrRef;

/**
 * set() — Overwrite a record via Cloud Functions.
 */
export const set = async (pathOrRef: string | { _path: string }, data: any): Promise<void> => {
  const path = typeof pathOrRef === "string" ? pathOrRef : (pathOrRef as any)._path;
  await apiPost("/api/set", { path, data });
  // Invalidate client cache
  const collectionPath = path.includes("/") ? path.split("/").slice(0, -1).join("/") : path;
  invalidateCollectionCache(collectionPath);
};

/**
 * update() — Merge data into a record via Cloud Functions.
 */
export const update = async (pathOrRef: string | { _path: string }, data: any): Promise<void> => {
  const path = typeof pathOrRef === "string" ? pathOrRef : (pathOrRef as any)._path;
  await apiPost("/api/update", { path, data });
  const collectionPath = path.includes("/") ? path.split("/").slice(0, -1).join("/") : path;
  invalidateCollectionCache(collectionPath);
};

/**
 * push() — Create a new child record via Cloud Functions.
 * If data is provided, creates the record in one call.
 * Returns an object with `.key` (the new record ID).
 */
export const push = async (
  pathOrRef: string | { _path: string },
  data?: any,
): Promise<{ key: string }> => {
  const path = typeof pathOrRef === "string" ? pathOrRef : (pathOrRef as any)._path;
  const result = await apiPost<{ id: string }>("/api/create", { path, data: data || null });
  const collectionPath = path.includes("/") ? path.split("/").slice(0, -1).join("/") : path;
  invalidateCollectionCache(collectionPath);
  return { key: result.id };
};

/**
 * remove() — Delete a record via Cloud Functions.
 */
export const remove = async (pathOrRef: string | { _path: string }): Promise<void> => {
  const path = typeof pathOrRef === "string" ? pathOrRef : (pathOrRef as any)._path;
  await apiDelete("/api/delete", { path });
  const collectionPath = path.includes("/") ? path.split("/").slice(0, -1).join("/") : path;
  invalidateCollectionCache(collectionPath);
};

/**
 * get() — Read a single record via Cloud Functions.
 * Returns a fake snapshot with .exists(), .val(), .key
 */
export const get = async (pathOrRef: string | { _path: string }): Promise<FakeSnapshot> => {
  const path = typeof pathOrRef === "string" ? pathOrRef : (pathOrRef as any)._path;
  try {
    const data = await apiGet<Record<string, any>>("/api/record", { path });
    return {
      exists: () => true,
      val: () => data,
      key: path.includes("/") ? path.split("/").pop() || null : path,
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes("404")) {
      return { exists: () => false, val: () => null, key: path.includes("/") ? path.split("/").pop() || null : path };
    }
    throw err;
  }
};

// --- Query helpers (for compatibility with onValue pattern) ---

type QueryDescriptor = {
  _type: "query";
  path: string;
  filters: Array<{ field: string; operator: string; value: any }>;
};

/**
 * query() — Build a query descriptor (no actual DB query).
 * Works with onValue() below to poll the server.
 */
export const query = (pathOrRef: string | QueryDescriptor, ...filters: any[]): QueryDescriptor => {
  if (typeof pathOrRef === "object" && (pathOrRef as QueryDescriptor)._type === "query") {
    return pathOrRef;
  }
  return {
    _type: "query",
    path: pathOrRef as string,
    filters: filters.map((f) => ({
      field: (f as any)?.field || (f as any)?.key || "programme",
      operator: (f as any)?.operator || "==",
      value: (f as any)?.value,
    })),
  };
};

/**
 * orderByChild() — Returns a filter descriptor for query().
 */
export const orderByChild = (field: string) => ({ _queryFilter: true, field });

/**
 * equalTo() — Returns a filter descriptor for query().
 */
export const equalTo = (value: any) => ({ _queryFilter: true, value, operator: "==" });

/**
 * onValue() — Polling-based replacement for Firebase onValue().
 * Polls the /api/query endpoint every 15 seconds.
 */
export const onValue = (
  queryOrRef: string | QueryDescriptor,
  callback: (snapshot: FakeSnapshot) => void,
  errorCallback?: (error: Error) => void,
): (() => void) => {
  let path: string;
  let filters: Array<{ field: string; value: any }> = [];

  if (typeof queryOrRef === "string") {
    path = queryOrRef;
  } else {
    const q = queryOrRef as QueryDescriptor;
    path = q.path;
    filters = q.filters.map((f) => ({ field: f.field, value: f.value }));
  }

  let active = true;
  const poll = async () => {
    if (!active) return;
    try {
      const data = await apiPost<Record<string, any>[]>("/api/query", { path, filters });
      if (!active) return;
      const obj: Record<string, any> = {};
      if (Array.isArray(data)) {
        data.forEach((r: any) => { if (r.id) { const { id, ...rest } = r; obj[id] = rest; } });
      }
      callback({
        exists: () => Object.keys(obj).length > 0,
        val: () => Object.keys(obj).length > 0 ? obj : null,
        key: path,
      });
    } catch (err) {
      if (active && errorCallback) {
        errorCallback(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };

  poll();
  const interval = setInterval(poll, 30_000);
  return () => {
    active = false;
    clearInterval(interval);
  };
};

// --- Server Timestamp placeholder ---
export const serverTimestamp = () => ({ ".sv": "timestamp" });

// --- Additional query helpers (no-ops, for API compatibility) ---
export const startAt = (value: any) => ({ _queryFilter: true, value, range: "startAt" });
export const endAt = (value: any) => ({ _queryFilter: true, value, range: "endAt" });
export const limitToFirst = (count: number) => ({ _queryFilter: true, value: count, range: "limitToFirst" });
export const limitToLast = (count: number) => ({ _queryFilter: true, value: count, range: "limitToLast" });

// --- Type placeholder (for Database type annotations) ---
export type Database = any;