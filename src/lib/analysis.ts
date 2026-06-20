import { auth } from "@/lib/firebase";
import { cacheKey, readCachedValue, writeCachedValue } from "@/lib/data-cache";
import { runSingleActiveDataLoad } from "@/lib/data-load-lock";
import { serverApiFetch } from "@/lib/server-api";

export type AnalysisScope =
  | "overview"
  | "livestock-analytics"
  | "performance-report"
  | "sales-report";

const ANALYSIS_CACHE_VERSION = "v12";

export interface AnalysisRequest {
  scope: AnalysisScope;
  programme?: string | null;
  dateRange?: { startDate?: string; endDate?: string } | null;
  timeFrame?: "weekly" | "monthly" | "yearly" | string | null;
  selectedYear?: number | string | null;
  target?: number | null;
  salesInputs?: { pricePerKg?: number | string | null; expenses?: number | string | null } | null;
}

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const OVERVIEW_CACHE_TTL_MS = 15 * 60 * 1000;
const buildCacheKey = (request: AnalysisRequest): string =>
  cacheKey(
    "analysis",
    ANALYSIS_CACHE_VERSION,
    auth.currentUser?.uid || "anon",
    request.scope,
    request.programme || "all",
    request.dateRange?.startDate || "",
    request.dateRange?.endDate || "",
    request.timeFrame || "",
    request.selectedYear ?? "",
    request.target ?? "",
    request.salesInputs?.pricePerKg ?? "",
    request.salesInputs?.expenses ?? "",
  );

export const fetchAnalysisSummary = async (request: AnalysisRequest): Promise<any> => {
  const key = buildCacheKey(request);
  const ttlMs = request.scope === "overview" ? OVERVIEW_CACHE_TTL_MS : DEFAULT_CACHE_TTL_MS;
  const cached = readCachedValue<any>(key, ttlMs);
  if (cached) return cached;

  const result = await runSingleActiveDataLoad(() =>
    serverApiFetch<{data: any}>("/api/analysis-summary", {
      method: "POST",
      body: JSON.stringify(request),
    }),
    key,
  );

  writeCachedValue(key, result.data);
  return result.data;
};
