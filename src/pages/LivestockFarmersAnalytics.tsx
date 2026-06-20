import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { subscribeCollectionByProgrammes } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery } from "@tanstack/react-query";
import { fetchAnalysisSummary } from "@/lib/analysis";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { 
  PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip, 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, BarChart, Bar 
} from "recharts";
import { Users, GraduationCap, Beef, Map, UserCheck, AlertCircle, Activity, Eye, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSharedProgrammeSelection } from "@/hooks/use-shared-programme-selection";
import { canViewAllProgrammes, isAdmin } from "@/contexts/authhelper";
import {
  ALL_PROGRAMMES_VALUE,
  normalizeProgramme as normalizeProg,
  resolveAccessibleProgrammes,
} from "@/lib/programme-access";

// --- Constants ---
const COLORS = {
  navy: "#1e3a8a",
  orange: "#f97316", 
  yellow: "#f59e0b",
  maroon: "#7f1d1d"
};
const BAR_COLORS = [COLORS.navy, COLORS.orange, COLORS.yellow];

// Target Constants
const TARGETS = {
  weekly: 30,
  monthly: 117,
  yearly: 1404
};
const QUARTER_TARGET = 351;
const QUARTER_TARGET_MILESTONES = [351, 351, 351, 351];
const PROGRESS_ANALYTICS_QUERY_VERSION = "v6";
const EMPTY_STATS = {
  total: 0,
  trained: 0,
  totalAnimals: 0,
  trainingRate: 0,
  maleFarmers: 0,
  femaleFarmers: 0,
  totalTrainedFromCapacity: 0,
};

// --- Interfaces ---
interface FarmerData {
  id: string;
  createdAt: number | string;
  created_at?: number | string;
  registrationDate?: number | string;
  registration_date?: number | string;
  registeredAt?: number | string;
  timestamp?: number | string;
  date?: number | string;
  name: string;
  gender: string;
  phone: string;
  county: string;
  subcounty: string;
  location: string;
  goats: number | string | { male?: number | string; female?: number | string; total?: number | string };
  sheep: number | string;
  programme?: string;
  username?: string;
}

interface TrainingData {
  id: string;
  startDate?: string;
  createdAt?: number | string;
  totalFarmers?: number;
  programme?: string;
}

type ProgressStatus = "target-met" | "on-track" | "above-average" | "below-average" | "action-needed" | "not-started";

type ProgressPeriodKey = "q1" | "q2" | "q3" | "q4";

interface ProgressPeriod {
  key: ProgressPeriodKey;
  label: string;
  count: number;
  target: number;
  progressPercentage: number;
  status: ProgressStatus;
  met: boolean;
  upcoming?: boolean;
}

interface UserProgress {
  id: string;
  name: string;
  region: string;
  farmersRegistered: number;
  target: number; // Dynamic target
  progressPercentage: number;
  status: ProgressStatus;
  periods: ProgressPeriod[];
}

interface PieDataItem {
  name: string;
  value: number;
  color: string;
}

interface TimeSeriesItem {
  name: string;
  farmers: any;
  animals: any;
}

type FilterMode = "weekly" | "monthly" | "yearly" | "custom";

const getGenderColor = (label: string): string => {
  const normalized = label.trim().toLowerCase();
  if (normalized === "male") return COLORS.navy;
  if (normalized === "female") return COLORS.orange;
  return COLORS.yellow;
};

const getAnimalCensusColor = (label: string): string => {
  const normalized = label.trim().toLowerCase();
  if (normalized === "goats") return COLORS.maroon;
  if (normalized === "sheep") return COLORS.orange;
  return COLORS.navy;
};

const normalizePieChartData = (
  data: Array<Partial<PieDataItem>> | undefined,
  chartType: "gender" | "animal",
): PieDataItem[] =>
  (data || [])
    .map((item) => {
      const value = typeof item?.value === "number" ? item.value : Number(item?.value || 0);
      return {
        name: typeof item?.name === "string" ? item.name : "",
        value: Number.isFinite(value) ? value : 0,
      };
    })
    .filter((item) => item.name && item.value > 0)
    .map((item) => ({
      name: item.name,
      value: item.value,
      color: chartType === "gender" ? getGenderColor(item.name) : getAnimalCensusColor(item.name),
    }));

// --- Helper Functions ---

const parseDate = (date: any): Date | null => {
  if (!date) return null;
  try {
    if (date instanceof Date) return date;
    if (typeof date === 'number') return new Date(date);
    if (typeof date === 'string') {
      const parsed = new Date(date);
      return isNaN(parsed.getTime()) ? null : parsed;
    }
  } catch (error) {
    console.error('Error parsing date:', error);
  }
  return null;
};

const formatDateToLocal = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const getToday = (): Date => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
};

const getDateTimestamp = (value: unknown): number => parseDate(value)?.getTime() || 0;

const getFarmerRegistrationDateValue = (farmer: FarmerData): unknown =>
  farmer.createdAt ??
  farmer.created_at ??
  farmer.registrationDate ??
  farmer.registration_date ??
  farmer.registeredAt ??
  farmer.timestamp ??
  farmer.date;

const getCurrentMonthDates = () => {
  const now = getToday();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    startDate: formatDateToLocal(startOfMonth),
    endDate: formatDateToLocal(now),
  };
};

const getCurrentYearDates = () => {
  const now = getToday();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  return {
    startDate: formatDateToLocal(startOfYear),
    endDate: formatDateToLocal(now),
  };
};

const getCurrentWeekDates = () => {
  const now = getToday();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  return {
    startDate: formatDateToLocal(startOfWeek),
    endDate: formatDateToLocal(now),
  };
};

const normalizeDateRange = (range: { startDate?: string; endDate?: string }) => {
  const today = getToday();
  const start = parseDate(range.startDate) ?? parseDate(range.endDate) ?? today;
  const end = parseDate(range.endDate) ?? parseDate(range.startDate) ?? today;
  const normalizedStart = new Date(start);
  const normalizedEnd = new Date(end);
  normalizedStart.setHours(0, 0, 0, 0);
  normalizedEnd.setHours(0, 0, 0, 0);

  if (normalizedEnd > today) {
    normalizedEnd.setTime(today.getTime());
  }

  if (normalizedStart > normalizedEnd) {
    return {
      start: normalizedEnd,
      end: normalizedStart > today ? today : normalizedStart,
    };
  }

  return { start: normalizedStart, end: normalizedEnd };
};

const getInclusiveDayCount = (start: Date, end: Date): number =>
  Math.max(1, Math.floor((end.getTime() - start.getTime()) / MS_PER_DAY) + 1);

const addDays = (date: Date, days: number): Date => {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  result.setHours(0, 0, 0, 0);
  return result;
};

const isSameCalendarWeek = (start: Date, end: Date): boolean => {
  const startOfWeek = new Date(start);
  startOfWeek.setDate(start.getDate() - start.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);

  return end >= startOfWeek && end <= endOfWeek;
};

const countCoveredWeeks = (start: Date, end: Date): number => {
  let total = 0;
  let cursor = new Date(start);

  while (cursor <= end) {
    total += 1;
    const weekStart = new Date(cursor);
    weekStart.setDate(cursor.getDate() - cursor.getDay());
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    cursor = addDays(weekEnd, 1);
  }

  return Math.max(1, total);
};

/**
 * Count full months between two dates.
 * A full month is counted when the day-of-month of end >= day-of-month of start.
 */
const countFullMonths = (start: Date, end: Date): number => {
  if (end < start) return 0;
  let months = 0;
  let cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);

  while (true) {
    const nextMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    const monthEnd = new Date(nextMonth);
    monthEnd.setDate(0); // Last day of current month

    // If the range includes this full month
    if (cursor <= end) {
      // Check if we have a full month or just a partial month at the end
      const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
      if (monthStart >= start && monthEnd <= end) {
        months += 1;
      }
    }

    // Move to next month
    cursor = nextMonth;
    if (cursor > end) break;
  }

  return months;
};

/**
 * Calculate target based on exact duration of date range.
 * - Full months: 117 per month
 * - Remaining weeks: 30 per week
 * - Uses a hybrid approach for ranges spanning months + partial weeks
 */
const calculateDurationBasedTarget = (start: Date, end: Date): number => {
  if (end < start) return 0;

  const totalDays = getInclusiveDayCount(start, end);
  const fullMonths = countFullMonths(start, end);

  // Calculate remaining days after full months
  let remainingDays = totalDays;
  if (fullMonths > 0) {
    const monthsEnd = new Date(start.getFullYear(), start.getMonth() + fullMonths, 0);
    const daysInFullMonths = getInclusiveDayCount(start, monthsEnd);
    remainingDays = Math.max(0, totalDays - daysInFullMonths);
  }

  // Calculate weeks from remaining days
  const coveredWeeks = remainingDays > 0 ? Math.ceil(remainingDays / 7) : 0;

  // Apply targets
  const monthTarget = fullMonths * TARGETS.monthly;
  const weekTarget = coveredWeeks * TARGETS.weekly;

  return Math.max(1, monthTarget + weekTarget);
};

const resolveTargetMode = (
  dateRange: { startDate?: string; endDate?: string },
  filterMode: FilterMode,
): Exclude<FilterMode, "custom"> => {
  if (filterMode !== "custom") return filterMode;
  if (!dateRange.startDate && !dateRange.endDate) return "yearly";
  // If both dates are set and represent a single month, use monthly target
  if (dateRange.startDate && dateRange.endDate) {
    const start = parseDate(dateRange.startDate);
    const end = parseDate(dateRange.endDate);
    if (start && end &&
        start.getFullYear() === end.getFullYear() &&
        start.getMonth() === end.getMonth()) {
      return "monthly";
    }
  }
  return "weekly";
};

const calculateActiveTarget = (
  dateRange: { startDate?: string; endDate?: string },
  targetMode: Exclude<FilterMode, "custom">,
): number => {
  if (!dateRange.startDate && !dateRange.endDate) return TARGETS.yearly;
  const { start, end } = normalizeDateRange(dateRange);

  // For explicit filter modes (weekly/monthly buttons), use the simple calculation
  if (targetMode === "monthly") {
    // Check if it's a single month or multiple months
    const fullMonths = countFullMonths(start, end);
    if (fullMonths >= 1) {
      // Calculate remaining days for partial month
      const monthsEnd = new Date(start.getFullYear(), start.getMonth() + fullMonths, 0);
      const remainingDays = getInclusiveDayCount(monthsEnd, end);
      const monthPortion = fullMonths * TARGETS.monthly;
      const weekPortion = remainingDays > 0 ? Math.ceil(remainingDays / 7) * TARGETS.weekly : 0;
      return monthPortion + weekPortion;
    }
    return TARGETS.monthly;
  }

  if (targetMode === "weekly") {
    // For weekly mode, calculate based on covered weeks
    return countCoveredWeeks(start, end) * TARGETS.weekly;
  }

  // For yearly or custom ranges, use duration-based calculation
  return calculateDurationBasedTarget(start, end);
};

const normalizeProgramme = (value: unknown): string => normalizeProg(value);

const parseNumericValue = (value: unknown): number => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "string") {
    const normalized = value.replace(/,/g, "").trim();
    if (!normalized) return 0;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const getGoatTotal = (goats: any): number => {
  if (typeof goats === "number" || typeof goats === "string") return parseNumericValue(goats);
  if (typeof goats === "object" && goats !== null) {
    if (Object.prototype.hasOwnProperty.call(goats, "total")) {
      return parseNumericValue(goats.total);
    }
    return parseNumericValue(goats.male) + parseNumericValue(goats.female);
  }
  return 0;
};

const getProgressStatus = (
  progressPercentage: number,
  options: { allowOnTrack?: boolean; allowTargetMet?: boolean } = {},
): ProgressStatus => {
  if (options.allowTargetMet && progressPercentage >= 100) return "target-met";
  if (options.allowOnTrack !== false && progressPercentage >= 70) return "on-track";
  if (progressPercentage >= 50) return "above-average";
  if (progressPercentage >= 30) return "below-average";
  return "action-needed";
};

const getProgressStatusLabel = (status: ProgressStatus): string => {
  if (status === "target-met") return "Target met";
  if (status === "on-track") return "On track";
  if (status === "above-average") return "Above Average";
  if (status === "below-average") return "Below Average";
  if (status === "not-started") return "Not started";
  return "Action Needed";
};

const getProgressBarClass = (status: ProgressStatus): string => {
  if (status === "target-met") return "bg-green-500";
  if (status === "on-track") return "bg-blue-500";
  if (status === "above-average") return "bg-emerald-500";
  if (status === "below-average") return "bg-amber-400";
  if (status === "not-started") return "bg-slate-300";
  return "bg-red-400";
};

const getProgressTextClass = (status: ProgressStatus): string => {
  if (status === "target-met") return "text-green-700";
  if (status === "on-track") return "text-blue-700";
  if (status === "above-average") return "text-emerald-700";
  if (status === "below-average") return "text-amber-700";
  if (status === "not-started") return "text-slate-600";
  return "text-red-700";
};

const isCompletedQuarter = (periodEnd: Date, analysisYear: number): boolean => {
  const today = getToday();
  const currentYear = today.getFullYear();
  if (analysisYear < currentYear) return true;
  if (analysisYear > currentYear) return false;
  const normalizedEnd = new Date(periodEnd);
  normalizedEnd.setHours(23, 59, 59, 999);
  return today > normalizedEnd;
};

const getAnalysisYearFromDateRange = (
  dateRange: { startDate?: string; endDate?: string },
): number | null => {
  const startYear = parseDate(dateRange.startDate)?.getFullYear();
  if (typeof startYear === "number" && Number.isFinite(startYear)) return startYear;

  const endYear = parseDate(dateRange.endDate)?.getFullYear();
  if (typeof endYear === "number" && Number.isFinite(endYear)) return endYear;

  return null;
};

const getSelectedYearFromDateRange = (dateRange: { startDate?: string; endDate?: string }): string => {
  const startYear = parseDate(dateRange.startDate)?.getFullYear();
  const endYear = parseDate(dateRange.endDate)?.getFullYear();

  if (typeof startYear === "number" && Number.isFinite(startYear) &&
      typeof endYear === "number" && Number.isFinite(endYear)) {
    return startYear === endYear ? String(startYear) : "";
  }
  if (typeof startYear === "number" && Number.isFinite(startYear)) return String(startYear);
  if (typeof endYear === "number" && Number.isFinite(endYear)) return String(endYear);
  return "";
};

const getQuarterCountingCutoff = (year: number): Date | null => {
  const today = getToday();
  const currentYear = today.getFullYear();

  if (year < currentYear) {
    const endOfYear = new Date(year, 11, 31);
    endOfYear.setHours(23, 59, 59, 999);
    return endOfYear;
  }

  if (year > currentYear) {
    return null;
  }

  const endOfToday = new Date(today);
  endOfToday.setHours(23, 59, 59, 999);
  return endOfToday;
};

const isUpcomingQuarter = (periodStart: Date, analysisYear: number): boolean => {
  const today = getToday();
  const currentYear = today.getFullYear();
  if (analysisYear > currentYear) return true;
  if (analysisYear < currentYear) return false;
  return periodStart > today;
};

const buildQuarterTargets = (year: number) => [
  {
    key: "q1" as const,
    label: `Q1 ${year}`,
    start: new Date(year, 0, 1),
    end: new Date(year, 2, 31),
    target: QUARTER_TARGET,
  },
  {
    key: "q2" as const,
    label: `Q2 ${year}`,
    start: new Date(year, 3, 1),
    end: new Date(year, 5, 30),
    target: QUARTER_TARGET,
  },
  {
    key: "q3" as const,
    label: `Q3 ${year}`,
    start: new Date(year, 6, 1),
    end: new Date(year, 8, 30),
    target: QUARTER_TARGET_MILESTONES[2],
  },
  {
    key: "q4" as const,
    label: `Q4 ${year}`,
    start: new Date(year, 9, 1),
    end: new Date(year, 11, 31),
    target: QUARTER_TARGET_MILESTONES[3],
  },
];

const USE_REMOTE_ANALYTICS = true;

const LivestockFarmersAnalytics = () => {
  const { user, userRole, userAttribute, allowedProgrammes } = useAuth();
  const [loading, setLoading] = useState(true);
  const [allFarmers, setAllFarmers] = useState<FarmerData[]>([]);
  const [trainingRecords, setTrainingRecords] = useState<TrainingData[]>([]);
  const [filteredData, setFilteredData] = useState<FarmerData[]>([]);
  const [availablePrograms, setAvailablePrograms] = useState<string[]>([]);
  const [filterMode, setFilterMode] = useState<FilterMode>("monthly");

  // Chart Data States
  const [genderData, setGenderData] = useState<PieDataItem[]>([]);
  const [animalCensusData, setAnimalCensusData] = useState<PieDataItem[]>([]); 
  const [weeklyPerformanceData, setWeeklyPerformanceData] = useState<TimeSeriesItem[]>([]); 
  const [subcountyPerformanceData, setSubcountyPerformanceData] = useState<any[]>([]);
  const [localUserProgressData, setLocalUserProgressData] = useState<UserProgress[]>([]);
  const [selectedOfficer, setSelectedOfficer] = useState<UserProgress | null>(null);
  const [isOfficerTargetsOpen, setIsOfficerTargetsOpen] = useState(false);
  const filterStripRef = useRef<HTMLDivElement | null>(null);
  
  const [stats, setStats] = useState(EMPTY_STATS);

  const [dateRange, setDateRange] = useState<{ startDate: string; endDate: string }>(() => getCurrentMonthDates());
  const [selectedYear, setSelectedYear] = useState(() => String(getToday().getFullYear()));
  const hasActiveDateFilters = Boolean(dateRange.startDate || dateRange.endDate);
  const targetMode = useMemo(
    () => resolveTargetMode(dateRange, filterMode),
    [dateRange, filterMode],
  );
  const coverageYears = useMemo(() => {
    if (hasActiveDateFilters) return null;
    const years = allFarmers
      .map((farmer) => parseDate(getFarmerRegistrationDateValue(farmer))?.getFullYear())
      .filter((year): year is number => typeof year === "number" && Number.isFinite(year));
    if (years.length === 0) return null;
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);
    return {
      count: Math.max(1, maxYear - minYear + 1),
      start: minYear,
      end: maxYear,
    };
  }, [allFarmers, hasActiveDateFilters]);

  const computedTarget = useMemo(() => {
    if (!hasActiveDateFilters && coverageYears?.count) {
      return coverageYears.count * TARGETS.yearly;
    }
    return calculateActiveTarget(dateRange, targetMode);
  }, [coverageYears, dateRange, hasActiveDateFilters, targetMode]);

  const userCanViewAllProgrammeData = useMemo(
    () => canViewAllProgrammes(userRole, userAttribute, allowedProgrammes),
    [allowedProgrammes, userRole, userAttribute]
  );
  const userIsAdmin = useMemo(() => isAdmin(userRole), [userRole]);
  const analysisYear = useMemo(
    () => {
      const parsedSelectedYear = Number.parseInt(selectedYear, 10);
      if (Number.isFinite(parsedSelectedYear)) return parsedSelectedYear;
      return getAnalysisYearFromDateRange(dateRange);
    },
    [dateRange, selectedYear]
  );
  const quarterYear = analysisYear ?? getToday().getFullYear();
  const analysisYearLabel = analysisYear ?? "All years";
  const availableYears = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const years = Array.from({ length: 10 }, (_, index) => String(currentYear - index));
    return selectedYear && !years.includes(selectedYear) ? [selectedYear, ...years] : years;
  }, [selectedYear]);
  const quarterTargets = useMemo(() => buildQuarterTargets(quarterYear), [quarterYear]);
  const accessibleProgrammes = useMemo(
    () => resolveAccessibleProgrammes(userCanViewAllProgrammeData, allowedProgrammes),
    [allowedProgrammes, userCanViewAllProgrammeData]
  );
  const [activeProgram, setActiveProgram] = useSharedProgrammeSelection(accessibleProgrammes, {
    allowAll: accessibleProgrammes.length > 1,
    fallbackToAll: accessibleProgrammes.length > 1,
  });
  const resetAnalyticsState = useCallback(() => {
    setStats(EMPTY_STATS);
    setGenderData([]);
    setAnimalCensusData([]);
    setWeeklyPerformanceData([]);
    setSubcountyPerformanceData([]);
    setFilteredData([]);
    setLocalUserProgressData([]);
  }, []);

  const analyticsQuery = useQuery({
    queryKey: [
      PROGRESS_ANALYTICS_QUERY_VERSION,
      "livestock-analytics",
      user?.uid,
      userRole,
      userAttribute,
      activeProgram,
      dateRange.startDate,
      dateRange.endDate,
      selectedYear,
      targetMode,
      computedTarget,
    ],
    queryFn: () =>
      fetchAnalysisSummary({
        scope: "livestock-analytics",
        programme: activeProgram === ALL_PROGRAMMES_VALUE ? "All" : (activeProgram || null),
        dateRange: hasActiveDateFilters ? dateRange : null,
        selectedYear: selectedYear || null,
        timeFrame: targetMode,
        target: hasActiveDateFilters ? computedTarget : null,
      }),
    enabled: USE_REMOTE_ANALYTICS && !!activeProgram,
    placeholderData: (previousData) => previousData,
    staleTime: 10 * 60 * 1000,
    retry: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const effectiveTarget = useMemo(() => {
    if (!hasActiveDateFilters && USE_REMOTE_ANALYTICS) {
      const serverTarget = Number((analyticsQuery.data as any)?.activeTarget);
      return Number.isFinite(serverTarget) && serverTarget > 0 ? serverTarget : computedTarget;
    }
    return computedTarget;
  }, [analyticsQuery.data, computedTarget, hasActiveDateFilters]);

  useEffect(() => {
    const analysis = analyticsQuery.data as any;
    if (!analysis) return;

    setStats({
      total: analysis.total || 0,
      trained: analysis.trained || 0,
      totalAnimals: analysis.totalAnimals || 0,
      trainingRate: analysis.trainingRate || 0,
      maleFarmers: analysis.maleFarmers || 0,
      femaleFarmers: analysis.femaleFarmers || 0,
      totalTrainedFromCapacity: analysis.totalTrainedFromCapacity || 0,
    });
    setGenderData(normalizePieChartData(analysis.genderData, "gender"));
    setAnimalCensusData(normalizePieChartData(analysis.animalCensusData, "animal"));
    setWeeklyPerformanceData(analysis.weeklyPerformanceData || []);
    setSubcountyPerformanceData(analysis.subcountyPerformanceData || []);
    setFilteredData([]);
  }, [analyticsQuery.data, hasActiveDateFilters, resetAnalyticsState]);

  // --- 1. Fetch User Permissions ---
  useEffect(() => {
    setAvailablePrograms(accessibleProgrammes);
  }, [accessibleProgrammes]);

  // --- 2. Data Fetching (Farmers) ---
  useEffect(() => {
    if (USE_REMOTE_ANALYTICS) return;
    if (!activeProgram) {
        setAllFarmers([]);
        setLocalUserProgressData([]);
        setLoading(false);
        return;
    }
    setLoading(true);

    const normalizedActiveProgram = normalizeProgramme(activeProgram);
    const mapFarmers = (data: Record<string, any> | null | undefined): FarmerData[] =>
      Object.keys(data || {})
        .map<FarmerData | null>((key) => {
          const item = data?.[key] || {};
          const programme = normalizeProgramme(item.programme ?? item.Programme);
          if (normalizedActiveProgram && normalizedActiveProgram !== "ALL" && programme !== normalizedActiveProgram) {
            return null;
          }

          const parsedCreatedAt =
            parseDate(item.createdAt)?.getTime() ||
            parseDate(item.created_at)?.getTime() ||
            parseDate(item.registrationDate)?.getTime() ||
            parseDate(item.registration_date)?.getTime() ||
            parseDate(item.registeredAt)?.getTime() ||
            parseDate(item.timestamp)?.getTime() ||
            parseDate(item.date)?.getTime() ||
            Date.now();

          return {
            id: key,
            createdAt: parsedCreatedAt,
            created_at: item.created_at,
            registrationDate: item.registrationDate,
            registration_date: item.registration_date,
            registeredAt: item.registeredAt,
            timestamp: item.timestamp,
            date: item.date,
            name: item.name || item.farmerName || '',
            gender: item.gender || '',
            phone: item.phone || item.phoneNumber || '',
            county: item.county || item.County || '',
            subcounty: item.subcounty || item.Subcounty || item["Sub County"] || item["Sub-County"] || '',
            location: item.location || item.Location || item.subcounty || item.Subcounty || '',
            goats: item.goats ?? item.Goats ?? item.totalGoats ?? 0,
            sheep: item.sheep ?? item.Sheep ?? 0,
            programme,
            username: item.username || item.created_by || item.createdBy || item.fieldOfficer || item.officer || 'Unknown User'
          };
        })
        .filter((item): item is FarmerData => item !== null)
        .sort((a, b) => getDateTimestamp(b.createdAt) - getDateTimestamp(a.createdAt));

    const programmesToRead =
      activeProgram === ALL_PROGRAMMES_VALUE
        ? accessibleProgrammes
        : [normalizeProgramme(activeProgram)].filter(Boolean);

    if (programmesToRead.length === 0) {
      setAllFarmers([]);
      setLoading(false);
      return;
    }

    const unsubscribe = subscribeCollectionByProgrammes<Record<string, any>>(
      "farmers",
      programmesToRead,
      (records) => {
        setAllFarmers(mapFarmers(records));
        setLoading(false);
      },
      (error) => {
        console.error("Error fetching farmers data:", error);
        setLoading(false);
      },
    );

    return () => { unsubscribe(); };
  }, [activeProgram, accessibleProgrammes]);

  // --- 3. Data Fetching (Capacity Building) ---
  useEffect(() => {
    if (USE_REMOTE_ANALYTICS) return;
    if (!activeProgram) {
        setTrainingRecords([]);
        return;
    }
    const normalizedActiveProgram = normalizeProgramme(activeProgram);
    const mapTraining = (data: Record<string, any> | null | undefined): TrainingData[] =>
      Object.keys(data || {})
        .map((key) => {
          const item = data?.[key] || {};
          const programme = normalizeProgramme(item.programme ?? item.Programme);
          if (normalizedActiveProgram && normalizedActiveProgram !== "ALL" && programme !== normalizedActiveProgram) {
            return null;
          }
          return {
            id: key,
            ...item,
            programme,
            startDate: item.startDate || item.start_date || item.date || item.Date,
            createdAt: item.createdAt ?? item.created_at ?? item.startDate ?? item.start_date ?? item.date ?? item.Date,
          };
        })
        .filter((item): item is TrainingData => item !== null);

    const programmesToRead =
      activeProgram === ALL_PROGRAMMES_VALUE
        ? accessibleProgrammes
        : [normalizeProgramme(activeProgram)].filter(Boolean);

    if (programmesToRead.length === 0) {
      setTrainingRecords([]);
      return;
    }

    const unsubscribe = subscribeCollectionByProgrammes<Record<string, any>>(
      "capacityBuilding",
      programmesToRead,
      (records) => {
        setTrainingRecords(mapTraining(records));
      },
      (error) => {
        console.error("Error fetching training data:", error);
      },
    );

    return () => { unsubscribe(); };
  }, [activeProgram, accessibleProgrammes]);

  // --- 4. Filtering & Analytics Logic ---
  useEffect(() => {
    if (USE_REMOTE_ANALYTICS) return;
    applyFilters();
  }, [allFarmers, dateRange, effectiveTarget, filterMode, hasActiveDateFilters, resetAnalyticsState, trainingRecords]);

  const isDateInRange = (date: any, startDate: string, endDate: string): boolean => {
    if (!startDate && !endDate) return true;
    const farmerDate = parseDate(date);
    if (!farmerDate) return false;
    const farmerDateOnly = new Date(farmerDate);
    farmerDateOnly.setHours(0, 0, 0, 0);
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;
    if (start) start.setHours(0, 0, 0, 0);
    if (end) end.setHours(23, 59, 59, 999);
    if (start && farmerDateOnly < start) return false;
    if (end && farmerDateOnly > end) return false;
    return true;
  };

  const applyFilters = () => {
    const filtered = hasActiveDateFilters
      ? allFarmers.filter((farmer) =>
        isDateInRange(getFarmerRegistrationDateValue(farmer), dateRange.startDate, dateRange.endDate)
      )
      : allFarmers;
    setFilteredData(filtered);
    updateAnalytics(filtered);
  };

  const updateAnalytics = (data: FarmerData[]) => {
    // Gender distribution
    const maleCount = data.filter(f => String(f.gender).toLowerCase() === 'male').length;
    const femaleCount = data.filter(f => String(f.gender).toLowerCase() === 'female').length;

    // Training Stats
    const filteredTrainingRecords = trainingRecords.filter((record) =>
      isDateInRange(record.startDate || record.createdAt, dateRange.startDate, dateRange.endDate)
    );
    const totalTrainedFromCapacity = filteredTrainingRecords.reduce(
      (sum, t) => sum + parseNumericValue(t.totalFarmers),
      0
    );
    
    // Capacity-building totals can include repeat attendees, so keep coverage bounded to registered farmers.
    const trainingRate = data.length > 0 ?
      (Math.min(totalTrainedFromCapacity, data.length) / data.length) * 100 :
      0;

    // Animal Census
    let totalGoats = 0;
    let totalSheep = 0;
    
    data.forEach(farmer => {
      const g = getGoatTotal(farmer.goats);
      totalGoats += g;
      totalSheep += parseNumericValue(farmer.sheep);
    });

    const totalAnimals = totalGoats + totalSheep;

    // Set Stats
    setStats({ 
      total: data.length, 
      trained: totalTrainedFromCapacity,
      totalAnimals,
      trainingRate,
      maleFarmers: maleCount,
      femaleFarmers: femaleCount,
      totalTrainedFromCapacity
    });

    // 1. Gender Data
    const genderChartData: PieDataItem[] = [
      { name: "Male", value: Number(maleCount), color: getGenderColor("Male") },
      { name: "Female", value: Number(femaleCount), color: getGenderColor("Female") },
    ];
    setGenderData(genderChartData);

    // 2. Animal Census Data
    const animalChartData: PieDataItem[] = [
      { name: "Goats", value: Number(totalGoats), color: getAnimalCensusColor("Goats") },
      { name: "Sheep", value: Number(totalSheep), color: getAnimalCensusColor("Sheep") },
    ];
    setAnimalCensusData(animalChartData);

    // 3. Weekly Performance (Farmers vs Livestock)
    const weeks: Record<number, { farmers: number; animals: number }> = {
      1: { farmers: 0, animals: 0 },
      2: { farmers: 0, animals: 0 },
      3: { farmers: 0, animals: 0 },
      4: { farmers: 0, animals: 0 }
    };

    data.forEach(farmer => {
      const date = new Date(farmer.createdAt);
      const day = date.getDate();
      const weekNum = Math.ceil(day / 7); 
      if (weekNum >= 1 && weekNum <= 4) {
        weeks[weekNum].farmers++;
        weeks[weekNum].animals += getGoatTotal(farmer.goats) + parseNumericValue(farmer.sheep);
      }
    });

    const weeklyChartData: TimeSeriesItem[] = [
      { name: "Week 1", farmers: weeks[1].farmers, animals: weeks[1].animals },
      { name: "Week 2", farmers: weeks[2].farmers, animals: weeks[2].animals },
      { name: "Week 3", farmers: weeks[3].farmers, animals: weeks[3].animals },
      { name: "Week 4", farmers: weeks[4].farmers, animals: weeks[4].animals },
    ];
    setWeeklyPerformanceData(weeklyChartData);

    // 4. Subcounty Performance
    const subcountyStats: Record<string, number> = {};
    data.forEach(farmer => {
      const sc = farmer.subcounty || "Unknown";
      subcountyStats[sc] = (subcountyStats[sc] || 0) + 1;
    });
    const scData = Object.entries(subcountyStats)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 15);
    setSubcountyPerformanceData(scData);

    const currentPeriodStats: Record<string, { count: number; counties: Set<string> }> = {};
    data.forEach((farmer) => {
      const officerName = String(farmer.username || "Unknown User").trim() || "Unknown User";
      if (!currentPeriodStats[officerName]) {
        currentPeriodStats[officerName] = {
          count: 0,
          counties: new Set<string>(),
        };
      }

      currentPeriodStats[officerName].count += 1;

      const county = String(farmer.county || "").trim();
      if (county) {
        currentPeriodStats[officerName].counties.add(county);
      }
    });

    const quarterCountingCutoff = getQuarterCountingCutoff(quarterYear);
    const quarterlyStats: Record<string, { periods: Record<ProgressPeriodKey, number>; counties: Set<string> }> = {};
    allFarmers.forEach((farmer) => {
      const officerName = String(farmer.username || "Unknown User").trim() || "Unknown User";
      if (!quarterlyStats[officerName]) {
        quarterlyStats[officerName] = {
          periods: { q1: 0, q2: 0, q3: 0, q4: 0 },
          counties: new Set<string>(),
        };
      }

      const farmerDate = parseDate(getFarmerRegistrationDateValue(farmer));
      if (
        farmerDate &&
        quarterCountingCutoff &&
        farmerDate.getFullYear() === quarterYear &&
        farmerDate <= quarterCountingCutoff
      ) {
        quarterTargets.forEach((period) => {
          if (farmerDate >= period.start && farmerDate <= period.end) {
            quarterlyStats[officerName].periods[period.key] += 1;
          }
        });
      }

      const county = String(farmer.county || "").trim();
      if (county) {
        quarterlyStats[officerName].counties.add(county);
      }
    });

    const officerNames = new Set<string>([
      ...Object.keys(currentPeriodStats),
      ...Object.keys(quarterlyStats),
    ]);
    const currentTarget = Math.max(1, Math.round(effectiveTarget));

    const localProgress = [...officerNames]
      .map((name) => {
        const currentStats = currentPeriodStats[name] || { count: 0, counties: new Set<string>() };
        const quarterData = quarterlyStats[name] || {
          periods: { q1: 0, q2: 0, q3: 0, q4: 0 },
          counties: new Set<string>(),
        };
        const currentProgressPercentage = currentTarget > 0 ? (currentStats.count / currentTarget) * 100 : 0;
        const currentStatus = getProgressStatus(currentProgressPercentage);
        const counties = [...new Set([...currentStats.counties, ...quarterData.counties])];
        const periods = quarterTargets.map((period) => {
          const count = quarterData.periods[period.key];
          const upcoming = isUpcomingQuarter(period.start, quarterYear);
          const completed = isCompletedQuarter(period.end, quarterYear);
          const progressPercentage = period.target > 0 ? (count / period.target) * 100 : 0;
          const status = upcoming
            ? "not-started"
            : getProgressStatus(progressPercentage, { allowOnTrack: !completed, allowTargetMet: completed });
          return {
            key: period.key,
            label: period.label,
            count,
            target: period.target,
            progressPercentage,
            status,
            met: !upcoming && count >= period.target,
            upcoming,
          };
        });

        return {
          id: name,
          name,
          region: counties.slice(0, 3).join(", ") + (counties.length > 3 ? "..." : ""),
          farmersRegistered: currentStats.count,
          target: currentTarget,
          progressPercentage: currentProgressPercentage,
          status: currentStatus,
          periods,
        };
      })
      .sort((a, b) => b.farmersRegistered - a.farmersRegistered);
    setLocalUserProgressData(localProgress);
  };

  // User Progress with Dynamic Targets
  const userProgressData = useMemo(
    () => {
      const rawProgressData = USE_REMOTE_ANALYTICS ? (analyticsQuery.data as any)?.userProgressData || [] : localUserProgressData;
      return rawProgressData.map((user: any) => {
        const periods = (Array.isArray(user.periods) && user.periods.length > 0 ?
          user.periods :
          quarterTargets.map((period) => ({
            key: period.key,
            label: period.label,
            count: 0,
            target: period.target,
            progressPercentage: 0,
            status: (isUpcomingQuarter(period.start, quarterYear) ? "not-started" : "action-needed") as ProgressStatus,
            met: false,
            upcoming: isUpcomingQuarter(period.start, quarterYear),
          }))).map((period: any) => {
            const fallbackQuarter = quarterTargets.find((entry) => entry.key === period.key);
            const target = Number(fallbackQuarter?.target || period.target || QUARTER_TARGET);
            const count = Number(period.count || 0);
            const progressPercentage = target > 0 ? (count / target) * 100 : 0;
            const upcoming = fallbackQuarter ? isUpcomingQuarter(fallbackQuarter.start, quarterYear) : Boolean(period.upcoming);
            const completed = fallbackQuarter ? isCompletedQuarter(fallbackQuarter.end, quarterYear) : false;
            return {
              ...period,
              target,
              count,
              progressPercentage,
              status: upcoming
                ? "not-started"
                : getProgressStatus(progressPercentage, { allowOnTrack: !completed, allowTargetMet: completed }),
              met: !upcoming && count >= target,
              upcoming,
            };
          });
        const farmersRegistered = Number(user.farmersRegistered || 0);
        const target = Number(effectiveTarget || user.target || TARGETS.yearly);
        const progressPercentage = target > 0 ? (farmersRegistered / target) * 100 : 0;
        const status = getProgressStatus(progressPercentage);
        return {
          ...user,
          farmersRegistered,
          target,
          progressPercentage,
          status,
          periods,
        } as UserProgress;
      });
    },
    [analyticsQuery.data, effectiveTarget, localUserProgressData, quarterTargets, quarterYear],
  );

  const handleDateRangeChange = (key: string, value: string) => {
    setDateRange(prev => {
      const nextRange = { ...prev, [key]: value };
      setSelectedYear(getSelectedYearFromDateRange(nextRange));
      return nextRange;
    });
    // Detect the appropriate filter mode based on the selected date range
    const updatedRange = key === "startDate" ? { ...dateRange, startDate: value } : { ...dateRange, endDate: value };
    if (updatedRange.startDate && updatedRange.endDate) {
      const start = parseDate(updatedRange.startDate);
      const end = parseDate(updatedRange.endDate);
      if (start && end) {
        // Same month = monthly mode
        if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
          setFilterMode("monthly");
          return;
        }
        // Check if the range spans multiple months - use custom mode for duration-based calculation
        const monthDiff = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
        if (monthDiff >= 1) {
          setFilterMode("custom"); // Will use duration-based calculation
          return;
        }
      }
    }
    setFilterMode("custom");
  };

  // Filter Buttons
  const setWeekFilter = () => {
    setDateRange(getCurrentWeekDates());
    setSelectedYear(String(getToday().getFullYear()));
    setFilterMode("weekly");
  };

  const setMonthFilter = () => {
    setDateRange(getCurrentMonthDates());
    setSelectedYear(String(getToday().getFullYear()));
    setFilterMode("monthly");
  };

  const setYearFilter = () => {
    setDateRange(getCurrentYearDates());
    setSelectedYear(String(getToday().getFullYear()));
    setFilterMode("yearly");
  };

  const handleYearChange = (yearValue: string) => {
    const year = Number.parseInt(yearValue, 10);
    if (!Number.isFinite(year)) return;

    setSelectedYear(yearValue);
    setDateRange({
      startDate: `${year}-01-01`,
      endDate: `${year}-12-31`,
    });
    setFilterMode("yearly");
  };

  const clearFilters = () => {
    setDateRange({ startDate: "", endDate: "" });
    setSelectedYear("");
    setFilterMode("yearly"); // Reset to yearly as default after clearing
    setSelectedOfficer(null);
    setIsOfficerTargetsOpen(false);
  };

  const renderCustomizedLabel = useCallback(({
    cx, cy, midAngle, innerRadius, outerRadius, percent
  }: any) => {
    if (percent === 0) return null;
    const RADIAN = Math.PI / 180;
    const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);
    return (
      <text 
        x={x} 
        y={y} 
        fill="white" 
        textAnchor={x > cx ? 'start' : 'end'} 
        dominantBaseline="central"
        fontSize="12"
        fontWeight="bold"
      >
        {`${(percent * 100).toFixed(0)}%`}
      </text>
    );
  }, []);

  const renderAnimalCensusTooltip = useCallback(({ active, payload }: any) => {
    if (!active || !payload?.length) return null;

    const segment = payload[0]?.payload;
    if (!segment) return null;

    return (
      <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-[0_12px_28px_rgba(15,23,42,0.12)]">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: segment.color }} />
          <span className="text-sm font-medium text-slate-700">{segment.name}</span>
        </div>
        <p className="mt-1 text-sm font-semibold text-slate-900">
          {Number(segment.value || 0).toLocaleString()} animals
        </p>
      </div>
    );
  }, []);

  const getFilterButtonClass = (isActive: boolean) =>
    isActive
      ? "text-xs h-9 bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100"
      : "text-xs h-9";

  const scrollFilterStripBy = useCallback((direction: "left" | "right") => {
    const strip = filterStripRef.current;
    if (!strip) return;
    const offset = direction === "left" ? -220 : 220;
    strip.scrollBy({ left: offset, behavior: "smooth" });
  }, []);

  const openOfficerTargets = useCallback((officer: UserProgress) => {
    setSelectedOfficer(officer);
    setIsOfficerTargetsOpen(true);
  }, []);

  const StatsCard = ({ title, value, icon: Icon, description, color = "navy" }: any) => (
    <Card className="relative overflow-hidden group hover:shadow-xl transition-all duration-300 border-0 bg-gradient-to-br from-white to-gray-50">
      <div className={`absolute left-0 top-0 bottom-0 w-1 ${
        color === 'navy' ? 'bg-blue-900' :
        color === 'orange' ? 'bg-orange-500' :
        color === 'yellow' ? 'bg-yellow-500' : 'bg-blue-900'
      }`}></div>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1.5 pt-3 pl-5 pr-4">
        <CardTitle className="text-xs font-medium text-gray-600">{title}</CardTitle>
        <div className={`rounded-xl p-1.5 ${
          color === 'navy' ? 'bg-blue-100' :
          color === 'orange' ? 'bg-orange-100' :
          color === 'yellow' ? 'bg-yellow-100' : 'bg-blue-100'
        } shadow-sm`}>
          <Icon className={`h-3.5 w-3.5 ${
            color === 'navy' ? 'text-blue-900' :
            color === 'orange' ? 'text-orange-600' :
            color === 'yellow' ? 'text-yellow-600' : 'text-blue-900'
          }`} />
        </div>
      </CardHeader>
      <CardContent className="pl-5 pb-4">
        <div className="text-xl font-bold tracking-tight text-gray-900 sm:text-[1.65rem]">{value}</div>
        {description && (
          <p className="mt-1.5 text-[11px] font-medium text-gray-500">
            {description}
          </p>
        )}
      </CardContent>
    </Card>
  );

  const isPageLoading = USE_REMOTE_ANALYTICS
    ? ((accessibleProgrammes.length > 0 && !activeProgram) || (analyticsQuery.isLoading && !analyticsQuery.isError && !analyticsQuery.data))
    : loading;

  if (isPageLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
        <p className="ml-2 text-gray-600">Loading analytics data...</p>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-1">
      <div className="space-y-3">
        <h1 className="text-lg font-semibold tracking-tight text-gray-900">Livestock Farmers Dashboard</h1>

        {analyticsQuery.isError && !analyticsQuery.data ? (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Analytics took too long to load. Adjust the filters or try again.</span>
          </div>
        ) : null}

        <Card className="w-full border-0 bg-white shadow-lg">
          <CardContent className="px-3 py-3">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => scrollFilterStripBy("left")}
                className="hidden h-9 w-9 shrink-0 rounded-full border border-slate-200 bg-white text-slate-800 shadow-sm hover:bg-slate-50 max-[900px]:inline-flex"
              >
                <ChevronLeft className="h-5 w-5" />
                <span className="sr-only">Scroll filters left</span>
              </Button>

              <div className="min-w-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div
                  ref={filterStripRef}
                  className="w-full overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
                >
                  <div className="flex min-w-max flex-nowrap items-center gap-2 p-1">
                    <Input
                      type="date"
                      value={dateRange.startDate}
                      onChange={(e) => handleDateRangeChange("startDate", e.target.value)}
                      className="h-9 w-[150px] shrink-0 border-gray-200 pr-2 text-xs focus:border-blue-500"
                    />

                    <Input
                      type="date"
                      value={dateRange.endDate}
                      onChange={(e) => handleDateRangeChange("endDate", e.target.value)}
                      className="h-9 w-[150px] shrink-0 border-gray-200 pr-2 text-xs focus:border-blue-500"
                    />

                    {availablePrograms.length > 1 ? (
                      <Select value={activeProgram} onValueChange={setActiveProgram}>
                        <SelectTrigger className="h-9 w-[150px] shrink-0 border-gray-200 text-sm">
                          <SelectValue placeholder="Select Programme" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ALL">All Programmes</SelectItem>
                          {availablePrograms.map((p) => (
                            <SelectItem key={p} value={p}>
                              {p}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : null}

                    <Select value={selectedYear || ""} onValueChange={handleYearChange}>
                      <SelectTrigger className="h-9 w-[150px] shrink-0 border-gray-200 text-sm">
                        <SelectValue placeholder="Select Year" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableYears.map((year) => (
                          <SelectItem key={year} value={year}>
                            {year}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <Button
                      variant="outline"
                      onClick={setMonthFilter}
                      size="sm"
                      className={getFilterButtonClass(filterMode === "monthly")}
                    >
                      This Month
                    </Button>
                    <Button onClick={clearFilters} variant="ghost" size="sm" className="h-9 shrink-0 text-red-500 hover:text-red-600">
                      Clear
                    </Button>
                  </div>
                </div>
              </div>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => scrollFilterStripBy("right")}
                className="hidden h-9 w-9 shrink-0 rounded-full border border-slate-200 bg-white text-slate-800 shadow-sm hover:bg-slate-50 max-[900px]:inline-flex"
              >
                <ChevronRight className="h-5 w-5" />
                <span className="sr-only">Scroll filters right</span>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {hasActiveDateFilters && stats.total === 0 && filteredData.length === 0 ? (
        <Card className="border-amber-200 bg-amber-50">
          <CardHeader>
            <CardTitle className="flex items-center text-base text-amber-800">
              <AlertCircle className="mr-2 h-5 w-5" />
              No farmer data for this filter
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-amber-700">
              No farmers were found for the selected date range. Change the dates or use Clear to reset the filters.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-3">
        <StatsCard 
          title="Total Farmers" 
          value={stats.total.toLocaleString()} 
          icon={Users}
          description={`${stats.maleFarmers} Male (${stats.maleFarmers > 0 ? ((stats.maleFarmers / stats.total) * 100).toFixed(1) : 0}%) | ${stats.femaleFarmers} Female`}
          color="navy"
        />
        <StatsCard 
          title="Average of Registered Farmers" 
          value={stats.total > 0 ? (stats.total / (stats.totalAnimals || 1)).toFixed(1) : "0"} 
          icon={GraduationCap}
          description={`Per animal census across ${stats.total.toLocaleString()} farmers`}
          color="yellow"
        />
        <StatsCard 
          title="Animals Census" 
          value={stats.totalAnimals.toLocaleString()} 
          icon={Beef}
          description="Total livestock count"
          color="orange"
        />
      </div>

      <div className="space-y-6">
        <Card className="overflow-hidden border border-slate-200 bg-white shadow-lg">
          <CardHeader className="border-b border-slate-100 bg-slate-50/70">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <CardTitle className="flex items-center gap-2 text-base text-gray-800">
                <UserCheck className="h-5 w-5 text-blue-600" />
                Field Officers Performance
              </CardTitle>
              
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="min-w-[980px] w-full border-collapse text-left">
                <thead className="bg-blue-50">
                  <tr>
                    <th className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-blue-800">Field Officer</th>
                    <th className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-blue-800">Counties Active</th>
                    <th className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-blue-800">Farmers Registered</th>
                    <th className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-blue-800">Target</th>
                    <th className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-blue-800">Progress</th>
                    <th className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-blue-800">Status</th>
                    <th className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-blue-800">View</th>
                  </tr>
                </thead>
                <tbody>
                  {userProgressData.map((user) => {
                    const statusLabel = getProgressStatusLabel(user.status);
                    return (
                      <tr key={user.id} className="border-b border-slate-100 transition-colors hover:bg-blue-50/40">
                        <td className="px-4 py-2 font-medium text-slate-900">
                          <div className="leading-tight">{user.name}</div>
                        </td>
                        <td className="px-4 py-2">
                          <span className="text-sm text-slate-600">{user.region || "N/A"}</span>
                        </td>
                        <td className="px-4 py-2 font-semibold text-slate-900">
                          {user.farmersRegistered.toLocaleString()}
                        </td>
                        <td className="px-4 py-2 text-slate-600">{user.target.toLocaleString()}</td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-3">
                            <div className="h-2 w-28 rounded-full bg-slate-100">
                              <div
                                className={`h-2 rounded-full transition-all duration-500 ${getProgressBarClass(user.status)}`}
                                style={{ width: `${Math.min(user.progressPercentage, 100)}%` }}
                              />
                            </div>
                            <span className="w-12 text-right text-xs font-medium text-slate-600">
                              {user.progressPercentage.toFixed(0)}%
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <span className={`text-sm font-semibold ${getProgressTextClass(user.status)}`}>
                            {statusLabel}
                          </span>
                        </td>
                        <td className="px-4 py-2">
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() => openOfficerTargets(user)}
                            className="h-8 w-8 border-blue-200 p-0 text-blue-700 hover:bg-blue-50 hover:text-blue-800"
                            aria-label={`View quarterly targets for ${user.name}`}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                  {userProgressData.length === 0 && hasActiveDateFilters && stats.total === 0 && filteredData.length === 0 && (
                    <tr>
                      <td colSpan={7} className="bg-gray-50 py-8 text-center text-gray-500">
                        No farmer data available for the selected filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={isOfficerTargetsOpen} onOpenChange={setIsOfficerTargetsOpen}>
        <DialogContent className="max-w-3xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-gray-800">
              <Eye className="h-5 w-5 text-blue-600" />
              {selectedOfficer ? `${selectedOfficer.name} Quarterly Targets ${analysisYearLabel}` : `Quarterly Targets (${analysisYearLabel})`}
            </DialogTitle>
           
          </DialogHeader>

          {selectedOfficer ? (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Analysis Year</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">{analysisYearLabel}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Registered</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {selectedOfficer.farmersRegistered.toLocaleString()} farmers
                  </p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Target Result</p>
                  <p className={`mt-1 text-sm font-semibold ${getProgressTextClass(selectedOfficer.status)}`}>
                    {getProgressStatusLabel(selectedOfficer.status)}
                  </p>
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="w-full border-collapse text-left">
                  <thead className="bg-blue-50">
                    <tr>
                      <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-blue-800">Period</th>
                      <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-blue-800">Farmers</th>
                      <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-blue-800">Target</th>
                      <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-blue-800">Progress</th>
                      <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-blue-800">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedOfficer.periods.map((period) => {
                      const progressPercent = Math.min(period.progressPercentage, 100);
                      const fallbackQuarter = quarterTargets.find((entry) => entry.key === period.key);
                      const isUpcoming = period.upcoming ?? (fallbackQuarter ? isUpcomingQuarter(fallbackQuarter.start, quarterYear) : false);
                      return (
                        <tr key={period.key} className="border-b border-slate-100">
                          <td className="px-4 py-4 font-medium text-slate-900">{period.label}</td>
                          <td className="px-4 py-4 text-slate-700">{period.count.toLocaleString()}</td>
                          <td className="px-4 py-4 text-slate-700">{period.target.toLocaleString()}</td>
                          <td className="px-4 py-4">
                            <div className="flex items-center gap-3">
                              <div className="h-2 w-28 rounded-full bg-slate-100">
                                <div
                                className={`h-2 rounded-full transition-all duration-500 ${getProgressBarClass(period.status)}`}
                                style={{ width: `${progressPercent}%` }}
                              />
                            </div>
                              <span className="text-xs font-medium text-slate-600">
                                {period.progressPercentage.toFixed(0)}%
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <span className={`text-sm font-semibold ${getProgressTextClass(period.status)}`}>
                              {getProgressStatusLabel(period.status)}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="border-0 shadow-lg bg-white">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base text-gray-800">
              <Users className="h-5 w-5 text-blue-900" />
              Farmers by Gender
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie
                  data={genderData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={2}
                  dataKey="value"
                  label={renderCustomizedLabel}
                  labelLine={false}
                >
                  {genderData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(value: number) => [value, "Farmers"]} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-lg bg-white">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base text-gray-800">
              <Beef className="h-5 w-5 text-red-900" />
              Animal Census
            </CardTitle>
          </CardHeader>
          <CardContent>
            {animalCensusData.length > 0 ? (
              <>
                <div className="mx-auto h-[280px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={animalCensusData}
                        cx="50%"
                        cy="50%"
                        outerRadius={108}
                        paddingAngle={2}
                        dataKey="value"
                        label={renderCustomizedLabel}
                        labelLine={false}
                        startAngle={90}
                        endAngle={-270}
                        stroke="#ffffff"
                        strokeWidth={2}
                      >
                        {animalCensusData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip content={renderAnimalCensusTooltip} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>

                <div className="mt-2 flex flex-wrap justify-center gap-2">
                  {animalCensusData.map((item) => (
                    <div
                      key={item.name}
                      className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700"
                    >
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                      <span>{item.name}</span>
                      <span className="font-semibold text-slate-900">{item.value.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="flex h-[280px] items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500">
                No data available yet
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-0 shadow-lg bg-white">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base text-gray-800">
              <Activity className="h-5 w-5 text-orange-600" />
              Farmers vs Livestock (Weekly Trend)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={weeklyPerformanceData}>
                <defs>
                  <linearGradient id="colorFarmers" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COLORS.navy} stopOpacity={0.8}/>
                    <stop offset="95%" stopColor={COLORS.navy} stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorAnimals" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COLORS.orange} stopOpacity={0.8}/>
                    <stop offset="95%" stopColor={COLORS.orange} stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                <XAxis 
                  dataKey="name" 
                  fontSize={11}
                  tick={{ fill: '#6b7280' }}
                />
                <YAxis 
                  fontSize={11} 
                  tick={{ fill: '#6b7280' }}
                />
                <Tooltip 
                  cursor={{fill: 'transparent'}}
                  contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}
                />
                <Legend 
                  verticalAlign="top" 
                  height={40}
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ fontSize: '11px' }}
                />
                <Area 
                  type="monotone" 
                  dataKey="farmers" 
                  stroke={COLORS.navy} 
                  fillOpacity={1} 
                  fill="url(#colorFarmers)" 
                  strokeWidth={2}
                  name="Farmers" 
                />
                <Area 
                  type="monotone" 
                  dataKey="animals" 
                  stroke={COLORS.orange} 
                  fillOpacity={1} 
                  fill="url(#colorAnimals)" 
                  strokeWidth={2}
                  name="Livestock" 
                />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-lg bg-white">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base text-gray-800">
              <Map className="h-5 w-5 text-blue-900" />
              Subcounty Performance
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={subcountyPerformanceData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                <XAxis 
                  dataKey="name" 
                  fontSize={11}
                  tick={{ fill: '#6b7280' }}
                  angle={-45}
                  textAnchor="end"
                  height={80}
                />
                <YAxis 
                  fontSize={11} 
                  tick={{ fill: '#6b7280' }}
                />
                <Tooltip 
                  cursor={{fill: 'transparent'}}
                  contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}
                />
                <Legend 
                  verticalAlign="top" 
                  height={40}
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ fontSize: '11px' }}
                />
                <Bar dataKey="value" name="Farmers" fill={COLORS.navy} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default LivestockFarmersAnalytics;

