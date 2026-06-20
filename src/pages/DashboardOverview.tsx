import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  Clock3,
  Eye,
  Leaf,
  Loader2,
  MapPin,
  Plus,
  ShoppingCart,
  UsersRound,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import ProgrammeSelector from "@/components/programme-selector";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { canViewAllProgrammes } from "@/contexts/authhelper";
import { useSharedProgrammeSelection } from "@/hooks/use-shared-programme-selection";
import { fetchAnalysisSummary } from "@/lib/analysis";
import { cacheKey, readCachedValue, writeCachedValue } from "@/lib/data-cache";
import { getCurrentMonthDateRange } from "@/lib/date-range";
import {
  ALL_PROGRAMMES_VALUE,
  PROGRAMME_OPTIONS,
  isAllProgrammesSelection,
  normalizeProgramme,
  resolveAccessibleProgrammes,
} from "@/lib/programme-access";

type OverviewRecord = Record<string, any>;

type YearlyTrendPoint = {
  name: string;
  [year: string]: number | string;
};

type YearlyTrend = {
  years: number[];
  data: YearlyTrendPoint[];
};

type AnnualComparisonPoint = {
  name: string;
  goatsOnRecord: number;
  goatsPurchased: number;
};

type AnnualComparison = {
  years: number[];
  data: AnnualComparisonPoint[];
};

type DonutSegment = {
  name: string;
  value: number;
  color: string;
};

type CountyCoverage = {
  name: string;
  value: number;
  color: string;
};

type RecentLocation = {
  name: string;
  county: string;
  visitedAt: string;
};

type RecentActivity = {
  id: string;
  activityName: string;
  date: string;
  status: string;
  location: string;
  participants: number;
};

type RecentFarmer = {
  id: string;
  name: string;
  county: string;
  registeredAt: string;
  gender: string;
  goats: number;
};

interface OverviewSummaryData {
  stats: {
    totalFarmers: number;
    maleFarmers: number;
    femaleFarmers: number;
    trainedFarmers: number;
    totalAnimals: number;
    totalGoats: number;
    totalSheep: number;
    totalCattle: number;
    totalGoatsPurchased: number;
    countiesCovered: number;
  };
  maintainedInfrastructure: DonutSegment[];
  registrationComparison: DonutSegment[];
  animalCensusComparison: AnnualComparison;
  vaccinationTrend: YearlyTrend;
  countyCoverage: CountyCoverage[];
  recentLocations: RecentLocation[];
  recentActivities: RecentActivity[];
  recentFarmers: RecentFarmer[];
  pendingActivitiesCount: number;
}

type OverviewStats = OverviewSummaryData["stats"];

type OverviewCollections = {
  farmers: OverviewRecord[];
  capacity: OverviewRecord[];
  offtakes: OverviewRecord[];
  animalHealth: OverviewRecord[];
  boreholes: OverviewRecord[];
  activities: OverviewRecord[];
};

const USE_REMOTE_ANALYTICS = true;

const SERIES_COLORS = ["#2710a1", "#f89b0d", "#ffea00", "#2cb100", "#0ea5e9", "#ef4444"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const COUNTY_BAR_COLORS = SERIES_COLORS.slice(0, 4);
const SECONDARY_TEXT_CLASS = "text-gray-600";
const RECENT_LOCATION_MAX_AGE_DAYS = 180;
const RECENT_LOCATION_MAX_AGE_MS = RECENT_LOCATION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
const OVERVIEW_TIME_ZONE = "Africa/Nairobi";
const relativeTimeFormatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const activityDateFormatter = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const overviewHeroDateFormatter = new Intl.DateTimeFormat("en", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: OVERVIEW_TIME_ZONE,
});
const farmerRegisteredDateFormatter = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const createEmptyYearlyTrend = (): YearlyTrend => ({
  years: [],
  data: MONTH_LABELS.map((name) => ({ name })),
});

const EMPTY_DONUT_SEGMENTS: DonutSegment[] = [];

const EMPTY_COUNTY_COVERAGE: CountyCoverage[] = COUNTY_BAR_COLORS.map((color, index) => ({
  name: `County ${index + 1}`,
  value: 0,
  color,
}));

const EMPTY_OVERVIEW_DATA: OverviewSummaryData = {
  stats: {
    totalFarmers: 0,
    maleFarmers: 0,
    femaleFarmers: 0,
    trainedFarmers: 0,
    totalAnimals: 0,
    totalGoats: 0,
    totalSheep: 0,
    totalCattle: 0,
    totalGoatsPurchased: 0,
    countiesCovered: 0,
  },
  maintainedInfrastructure: EMPTY_DONUT_SEGMENTS,
  registrationComparison: EMPTY_DONUT_SEGMENTS,
  animalCensusComparison: {
    years: [],
    data: [],
  },
  vaccinationTrend: createEmptyYearlyTrend(),
  countyCoverage: EMPTY_COUNTY_COVERAGE,
  recentLocations: [],
  recentActivities: [],
  recentFarmers: [],
  pendingActivitiesCount: 0,
};

const OVERVIEW_CACHE_TTL_MS = 10 * 60 * 1000;
const CANONICAL_PROGRAMME_SET = new Set<string>(PROGRAMME_OPTIONS);

const buildOverviewCacheKey = (
  userId: string | null | undefined,
  programme: string | null | undefined,
  startDate: string,
  endDate: string,
) => cacheKey("overview-summary-v8", userId || "anon", programme || "none", startDate, endDate);

const getGreetingLabel = (date: Date): string => {
  const hour = Number(
    new Intl.DateTimeFormat("en", {
      hour: "numeric",
      hour12: false,
      timeZone: OVERVIEW_TIME_ZONE,
    }).format(date),
  );

  if (hour >= 0 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  return "Good evening";
};

const parseDate = (value: unknown): Date | null => {
  if (!value) return null;

  try {
    if (value instanceof Date) return value;
    if (typeof value === "number") {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    if (typeof value === "string") {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    if (typeof value === "object" && value !== null) {
      const record = value as { seconds?: number; toDate?: () => Date; _seconds?: number };
      if (typeof record.toDate === "function") {
        const parsed = record.toDate();
        return Number.isNaN(parsed.getTime()) ? null : parsed;
      }
      if (typeof record.seconds === "number") {
        const parsed = new Date(record.seconds * 1000);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
      }
      if (typeof record._seconds === "number") {
        const parsed = new Date(record._seconds * 1000);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
      }
    }
  } catch (error) {
    console.error("Failed to parse date:", error, value);
  }

  return null;
};

const getNumberField = (record: Record<string, unknown>, ...fields: string[]): number => {
  for (const field of fields) {
    const value = record[field];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value.replace(/,/g, "").trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
};

const parseBoolean = (value: unknown): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "yes" || normalized === "1";
  }
  return false;
};

const getArrayLikeSize = (value: unknown): number => {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).length;
  return 0;
};

const getGoatTotal = (goats: unknown): number => {
  if (typeof goats === "number" || typeof goats === "string") {
    return getNumberField({ goats }, "goats");
  }

  if (Array.isArray(goats)) {
    return goats.length;
  }

  if (goats && typeof goats === "object") {
    const record = goats as Record<string, unknown>;
    const directTotal = getNumberField(
      record,
      "total",
      "goats",
      "goat",
      "noOfGoats",
      "no of goats",
      "numberOfGoats",
      "goatsTotal",
      "totalGoats",
      "goatsCount",
      "goatCount",
    );

    if (directTotal > 0) {
      return directTotal;
    }

    return getNumberField(record, "male") + getNumberField(record, "female");
  }

  return 0;
};

const getFarmerGoatTotal = (record: Record<string, unknown>): number =>
  Math.max(
    getGoatTotal(record.goats ?? record.Goats),
    getNumberField(
      record,
      "goats",
      "goat",
      "noOfGoats",
      "no of goats",
      "numberOfGoats",
      "goatsTotal",
      "totalGoats",
      "goatsCount",
      "goatCount",
    ),
    getArrayLikeSize(record.goats),
    getArrayLikeSize(record.Goats),
    0,
  );

const getOfftakeGoatsTotal = (record: Record<string, unknown>): number =>
  Math.max(
    getNumberField(record, "totalGoats"),
    getNumberField(record, "goatsBought"),
    getNumberField(record, "goats"),
    getNumberField(record, "goat"),
    getNumberField(record, "noOfGoats"),
    getNumberField(record, "no of goats"),
    getNumberField(record, "numberOfGoats"),
    getArrayLikeSize(record.goats),
    getArrayLikeSize(record.Goats),
    0,
  );

const getActivityTotalDoses = (record: Record<string, unknown>): number => {
  if (Array.isArray(record.vaccines)) {
    return record.vaccines.reduce((sum, vaccine) => {
      if (!vaccine || typeof vaccine !== "object") return sum;
      return sum + getNumberField(vaccine as Record<string, unknown>, "doses");
    }, 0);
  }

  return getNumberField(record, "number_doses");
};

const getInfrastructureStatuses = (record: Record<string, unknown>) => ({
  drilled: parseBoolean(record.drilled ?? record.Drilled),
  equipped: parseBoolean(record.equipped ?? record.Equipped ?? record.equiped ?? record.Equiped),
  maintained: parseBoolean(
    record.maintained ??
    record.Maintained ??
    record.maintaned ??
    record.Maintaned ??
    record.rehabilitated ??
    record.Rehabilitated,
  ),
});

const getInfrastructureRecordDate = (record: Record<string, unknown>) =>
  parseDate(record.date ?? record.Date ?? record.created_at ?? record.createdAt);

const getActivityRecordDate = (record: Record<string, unknown>) =>
  parseDate(record.date ?? record.Date ?? record.created_at ?? record.createdAt);

const getFarmerVaccinationDate = (record: Record<string, unknown>) =>
  parseDate(
    record.vaccinationDate ??
    record.vaccination_date ??
    record.dateVaccinated ??
    record.date_vaccinated ??
    record.updatedAt ??
    record.updated_at,
  );

const getFarmerVisitDate = (record: Record<string, unknown>) =>
  parseDate(
    record.lastVisitedAt ??
    record.lastVisitDate ??
    record.visitDate ??
    record.updatedAt ??
    record.updated_at ??
    record.vaccinationDate ??
    record.vaccination_date ??
    record.createdAt ??
    record.registrationDate,
  );

const getFarmerRegistrationDate = (record: Record<string, unknown>) =>
  parseDate(
    record.createdAt ??
    record.created_at ??
    record.registrationDate ??
    record.registration_date ??
    record.registeredAt ??
    record.timestamp ??
    record.date,
  );

const getSeriesColor = (index: number): string => SERIES_COLORS[index % SERIES_COLORS.length];

const buildYearlySegments = (
  records: OverviewRecord[],
  getDateValue: (record: OverviewRecord) => Date | null,
  includeRecord: (record: OverviewRecord) => boolean = () => true,
): DonutSegment[] => {
  const yearCounts = new Map<number, number>();

  for (const record of records) {
    if (!includeRecord(record)) continue;
    const date = getDateValue(record);
    if (!date) continue;

    const year = date.getFullYear();
    yearCounts.set(year, (yearCounts.get(year) || 0) + 1);
  }

  return [...yearCounts.entries()]
    .sort(([leftYear], [rightYear]) => leftYear - rightYear)
    .map(([year, value], index) => ({
      name: String(year),
      value,
      color: getSeriesColor(index),
    }));
};

const buildYearlyTrend = (
  records: OverviewRecord[],
  getDateValue: (record: OverviewRecord) => Date | null,
  getValue: (record: OverviewRecord) => number,
  includeRecord: (record: OverviewRecord) => boolean = () => true,
): YearlyTrend => {
  const yearSet = new Set<number>();

  for (const record of records) {
    if (!includeRecord(record)) continue;
    const date = getDateValue(record);
    const value = getValue(record);
    if (!date || value <= 0) continue;
    yearSet.add(date.getFullYear());
  }

  const years = [...yearSet].sort((left, right) => left - right);
  const yearLookup = new Set(years);
  const data = MONTH_LABELS.map((name) => {
    const point: YearlyTrendPoint = { name };
    for (const year of years) {
      point[String(year)] = 0;
    }
    return point;
  });

  for (const record of records) {
    if (!includeRecord(record)) continue;
    const date = getDateValue(record);
    const value = getValue(record);
    if (!date || value <= 0) continue;

    const year = date.getFullYear();
    if (!yearLookup.has(year)) continue;

    const monthPoint = data[date.getMonth()];
    const key = String(year);
    const currentValue = typeof monthPoint[key] === "number" ? monthPoint[key] : 0;
    monthPoint[key] = currentValue + value;
  }

  return {
    years,
    data,
  };
};

const buildAnnualComparison = (
  farmers: OverviewRecord[],
  offtakes: OverviewRecord[],
): AnnualComparison => {
  const yearSet = new Set<number>();
  const goatsOnRecordByYear = new Map<number, number>();
  const goatsPurchasedByYear = new Map<number, number>();

  for (const farmer of farmers) {
    const date = parseDate(farmer.createdAt || farmer.registrationDate);
    if (!date) continue;

    const year = date.getFullYear();
    yearSet.add(year);
    goatsOnRecordByYear.set(year, (goatsOnRecordByYear.get(year) || 0) + getFarmerGoatTotal(farmer));
  }

  for (const record of offtakes) {
    const date = parseDate(record.date ?? record.Date ?? record.createdAt ?? record.created_at);
    if (!date) continue;

    const year = date.getFullYear();
    yearSet.add(year);
    goatsPurchasedByYear.set(year, (goatsPurchasedByYear.get(year) || 0) + getOfftakeGoatsTotal(record));
  }

  const years = [...yearSet].sort((left, right) => left - right);

  return {
    years,
    data: years.map((year) => ({
      name: String(year),
      goatsOnRecord: goatsOnRecordByYear.get(year) || 0,
      goatsPurchased: goatsPurchasedByYear.get(year) || 0,
    })),
  };
};

const buildInfrastructureComparison = (records: OverviewRecord[]): DonutSegment[] => {
  let drilled = 0;
  let equipped = 0;
  let maintained = 0;

  for (const record of records) {
    const statuses = getInfrastructureStatuses(record);
    if (statuses.drilled) drilled += 1;
    if (statuses.equipped) equipped += 1;
    if (statuses.maintained) maintained += 1;
  }

  return [
    { name: "Drilled", value: drilled, color: "#2710a1" },
    { name: "Equipped", value: equipped, color: "#0ea5e9" },
    { name: "Maintained", value: maintained, color: "#f89b0d" },
  ];
};

const getAnalyticsProgrammeToken = (value: unknown): string => {
  const normalized = normalizeProgramme(value);
  return normalized && CANONICAL_PROGRAMME_SET.has(normalized) ? normalized : "";
};

const getOverviewRecordProgramme = (record: OverviewRecord) =>
  getAnalyticsProgrammeToken(record.programme ?? record.Programme);

const normalizeDuplicateToken = (value: unknown): string =>
  String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

const isUsableIdentityValue = (value: unknown): boolean => {
  const normalized = normalizeDuplicateToken(value);
  return Boolean(normalized) && !["n/a", "na", "/a", "0", "0.0", "null", "undefined"].includes(normalized);
};

const getFarmerDuplicateKey = (record: OverviewRecord): string => {
  if (isUsableIdentityValue(record.idNumber)) return `id:${normalizeDuplicateToken(record.idNumber)}`;

  return [
    "profile",
    normalizeDuplicateToken(record.fullName || record.name || record.farmerName),
    normalizeDuplicateToken(record.county || record.region),
    normalizeDuplicateToken(record.subcounty),
    normalizeDuplicateToken(record.location),
  ].join(":");
};

const dedupeFarmers = (records: OverviewRecord[]): OverviewRecord[] => {
  const uniqueRecords = new Map<string, OverviewRecord>();

  [...records]
    .sort(
      (left, right) =>
        (parseDate(right.createdAt || right.registrationDate)?.getTime() || 0) -
        (parseDate(left.createdAt || left.registrationDate)?.getTime() || 0),
    )
    .forEach((record) => {
      const key = getFarmerDuplicateKey(record);
      if (!uniqueRecords.has(key)) uniqueRecords.set(key, record);
    });

  return Array.from(uniqueRecords.values());
};

const buildRecentLocations = (farmers: OverviewRecord[]): RecentLocation[] => {
  const seen = new Set<string>();

  return [...farmers]
    .map((record) => {
      const visitedDate = getFarmerVisitDate(record);
      const location = String(record.location || record.subcounty || record.county || record.region || "").trim();
      const county = String(record.county || record.region || "").trim();

      return {
        name: location || county || "Unknown location",
        county: county || "Unknown county",
        visitedAt: visitedDate ? visitedDate.toISOString() : "",
        timestamp: visitedDate?.getTime() || 0,
      };
    })
    .filter((entry) => entry.timestamp > 0 && Date.now() - entry.timestamp < RECENT_LOCATION_MAX_AGE_MS)
    .sort((left, right) => right.timestamp - left.timestamp)
    .filter((entry) => {
      const key = `${entry.name}|${entry.county}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4)
    .map(({ timestamp, ...entry }) => entry);
};

const buildRecentFarmers = (farmers: OverviewRecord[]): RecentFarmer[] =>
  [...farmers]
    .map((record) => ({
      id: String(record.id || ""),
      name: String(
        record.fullName ||
        record.name ||
        record.farmerName ||
        `${record.firstName || ""} ${record.lastName || ""}`.trim(),
      ).trim() || "Unknown farmer",
      county: String(record.county || record.region || "").trim() || "Unknown county",
      registeredAt: getFarmerRegistrationDate(record)?.toISOString() || "",
      gender: String(record.gender || "").trim(),
      goats: getFarmerGoatTotal(record),
    }))
    .filter((record) => parseDate(record.registeredAt))
    .sort(
      (left, right) =>
        (parseDate(right.registeredAt)?.getTime() || 0) -
        (parseDate(left.registeredAt)?.getTime() || 0),
    )
    .slice(0, 5);

const buildRecentActivities = (activities: OverviewRecord[]): RecentActivity[] =>
  [...activities]
    .map((record) => ({
      id: String(record.id || record.activityId || record.activityName || Math.random()),
      activityName: String(record.activityName || record.title || "Untitled activity").trim() || "Untitled activity",
      date: String(record.date || record.createdAt || ""),
      status: String(record.status || "pending").trim() || "pending",
      location: String(record.location || record.activityName || record.county || "Unknown location").trim() || "Unknown location",
      participants: Math.max(
        getNumberField(record, "numberOfPersons", "participantsCount"),
        getArrayLikeSize(record.participants),
        0,
      ),
    }))
    .filter((record) => parseDate(record.date))
    .sort((left, right) => (parseDate(right.date)?.getTime() || 0) - (parseDate(left.date)?.getTime() || 0))
    .slice(0, 3);

const buildOverviewSummaryFromRecords = ({
  farmers,
  capacity,
  offtakes,
  boreholes,
  activities,
}: OverviewCollections): OverviewSummaryData => {
  let maleFarmers = 0;
  let femaleFarmers = 0;
  let totalGoats = 0;
  let totalSheep = 0;
  let totalCattle = 0;
  const countyMap: Record<string, number> = {};

  for (const farmer of farmers) {
    const gender = String(farmer.gender || "").trim().toLowerCase();
    if (gender === "male") maleFarmers += 1;
    if (gender === "female") femaleFarmers += 1;

    totalGoats += getGoatTotal(farmer.goats);
    totalSheep += getNumberField(farmer, "sheep");
    totalCattle += getNumberField(farmer, "cattle");

    const county = String(farmer.county || farmer.region || "").trim();
    if (county) countyMap[county] = (countyMap[county] || 0) + 1;
  }

  const totalAnimals = totalGoats + totalSheep + totalCattle;
  const trainedFarmers = capacity.reduce(
    (sum, record) => sum + getNumberField(record, "totalFarmers", "trainedFarmers"),
    0,
  );
  const totalGoatsPurchased = offtakes.reduce(
    (sum, record) => sum + getOfftakeGoatsTotal(record),
    0,
  );
  const countyCoverage = Object.entries(countyMap)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4)
    .map(([name, value], index) => ({
      name,
      value,
      color: COUNTY_BAR_COLORS[index % COUNTY_BAR_COLORS.length],
    }));

  return {
    stats: {
      totalFarmers: farmers.length,
      maleFarmers,
      femaleFarmers,
      trainedFarmers,
      totalAnimals,
      totalGoats,
      totalSheep,
      totalCattle,
      totalGoatsPurchased,
      countiesCovered: Object.keys(countyMap).length,
    },
    maintainedInfrastructure: buildInfrastructureComparison(boreholes),
    registrationComparison: buildYearlySegments(
      farmers,
      (record) => parseDate(record.createdAt || record.registrationDate),
    ),
    animalCensusComparison: buildAnnualComparison(farmers, offtakes),
    vaccinationTrend: buildYearlyTrend(
      farmers,
      getFarmerVaccinationDate,
      (record) => Math.max(getFarmerGoatTotal(record), getNumberField(record, "goats"), 0),
      (record) => parseBoolean(record.vaccinated),
    ),
    countyCoverage: countyCoverage.length > 0 ? countyCoverage : EMPTY_COUNTY_COVERAGE,
    recentLocations: buildRecentLocations(farmers),
    recentActivities: buildRecentActivities(activities),
    recentFarmers: buildRecentFarmers(farmers),
    pendingActivitiesCount: activities.filter(
      (record) => String(record.status || "").trim().toLowerCase() === "pending",
    ).length,
  };
};

// -- Formatting helpers --------------------------------------------------

const toPercentage = (value: number, total: number): number => {
  if (total <= 0) return 0;
  return Number(((value / total) * 100).toFixed(1));
};

const getSafeNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, "").trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

const cloneDonutSegments = (segments: DonutSegment[]): DonutSegment[] =>
  segments.map((segment) => ({ ...segment }));

const sanitizeDonutSegments = (
  value: unknown,
  fallback: DonutSegment[] = EMPTY_DONUT_SEGMENTS,
): DonutSegment[] => {
  if (!Array.isArray(value) || value.length === 0) return cloneDonutSegments(fallback);

  return value.map((item, index) => {
    const segment = item && typeof item === "object" ? item as Partial<DonutSegment> : {};
    return {
      name: typeof segment.name === "string" && segment.name.trim() ? segment.name : `Item ${index + 1}`,
      value: getSafeNumber(segment.value),
      color:
        typeof segment.color === "string" && segment.color.trim()
          ? segment.color
          : fallback[index % fallback.length]?.color || SERIES_COLORS[0],
    };
  });
};

const cloneYearlyTrend = (trend: YearlyTrend): YearlyTrend => ({
  years: [...trend.years],
  data: trend.data.map((point) => ({ ...point })),
});

const cloneAnnualComparison = (comparison: AnnualComparison): AnnualComparison => ({
  years: [...comparison.years],
  data: comparison.data.map((point) => ({ ...point })),
});

const sanitizeYearlyTrend = (value: unknown, fallback: YearlyTrend = createEmptyYearlyTrend()): YearlyTrend => {
  if (!value || typeof value !== "object") return cloneYearlyTrend(fallback);

  const candidate = value as Partial<YearlyTrend>;
  if (!Array.isArray(candidate.years) || !Array.isArray(candidate.data) || candidate.data.length === 0) {
    return cloneYearlyTrend(fallback);
  }

  const years = Array.from(
    new Set(
      candidate.years
        .map((year) => getSafeNumber(year))
        .filter((year) => year > 0),
    ),
  ).sort((left, right) => left - right);

  if (years.length === 0) {
    return cloneYearlyTrend(fallback);
  }

  const data = candidate.data.map((item, index) => {
    const point = item && typeof item === "object" ? item as Partial<YearlyTrendPoint> : {};
    const nextPoint: YearlyTrendPoint = {
      name: typeof point.name === "string" && point.name.trim() ? point.name : MONTH_LABELS[index] || `Point ${index + 1}`,
    };

    for (const year of years) {
      nextPoint[String(year)] = getSafeNumber(point[String(year)]);
    }

    return nextPoint;
  });

  return {
    years,
    data,
  };
};

const sanitizeAnnualComparison = (
  value: unknown,
  fallback: AnnualComparison = EMPTY_OVERVIEW_DATA.animalCensusComparison,
): AnnualComparison => {
  if (!value || typeof value !== "object") return cloneAnnualComparison(fallback);

  const candidate = value as Partial<AnnualComparison>;
  if (!Array.isArray(candidate.years) || !Array.isArray(candidate.data) || candidate.data.length === 0) {
    return cloneAnnualComparison(fallback);
  }

  const years = Array.from(
    new Set(
      candidate.years
        .map((year) => getSafeNumber(year))
        .filter((year) => year > 0),
    ),
  ).sort((left, right) => left - right);

  if (years.length === 0) {
    return cloneAnnualComparison(fallback);
  }

  const data = years.map((year, index) => {
    const point = candidate.data[index] && typeof candidate.data[index] === "object"
      ? candidate.data[index] as Partial<AnnualComparisonPoint>
      : {};
    return {
      name: typeof point.name === "string" && point.name.trim() ? point.name : String(year),
      goatsOnRecord: getSafeNumber(point.goatsOnRecord),
      goatsPurchased: getSafeNumber(point.goatsPurchased),
    };
  });

  return {
    years,
    data,
  };
};

const sanitizeCountyCoverage = (value: unknown): CountyCoverage[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return EMPTY_COUNTY_COVERAGE.map((item) => ({ ...item }));
  }

  return value.map((item, index) => {
    const coverage = item && typeof item === "object" ? item as Partial<CountyCoverage> : {};
    return {
      name: typeof coverage.name === "string" && coverage.name.trim() ? coverage.name : `County ${index + 1}`,
      value: getSafeNumber(coverage.value),
      color:
        typeof coverage.color === "string" && coverage.color.trim()
          ? coverage.color
          : COUNTY_BAR_COLORS[index % COUNTY_BAR_COLORS.length],
    };
  });
};

const sanitizeRecentLocations = (value: unknown): RecentLocation[] => {
  if (!Array.isArray(value)) return [];

  return value.map((item, index) => {
    const location = item && typeof item === "object" ? item as Partial<RecentLocation> : {};
    return {
      name: typeof location.name === "string" && location.name.trim() ? location.name : `Location ${index + 1}`,
      county: typeof location.county === "string" && location.county.trim() ? location.county : "Unknown county",
      visitedAt: typeof location.visitedAt === "string" ? location.visitedAt : "",
    };
  });
};

const sanitizeRecentFarmers = (value: unknown): RecentFarmer[] => {
  if (!Array.isArray(value)) return [];

  return value.map((item, index) => {
    const farmer = item && typeof item === "object" ? item as Partial<RecentFarmer> : {};
    return {
      id: typeof farmer.id === "string" && farmer.id.trim() ? farmer.id : `farmer-${index + 1}`,
      name: typeof farmer.name === "string" && farmer.name.trim() ? farmer.name : "Unknown farmer",
      county: typeof farmer.county === "string" && farmer.county.trim() ? farmer.county : "Unknown county",
      registeredAt: typeof farmer.registeredAt === "string" ? farmer.registeredAt : "",
      gender: typeof farmer.gender === "string" && farmer.gender.trim() ? farmer.gender : "",
      goats: getSafeNumber(farmer.goats),
    };
  });
};

const sanitizeRecentActivities = (value: unknown): RecentActivity[] => {
  if (!Array.isArray(value)) return [];

  return value.map((item, index) => {
    const activity = item && typeof item === "object" ? item as Partial<RecentActivity> : {};
    return {
      id: typeof activity.id === "string" && activity.id.trim() ? activity.id : `activity-${index + 1}`,
      activityName:
        typeof activity.activityName === "string" && activity.activityName.trim()
          ? activity.activityName
          : "Untitled activity",
      date: typeof activity.date === "string" ? activity.date : "",
      status: typeof activity.status === "string" && activity.status.trim() ? activity.status : "pending",
      location:
        typeof activity.location === "string" && activity.location.trim()
          ? activity.location
          : "Unknown location",
      participants: getSafeNumber(activity.participants),
    };
  });
};

const hasLegacyYearLabels = (segments: DonutSegment[]): boolean =>
  segments.some((segment) => /^Year\s+\d+$/i.test(segment.name.trim()));

const sanitizeOverviewSummary = (value: unknown): OverviewSummaryData => {
  if (!value || typeof value !== "object") return EMPTY_OVERVIEW_DATA;

  const data = value as Partial<OverviewSummaryData> & {
    stats?: Partial<OverviewSummaryData["stats"]>;
  };
  const stats: Partial<OverviewStats> | undefined =
    data.stats && typeof data.stats === "object"
      ? data.stats as Partial<OverviewStats>
      : undefined;

  return {
    stats: {
      totalFarmers: getSafeNumber(stats?.totalFarmers),
      maleFarmers: getSafeNumber(stats?.maleFarmers),
      femaleFarmers: getSafeNumber(stats?.femaleFarmers),
      trainedFarmers: getSafeNumber(stats?.trainedFarmers),
      totalAnimals: getSafeNumber(stats?.totalAnimals),
      totalGoats: getSafeNumber(stats?.totalGoats),
      totalSheep: getSafeNumber(stats?.totalSheep),
      totalCattle: getSafeNumber(stats?.totalCattle),
      totalGoatsPurchased: getSafeNumber(stats?.totalGoatsPurchased),
      countiesCovered: getSafeNumber(stats?.countiesCovered),
    },
    maintainedInfrastructure: sanitizeDonutSegments(data.maintainedInfrastructure, EMPTY_DONUT_SEGMENTS),
    registrationComparison: sanitizeDonutSegments(data.registrationComparison, EMPTY_DONUT_SEGMENTS),
    animalCensusComparison: sanitizeAnnualComparison(
      (data as Partial<OverviewSummaryData> & { animalCensusVsPurchased?: unknown }).animalCensusComparison ??
        (data as Partial<OverviewSummaryData> & { animalCensusVsPurchased?: unknown }).animalCensusVsPurchased,
      EMPTY_OVERVIEW_DATA.animalCensusComparison,
    ),
    vaccinationTrend: sanitizeYearlyTrend(data.vaccinationTrend, EMPTY_OVERVIEW_DATA.vaccinationTrend),
    countyCoverage: sanitizeCountyCoverage(data.countyCoverage),
    recentLocations: sanitizeRecentLocations(data.recentLocations),
    recentActivities: sanitizeRecentActivities(data.recentActivities),
    recentFarmers: sanitizeRecentFarmers((data as Partial<OverviewSummaryData> & { recentFarmers?: unknown }).recentFarmers),
    pendingActivitiesCount: getSafeNumber(data.pendingActivitiesCount),
  };
};

const hasMeaningfulOverviewData = (value: unknown): boolean => {
  const data = sanitizeOverviewSummary(value);

  if (hasLegacyYearLabels(data.maintainedInfrastructure) || hasLegacyYearLabels(data.registrationComparison)) {
    return false;
  }

  return (
    data.stats.totalFarmers > 0 ||
    data.stats.trainedFarmers > 0 ||
    data.stats.totalAnimals > 0 ||
    data.stats.totalGoatsPurchased > 0 ||
    data.maintainedInfrastructure.some((item) => item.value > 0) ||
    data.registrationComparison.some((item) => item.value > 0) ||
    (data.animalCensusComparison.years.length > 0 && data.animalCensusComparison.data.some((point) => point.goatsOnRecord > 0 || point.goatsPurchased > 0)) ||
    (data.vaccinationTrend.years.length > 0 && data.vaccinationTrend.data.some((point) => data.vaccinationTrend.years.some((year) => getSafeNumber(point[String(year)]) > 0))) ||
    data.countyCoverage.some((item) => item.value > 0) ||
    data.recentLocations.length > 0 ||
    data.recentActivities.length > 0 ||
    data.recentFarmers.length > 0
  );
};

const formatWholeNumber = (value: unknown) => getSafeNumber(value).toLocaleString();

const formatCompactNumber = (value: unknown): string => {
  const num = getSafeNumber(value);
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return formatWholeNumber(num);
};

const formatProgressLabel = (value: unknown, description: string) =>
  description ? `${getSafeNumber(value).toFixed(1)}% ${description}` : `${getSafeNumber(value).toFixed(1)}%`;

const formatActivityDate = (value: string): string => {
  const date = parseDate(value);
  if (!date) return "Unknown date";
  return activityDateFormatter.format(date);
};

const formatFarmerRegisteredDate = (value: string): string => {
  const date = parseDate(value);
  if (!date) return "Unknown date";
  return farmerRegisteredDateFormatter.format(date);
};

const formatActivityStatus = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "Pending";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
};

const formatRelativeTime = (value: string): string => {
  const date = parseDate(value);
  if (!date) return "Unknown";

  const diffMs = date.getTime() - Date.now();
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 24 * 60 * 60 * 1000],
    ["hour", 60 * 60 * 1000],
    ["minute", 60 * 1000],
  ];

  for (const [unit, size] of units) {
    if (Math.abs(diffMs) >= size || unit === "minute") {
      return relativeTimeFormatter.format(Math.round(diffMs / size), unit);
    }
  }

  return "just now";
};

// -- Shared UI primitives ------------------------------------------------

const TopMetricCard = ({
  title,
  value,
  icon,
  accentColor,
  progressValue,
  progressLabel,
  detail,
}: {
  title: string;
  value: number;
  icon: ReactNode;
  accentColor: string;
  progressValue: number;
  progressLabel: string;
  detail?: ReactNode;
}) => (
  <div
    className="rounded-[18px] border border-l-4 border-slate-200 bg-white px-4 py-4 shadow-[0_8px_30px_rgba(15,23,42,0.05)] sm:px-5"
    style={{ borderLeftColor: accentColor }}
  >
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-1.5">
        <p className={`text-sm font-medium tracking-[-0.02em] ${SECONDARY_TEXT_CLASS}`}>{title}</p>
        <p className="text-[21px] font-semibold leading-none tracking-[-0.04em] text-slate-950 sm:text-[30px]">
          {formatCompactNumber(value)}
        </p>
      </div>
      <div className="mt-0.5 shrink-0">{icon}</div>
    </div>

    <div className={`mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] leading-tight sm:text-xs ${SECONDARY_TEXT_CLASS}`}>
      <span className={`shrink-0 whitespace-nowrap font-semibold ${SECONDARY_TEXT_CLASS}`}>{progressLabel}</span>
      {detail}
    </div>

    <div className="mt-3 h-[6px] rounded-full bg-slate-100">
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${Math.min(progressValue, 100)}%`, backgroundColor: accentColor }}
      />
    </div>
  </div>
);

const OverviewPanel = ({
  title,
  children,
  className = "",
  headerExtra,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  headerExtra?: ReactNode;
}) => (
  <div className={`rounded-[24px] border border-slate-200 bg-white p-5 shadow-[0_10px_35px_rgba(15,23,42,0.04)] sm:p-6 ${className}`}>
    <div className="flex items-start justify-between gap-4">
      <h2 className={`text-[13px] font-medium uppercase tracking-[-0.01em] ${SECONDARY_TEXT_CLASS}`}>{title}</h2>
      {headerExtra}
    </div>
    {children}
  </div>
);

// -- Chart panels --------------------------------------------------------

const YearTrendPanel = ({
  title,
  trend,
  tooltipValueLabel = "records",
}: {
  title: string;
  trend: YearlyTrend;
  tooltipValueLabel?: string;
}) => {
  const hasValues =
    trend.years.length > 0 &&
    trend.data.some((point) => trend.years.some((year) => getSafeNumber(point[String(year)]) > 0));

  return (
    <OverviewPanel title={title} className="flex h-full min-h-[360px] flex-col">
      <div className="mt-5 flex-1">
        {hasValues ? (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={trend.data} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
              <defs>
                {trend.years.map((year, index) => {
                  const color = getSeriesColor(index);
                  return (
                    <linearGradient key={year} id={`overviewTrendFill-${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${year}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={color} stopOpacity={index === trend.years.length - 1 ? 0.58 : 0.1} />
                      <stop offset="100%" stopColor={color} stopOpacity={0.03} />
                    </linearGradient>
                  );
                })}
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
              <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fill: "#9ca3af", fontSize: 12 }} />
              <YAxis tickLine={false} axisLine={false} tick={{ fill: "#9ca3af", fontSize: 12 }} />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;

                  const entries = payload
                    .map((item, index) => {
                      const seriesYear = String(item.dataKey ?? "");
                      const value = getSafeNumber(item.value);
                      const color = typeof item.color === "string" ? item.color : getSeriesColor(index);
                      return { seriesYear, value, color };
                    })
                    .filter((item) => item.seriesYear && item.value > 0);

                  if (entries.length === 0) return null;

                  return (
                    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-[0_12px_28px_rgba(15,23,42,0.12)]">
                      <p className={`text-xs ${SECONDARY_TEXT_CLASS}`}>{String(label)}</p>
                      <div className="mt-2 space-y-1">
                        {entries.map((entry) => (
                          <div key={entry.seriesYear} className="flex items-center justify-between gap-4">
                            <div className="flex items-center gap-2">
                              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: entry.color }} />
                              <span className="text-sm font-medium text-slate-700">{entry.seriesYear}</span>
                            </div>
                            <span className="text-sm font-semibold text-slate-900">
                              {formatWholeNumber(entry.value)} {tooltipValueLabel}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                }}
              />
              {trend.years.map((year, index) => {
                const color = getSeriesColor(index);
                const gradientId = `overviewTrendFill-${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${year}`;
                const isLatestYear = index === trend.years.length - 1;

                return (
                  <Area
                    key={year}
                    type="monotone"
                    dataKey={String(year)}
                    stroke={color}
                    strokeWidth={2.5}
                    fill={isLatestYear ? `url(#${gradientId})` : "none"}
                    fillOpacity={isLatestYear ? 1 : 0}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                );
              })}
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className={`flex h-[260px] items-center justify-center text-sm ${SECONDARY_TEXT_CLASS}`}>
            No data available yet
          </div>
        )}
      </div>
    </OverviewPanel>
  );
};

const AnnualComparisonPanel = ({
  title,
  comparison,
}: {
  title: string;
  comparison: AnnualComparison;
}) => {
  const hasValues =
    comparison.years.length > 0 &&
    comparison.data.some((point) => point.goatsOnRecord > 0 || point.goatsPurchased > 0);

  return (
    <OverviewPanel title={title} className="flex h-full min-h-[360px] flex-col">
      <div className="mt-5 flex-1">
        {hasValues ? (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={comparison.data} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="overviewAnimalCensusRecordFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2710a1" stopOpacity={0.55} />
                  <stop offset="100%" stopColor="#2710a1" stopOpacity={0.05} />
                </linearGradient>
                <linearGradient id="overviewAnimalCensusPurchasedFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f89b0d" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="#f89b0d" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
              <XAxis hide dataKey="name" />
              <YAxis tickLine={false} axisLine={false} tick={{ fill: "#9ca3af", fontSize: 12 }} />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;

                  const entries = payload
                    .map((item, index) => {
                      const key = String(item.dataKey ?? "");
                      const value = getSafeNumber(item.value);
                      const color = typeof item.color === "string" ? item.color : getSeriesColor(index);
                      const name = key === "goatsOnRecord" ? "Goats on record" : key === "goatsPurchased" ? "Goats purchased" : key;
                      return { name, value, color };
                    })
                    .filter((item) => item.name && item.value > 0);

                  if (entries.length === 0) return null;

                  return (
                    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-[0_12px_28px_rgba(15,23,42,0.12)]">
                      <p className={`text-xs ${SECONDARY_TEXT_CLASS}`}>{String(label)}</p>
                      <div className="mt-2 space-y-1">
                        {entries.map((entry) => (
                          <div key={entry.name} className="flex items-center justify-between gap-4">
                            <div className="flex items-center gap-2">
                              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: entry.color }} />
                              <span className="text-sm font-medium text-slate-700">{entry.name}</span>
                            </div>
                            <span className="text-sm font-semibold text-slate-900">{formatWholeNumber(entry.value)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                }}
              />
              <Area
                type="monotone"
                dataKey="goatsOnRecord"
                stroke="#2710a1"
                strokeWidth={2.5}
                fill="url(#overviewAnimalCensusRecordFill)"
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Area
                type="monotone"
                dataKey="goatsPurchased"
                stroke="#f89b0d"
                strokeWidth={2.5}
                fill="url(#overviewAnimalCensusPurchasedFill)"
                dot={false}
                activeDot={{ r: 4 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className={`flex h-[260px] items-center justify-center text-sm ${SECONDARY_TEXT_CLASS}`}>
            No data available yet
          </div>
        )}
      </div>
    </OverviewPanel>
  );
};

const DonutPanel = ({
  title,
  data,
  headerExtra,
  tooltipValueLabel = "records",
  legendItems,
}: {
  title: string;
  data: DonutSegment[];
  headerExtra?: ReactNode;
  tooltipValueLabel?: string;
  legendItems?: Array<Pick<DonutSegment, "name" | "color">>;
}) => {
  const hasValues = data.some((item) => item.value > 0);
  const chartData = hasValues ? data : [{ name: "No data", value: 1, color: "#e2e8f0" }];

  return (
    <OverviewPanel title={title} className="flex h-full min-h-[360px] flex-col" headerExtra={headerExtra}>
      <div className="mt-4 flex-1">
        <ResponsiveContainer width="100%" height={260}>
          <PieChart>
            <Tooltip
              content={({ active, payload }) => {
                const segment = payload?.[0]?.payload as DonutSegment | undefined;
                if (!active || !segment || !hasValues) return null;

                return (
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-[0_12px_28px_rgba(15,23,42,0.12)]">
                    <div className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: segment.color }} />
                      <span className="text-sm font-medium text-slate-700">{segment.name}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="text-sm font-semibold text-slate-900">
                        {formatWholeNumber(segment.value)} {tooltipValueLabel}
                      </span>
                    </div>
                  </div>
                );
              }}
              />
            <Pie
              data={chartData}
              dataKey="value"
              nameKey="name"
              innerRadius={72}
              outerRadius={104}
              paddingAngle={0}
              stroke="none"
            >
              {chartData.map((entry) => (
                <Cell key={entry.name} fill={entry.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
      {hasValues && legendItems?.length ? (
        <div className="mt-3 flex flex-wrap justify-center gap-3">
          {legendItems.map((item) => (
            <div key={item.name} className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
              <span>{item.name}</span>
            </div>
          ))}
        </div>
      ) : null}
      {!hasValues ? (
        <p className={`mt-3 text-center text-sm ${SECONDARY_TEXT_CLASS}`}>No data available yet</p>
      ) : null}
    </OverviewPanel>
  );
};

const CountiesCoveredPanel = ({ data }: { data: CountyCoverage[] }) => {
  const maxValue = Math.max(...data.map((item) => item.value), 1);

  return (
    <OverviewPanel title="COUNTIES COVERED" className="h-full min-h-[360px]">
      <div className="mt-10 space-y-5">
        {data.map((item, index) => (
          <div key={`${item.name}-${index}`} className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-xs uppercase tracking-[0.12em] text-gray-400">
              <span className="truncate">{item.name}</span>
              <span>{formatWholeNumber(item.value)}</span>
            </div>
            <div className="h-4 rounded-full bg-slate-100">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${(item.value / maxValue) * 100}%`,
                  backgroundColor: item.color,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </OverviewPanel>
  );
};

// -- NEW: Recently Registered Farmers panel ------------------------------

const RecentFarmersPanel = ({ farmers }: { farmers: RecentFarmer[] }) => (
  <div className="flex h-full min-h-[360px] flex-col rounded-[24px] border border-slate-200 bg-white p-6 shadow-[0_10px_35px_rgba(15,23,42,0.04)]">
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-slate-900">
          Recently Registered Farmers
        </h2>
        <p className={`mt-0.5 text-xs ${SECONDARY_TEXT_CLASS}`}>Latest 5 registrations</p>
      </div>
      <Link
        to="/dashboard/livestock"
        className={`inline-flex items-center gap-1 text-xs font-medium ${SECONDARY_TEXT_CLASS} transition-colors hover:text-gray-600`}
      >
        <span>View All</span>
        <ArrowRight className="h-3 w-3" />
      </Link>
    </div>

    {farmers.length > 0 ? (
      <div className="mt-5 flex-1 overflow-hidden">
        {/* Desktop table */}
        <div className="hidden overflow-x-auto rounded-2xl border border-slate-100 sm:block">
          <div className="min-w-[620px]">
            <div className={`grid grid-cols-[minmax(180px,1.5fr)_minmax(140px,1fr)_80px_130px] items-center gap-4 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-[0.06em] ${SECONDARY_TEXT_CLASS}`}>
              <span className="whitespace-nowrap">Farmer Name</span>
              <span className="whitespace-nowrap">County</span>
              <span className="whitespace-nowrap text-right">Goats</span>
              <span className="whitespace-nowrap">Registered</span>
            </div>

            {farmers.map((farmer, index) => {
              const genderInitial = farmer.gender.trim().toLowerCase();
              const avatarBg =
                genderInitial === "female"
                  ? "bg-pink-100 text-pink-600"
                  : genderInitial === "male"
                    ? "bg-blue-100 text-blue-600"
                    : "bg-slate-100 text-slate-500";

              return (
                <div
                  key={`${farmer.id}-${farmer.registeredAt}-${index}`}
                  className={`grid grid-cols-[minmax(180px,1.5fr)_minmax(140px,1fr)_80px_130px] items-center gap-4 border-t border-slate-100 px-5 py-3.5 text-sm ${SECONDARY_TEXT_CLASS}`}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${avatarBg}`}
                    >
                      {farmer.name.charAt(0).toUpperCase()}
                    </span>
                    <span className="truncate font-medium text-slate-800">
                      {farmer.name}
                    </span>
                  </div>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <span className="truncate">{farmer.county}</span>
                  </div>
                  <div className="text-right font-semibold tabular-nums text-slate-700">
                    {formatWholeNumber(farmer.goats)}
                  </div>
                  <div className="flex items-center gap-1.5 whitespace-nowrap">
                    <Clock3 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <span className="text-xs">{formatFarmerRegisteredDate(farmer.registeredAt)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Mobile card list */}
        <div className="space-y-3 sm:hidden">
          {farmers.map((farmer, index) => {
            const genderInitial = farmer.gender.trim().toLowerCase();
            const avatarBg =
              genderInitial === "female"
                ? "bg-pink-100 text-pink-600"
                : genderInitial === "male"
                  ? "bg-blue-100 text-blue-600"
                  : "bg-slate-100 text-slate-500";

            return (
              <div
                key={`${farmer.id}-${farmer.registeredAt}-${index}`}
                className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/50 px-4 py-3"
              >
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${avatarBg}`}
                >
                  {farmer.name.charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-800">{farmer.name}</p>
                  <div className={`mt-0.5 flex items-center gap-3 text-xs ${SECONDARY_TEXT_CLASS}`}>
                    <span className="flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      {farmer.county}
                    </span>
                    <span className="font-medium text-slate-600">
                      {formatWholeNumber(farmer.goats)} goats
                    </span>
                  </div>
                </div>
                <span className={`shrink-0 text-[11px] ${SECONDARY_TEXT_CLASS}`}>
                  {formatRelativeTime(farmer.registeredAt)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    ) : (
      <div className={`flex flex-1 items-center justify-center text-sm ${SECONDARY_TEXT_CLASS}`}>
        No recent registrations available yet.
      </div>
    )}
  </div>
);

// -- Existing side-panels ------------------------------------------------

const RecentLocationsPanel = ({ locations }: { locations: RecentLocation[] }) => (
  <div className="flex h-full min-h-[360px] flex-col rounded-[24px] border border-slate-200 bg-white p-6 shadow-[0_10px_35px_rgba(15,23,42,0.04)]">
    <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-slate-900">Recently Visited Locations</h2>

    {locations.length > 0 ? (
      <div className="mt-7 overflow-hidden rounded-2xl border border-slate-100">
        <div className={`grid grid-cols-[minmax(0,1fr)_130px] items-center gap-4 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-[0.06em] ${SECONDARY_TEXT_CLASS}`}>
          <span>Location</span>
          <span className="whitespace-nowrap">Time</span>
        </div>
        {locations.map((location) => (
          <div
            key={`${location.name}-${location.visitedAt}`}
            className="grid grid-cols-[minmax(0,1fr)_130px] items-center gap-4 border-t border-slate-100 px-4 py-4"
          >
            <div className="flex min-w-0 items-center gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-50">
                <MapPin className="h-5 w-5 text-emerald-500" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-[16px] font-medium text-slate-800">{location.name}</p>
                <p className={`truncate text-sm ${SECONDARY_TEXT_CLASS}`}>{location.county}</p>
              </div>
            </div>

            <div className={`flex items-center gap-2 whitespace-nowrap text-sm ${SECONDARY_TEXT_CLASS}`}>
              <Clock3 className="h-4 w-4 shrink-0" />
              <span className="tabular-nums">{formatRelativeTime(location.visitedAt)}</span>
            </div>
          </div>
        ))}
      </div>
    ) : (
      <div className={`flex flex-1 items-center justify-center text-sm ${SECONDARY_TEXT_CLASS}`}>
        No recent locations available yet.
      </div>
    )}
  </div>
);

const RecentActivitiesPanel = ({ activities }: { activities: RecentActivity[] }) => (
  <div className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
    <div className="flex items-center justify-between gap-4 border-b border-slate-100 bg-gradient-to-r from-slate-50 via-white to-slate-50 px-6 py-6 sm:px-8">
      <div className="flex items-center gap-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-r from-[#4f7cff] to-[#9333ea] text-white shadow-[0_12px_24px_rgba(99,102,241,0.28)]">
          <Activity className="h-5 w-5" />
        </div>
        <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-slate-900">Recent Activities</h2>
      </div>

      <Link
        to="/dashboard/activities"
        className={`inline-flex items-center gap-2 text-base font-medium ${SECONDARY_TEXT_CLASS} transition-colors hover:text-gray-600`}
      >
        <span>View All</span>
        <ArrowRight className="h-4 w-4" />
      </Link>
    </div>

    <div className="px-6 py-7 sm:px-8">
      {activities.length > 0 ? (
        <div className="overflow-x-auto">
          <div className="min-w-[860px] overflow-hidden rounded-[24px] border border-slate-100 bg-white shadow-[0_14px_34px_rgba(15,23,42,0.09)]">
            <div className={`grid grid-cols-[minmax(0,1.8fr)_minmax(110px,0.9fr)_minmax(110px,0.8fr)_minmax(120px,1fr)_minmax(90px,0.7fr)] gap-4 bg-slate-50 px-5 py-5 text-sm font-semibold ${SECONDARY_TEXT_CLASS}`}>
              <span>Activity Name</span>
              <span>Date</span>
              <span>Status</span>
              <span>Location</span>
              <span>Participants</span>
            </div>

            {activities.map((activity, index) => {
              const normalizedStatus = activity.status.trim().toLowerCase();
              const statusClasses = normalizedStatus === "completed"
                ? "bg-emerald-100 text-emerald-700"
                : "bg-amber-100 text-amber-700";

              return (
                <div
                  key={`${activity.id}-${activity.date}-${index}`}
                  className={`grid grid-cols-[minmax(0,1.8fr)_minmax(110px,0.9fr)_minmax(110px,0.8fr)_minmax(120px,1fr)_minmax(90px,0.7fr)] gap-4 border-t border-slate-100 px-5 py-5 text-sm ${SECONDARY_TEXT_CLASS}`}
                >
                  <div className="flex items-center gap-4">
                    <span className="h-3 w-3 rounded-full bg-gradient-to-r from-[#4f7cff] to-[#9333ea]" />
                    <span className="truncate text-[16px] font-medium text-gray-600">{activity.activityName}</span>
                  </div>
                  <div className="flex items-center">
                    <span className="rounded-full bg-blue-100 px-3 py-1 text-sm font-semibold text-blue-700">
                      {formatActivityDate(activity.date)}
                    </span>
                  </div>
                  <div className="flex items-center">
                    <span className={`rounded-full px-3 py-1 text-sm font-semibold ${statusClasses}`}>
                      {formatActivityStatus(activity.status)}
                    </span>
                  </div>
                  <div className={`flex items-center gap-2 text-[16px] ${SECONDARY_TEXT_CLASS}`}>
                    <MapPin className={`h-4 w-4 ${SECONDARY_TEXT_CLASS}`} />
                    <span className="truncate">{activity.location}</span>
                  </div>
                  <div className={`flex items-center gap-2 text-[16px] font-semibold ${SECONDARY_TEXT_CLASS}`}>
                    <UsersRound className={`h-4 w-4 ${SECONDARY_TEXT_CLASS}`} />
                    <span>{formatWholeNumber(activity.participants)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className={`flex min-h-[220px] items-center justify-center rounded-[24px] border border-dashed border-slate-200 bg-slate-50 text-sm ${SECONDARY_TEXT_CLASS}`}>
          No recent activities available yet.
        </div>
      )}

      <div className="mt-8 flex flex-col gap-4 border-t border-slate-200 pt-8 sm:flex-row sm:items-center sm:justify-between">
        <Button
          asChild
          variant="outline"
          className={`h-12 rounded-2xl border-slate-300 bg-white px-6 text-base font-medium ${SECONDARY_TEXT_CLASS} hover:bg-slate-50 hover:text-gray-600`}
        >
          <Link to="/dashboard/activities">
            <Eye className="h-4 w-4" />
            View All Activities
          </Link>
        </Button>

        <Button
          asChild
          className="h-12 rounded-2xl bg-gradient-to-r from-[#4f7cff] to-[#9333ea] px-6 text-base font-semibold text-white shadow-[0_16px_32px_rgba(99,102,241,0.28)] hover:from-[#4370ec] hover:to-[#8429d6]"
        >
          <Link to="/dashboard/activities">
            <Plus className="h-4 w-4" />
            Schedule Activity
          </Link>
        </Button>
      </div>
    </div>
  </div>
);

// -- Loading skeleton ----------------------------------------------------

const OverviewLoading = () => (
  <div className="space-y-6">
    <div className="grid gap-4 md:grid-cols-3">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="rounded-[20px] border border-slate-200 bg-white p-6">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-4 h-10 w-24" />
          <Skeleton className="mt-6 h-4 w-52" />
          <Skeleton className="mt-4 h-2 w-full rounded-full" />
        </div>
      ))}
    </div>

    <div className="grid gap-6 lg:grid-cols-2">
      <Skeleton className="h-[360px] rounded-[24px]" />
      <Skeleton className="h-[360px] rounded-[24px]" />
    </div>

    <div className="grid gap-6 lg:grid-cols-2">
      <Skeleton className="h-[360px] rounded-[24px]" />
      <Skeleton className="h-[360px] rounded-[24px]" />
    </div>

    <div className="grid gap-6 lg:grid-cols-2">
      <Skeleton className="h-[360px] rounded-[24px]" />
      <Skeleton className="h-[360px] rounded-[24px]" />
    </div>
  </div>
);

// -- Recent Offtakes Canvas -----------------------------------------------

const RecentOfftakesCanvas = ({ offtakes }: { offtakes: OverviewRecord[] }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;

    // Background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);

    // Take the 8 most recent offtakes
    const recent = [...offtakes]
      .sort((a, b) => {
        const da = new Date(a.date ?? a.Date ?? a.createdAt ?? 0).getTime();
        const db = new Date(b.date ?? b.Date ?? b.createdAt ?? 0).getTime();
        return db - da;
      })
      .slice(0, 8);

    if (recent.length === 0) {
      ctx.fillStyle = "#94a3b8";
      ctx.font = "13px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No recent offtakes", W / 2, H / 2);
      return;
    }

    const padding = { top: 30, right: 20, bottom: 60, left: 20 };
    const chartW = W - padding.left - padding.right;
    const chartH = H - padding.top - padding.bottom;
    const maxVal = Math.max(...recent.map((r) => {
      const g = r.goats_purchased ?? r.goatsPurchased ?? 0;
      return typeof g === "number" ? g : parseInt(String(g)) || 0;
    }), 1);
    const barGap = 6;
    const barWidth = Math.min(40, (chartW - barGap * (recent.length - 1)) / recent.length);

    // Title
    ctx.fillStyle = "#334155";
    ctx.font = "bold 13px Inter, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Recent Offtakes", padding.left, 18);

    const startX = padding.left + (chartW - (barWidth * recent.length + barGap * (recent.length - 1))) / 2;

    recent.forEach((record) => {
      const goats = record.goats_purchased ?? record.goatsPurchased ?? 0;
      const val = typeof goats === "number" ? goats : parseInt(String(goats)) || 0;
      const barH = (val / maxVal) * chartH;
      const x = startX + recent.indexOf(record) * (barWidth + barGap);
      const y = padding.top + chartH - barH;

      // Bar with gradient
      const grad = ctx.createLinearGradient(x, y, x, y + barH);
      grad.addColorStop(0, "#3b82f6");
      grad.addColorStop(1, "#1d4ed8");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barH, [4, 4, 0, 0]);
      ctx.fill();

      // Value on top
      ctx.fillStyle = "#1e293b";
      ctx.font = "bold 10px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(val), x + barWidth / 2, y - 6);

      // Date label
      const dateStr = record.date ?? record.Date ?? record.createdAt ?? "";
      const d = new Date(dateStr);
      let label = "";
      if (!isNaN(d.getTime())) {
        label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      } else {
        label = String(dateStr).slice(0, 6);
      }
      ctx.fillStyle = "#64748b";
      ctx.font = "9px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.save();
      ctx.translate(x + barWidth / 2, padding.top + chartH + 10);
      ctx.rotate(-0.4);
      ctx.fillText(label, 0, 0);
      ctx.restore();
    });

    // "Animals Purchased" subtitle
    ctx.fillStyle = "#94a3b8";
    ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Animals Purchased", W / 2, H - 8);
  }, [offtakes]);

  return (
    <div className="flex h-full min-h-[360px] flex-col rounded-[24px] border border-slate-200 bg-white p-6 shadow-[0_10px_35px_rgba(15,23,42,0.04)]">
      <div className="flex items-start justify-between gap-4 mb-1">
        <div>
          <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-slate-900">
            Recent Offtakes
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">Latest purchases overview</p>
        </div>
        <Link
          to="/dashboard/livestock-offtake"
          className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 transition-colors hover:text-gray-600"
        >
          <span>View All</span>
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <div className="flex-1 mt-2">
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: "calc(100% - 8px)" }}
          className="block"
        />
      </div>
    </div>
  );
};

// -- Main component ------------------------------------------------------

const DashboardOverview = () => {
  const { user, userRole, userAttribute, userName, allowedProgrammes, loading } = useAuth();
  const userCanViewAllProgrammeData = useMemo(
    () => canViewAllProgrammes(userRole, userAttribute, allowedProgrammes),
    [allowedProgrammes, userAttribute, userRole],
  );

  const accessibleProgrammes = useMemo(
    () => resolveAccessibleProgrammes(userCanViewAllProgrammeData, allowedProgrammes),
    [allowedProgrammes, userCanViewAllProgrammeData],
  );
  const canSwitchProgrammes = accessibleProgrammes.length > 1;

  const [selectedProgramme, setSelectedProgramme] = useSharedProgrammeSelection(accessibleProgrammes, {
    allowAll: accessibleProgrammes.length > 1,
    fallbackToAll: accessibleProgrammes.length > 1,
  });
  const appliedDefaultProgrammeRef = useRef(false);

  useEffect(() => {
    if (appliedDefaultProgrammeRef.current || accessibleProgrammes.length <= 1) return;
    appliedDefaultProgrammeRef.current = true;
    setSelectedProgramme(ALL_PROGRAMMES_VALUE);
  }, [accessibleProgrammes.length, setSelectedProgramme]);

  // -- Local overview state -----------------------------------------------
  const [localOverviewState, setLocalOverviewState] = useState<{
    key: string;
    data: OverviewSummaryData | null;
  }>({
    key: "",
    data: null,
  });
  const [localOverviewLoading, setLocalOverviewLoading] = useState(false);
  const currentMonthRange = useMemo(() => getCurrentMonthDateRange(), []);

  const overviewCacheStorageKey = useMemo(
    () => buildOverviewCacheKey(
      user?.uid,
      selectedProgramme || null,
      currentMonthRange.startDate,
      currentMonthRange.endDate,
    ),
    [currentMonthRange.endDate, currentMonthRange.startDate, selectedProgramme, user?.uid],
  );

  const cachedOverviewData = useMemo(
    () => {
      if (!selectedProgramme) return null;
      const cached = readCachedValue<OverviewSummaryData>(overviewCacheStorageKey, OVERVIEW_CACHE_TTL_MS);
      return cached ? sanitizeOverviewSummary(cached) : null;
    },
    [overviewCacheStorageKey, selectedProgramme],
  );

  const localOverviewData = localOverviewState.key === overviewCacheStorageKey ? localOverviewState.data : null;
  const hasImmediateOverviewData = Boolean(cachedOverviewData || localOverviewData);

  // -- Sync local state when cache key or cached data changes ------------
  useEffect(() => {
    if (!selectedProgramme) {
      setLocalOverviewState({ key: "", data: null });
      return;
    }

    setLocalOverviewState((current) => {
      if (current.key === overviewCacheStorageKey && current.data) {
        return current;
      }

      return {
        key: overviewCacheStorageKey,
        data: cachedOverviewData,
      };
    });
  }, [cachedOverviewData, overviewCacheStorageKey, selectedProgramme]);

  // -- Remote analytics query --------------------------------------------
  const remoteOverviewEnabled = USE_REMOTE_ANALYTICS && Boolean(selectedProgramme) && !loading;

  const overviewQuery = useQuery({
    queryKey: [
      "overview-analysis",
      user?.uid,
      userRole,
      userAttribute,
      selectedProgramme,
      currentMonthRange.startDate,
      currentMonthRange.endDate,
    ],
    queryFn: async () =>
      fetchAnalysisSummary({
        scope: "overview",
        programme: isAllProgrammesSelection(selectedProgramme) ? "All" : selectedProgramme || null,
        dateRange: currentMonthRange,
      }),
    enabled: remoteOverviewEnabled,
    retry: 0,
    staleTime: 10 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    initialData: cachedOverviewData ?? undefined,
  });

  const remoteOverviewData = overviewQuery.data ? sanitizeOverviewSummary(overviewQuery.data) : undefined;
  const remoteOverviewHasData = hasMeaningfulOverviewData(remoteOverviewData);
  const remoteOverviewHasUsableData = remoteOverviewHasData;

  // -- Extract raw record arrays from query data --------------------------
  const rawQueryData = overviewQuery.data as any;
  const training: OverviewRecord[] = Array.isArray(rawQueryData?.capacity)
    ? rawQueryData.capacity
    : Array.isArray(rawQueryData?.training)
      ? rawQueryData.training
      : [];
  const offtakes: OverviewRecord[] = Array.isArray(rawQueryData?.offtakes) ? rawQueryData.offtakes : [];

  // -- Cache remote results ----------------------------------------------
  useEffect(() => {
    const remoteData = overviewQuery.data as OverviewSummaryData | undefined;
    if (!selectedProgramme || !remoteData) return;

    setLocalOverviewState((current) => {
      if (current.key === overviewCacheStorageKey && current.data) {
        return current;
      }

      writeCachedValue(overviewCacheStorageKey, remoteData);
      return {
        key: overviewCacheStorageKey,
        data: remoteData,
      };
    });
  }, [overviewCacheStorageKey, overviewQuery.data, selectedProgramme]);

  // -- Local fallback fetch ----------------------------------------------
  const shouldFetchLocalOverview = false;

  useEffect(() => {
    if (!selectedProgramme) {
      setLocalOverviewState({ key: "", data: null });
      setLocalOverviewLoading(false);
      return;
    }

    setLocalOverviewLoading(false);
  }, [selectedProgramme]);

  // -- Resolved overview data --------------------------------------------
  const overviewData = sanitizeOverviewSummary(
    localOverviewData ??
    (remoteOverviewHasUsableData ? remoteOverviewData : undefined) ??
    cachedOverviewData ??
    EMPTY_OVERVIEW_DATA
  );

  const stats = overviewData.stats ?? EMPTY_OVERVIEW_DATA.stats;
  const maintainedInfrastructureData = overviewData.maintainedInfrastructure ?? EMPTY_DONUT_SEGMENTS;
  const registrationComparisonData = overviewData.registrationComparison ?? EMPTY_DONUT_SEGMENTS;
  const latestRegistrationSegment = registrationComparisonData[registrationComparisonData.length - 1];
  const registrationComparisonValue = latestRegistrationSegment?.value ?? registrationComparisonData[0]?.value ?? 0;
  const registrationPercentage = toPercentage(registrationComparisonValue, stats.totalFarmers);
  const trainingPercentage = toPercentage(stats.trainedFarmers, stats.totalFarmers);
  const censusPercentage = toPercentage(stats.totalGoatsPurchased, stats.totalGoats);

  const totalTrainingConducted = training.length;
  const averageAttendance = totalTrainingConducted > 0
    ? training.reduce((sum: number, t: any) => sum + (t.totalFarmers || t.participants || 0), 0) / totalTrainingConducted
    : 0;

  const hasOverviewData = Boolean(remoteOverviewHasUsableData || localOverviewData || cachedOverviewData);
  const isLoadingRemoteOverview =
    remoteOverviewEnabled &&
    !overviewQuery.isError &&
    overviewQuery.isLoading;
  const isLoadingData = !hasOverviewData && (isLoadingRemoteOverview || localOverviewLoading || shouldFetchLocalOverview);

  const [overviewHeroDate, setOverviewHeroDate] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setOverviewHeroDate(new Date());
    }, 60 * 1000);

    return () => window.clearInterval(timer);
  }, []);
  const overviewGreeting = useMemo(() => {
    const greetingName =
      userName ||
      user?.displayName ||
      user?.email?.split("@")[0] ||
      "System";
    return `${getGreetingLabel(overviewHeroDate)}, ${greetingName}!`;
  }, [overviewHeroDate, user?.displayName, user?.email, userName]);

  const overviewHeroProgrammeLabel = useMemo(() => {
    if (!selectedProgramme || isAllProgrammesSelection(selectedProgramme)) return "All Programmes";
    return selectedProgramme;
  }, [selectedProgramme]);

  // -- Auth / loading guards ---------------------------------------------

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className={`h-8 w-8 animate-spin ${SECONDARY_TEXT_CLASS}`} />
      </div>
    );
  }

  if (!userCanViewAllProgrammeData && accessibleProgrammes.length === 0) {
    return (
      <div className="rounded-[24px] border border-slate-200 bg-white p-8 text-center shadow-[0_10px_35px_rgba(15,23,42,0.04)]">
        <h1 className="text-lg font-semibold text-slate-900">No programme access</h1>
        <p className={`mt-2 text-sm ${SECONDARY_TEXT_CLASS}`}>This account is not assigned to any programme data.</p>
      </div>
    );
  }

  // -- Render ------------------------------------------------------------

  return (
    <div className="min-h-screen bg-[#f5f6f7] px-3 py-3 sm:px-5 sm:py-5">
      <div className="mx-auto max-w-[1120px] space-y-4 sm:space-y-6">
        {/* -- Compact hero banner with inline programme selector --- */}
        <div className="relative overflow-hidden rounded-[16px] bg-gradient-to-r from-[#042d14] via-[#0a5d29] to-[#249654] px-4 py-3 text-white shadow-[0_12px_30px_rgba(4,45,20,0.18)] sm:rounded-[20px] sm:px-6 sm:py-4">
          <div className="absolute inset-y-0 right-0 hidden w-1/3 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.15),transparent_58%)] sm:block" />

          <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between lg:gap-6">
            {/* Left: greeting */}
            <div className="min-w-0 space-y-0.5 sm:space-y-1">
              <h1 className="text-lg font-bold tracking-[-0.03em] text-white sm:text-2xl lg:text-3xl">
                {overviewGreeting}
              </h1>
              <p className="text-[11px] text-emerald-50/80 sm:text-sm">
                {overviewHeroDateFormatter.format(overviewHeroDate)}
              </p>
            </div>

            {/* Right: programme badge + selector inline */}
            <div className="flex items-center gap-3">
              {canSwitchProgrammes ? (
                <div className="w-full min-w-[130px] max-w-[170px] sm:min-w-[150px] sm:max-w-[200px]">
                  <ProgrammeSelector
                    value={selectedProgramme}
                    onValueChange={setSelectedProgramme}
                    programmes={accessibleProgrammes}
                    includeAll={accessibleProgrammes.length > 1}
                    triggerClassName="h-9 rounded-xl border-white/20 bg-white/12 px-3 text-sm text-white backdrop-blur-sm focus:ring-white/30 sm:h-10 sm:rounded-xl sm:px-4"
                  />
                </div>
              ) : null}
              <div className="hidden shrink-0 rounded-2xl bg-white/12 px-4 py-2 shadow-[0_10px_24px_rgba(4,45,20,0.15)] backdrop-blur-sm sm:block">
                <span className="text-sm font-semibold tracking-[-0.01em] sm:text-base">
                  {overviewHeroProgrammeLabel}
                </span>
                <span className="mt-0.5 block text-[10px] text-emerald-50/70 sm:text-xs">
                  Dashboard Overview
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* -- Data panels --------------------------------------------- */}
        {isLoadingData ? (
          <OverviewLoading />
        ) : (
          <>
            {/* Metric cards */}
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <TopMetricCard
                title="Registered Farmers"
                value={stats.totalFarmers}
                progressValue={registrationPercentage}
                progressLabel=""
                accentColor="#2ea55f"
                icon={<UsersRound className="h-5 w-5 text-[#2ea55f]" />}
                detail={
                  <>
                    <span className="whitespace-nowrap">Male : {formatWholeNumber(stats.maleFarmers)}</span>
                    <span className="shrink-0">|</span>
                    <span className="whitespace-nowrap">Female : {formatWholeNumber(stats.femaleFarmers)}</span>
                  </>
                }
              />

              <TopMetricCard
                title="Trained Farmers"
                value={stats.trainedFarmers}
                progressValue={trainingPercentage}
                progressLabel={formatProgressLabel(trainingPercentage, "Of Registered Farmers")}
                accentColor="#3978c7"
                icon={<Leaf className="h-5 w-5 text-[#3978c7]" />}
                detail={
                  <>
                    <span className="whitespace-nowrap">Trainings: {totalTrainingConducted}</span>
                    <span className="shrink-0">|</span>
                    <span className="whitespace-nowrap">Avg: {averageAttendance.toFixed(1)}</span>
                  </>
                }
              />

              <TopMetricCard
                title="Animal Census"
                value={stats.totalAnimals}
                progressValue={censusPercentage}
                progressLabel={formatProgressLabel(censusPercentage, "")}
                accentColor="#f58b1f"
                icon={<ShoppingCart className="h-5 w-5 text-[#f58b1f]" />}
                detail={
                  <>
                    <span className="whitespace-nowrap">Goats : {formatWholeNumber(stats.totalGoats)}</span>
                    <span className="shrink-0">|</span>
                    <span className="whitespace-nowrap">Purchased : {formatWholeNumber(stats.totalGoatsPurchased)}</span>
                  </>
                }
              />
            </div>

            {/* Row 1: Infrastructure + Animal Census */}
            <div className="grid items-stretch gap-6 lg:grid-cols-2">
              <DonutPanel
                title="INFRASTRUCTURE"
                data={maintainedInfrastructureData}
                tooltipValueLabel="boreholes"
                legendItems={maintainedInfrastructureData}
              />
              <AnnualComparisonPanel
                title="ANIMAL CENSUS"
                comparison={overviewData.animalCensusComparison ?? EMPTY_OVERVIEW_DATA.animalCensusComparison}
              />
            </div>

            {/* Row 2: Registration Donut + Recently Visited Locations */}
            <div className="grid items-stretch gap-6 lg:grid-cols-2">
              <DonutPanel
                title="FARMERS REGISTRATION PER YEAR"
                data={registrationComparisonData}
                tooltipValueLabel="farmers"
                legendItems={registrationComparisonData}
              />
              <RecentLocationsPanel locations={overviewData.recentLocations ?? EMPTY_OVERVIEW_DATA.recentLocations} />
            </div>

            {/* Row 3: Vaccination Trend + Counties Covered */}
            <div className="grid items-stretch gap-6 lg:grid-cols-2">
              <YearTrendPanel
                title="ANIMAL HEALTH (VACCINATION)"
                trend={overviewData.vaccinationTrend ?? EMPTY_OVERVIEW_DATA.vaccinationTrend}
                tooltipValueLabel="vaccinated goats"
              />
              <CountiesCoveredPanel data={overviewData.countyCoverage ?? EMPTY_COUNTY_COVERAGE} />
            </div>

            {/* Row 4: Recently Registered Farmers + Recent Activities */}
            <div className="grid items-stretch gap-6 lg:grid-cols-2">
              <RecentFarmersPanel
                farmers={overviewData.recentFarmers ?? EMPTY_OVERVIEW_DATA.recentFarmers}
              />
              <RecentActivitiesPanel activities={overviewData.recentActivities ?? EMPTY_OVERVIEW_DATA.recentActivities} />
            </div>

            {/* Row 5: Recent Offtakes Canvas */}
            <div className="grid items-stretch gap-6">
              <RecentOfftakesCanvas offtakes={offtakes} />
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default DashboardOverview;
