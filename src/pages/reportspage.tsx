import * as React from "react";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import {
  canViewAllProgrammes,
  isHummanResourceManager,
  isProjectManager,
  resolvePermissionPrincipal,
} from "@/contexts/authhelper";
import { db, ref, push, update, remove, fetchCollectionByProgrammes, invalidateCollectionCache } from "@/lib/firebase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { 
  PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip, 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, AreaChart, Area
} from "recharts";
import { 
  Users, GraduationCap, Beef, TrendingUp, Award, 
  MapPin, Syringe, TargetIcon, Loader2, Calendar, PencilLine, Trash2, UserX, MoreVertical, ChevronLeft, ChevronRight
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSharedProgrammeSelection } from "@/hooks/use-shared-programme-selection";
import { toast } from "@/hooks/use-toast";
import { fetchAnalysisSummary } from "@/lib/analysis";
import {
  ALL_PROGRAMMES_VALUE,
  PROGRAMME_OPTIONS,
  matchesProgrammeSelection,
  resolveAccessibleProgrammes,
} from "@/lib/programme-access";
import Chart from "react-apexcharts";

// --- Constants ---
const COLORS = {
  darkBlue: "#1e3a8a",
  orange: "#f97316", 
  yellow: "#f59e0b",
  green: "#16a34a",
  maroon: "#991b1b",
  purple: "#7c3aed",
  teal: "#0d9488",
  red: "#dc2626"
};

const BAR_COLORS = [
  COLORS.darkBlue, COLORS.orange, COLORS.yellow, COLORS.green, 
  COLORS.purple, COLORS.teal, COLORS.maroon
];

const HORIZONTAL_BAR_CHART_MARGIN = { top: 0, right: 12, left: 48, bottom: 0 };
const HORIZONTAL_BAR_CHART_Y_AXIS_WIDTH = 68;

// Cache duration: 5 minutes
const CACHE_DURATION = 5 * 60 * 1000; 

// --- Types ---
interface Farmer {
  id: string;
  name: string;
  farmerName?: string;
  gender: string;
  phone: string;
  county: string;
  subcounty: string;
  location: string;
  goats: { total?: number; female?: number; male?: number };
  sheep: string | number;
  cattle: string | number;
  vaccinated: boolean;
  vaccines: string[];
  createdAt: number | string;
  registrationDate: string;
  femaleBreeds: string | number;
  maleBreeds: string | number;
  ageDistribution?: any;
  aggregationGroup?: string;
  bucksServed?: string;
  farmerId?: string;
  traceability?: boolean;
  username?: string;
  programme?: string;
}

interface TrainingRecord {
  id: string;
  totalFarmers: number;
  county: string;
  subcounty: string;
  location: string;
  startDate: string;
  endDate: string;
  topicTrained: string;
  createdAt?: string | number;
  programme?: string;
  fieldOfficer?: string;
  username?: string;
}

interface OfftakeRecord {
  id: string;
  date?: string | number | Date;
  Date?: string | number | Date;
  createdAt?: string | number;
  programme?: string;
  totalGoats?: number | string;
  goatsBought?: number | string;
  goats?: unknown;
  Goats?: unknown;
}

interface AnimalHealthVaccine {
  type?: string;
  doses?: number | string;
}

interface AnimalHealthRecord {
  id: string;
  date?: string;
  createdAt?: string | number;
  programme?: string;
  county?: string;
  subcounty?: string;
  location?: string;
  vaccines?: AnimalHealthVaccine[];
  vaccinetype?: string;
  number_doses?: number | string;
}

interface StaffMarkRecord {
  id: string;
  staffName?: string;
  staff?: string;
  name?: string;
  marks?: number | string;
  note?: string;
  programme?: string;
  dateAwarded?: string;
  createdAt?: number | string;
  awardedBy?: string;
  periodStart?: string;
  periodEnd?: string;
}

interface StaffDirectoryRecord {
  id: string;
  staffName?: string;
  role?: string;
  county?: string;
  phone?: string;
  notes?: string;
  programme?: string;
  status?: string;
  createdAt?: number | string;
  createdBy?: string;
  updatedAt?: number | string;
  updatedBy?: string;
}

type StaffManagementRow = {
  id: string;
  staffName: string;
  role: string;
  county: string;
  phone: string;
  programme: string;
  status: string;
  notes: string;
  totalMarks: number;
  awardCount: number;
  lastAwardDate: string;
  lastAwardNote: string;
  managedInDirectory: boolean;
};

type CreateStaffFormState = {
  staffName: string;
  role: string;
  county: string;
  phone: string;
  notes: string;
};

type StaffMarkFormState = {
  staffName: string;
  marks: string;
  note: string;
  dateAwarded: string;
};

const EMPTY_STAFF_MARK_RECORDS: StaffMarkRecord[] = [];
const EMPTY_STAFF_DIRECTORY_RECORDS: StaffDirectoryRecord[] = [];
const EMPTY_STAFF_MANAGEMENT_ROWS: StaffManagementRow[] = [];

const createDefaultStaffForm = (): CreateStaffFormState => ({
  staffName: "",
  role: "",
  county: "",
  phone: "",
  notes: "",
});

const createDefaultStaffMarkForm = (): StaffMarkFormState => ({
  staffName: "",
  marks: "",
  note: "",
  dateAwarded: formatDateToLocal(new Date()),
});

// --- Helper Functions ---
const parseNumericValue = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.replace(/,/g, "").trim();
    if (!normalized) return 0;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const parseDate = (date: any): Date | null => {
  if (!date) return null;
  try {
    if (date?.toDate && typeof date.toDate === 'function') return date.toDate(); 
    if (date instanceof Date) return date;
    if (typeof date === 'number') return new Date(date);
    if (typeof date === 'string') {
      const parsedCustom = new Date(date);
      if (!isNaN(parsedCustom.getTime())) return parsedCustom;
    } 
    if (date?.seconds) return new Date(date.seconds * 1000);
  } catch (error) {
    console.error('Error parsing date:', error, date);
  }
  return null;
};

const formatDateToLocal = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getNumberField = (obj: any, ...fieldNames: string[]): number => {
  for (const fieldName of fieldNames) {
    const value = obj[fieldName];
    if (value !== undefined && value !== null && value !== '') {
      const num = parseNumericValue(value);
      return isNaN(num) ? 0 : num;
    }
  }
  return 0;
};

const getArrayLikeSize = (value: unknown): number => {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).length;
  return 0;
};

const getLeaderName = (value: unknown, fallback: string): string => {
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
};

const normalizeStaffName = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

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

const formatDisplayDate = (value: unknown): string => {
  const parsed = parseDate(value);
  if (!parsed) return "N/A";
  return parsed.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

const getOfftakeGoatsTotal = (record: OfftakeRecord): number =>
  Math.max(
    getNumberField(record, "totalGoats"),
    getNumberField(record, "goatsBought"),
    getNumberField(record, "goats"),
    getArrayLikeSize(record.goats),
    getArrayLikeSize(record.Goats),
    0,
  );

const getAnimalHealthTotalDoses = (record: AnimalHealthRecord): number => {
  if (Array.isArray(record.vaccines)) {
    return record.vaccines.reduce((sum, vaccine) => sum + (Number(vaccine?.doses) || 0), 0);
  }
  return getNumberField(record, "number_doses");
};

const getAnimalHealthLocationName = (record: AnimalHealthRecord): string =>
  String(record.location || record.subcounty || record.county || "Unknown").trim() || "Unknown";

const buildLocationMetricSeries = (entries: Array<{ name: string; value: number }>) => {
  const totals = new Map<string, number>();

  entries.forEach((entry) => {
    const locationName = String(entry.name || "Unknown").trim() || "Unknown";
    const value = Number(entry.value || 0);
    if (value <= 0) return;
    totals.set(locationName, (totals.get(locationName) || 0) + value);
  });

  return Array.from(totals.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
};

const isDateInRange = (date: any, startDate: string, endDate: string): boolean => {
  if (!startDate && !endDate) return true;
  const parsedDate = parseDate(date);
  if (!parsedDate) return false;

  const dateOnly = new Date(parsedDate);
  dateOnly.setHours(0, 0, 0, 0);

  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate) : null;
  
  if (start) start.setHours(0, 0, 0, 0);
  if (end) end.setHours(23, 59, 59, 999);

  if (start && dateOnly < start) return false;
  if (end && dateOnly > end) return false;
  return true;
};

const getCurrentWeekDates = () => {
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  return {
    startDate: formatDateToLocal(startOfWeek),
    endDate: formatDateToLocal(endOfWeek)
  };
};

const getCurrentMonthDates = () => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return {
    startDate: formatDateToLocal(startOfMonth),
    endDate: formatDateToLocal(endOfMonth)
  };
};

const getCurrentYearDates = () => {
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  return {
    startDate: formatDateToLocal(startOfYear),
    endDate: formatDateToLocal(now),
  };
};

const getQ1Dates = (year: number) => { 
  return { startDate: `${year}-01-01`, endDate: `${year}-03-31` };
};

const getQ2Dates = (year: number) => { 
  return { startDate: `${year}-01-01`, endDate: `${year}-06-30` };
};

const getQ3Dates = (year: number) => { 
  return { startDate: `${year}-01-01`, endDate: `${year}-09-30` };
};

const getQ4Dates = (year: number) => { 
  return { startDate: `${year}-01-01`, endDate: `${year}-12-31` };
};

const USE_REMOTE_ANALYTICS = true;

type PerformanceReportData = {
  scope: "performance-report";
  resolvedProgrammes: string[];
  totalFarmers: number;
  maleFarmers: number;
  femaleFarmers: number;
  malePercentage: string;
  femalePercentage: string;
  totalAnimals: number;
  totalGoats: number;
  totalSheep: number;
  goatsPercentage: string;
  sheepPercentage: string;
  totalTrainedFarmers: number;
  countyPerformanceData: Array<{ name: string; value: number }>;
  subcountyPerformanceData: Array<{ name: string; value: number }>;
  registrationTrendData: Array<{ name: string; registrations: number }>;
  registrationTrendComparisonData: Array<{ name: string; registrations: number }>;
  topLocations: Array<{ name: string; value: number }>;
  topCustomers: Array<{ name: string; value: number; county: string }>;
  totalGoatsPurchased: number;
  topFieldOfficers: Array<{ name: string; value: number; county: string }>;
  topStaffAwarded: Array<{ name: string; value: number }>;
  totalDosesGivenOut: number;
  uniqueCounties: number;
  totalBreedsDistributed: number;
  breedsMale: number;
  breedsFemale: number;
  breedsMalePercentage: string;
  breedsFemalePercentage: string;
  farmersWithBreedData: number;
  vaccinationRate: string;
  vaccinatedAnimals: number;
  vaccinatedFarmersCount: number;
  breedsByCountyData: Array<{ name: string; value: number }>;
  breedsBySubcountyData: Array<{ name: string; value: number }>;
  breedsByLocationData: Array<{ name: string; value: number }>;
  vaccinationByCountyData: Array<{ name: string; value: number }>;
  vaccinationBySubcountyData: Array<{ name: string; value: number }>;
  dosesByLocationData: Array<{ name: string; value: number }>;
};

const EMPTY_PERFORMANCE_DATA: PerformanceReportData = {
  scope: "performance-report",
  resolvedProgrammes: [],
  totalFarmers: 0,
  maleFarmers: 0,
  femaleFarmers: 0,
  malePercentage: "0.0",
  femalePercentage: "0.0",
  totalAnimals: 0,
  totalGoats: 0,
  totalSheep: 0,
  goatsPercentage: "0.0",
  sheepPercentage: "0.0",
  totalTrainedFarmers: 0,
  countyPerformanceData: [],
  subcountyPerformanceData: [],
  registrationTrendData: [],
  registrationTrendComparisonData: [],
  topLocations: [],
  topCustomers: [],
  totalGoatsPurchased: 0,
  topFieldOfficers: [],
  topStaffAwarded: [],
  totalDosesGivenOut: 0,
  uniqueCounties: 0,
  totalBreedsDistributed: 0,
  breedsMale: 0,
  breedsFemale: 0,
  breedsMalePercentage: "0.0",
  breedsFemalePercentage: "0.0",
  farmersWithBreedData: 0,
  vaccinationRate: "0.0",
  vaccinatedAnimals: 0,
  vaccinatedFarmersCount: 0,
  breedsByCountyData: [],
  breedsBySubcountyData: [],
  breedsByLocationData: [],
  vaccinationByCountyData: [],
  vaccinationBySubcountyData: [],
  dosesByLocationData: [],
};

const normalizeProgramme = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toUpperCase();
  if (normalized === "KPMD 2" || normalized === "KPMD-2") return "KPMD 2";
  return normalized;
};

function computeLocalPerformanceReportData(
  farmers: Farmer[],
  trainingRecords: TrainingRecord[],
  animalHealthActivities: AnimalHealthRecord[],
  offtakeRecords: OfftakeRecord[],
  staffMarkRecords: StaffMarkRecord[],
  dateRange: { startDate: string; endDate: string },
  timeFrame: "weekly" | "monthly" | "yearly",
  selectedProgramme: string | null,
  selectedYear: number | null,
  canViewAllProgrammeData: boolean,
): PerformanceReportData {
  if (!selectedProgramme) return EMPTY_PERFORMANCE_DATA;

  const filteredFarmers = farmers.filter((farmer) => {
    const farmerDate = farmer.createdAt || farmer.registrationDate;
    return matchesProgrammeSelection(farmer.programme, selectedProgramme, canViewAllProgrammeData) &&
      isDateInRange(farmerDate, dateRange.startDate, dateRange.endDate);
  });

  const filteredTraining = trainingRecords.filter((record) => {
    const recordDate = record.createdAt || record.startDate;
    return matchesProgrammeSelection(record.programme, selectedProgramme, canViewAllProgrammeData) &&
      isDateInRange(recordDate, dateRange.startDate, dateRange.endDate);
  });
  const filteredAnimalHealthActivities = animalHealthActivities.filter((record) => {
    const recordDate = record.createdAt || record.date;
    return matchesProgrammeSelection(record.programme, selectedProgramme, canViewAllProgrammeData) &&
      isDateInRange(recordDate, dateRange.startDate, dateRange.endDate);
  });
  const filteredOfftakeRecords = offtakeRecords.filter((record) => {
    const recordDate = record.date || record.Date || record.createdAt;
    return matchesProgrammeSelection(record.programme, selectedProgramme, canViewAllProgrammeData) &&
      isDateInRange(recordDate, dateRange.startDate, dateRange.endDate);
  });
  const filteredStaffMarks = staffMarkRecords.filter((record) => {
    const recordDate = record.dateAwarded || record.createdAt;
    return matchesProgrammeSelection(record.programme, selectedProgramme, canViewAllProgrammeData) &&
      isDateInRange(recordDate, dateRange.startDate, dateRange.endDate);
  });
  const requestedProgramme = normalizeProgramme(selectedProgramme);
  const includeAllProgrammes = selectedProgramme === ALL_PROGRAMMES_VALUE || !requestedProgramme;
  const programmeFarmers = farmers.filter((farmer) =>
    matchesProgrammeSelection(farmer.programme, selectedProgramme, canViewAllProgrammeData)
  );

  let maleFarmers = 0;
  let femaleFarmers = 0;
  let totalGoats = 0;
  let totalSheep = 0;
  let totalCattle = 0;
  let totalGoatsPurchased = 0;
  let totalDosesGivenOut = 0;
  let totalVaccinatedAnimals = 0;
  let vaccinatedFarmersCount = 0;
  let breedsMale = 0;
  let breedsFemale = 0;
  let farmersWithBreedData = 0;
  const countyMap: Record<string, number> = {};
  const subcountyMap: Record<string, number> = {};
  const locationMap: Record<string, number> = {};
  const topCustomersMap: Record<string, { name: string; value: number; county: string }> = {};
  const topFieldOfficersMap: Record<string, { value: number; counties: Record<string, number> }> = {};
  const topStaffAwardedMap: Record<string, number> = {};
  const breedsByCountyMap: Record<string, number> = {};
  const breedsBySubcountyMap: Record<string, number> = {};
  const breedsByLocationMap: Record<string, number> = {};
  const vaccinationByCountyMap: Record<string, number> = {};
  const vaccinationBySubcountyMap: Record<string, number> = {};
  const dosesByLocationMap: Record<string, number> = {};
  const selectedYearNumber = selectedYear && Number.isFinite(selectedYear) ? selectedYear : null;
  const currentYear = new Date().getFullYear();
  const trendYear = selectedYearNumber ?? null;
  const trendComparisonYears = Array.from({ length: 5 }, (_, index) => currentYear - 4 + index);

  for (const farmer of filteredFarmers) {
    const gender = String(farmer.gender || "").trim().toLowerCase();
    if (gender === "male") maleFarmers += 1;
    else if (gender === "female") femaleFarmers += 1;

    const goats = getGoatTotal(farmer.goats);
    const sheep = getNumberField(farmer, "sheep");
    const cattle = getNumberField(farmer, "cattle");
    const totalAnimalsForFarmer = goats + sheep + cattle;
    totalGoats += goats;
    totalSheep += sheep;
    totalCattle += cattle;

    const maleBreedCount = getNumberField(farmer, "maleBreeds");
    const femaleBreedCount = getNumberField(farmer, "femaleBreeds");
    breedsMale += maleBreedCount;
    breedsFemale += femaleBreedCount;

    const county = String(farmer.county || "Unknown").trim() || "Unknown";
    const subcounty = String(farmer.subcounty || "Unknown").trim() || "Unknown";
    const location = String(farmer.location || "Unknown").trim() || "Unknown";
    countyMap[county] = (countyMap[county] || 0) + 1;
    subcountyMap[subcounty] = (subcountyMap[subcounty] || 0) + 1;
    locationMap[location] = (locationMap[location] || 0) + 1;

    const farmerName = String(farmer.name || farmer.farmerName || farmer.farmerId || farmer.id || "Unknown").trim() || "Unknown";
    const currentTop = topCustomersMap[farmerName] || { name: farmerName, value: 0, county };
    currentTop.value += totalAnimalsForFarmer;
    if (county !== "Unknown") currentTop.county = county;
    topCustomersMap[farmerName] = currentTop;

    const fieldOfficerName = typeof farmer.username === "string" ? farmer.username.trim() : "";
    if (fieldOfficerName) {
      const currentOfficer = topFieldOfficersMap[fieldOfficerName] || { value: 0, counties: {} };
      currentOfficer.value += 1;
      currentOfficer.counties[county] = (currentOfficer.counties[county] || 0) + 1;
      topFieldOfficersMap[fieldOfficerName] = currentOfficer;
    }

    if (farmer.vaccinated === true) {
      totalVaccinatedAnimals += totalAnimalsForFarmer;
      vaccinatedFarmersCount += 1;
      vaccinationByCountyMap[county] = (vaccinationByCountyMap[county] || 0) + totalAnimalsForFarmer;
      vaccinationBySubcountyMap[subcounty] = (vaccinationBySubcountyMap[subcounty] || 0) + totalAnimalsForFarmer;
    }

    if (maleBreedCount + femaleBreedCount > 0) {
      farmersWithBreedData += 1;
      breedsByCountyMap[county] = (breedsByCountyMap[county] || 0) + maleBreedCount + femaleBreedCount;
      breedsBySubcountyMap[subcounty] = (breedsBySubcountyMap[subcounty] || 0) + maleBreedCount + femaleBreedCount;
      breedsByLocationMap[location] = (breedsByLocationMap[location] || 0) + maleBreedCount + femaleBreedCount;
    }
  }

  filteredStaffMarks.forEach((record) => {
    const staffName = getLeaderName(
      record.staffName || record.staff || record.name,
      "",
    );
    const awardedMarks = getNumberField(record, "marks", "score", "awardedMarks");
    if (!staffName || awardedMarks <= 0) return;
    topStaffAwardedMap[staffName] = (topStaffAwardedMap[staffName] || 0) + awardedMarks;
  });

  filteredAnimalHealthActivities.forEach((record) => {
    const doses = getAnimalHealthTotalDoses(record);
    totalDosesGivenOut += doses;
    const location = getAnimalHealthLocationName(record);
    if (doses > 0) {
      dosesByLocationMap[location] = (dosesByLocationMap[location] || 0) + doses;
    }
  });

  filteredOfftakeRecords.forEach((record) => {
    totalGoatsPurchased += getOfftakeGoatsTotal(record);
  });

  const totalAnimals = totalGoats + totalSheep + totalCattle;
  const totalTrainedFarmers = filteredTraining.reduce((sum, record) => sum + getNumberField(record, "totalFarmers"), 0);
  const countyPerformanceData = Object.entries(countyMap)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
  const subcountyPerformanceData = Object.entries(subcountyMap)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
  const topLocations = Object.entries(locationMap)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
  const topCustomers = Object.values(topCustomersMap)
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
  const topFieldOfficers = Object.entries(topFieldOfficersMap)
    .map(([name, entry]) => {
      const countyEntries = Object.entries(entry.counties);
      const county =
        countyEntries.length > 0 ?
          countyEntries.sort((left, right) => right[1] - left[1])[0][0] :
          "Unknown";
      return { name, value: entry.value, county };
    })
    .sort((a, b) => b.value - a.value);
  const topStaffAwarded = Object.entries(topStaffAwardedMap)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
  const registrationTrendData = (() => {
    const trendData: Array<{ name: string; registrations: number }> = [];
    if (timeFrame === "weekly") {
      for (let offset = 3; offset >= 0; offset -= 1) {
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - (offset * 7) - weekStart.getDay());
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        const count = filteredFarmers.filter((farmer) => {
          const date = parseDate(farmer.createdAt || farmer.registrationDate);
          return !!date && date >= weekStart && date <= weekEnd;
        }).length;
        trendData.push({ name: `Week ${4 - offset}`, registrations: count });
      }
      return trendData;
    }

    if (timeFrame === "monthly") {
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const analysisYear = trendYear ?? currentYear;
      months.forEach((monthName, index) => {
        const count = filteredFarmers.filter((farmer) => {
          const date = parseDate(farmer.createdAt || farmer.registrationDate);
          if (!date) return false;
          if (trendYear === null) return date.getMonth() === index;
          const monthStart = new Date(analysisYear, index, 1);
          const monthEnd = new Date(analysisYear, index + 1, 0);
          return date >= monthStart && date <= monthEnd;
        }).length;
        trendData.push({ name: monthName, registrations: count });
      });
      return trendData;
    }

    if (trendYear !== null) {
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      months.forEach((monthName, index) => {
        const monthStart = new Date(trendYear, index, 1);
        const monthEnd = new Date(trendYear, index + 1, 0);
        const count = filteredFarmers.filter((farmer) => {
          const date = parseDate(farmer.createdAt || farmer.registrationDate);
          return !!date && date >= monthStart && date <= monthEnd;
        }).length;
        trendData.push({ name: monthName, registrations: count });
      });
      return trendData;
    }

    const resolvedYears =
      Array.from(
        new Set(
          filteredFarmers
            .map((farmer) => parseDate(farmer.createdAt || farmer.registrationDate)?.getFullYear() ?? null)
            .filter((year): year is number => year !== null),
        ),
      ).sort((left, right) => left - right);

    for (const year of (resolvedYears.length > 0 ? resolvedYears : trendComparisonYears)) {
      const yearStart = new Date(year, 0, 1);
      const yearEnd = new Date(year, 11, 31);
      const count = filteredFarmers.filter((farmer) => {
        const date = parseDate(farmer.createdAt || farmer.registrationDate);
        return !!date && date >= yearStart && date <= yearEnd;
      }).length;
      trendData.push({ name: String(year), registrations: count });
    }
    return trendData;
  })();
  const registrationTrendComparisonData = trendComparisonYears.map((year) => {
    const yearStart = new Date(year, 0, 1);
    const yearEnd = new Date(year, 11, 31);
    const count = programmeFarmers.filter((farmer) => {
      const date = parseDate(farmer.createdAt || farmer.registrationDate);
      return !!date && date >= yearStart && date <= yearEnd;
    }).length;
    return { name: String(year), registrations: count };
  });
  const uniqueCounties = new Set(
    filteredFarmers.map((farmer) => String(farmer.county || "").trim()).filter(Boolean),
  ).size;
  const totalBreedsDistributed = breedsMale + breedsFemale;
  const breedsByCountyData = Object.entries(breedsByCountyMap)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
  const breedsBySubcountyData = Object.entries(breedsBySubcountyMap)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
  const breedsByLocationData = Object.entries(breedsByLocationMap)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
  const vaccinationByCountyData = Object.entries(vaccinationByCountyMap)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
  const vaccinationBySubcountyData = Object.entries(vaccinationBySubcountyMap)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
  const dosesByLocationData = Object.entries(dosesByLocationMap)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  return {
    scope: "performance-report",
    resolvedProgrammes: includeAllProgrammes ? [...PROGRAMME_OPTIONS] : [requestedProgramme],
    totalFarmers: filteredFarmers.length,
    maleFarmers,
    femaleFarmers,
    malePercentage: filteredFarmers.length > 0 ? ((maleFarmers / filteredFarmers.length) * 100).toFixed(1) : "0.0",
    femalePercentage: filteredFarmers.length > 0 ? ((femaleFarmers / filteredFarmers.length) * 100).toFixed(1) : "0.0",
    totalAnimals,
    totalGoats,
    totalSheep,
    goatsPercentage: totalAnimals > 0 ? ((totalGoats / totalAnimals) * 100).toFixed(1) : "0.0",
    sheepPercentage: totalAnimals > 0 ? ((totalSheep / totalAnimals) * 100).toFixed(1) : "0.0",
    totalTrainedFarmers,
    countyPerformanceData,
    subcountyPerformanceData,
    registrationTrendData,
    registrationTrendComparisonData,
    topLocations,
    topCustomers,
    totalGoatsPurchased,
    topFieldOfficers,
    topStaffAwarded,
    totalDosesGivenOut,
    uniqueCounties,
    totalBreedsDistributed,
    breedsMale,
    breedsFemale,
    breedsMalePercentage: totalBreedsDistributed > 0 ? ((breedsMale / totalBreedsDistributed) * 100).toFixed(1) : "0.0",
    breedsFemalePercentage: totalBreedsDistributed > 0 ? ((breedsFemale / totalBreedsDistributed) * 100).toFixed(1) : "0.0",
    farmersWithBreedData,
    vaccinationRate: totalAnimals > 0 ? ((totalVaccinatedAnimals / totalAnimals) * 100).toFixed(1) : "0.0",
    vaccinatedAnimals: totalVaccinatedAnimals,
    vaccinatedFarmersCount,
    breedsByCountyData,
    breedsBySubcountyData,
    breedsByLocationData,
    vaccinationByCountyData,
    vaccinationBySubcountyData,
    dosesByLocationData,
  };
}

// --- Custom Hook for Data Processing ---
const useProcessedData = (
  _allFarmers: Farmer[],
  _trainingRecords: TrainingRecord[],
  _animalHealthActivities: AnimalHealthRecord[],
  _offtakeRecords: OfftakeRecord[],
  _staffMarkRecords: StaffMarkRecord[],
  dateRange: { startDate: string; endDate: string },
  timeFrame: 'weekly' | 'monthly' | 'yearly',
  selectedProgramme: string | null,
  selectedYear: number | null,
  canViewAllProgrammeData: boolean,
) => {
  const queryResult = useQuery({
    queryKey: [
      "performance-report",
      selectedProgramme,
      dateRange.startDate,
      dateRange.endDate,
      timeFrame,
      selectedYear,
    ],
    queryFn: () =>
      fetchAnalysisSummary({
        scope: "performance-report",
        programme: selectedProgramme,
        dateRange,
        timeFrame,
        selectedYear,
      }),
    enabled: USE_REMOTE_ANALYTICS && !!selectedProgramme,
    placeholderData: (previousData) => previousData,
    staleTime: 10 * 60 * 1000,
    retry: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const localData = useMemo(
    () =>
      USE_REMOTE_ANALYTICS
        ? undefined
        : computeLocalPerformanceReportData(
            _allFarmers,
            _trainingRecords,
            _animalHealthActivities,
            _offtakeRecords,
            _staffMarkRecords,
            dateRange,
            timeFrame,
            selectedProgramme,
            selectedYear,
            canViewAllProgrammeData,
          ),
    [_allFarmers, _trainingRecords, _animalHealthActivities, _offtakeRecords, _staffMarkRecords, dateRange, timeFrame, selectedProgramme, selectedYear, canViewAllProgrammeData],
  );

  const remoteData = useMemo(
    () => ({ ...EMPTY_PERFORMANCE_DATA, ...(queryResult.data as Partial<PerformanceReportData> | undefined) }),
    [queryResult.data],
  );

  return {
    data: USE_REMOTE_ANALYTICS ? remoteData : localData ?? EMPTY_PERFORMANCE_DATA,
    isLoading: queryResult.isLoading,
    isError: queryResult.isError,
    error: queryResult.error,
  };
};

// --- Sub Components ---

interface StatsCardProps {
  title: string;
  value: string | number;
  subtext?: string;
  icon: React.ElementType;
  color?: 'blue' | 'orange' | 'yellow' | 'green' | 'red' | 'purple' | 'teal';
}

const StatsCard = React.memo(({ title, value, subtext, icon: Icon, color = "blue" }: StatsCardProps) => {
  const colorMap: Record<string, { border: string, bg: string, text: string }> = {
    blue: { border: 'bg-blue-500', bg: 'bg-blue-50', text: 'text-blue-600' },
    orange: { border: 'bg-orange-500', bg: 'bg-orange-50', text: 'text-orange-600' },
    yellow: { border: 'bg-yellow-500', bg: 'bg-yellow-50', text: 'text-yellow-600' },
    green: { border: 'bg-green-500', bg: 'bg-green-50', text: 'text-green-600' },
    red: { border: 'bg-red-500', bg: 'bg-red-50', text: 'text-red-600' },
    purple: { border: 'bg-purple-500', bg: 'bg-purple-50', text: 'text-purple-600' },
    teal: { border: 'bg-teal-500', bg: 'bg-teal-50', text: 'text-teal-600' },
  };

  const theme = colorMap[color];

  return (
    <Card className="relative overflow-hidden group hover:shadow-xl transition-all duration-300 border-0 bg-gradient-to-br from-white to-gray-50">
      <div className={`absolute left-0 top-0 bottom-0 w-1 ${theme.border}`}></div>
      
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 pt-4 pl-6">
        <CardTitle className="text-xs font-medium text-gray-600">{title}</CardTitle>
        <div className={`p-2 rounded-xl ${theme.bg} shadow-sm`}>
          <Icon className={`h-4 w-4 ${theme.text}`} />
        </div>
      </CardHeader>
      <CardContent className="pl-6 pb-4">
        <div className="text-xl font-bold text-gray-900">{value}</div>
        {subtext && (
          <p className="text-[11px] text-gray-500 mt-2 font-medium leading-relaxed">{subtext}</p>
        )}
      </CardContent>
    </Card>
  );
});

const SectionHeader = React.memo(({ title }: { title: string }) => (
  <h2 className="text-lg font-medium text-gray-800 mb-2 flex items-center border-gray-100">
    {title}
  </h2>
));

type ReportAudience = "hr" | "project-manager" | "default";
type ReportSectionId =
  | "hr-summary"
  | "hr-rankings"
  | "hr-distribution"
  | "project-manager-report"
  | "default-registration"
  | "default-animal-health";

const REPORT_VIEW_PROFILES: Record<ReportAudience, { title: string; sections: ReportSectionId[] }> = {
  hr: {
    title: "General Report",
    sections: ["hr-summary", "hr-rankings", "hr-distribution"],
  },
  "project-manager": {
    title: "Project Manager Report",
    sections: ["project-manager-report"],
  },
  default: {
    title: "Performance Dashboard",
    sections: ["default-registration", "default-animal-health"],
  },
};

const ALL_YEARS_VALUE = "ALL";

const resolveReportAudience = (
  userRole: string | null | undefined,
  userAttribute?: string | null,
): ReportAudience => {
  const principal = resolvePermissionPrincipal(userRole, userAttribute);
  if (isHummanResourceManager(principal)) return "hr";
  if (isProjectManager(principal)) return "project-manager";
  return "default";
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const BalesTrendsComboChart = ({ hayStorageRecords }: { hayStorageRecords: any[] }) => {
  const chartData = useMemo(() => {
    const monthlyData: Record<string, { harvested: number; sold: number }> = {};
    hayStorageRecords.forEach((r: any) => {
      const dateStr = r.date_sold || r.createdAt || r.created_at;
      if (!dateStr) return;
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (!monthlyData[key]) monthlyData[key] = { harvested: 0, sold: 0 };
      monthlyData[key].harvested += r.bales_harvested_stored || 0;
      monthlyData[key].sold += r.bales_sold || 0;
    });
    const sorted = Object.entries(monthlyData).sort(([a], [b]) => a.localeCompare(b));
    return {
      categories: sorted.map(([k]) => k),
      harvested: sorted.map(([, v]) => v.harvested),
      sold: sorted.map(([, v]) => v.sold),
    };
  }, [hayStorageRecords]);

  const options: ApexCharts.ApexOptions = {
    chart: { type: "bar", height: 280, background: "transparent", toolbar: { show: false }, fontFamily: "inherit" },
    plotOptions: { bar: { columnWidth: "55%", borderRadius: 4 } },
    colors: ["#3b82f6", "#eab308"],
    xaxis: { categories: chartData.categories, labels: { style: { fontSize: "11px" } }, axisBorder: { show: false }, axisTicks: { show: false } },
    yaxis: { labels: { style: { fontSize: "11px" } } },
    grid: { borderColor: "#f1f5f9", strokeDashArray: 4 },
    dataLabels: { enabled: false },
    stroke: { width: [0, 3], curve: "smooth" },
    tooltip: { shared: true, intersect: false },
    legend: { position: "bottom", fontSize: "12px" },
  };

  return (
    <Chart
      options={options}
      series={[
        { name: "Bales Harvested", type: "column", data: chartData.harvested },
        { name: "Bales Sold", type: "line", data: chartData.sold },
      ]}
      type="bar"
      height={280}
    />
  );
};

const VaccinationMonthlyTrendChart = ({ animalHealthRecords }: { animalHealthRecords: any[] }) => {
  const chartData = useMemo(() => {
    const yearData: Record<number, number[]> = {};
    animalHealthRecords.forEach((r: any) => {
      const dateStr = r.date || r.createdAt || r.created_at;
      if (!dateStr) return;
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return;
      const year = d.getFullYear();
      const month = d.getMonth();
      if (!yearData[year]) yearData[year] = new Array(12).fill(0);
      yearData[year][month] += (r.totalDoses || r.doses?.reduce((s: number, v: any) => s + (v.doses || 0), 0)) || 0;
    });
    
    const currentYear = new Date().getFullYear();
    const years = Object.keys(yearData).map(Number).sort().filter(y => y >= currentYear - 2);
    if (years.length === 0) return { categories: MONTH_NAMES, series: [] };
    
    return {
      categories: MONTH_NAMES,
      series: years.map(year => ({
        name: String(year),
        data: yearData[year] || new Array(12).fill(0),
      })),
    };
  }, [animalHealthRecords]);

  const options: ApexCharts.ApexOptions = {
    chart: { height: 300, background: "transparent", toolbar: { show: false }, fontFamily: "inherit" },
    colors: ["#ef4444", "#f97316", "#3b82f6"],
    xaxis: { categories: chartData.categories },
    yaxis: { labels: { style: { fontSize: "11px" } } },
    grid: { borderColor: "#f1f5f9", strokeDashArray: 4 },
    dataLabels: { enabled: false },
    stroke: { width: 2, curve: "smooth" },
    tooltip: { shared: true, intersect: false },
    legend: { position: "bottom", fontSize: "12px" },
  };

  return <Chart options={options} series={chartData.series} type="line" height={300} />;
};

// --- Main Component ---

const PerformanceReport = () => {
  const { userRole, userAttribute, userName, allowedProgrammes } = useAuth();
  const currentMonthDates = useMemo(() => getCurrentMonthDates(), []);
  
  const cacheRef = useRef<{
    farmers: Farmer[] | null;
    training: TrainingRecord[] | null;
    animalHealth: AnimalHealthRecord[] | null;
    offtakes: OfftakeRecord[] | null;
    hayStorage: any[] | null;
    programmes: string;
    timestamp: number;
  }>({ farmers: null, training: null, animalHealth: null, offtakes: null, hayStorage: null, programmes: "", timestamp: 0 });
  
  const [loading, setLoading] = useState(true);
  const [allFarmers, setAllFarmers] = useState<Farmer[]>([]);
  const [trainingRecords, setTrainingRecords] = useState<TrainingRecord[]>([]);
  const [animalHealthActivities, setAnimalHealthActivities] = useState<AnimalHealthRecord[]>([]);
  const [offtakeRecords, setOfftakeRecords] = useState<OfftakeRecord[]>([]);
  const [hayStorageRecords, setHayStorageRecords] = useState<any[]>([]);
  const [staffDirectoryRecords, setStaffDirectoryRecords] = useState<StaffDirectoryRecord[]>([]);
  const [staffMarkRecords, setStaffMarkRecords] = useState<StaffMarkRecord[]>([]);
  const [createStaffForm, setCreateStaffForm] = useState<CreateStaffFormState>(createDefaultStaffForm);
  const [staffMarkForm, setStaffMarkForm] = useState<StaffMarkFormState>(createDefaultStaffMarkForm);
  const [isCreateStaffOpen, setIsCreateStaffOpen] = useState(false);
  const [editingStaffRow, setEditingStaffRow] = useState<StaffManagementRow | null>(null);
  const [isAwardDialogOpen, setIsAwardDialogOpen] = useState(false);
  const [selectedStaffRow, setSelectedStaffRow] = useState<StaffManagementRow | null>(null);
  const [isSavingStaffDirectory, setIsSavingStaffDirectory] = useState(false);
  const [isSavingStaffMark, setIsSavingStaffMark] = useState(false);
  
  const [dateRange, setDateRange] = useState(() => getCurrentMonthDates());
  const [timeFrame, setTimeFrame] = useState<'weekly' | 'monthly' | 'yearly'>('yearly');
  const [registrationTrendMode, setRegistrationTrendMode] = useState<"auto" | "yearly">("auto");

  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState<string>(ALL_YEARS_VALUE);
  const [selectedQuarter, setSelectedQuarter] = useState<string>("");
  
  const availableYears = useMemo(() => {
    const years: string[] = [];
    for(let i = 0; i < 5; i++) {
      years.push(String(currentYear - i));
    }
    return years;
  }, [currentYear]);

  const userCanViewAllProgrammeData = useMemo(
    () => canViewAllProgrammes(userRole, userAttribute, allowedProgrammes),
    [allowedProgrammes, userRole, userAttribute]
  );
  const accessibleProgrammes = useMemo(
    () => resolveAccessibleProgrammes(userCanViewAllProgrammeData, allowedProgrammes),
    [allowedProgrammes, userCanViewAllProgrammeData]
  );
  const reportAudience = useMemo(
    () => resolveReportAudience(userRole, userAttribute),
    [allowedProgrammes, userRole, userAttribute]
  );
  const isHrReport = reportAudience === "hr";
  const reportViewProfile = REPORT_VIEW_PROFILES[reportAudience];
  const hasSection = useCallback(
    (section: ReportSectionId) => reportViewProfile.sections.includes(section),
    [reportViewProfile.sections]
  );
  const showProgrammeFilter = accessibleProgrammes.length > 1;
  const canViewAllReportProgrammes = userCanViewAllProgrammeData || accessibleProgrammes.length > 1;
  const [activeProgram, setActiveProgram] = useSharedProgrammeSelection(accessibleProgrammes, {
    allowAll: canViewAllReportProgrammes,
    fallbackToAll: accessibleProgrammes.length > 1,
  });
  const appliedDefaultProgrammeRef = useRef(false);

  useEffect(() => {
    if (appliedDefaultProgrammeRef.current || accessibleProgrammes.length <= 1) return;
    appliedDefaultProgrammeRef.current = true;
    setActiveProgram(ALL_PROGRAMMES_VALUE);
  }, [accessibleProgrammes.length, setActiveProgram]);

  const filterStripRef = useRef<HTMLDivElement | null>(null);
  
  const selectedYearNum = useMemo(() => {
    const parsed = parseInt(selectedYear, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }, [selectedYear]);
  const allowedProgrammeSet = useMemo(
    () =>
      userCanViewAllProgrammeData ?
        null :
        new Set(accessibleProgrammes.map((programme) => normalizeProgramme(programme))),
    [accessibleProgrammes, userCanViewAllProgrammeData],
  );
  
  const { data, isLoading: analysisLoading, isError: analysisError } = useProcessedData(
    allFarmers,
    trainingRecords,
    animalHealthActivities,
    offtakeRecords,
    staffMarkRecords,
    dateRange,
    timeFrame,
    activeProgram || null,
    selectedYearNum,
    userCanViewAllProgrammeData,
  );
  const projectManagerBreedsByLocationData = useMemo(
    () => buildLocationMetricSeries(data.breedsByLocationData),
    [data.breedsByLocationData],
  );
  const projectManagerVaccinesByLocationData = useMemo(
    () => buildLocationMetricSeries(data.dosesByLocationData),
    [data.dosesByLocationData],
  );
  const queryableProgrammes = useMemo(
    () => Array.from(new Set(accessibleProgrammes)),
    [accessibleProgrammes],
  );
  const programmeCacheKey = useMemo(
    () => queryableProgrammes.join("|"),
    [queryableProgrammes],
  );

  const fetchReportCollection = useCallback(
    async <T extends Record<string, any>>(path: string) => {
      if (queryableProgrammes.length === 0) return [];
      return fetchCollectionByProgrammes<T>(path, queryableProgrammes);
    },
    [queryableProgrammes],
  );

  const fetchAllData = useCallback(async () => {
    if (USE_REMOTE_ANALYTICS) {
      setLoading(false);
      return;
    }

    if (queryableProgrammes.length === 0) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const now = Date.now();
      let farmersList: Farmer[] = [];
      let trainingList: TrainingRecord[] = [];
      let animalHealthList: AnimalHealthRecord[] = [];
      let offtakeList: OfftakeRecord[] = [];

      if (cacheRef.current.farmers && 
          cacheRef.current.training && 
          cacheRef.current.animalHealth &&
          cacheRef.current.offtakes &&
          cacheRef.current.hayStorage &&
          cacheRef.current.programmes === programmeCacheKey &&
          (now - cacheRef.current.timestamp < CACHE_DURATION)) {
        farmersList = cacheRef.current.farmers;
        trainingList = cacheRef.current.training;
        animalHealthList = cacheRef.current.animalHealth;
        offtakeList = cacheRef.current.offtakes;
        setHayStorageRecords(cacheRef.current.hayStorage);
      } else {
        const [farmersRaw, trainingRaw, animalHealthRaw, offtakeRaw, hayStorageRaw] = await Promise.all([
          fetchReportCollection<Farmer>("farmers"),
          fetchReportCollection<TrainingRecord>("capacityBuilding"),
          fetchReportCollection<AnimalHealthRecord>("AnimalHealthActivities"),
          fetchReportCollection<OfftakeRecord>("offtakes"),
          fetchReportCollection<any>("hayStorage"),
        ]);

        farmersList = farmersRaw.map((record) => ({
          ...record,
          goats: record.goats || { total: 0, male: 0, female: 0 },
          sheep: record.sheep || 0,
          cattle: record.cattle || 0,
          vaccinated: record.vaccinated || false,
          vaccines: record.vaccines || [],
          femaleBreeds: record.femaleBreeds || 0,
          maleBreeds: record.maleBreeds || 0,
          programme: record.programme || undefined,
        }));

        trainingList = trainingRaw.map((record) => ({
          ...record,
          programme: record.programme || undefined,
        }));

        animalHealthList = animalHealthRaw.map((record) => ({
          ...record,
          date: record.date || "",
          createdAt: record.createdAt,
          programme: record.programme || undefined,
          county: record.county || "",
          subcounty: record.subcounty || "",
          location: record.location || record.subcounty || record.county || "",
          vaccines: Array.isArray(record.vaccines) ? record.vaccines : undefined,
          vaccinetype: record.vaccinetype || undefined,
          number_doses: record.number_doses,
        }));

        offtakeList = offtakeRaw.map((record) => ({
          ...record,
          date: record.date,
          Date: record.Date,
          createdAt: record.createdAt,
          programme: record.programme || undefined,
          totalGoats: record.totalGoats,
          goatsBought: record.goatsBought,
          goats: record.goats,
          Goats: record.Goats,
        }));

        cacheRef.current = {
          farmers: farmersList,
          training: trainingList,
          animalHealth: animalHealthList,
          offtakes: offtakeList,
          hayStorage: hayStorageRaw,
          programmes: programmeCacheKey,
          timestamp: now
        };
        setHayStorageRecords(hayStorageRaw);
      }

      setAllFarmers(farmersList);
      setTrainingRecords(trainingList);
      setAnimalHealthActivities(animalHealthList);
      setOfftakeRecords(offtakeList);
      
    } catch (error) {
      console.error("Error fetching data:", error);
    } finally {
      setLoading(false);
    }
  }, [fetchReportCollection, programmeCacheKey, queryableProgrammes.length]);

  const fetchStaffDirectory = useCallback(async () => {
    if (!isHrReport) {
      setStaffDirectoryRecords((current) => (current.length > 0 ? EMPTY_STAFF_DIRECTORY_RECORDS : current));
      return;
    }

    try {
      const staffDirectory = await fetchReportCollection<StaffDirectoryRecord>("hrStaffDirectory");
      const filteredDirectory = staffDirectory
        .filter((record) => {
          if (!allowedProgrammeSet) return true;
          const programme = normalizeProgramme(record.programme);
          return allowedProgrammeSet.has(programme);
        })
        .sort((first, second) => {
          const firstDate = parseDate(second.createdAt || second.updatedAt)?.getTime() || 0;
          const secondDate = parseDate(first.createdAt || first.updatedAt)?.getTime() || 0;
          return firstDate - secondDate;
      });

      setStaffDirectoryRecords(filteredDirectory);
    } catch (error) {
      console.error("Error fetching HR staff directory:", error);
      toast({
        title: "Error",
        description: "Unable to load the HR staff list at the moment.",
        variant: "destructive",
      });
    }
  }, [allowedProgrammeSet, fetchReportCollection, isHrReport, toast]);

  const fetchStaffMarks = useCallback(async () => {
    if (!isHrReport) {
      setStaffMarkRecords((current) => (current.length > 0 ? EMPTY_STAFF_MARK_RECORDS : current));
      return;
    }

    try {
      const marks = (await fetchReportCollection<StaffMarkRecord>("hrStaffMarks"))
        .filter((record) => {
          if (!allowedProgrammeSet) return true;
          const programme = normalizeProgramme(record.programme);
          return allowedProgrammeSet.has(programme);
        })
        .sort((a, b) => {
          const first = parseDate(b.dateAwarded || b.createdAt)?.getTime() || 0;
          const second = parseDate(a.dateAwarded || a.createdAt)?.getTime() || 0;
          return first - second;
        });

      setStaffMarkRecords(marks);
    } catch (error) {
      console.error("Error fetching HR staff marks:", error);
      toast({
        title: "Error",
        description: "Unable to load staff marks at the moment.",
        variant: "destructive",
      });
    }
  }, [allowedProgrammeSet, fetchReportCollection, isHrReport, toast]);

  const filteredStaffMarkRecords = useMemo(
    () => {
      if (!isHrReport) return EMPTY_STAFF_MARK_RECORDS;
      return (
      staffMarkRecords.filter((record) => {
        const recordDate = record.dateAwarded || record.createdAt;
        return matchesProgrammeSelection(record.programme, activeProgram, userCanViewAllProgrammeData) &&
          isDateInRange(recordDate, dateRange.startDate, dateRange.endDate);
      })
      );
    },
    [activeProgram, dateRange.endDate, dateRange.startDate, isHrReport, staffMarkRecords, userCanViewAllProgrammeData],
  );

  const filteredStaffDirectoryRecords = useMemo(
    () => {
      if (!isHrReport) return EMPTY_STAFF_DIRECTORY_RECORDS;
      return (
      staffDirectoryRecords.filter((record) => {
        return matchesProgrammeSelection(record.programme, activeProgram, userCanViewAllProgrammeData);
      })
      );
    },
    [activeProgram, isHrReport, staffDirectoryRecords, userCanViewAllProgrammeData],
  );

  const staffManagementRows = useMemo(() => {
    if (!isHrReport) return EMPTY_STAFF_MANAGEMENT_ROWS;

    const rows = new Map<string, StaffManagementRow>();
    const marksByStaff = new Map<string, {
      totalMarks: number;
      awardCount: number;
      lastAwardDate: string;
      lastAwardTimestamp: number;
      lastAwardNote: string;
      displayName: string;
    }>();

    filteredStaffMarkRecords.forEach((record) => {
      const staffName = getLeaderName(record.staffName, "");
      const normalizedName = normalizeStaffName(staffName);
      if (!normalizedName) return;

      const marks = getNumberField(record, "marks", "score", "awardedMarks");
      const awardTimestamp = parseDate(record.dateAwarded || record.createdAt)?.getTime() || 0;
      const current = marksByStaff.get(normalizedName) || {
        totalMarks: 0,
        awardCount: 0,
        lastAwardDate: "N/A",
        lastAwardTimestamp: 0,
        lastAwardNote: "",
        displayName: staffName,
      };

      current.totalMarks += marks;
      current.awardCount += 1;
      if (awardTimestamp >= current.lastAwardTimestamp) {
        current.lastAwardTimestamp = awardTimestamp;
        current.lastAwardDate = formatDisplayDate(record.dateAwarded || record.createdAt);
        current.lastAwardNote = record.note?.trim() || "";
        current.displayName = staffName || current.displayName;
      }
      marksByStaff.set(normalizedName, current);
    });

    filteredStaffDirectoryRecords.forEach((record) => {
      const staffName = getLeaderName(record.staffName, "Unnamed staff");
      const normalizedName = normalizeStaffName(staffName);
      const markSummary = marksByStaff.get(normalizedName);
      rows.set(normalizedName || record.id, {
        id: record.id,
        staffName,
        role: record.role?.trim() || "Not assigned",
        county: record.county?.trim() || "N/A",
        phone: record.phone?.trim() || "N/A",
        programme: record.programme?.trim() || activeProgram || "N/A",
        status: record.status?.trim() || "active",
        notes: record.notes?.trim() || "",
        totalMarks: markSummary?.totalMarks || 0,
        awardCount: markSummary?.awardCount || 0,
        lastAwardDate: markSummary?.lastAwardDate || "Not awarded",
        lastAwardNote: markSummary?.lastAwardNote || "",
        managedInDirectory: true,
      });
    });

    marksByStaff.forEach((markSummary, normalizedName) => {
      if (rows.has(normalizedName)) return;
      rows.set(normalizedName, {
        id: `marks-${normalizedName}`,
        staffName: markSummary.displayName || "Unlisted staff",
        role: "Not in staff list",
        county: "N/A",
        phone: "N/A",
        programme: activeProgram || "N/A",
        status: "marks-only",
        notes: "",
        totalMarks: markSummary.totalMarks,
        awardCount: markSummary.awardCount,
        lastAwardDate: markSummary.lastAwardDate,
        lastAwardNote: markSummary.lastAwardNote,
        managedInDirectory: false,
      });
    });

    return [...rows.values()].sort((first, second) => {
      if (first.managedInDirectory !== second.managedInDirectory) {
        return first.managedInDirectory ? -1 : 1;
      }
      if (first.status !== second.status) {
        return first.status === "active" ? -1 : 1;
      }
      if (second.totalMarks !== first.totalMarks) {
        return second.totalMarks - first.totalMarks;
      }
      return first.staffName.localeCompare(second.staffName);
    });
  }, [activeProgram, filteredStaffDirectoryRecords, filteredStaffMarkRecords, isHrReport]);

  const openCreateStaffDialog = useCallback(() => {
    setEditingStaffRow(null);
    setCreateStaffForm(createDefaultStaffForm());
    setIsCreateStaffOpen(true);
  }, []);

  const openEditStaffDialog = useCallback((staffRow: StaffManagementRow) => {
    setEditingStaffRow(staffRow);
    setCreateStaffForm({
      staffName: staffRow.staffName,
      role: staffRow.role === "Not assigned" ? "" : staffRow.role,
      county: staffRow.county === "N/A" ? "" : staffRow.county,
      phone: staffRow.phone === "N/A" ? "" : staffRow.phone,
      notes: staffRow.notes,
    });
    setIsCreateStaffOpen(true);
  }, []);

  const openAwardDialog = useCallback((staffRow: StaffManagementRow | null = null) => {
    setSelectedStaffRow(staffRow);
    setStaffMarkForm({
      ...createDefaultStaffMarkForm(),
      staffName: staffRow?.staffName || "",
    });
    setIsAwardDialogOpen(true);
  }, []);

  const handleCreateStaff = useCallback(async () => {
    const staffName = createStaffForm.staffName.trim();
    const role = createStaffForm.role.trim();

    if (!staffName || !role) {
      toast({
        title: "Staff details required",
        description: "Enter at least the staff name and role.",
        variant: "destructive",
      });
      return;
    }

    if (!activeProgram || activeProgram === ALL_PROGRAMMES_VALUE) {
      toast({
        title: "Programme required",
        description: "Select a specific programme before saving staff.",
        variant: "destructive",
      });
      return;
    }

    const alreadyExists = staffDirectoryRecords.some((record) =>
      record.id !== editingStaffRow?.id &&
      normalizeStaffName(record.staffName) === normalizeStaffName(staffName) &&
      normalizeProgramme(record.programme) === normalizeProgramme(activeProgram),
    );

    if (alreadyExists) {
      toast({
        title: "Staff already exists",
        description: `${staffName} is already in the HR staff table for ${activeProgram}.`,
        variant: "destructive",
      });
      return;
    }

    try {
      setIsSavingStaffDirectory(true);
      const payload = {
        staffName,
        role,
        county: createStaffForm.county.trim(),
        phone: createStaffForm.phone.trim(),
        notes: createStaffForm.notes.trim(),
        programme: normalizeProgramme(activeProgram),
        status: editingStaffRow?.status || "active",
        updatedAt: Date.now(),
        updatedBy: userName || "HR Manager",
      };

      if (editingStaffRow) {
        await update(ref(db, `hrStaffDirectory/${editingStaffRow.id}`), payload);
      } else {
        await push(ref(db, "hrStaffDirectory"), {
          ...payload,
          status: "active",
          createdAt: Date.now(),
          createdBy: userName || "HR Manager",
        });
      }

      invalidateCollectionCache("hrStaffDirectory");
      setCreateStaffForm(createDefaultStaffForm());
      setEditingStaffRow(null);
      setIsCreateStaffOpen(false);
      await fetchStaffDirectory();
      toast({
        title: editingStaffRow ? "Staff updated" : "Staff created",
        description: editingStaffRow ?
          `${staffName} has been updated in the HR staff table.` :
          `${staffName} is now available in the HR staff table.`,
      });
    } catch (error) {
      console.error("Error saving HR staff:", error);
      toast({
        title: editingStaffRow ? "Update failed" : "Create failed",
        description: "We could not save the staff record right now.",
        variant: "destructive",
      });
    } finally {
      setIsSavingStaffDirectory(false);
    }
  }, [activeProgram, createStaffForm, editingStaffRow, fetchStaffDirectory, staffDirectoryRecords, toast, userName]);

  const handleToggleStaffStatus = useCallback(async (staffRow: StaffManagementRow) => {
    if (!staffRow.managedInDirectory) return;

    const nextStatus = staffRow.status === "active" ? "inactive" : "active";

    try {
      await update(ref(db, `hrStaffDirectory/${staffRow.id}`), {
        status: nextStatus,
        updatedAt: Date.now(),
        updatedBy: userName || "HR Manager",
      });
      invalidateCollectionCache("hrStaffDirectory");
      await fetchStaffDirectory();
      toast({
        title: "Staff updated",
        description: `${staffRow.staffName} is now ${nextStatus}.`,
      });
    } catch (error) {
      console.error("Error updating HR staff status:", error);
      toast({
        title: "Update failed",
        description: "We could not update the staff status right now.",
      variant: "destructive",
      });
    }
  }, [fetchStaffDirectory, toast, userName]);

  const handleDeleteStaff = useCallback(async (staffRow: StaffManagementRow) => {
    if (!staffRow.managedInDirectory) return;

    const confirmed = window.confirm(`Delete ${staffRow.staffName} from the HR staff table?`);
    if (!confirmed) return;

    try {
      setIsSavingStaffDirectory(true);
      await remove(ref(db, `hrStaffDirectory/${staffRow.id}`));
      if (selectedStaffRow?.id === staffRow.id) {
        setSelectedStaffRow(null);
      }
      invalidateCollectionCache("hrStaffDirectory");
      await fetchStaffDirectory();
      toast({
        title: "Staff deleted",
        description: `${staffRow.staffName} has been removed from the HR staff table.`,
      });
    } catch (error) {
      console.error("Error deleting HR staff:", error);
      toast({
        title: "Delete failed",
        description: "We could not delete the staff record right now.",
        variant: "destructive",
      });
    } finally {
      setIsSavingStaffDirectory(false);
    }
  }, [fetchStaffDirectory, selectedStaffRow, toast]);

  const handleStaffMarkSubmit = useCallback(async () => {
    const staffName = staffMarkForm.staffName.trim();
    const marks = parseNumericValue(staffMarkForm.marks);

    if (!staffName) {
      toast({
        title: "Staff name required",
        description: "Enter the staff member you want to score.",
        variant: "destructive",
      });
      return;
    }

    if (!activeProgram || activeProgram === ALL_PROGRAMMES_VALUE) {
      toast({
        title: "Programme required",
        description: "Select a specific programme before awarding marks.",
        variant: "destructive",
      });
      return;
    }

    if (!Number.isFinite(marks) || marks <= 0 || marks > 100) {
      toast({
        title: "Invalid marks",
        description: "Enter marks between 1 and 100.",
        variant: "destructive",
      });
      return;
    }

    try {
      setIsSavingStaffMark(true);
      await push(ref(db, "hrStaffMarks"), {
        staffName,
        marks,
        note: staffMarkForm.note.trim(),
        programme: normalizeProgramme(activeProgram),
        dateAwarded: staffMarkForm.dateAwarded || formatDateToLocal(new Date()),
        createdAt: Date.now(),
        awardedBy: userName || "HR Manager",
        periodStart: dateRange.startDate || "",
        periodEnd: dateRange.endDate || "",
      });

      invalidateCollectionCache("hrStaffMarks");
      setStaffMarkForm(createDefaultStaffMarkForm());
      setSelectedStaffRow(null);
      setIsAwardDialogOpen(false);
      await fetchStaffMarks();
      toast({
        title: "Marks saved",
        description: `${staffName} has been scored successfully.`,
      });
    } catch (error) {
      console.error("Error saving HR staff marks:", error);
      toast({
        title: "Save failed",
        description: "We could not save the staff marks right now.",
        variant: "destructive",
      });
    } finally {
      setIsSavingStaffMark(false);
    }
  }, [activeProgram, dateRange.endDate, dateRange.startDate, fetchStaffMarks, staffMarkForm, toast, userName]);

  useEffect(() => {
    fetchAllData();
  }, [fetchAllData]);

  useEffect(() => {
    fetchStaffDirectory();
  }, [fetchStaffDirectory]);

  useEffect(() => {
    fetchStaffMarks();
  }, [fetchStaffMarks]);

  const scrollFilterStripBy = useCallback((direction: "left" | "right") => {
    const strip = filterStripRef.current;
    if (!strip) return;
    const delta = Math.max(220, Math.floor(strip.clientWidth * 0.75));
    strip.scrollBy({ left: direction === "left" ? -delta : delta, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const strip = filterStripRef.current;
    if (!strip) return;

    const handleResize = () => {
      strip.scrollTo({ left: Math.min(strip.scrollLeft, Math.max(0, strip.scrollWidth - strip.clientWidth)), behavior: "auto" });
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  const handleDateRangeChange = useCallback((key: string, value: string) => {
    setDateRange(prev => ({ ...prev, [key]: value }));
    setRegistrationTrendMode("auto");
  }, []);

  const handleYearChange = useCallback((year: string) => {
    if (year === ALL_YEARS_VALUE) {
      setSelectedYear(ALL_YEARS_VALUE);
      setSelectedQuarter("");
      setDateRange({
        startDate: "",
        endDate: "",
      });
      setTimeFrame('yearly');
      setRegistrationTrendMode("auto");
      return;
    }
    const yearNum = parseInt(year, 10);
    setSelectedYear(year);
    setSelectedQuarter("");
    setDateRange({ 
      startDate: `${yearNum}-01-01`, 
      endDate: `${yearNum}-12-31` 
    });
    setTimeFrame('yearly'); 
    setRegistrationTrendMode("auto");
  }, []);

  // --- New Handler for Quarter Dropdown ---
  const handleQuarterChange = useCallback((value: string) => {
    setSelectedQuarter(value);
    const parsedYear = parseInt(selectedYear, 10);
    const yearNum = Number.isNaN(parsedYear) ? new Date().getFullYear() : parsedYear;
    if (Number.isNaN(parsedYear)) {
      setSelectedYear(String(yearNum));
    }
    if (value === 'q1') {
      setDateRange(getQ1Dates(yearNum));
      setTimeFrame('monthly');
    } else if (value === 'q2') {
      setDateRange(getQ2Dates(yearNum));
      setTimeFrame('monthly');
    } else if (value === 'q3') {
      setDateRange(getQ3Dates(yearNum));
      setTimeFrame('monthly');
    } else if (value === 'q4') {
      setDateRange(getQ4Dates(yearNum));
      setTimeFrame('yearly');
    }
    setRegistrationTrendMode("auto");
  }, [selectedYear]);

  // --- Updated Clear Filters ---
  const clearFilters = useCallback(() => {
    setSelectedYear(ALL_YEARS_VALUE);
    setSelectedQuarter("");
    setDateRange({
      startDate: "",
      endDate: "",
    });
    setTimeFrame('yearly');
    setRegistrationTrendMode("auto");
  }, []);

  const setWeekFilter = useCallback(() => {
    const dates = getCurrentWeekDates();
    setDateRange(dates);
    setTimeFrame('weekly');
    setSelectedYear(String(currentYear));
    setSelectedQuarter("");
    setRegistrationTrendMode("auto");
  }, []);

  const setMonthFilter = useCallback(() => {
    const dates = getCurrentMonthDates();
    setDateRange(dates);
    setTimeFrame('monthly');
    setSelectedYear(String(currentYear));
    setSelectedQuarter("");
    setRegistrationTrendMode("auto");
  }, []);

  const setYearFilter = useCallback(() => {
    setSelectedYear(String(currentYear));
    setSelectedQuarter("");
    setDateRange({
      startDate: `${currentYear}-01-01`,
      endDate: `${currentYear}-12-31`,
    });
    setTimeFrame('yearly');
    setRegistrationTrendMode("auto");
  }, [currentYear]);

  const renderCustomizedLabel = useCallback(({ cx, cy, midAngle, innerRadius, outerRadius, percent }: any) => {
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
        fontSize="10"
        fontWeight="bold"
      >
        {`${(percent * 100).toFixed(0)}%`}
      </text>
    );
  }, []);

  const topFieldOfficerPeak = data.topFieldOfficers[0]?.value || 0;
  const topCustomerPeak = data.topCustomers[0]?.value || 0;
  const registrationTrendChartData = useMemo(
    () =>
      registrationTrendMode === "yearly" && data.registrationTrendComparisonData.length > 0 ?
        data.registrationTrendComparisonData :
        data.registrationTrendData,
    [data.registrationTrendComparisonData, data.registrationTrendData, registrationTrendMode],
  );

  const trainingStatsSubtext = useMemo(() => {
    const totalTrainingConducted = trainingRecords.length;
    const totalParticipants = trainingRecords.reduce((sum, r) => sum + getNumberField(r, "totalFarmers"), 0);
    const avgAttendance = totalTrainingConducted > 0 ? Math.round(totalParticipants / totalTrainingConducted) : 0;
    return `Total Training Conducted: ${totalTrainingConducted} | Avg Attendance: ${avgAttendance}`;
  }, [trainingRecords]);

  const { totalBalesHarvested, totalBalesSold, totalBalesBalance, totalRevenue } = useMemo(() => {
    const harvested = hayStorageRecords.reduce((sum: number, r: any) => sum + (r.bales_harvested_stored || 0), 0);
    const sold = hayStorageRecords.reduce((sum: number, r: any) => sum + (r.bales_sold || 0), 0);
    const revenue = hayStorageRecords.reduce((sum: number, r: any) => sum + (r.revenue_generated || 0), 0);
    return { totalBalesHarvested: harvested, totalBalesSold: sold, totalBalesBalance: harvested - sold, totalRevenue: revenue };
  }, [hayStorageRecords]);

  if (loading && !USE_REMOTE_ANALYTICS) {
    return (
      <div className="flex flex-col justify-center items-center h-96 space-y-4">
        <Loader2 className="h-12 w-12 animate-spin text-blue-600" />
        <p className="text-gray-600 font-medium animate-pulse">Loading analytics data...</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 p-1 bg-gray-50/50 min-h-screen pb-10">
      <div className="flex flex-col gap-2">
        {reportViewProfile.title ? (
          <div>
            <h1 className="text-xl font-semibold text-gray-900">{reportViewProfile.title}</h1>
          </div>
        ) : null}

        {analysisError ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            Analytics took too long to load. Adjust the filters or try again.
          </div>
        ) : null}

        <Card className="w-full border-0 shadow-lg bg-white">
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
                    <Select value={selectedYear || undefined} onValueChange={handleYearChange}>
                      <SelectTrigger className="h-9 w-[150px] shrink-0">
                        <div className="flex items-center gap-2">
                          <Calendar className="h-4 w-4 text-gray-500" />
                          <SelectValue placeholder="Select Year" />
                        </div>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ALL_YEARS_VALUE}>Years</SelectItem>
                        {availableYears.map((year) => (
                          <SelectItem key={year} value={year}>{year}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {showProgrammeFilter && (
                      <Select value={activeProgram} onValueChange={setActiveProgram}>
                        <SelectTrigger className="h-9 w-[150px] shrink-0">
                          <SelectValue placeholder="Select Programme" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={ALL_PROGRAMMES_VALUE}>All Programmes</SelectItem>
                          {accessibleProgrammes.map((programme) => (
                            <SelectItem key={programme} value={programme}>{programme}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}

                    <Select
                      value={selectedQuarter || undefined}
                      onValueChange={handleQuarterChange}
                      disabled={selectedYear === ALL_YEARS_VALUE}
                    >
                      <SelectTrigger className="h-9 w-[150px] shrink-0">
                        <SelectValue placeholder={selectedYear === ALL_YEARS_VALUE ? "Select Year First" : "Quarter"} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="q1">Q1 (Jan-Mar)</SelectItem>
                        <SelectItem value="q2">Q2 (Jan-Jun)</SelectItem>
                        <SelectItem value="q3">Q3 (Jan-Sep)</SelectItem>
                        <SelectItem value="q4">Q4 (Full Year)</SelectItem>
                      </SelectContent>
                    </Select>

                    <Input
                      id="startDate"
                      type="date"
                      value={dateRange.startDate}
                      onChange={(e) => handleDateRangeChange("startDate", e.target.value)}
                      className="h-9 w-[150px] shrink-0 border-gray-200 pr-2 text-xs focus:border-blue-500"
                    />

                    <Input
                      id="endDate"
                      type="date"
                      value={dateRange.endDate}
                      onChange={(e) => handleDateRangeChange("endDate", e.target.value)}
                      className="h-9 w-[150px] shrink-0 border-gray-200 pr-2 text-xs focus:border-blue-500"
                    />

                    <Button variant="outline" onClick={setMonthFilter} size="sm" className="h-9 shrink-0">This Month</Button>
                    <Button onClick={clearFilters} variant="ghost" size="sm" className="h-9 shrink-0 text-red-500 hover:text-red-600">Clear</Button>
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

      {hasSection("hr-summary") && (
        <section>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 mb-6">
            <StatsCard
              title="Goats Purchased"
              value={data.totalGoatsPurchased.toLocaleString()}
              icon={Beef}
              color="orange"
            />

            <StatsCard
              title="Registered Farmers"
              value={data.totalFarmers.toLocaleString()}
              icon={Users}
              subtext={`Trained farmers: ${data.totalTrainedFarmers.toLocaleString()}`}
              color="blue"
            />

            <StatsCard
              title="Animal Health"
              value={data.totalBreedsDistributed.toLocaleString()}
              icon={Syringe}
              subtext={`Breeds distributed: ${data.totalBreedsDistributed.toLocaleString()} | Doses given out: ${data.totalDosesGivenOut.toLocaleString()}`}
              color="teal"
            />
          </div>
        </section>
      )}

      {hasSection("hr-rankings") && (
        <section>
          <div className="grid gap-6 lg:grid-cols-2 mb-6">
            <Card className="overflow-hidden border border-slate-200 bg-white shadow-lg">
              <CardHeader className="border-b border-slate-100 bg-slate-50/70 pb-3">
                <CardTitle className="flex items-center gap-2 text-sm text-gray-800">
                  <Users className="h-4 w-4 text-blue-600" />
                  Top Field Officers
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 pt-4">
                {data.topFieldOfficers.length > 0 ? data.topFieldOfficers.map((officer, index) => {
                  const share = topFieldOfficerPeak > 0 ? (officer.value / topFieldOfficerPeak) * 100 : 0;
                  return (
                    <div key={`${officer.name}-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-1 shadow-sm">
                      <div className="flex items-center gap-4">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white shadow-sm">
                          {index + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <p className="truncate text-sm font-semibold text-slate-900">{officer.name}</p>
                            <p className="truncate text-xs text-slate-500">County: {officer.county}</p>
                          </div>
                        </div>
                        <div className="min-w-[160px] max-w-[260px] flex-1">
                          <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-700 transition-all"
                              style={{ width: `${Math.max(share, 10)}%` }}
                            />
                          </div>
                        </div>
                        <Badge className="shrink-0 whitespace-nowrap border-blue-200 bg-blue-50 px-3 py-1 text-blue-700 hover:bg-blue-50">
                          {officer.value} farmers
                        </Badge>
                      </div>
                    </div>
                  );
                }) : (
                  <div className="flex h-[220px] items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500">
                    No field officer activity found for the selected filters.
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="overflow-hidden border border-slate-200 bg-white shadow-lg">
              <CardHeader className="border-b border-slate-100 bg-slate-50/70 pb-3">
                {reportAudience === "hr" && (
                  <div className="mb-3 flex flex-wrap justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={openCreateStaffDialog}>
                      Create Staff
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => openAwardDialog(null)}>
                      <Award className="mr-1 h-4 w-4" />
                      Award Marks
                    </Button>
                  </div>
                )}
                <CardTitle className="text-sm flex items-center gap-2 text-gray-800">
                  <Users className="h-4 w-4 text-yellow-600" />
                  Staff Table
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="max-h-[360px] overflow-auto">
                  <Table className="min-w-full">
                    <TableHeader className="sticky top-0 z-10 bg-slate-50">
                      <TableRow>
                        <TableHead className="py-2 text-xs">Staff</TableHead>
                        <TableHead className="py-2 text-xs">County</TableHead>
                        <TableHead className="py-2 text-xs">Role</TableHead>
                        <TableHead className="py-2 text-xs">Status</TableHead>
                        <TableHead className="py-2 text-xs">Total Marks</TableHead>
                        <TableHead className="py-2 text-xs">Awards</TableHead>
                        <TableHead className="py-2 text-xs text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {staffManagementRows.length > 0 ? staffManagementRows.map((staffRow) => (
                        <TableRow key={staffRow.id} className="border-b border-slate-100 transition-colors hover:bg-slate-50/80">
                          <TableCell className="py-1 text-xs text-slate-900">
                            <div className="leading-tight">{staffRow.staffName}</div>
                            {staffRow.lastAwardNote && (
                              <div className="mt-1 text-xs text-slate-500 line-clamp-2">{staffRow.lastAwardNote}</div>
                            )}
                          </TableCell>
                          <TableCell className="py-1 text-xs">{staffRow.county}</TableCell>
                          <TableCell className="py-1 text-xs">{staffRow.role}</TableCell>
                          <TableCell className="py-1 text-xs">
                            <Badge
                              className={
                                staffRow.status === "active" ?
                                  "border-green-200 bg-green-50 text-green-700 hover:bg-green-50" :
                                  staffRow.status === "inactive" ?
                                    "border-slate-200 bg-slate-100 text-slate-700 hover:bg-slate-100" :
                                    "border-yellow-200 bg-yellow-50 text-yellow-700 hover:bg-yellow-50"
                              }
                            >
                              {staffRow.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="py-1 text-xs">{staffRow.totalMarks}</TableCell>
                          <TableCell className="py-1 text-xs">{staffRow.awardCount}</TableCell>
                          <TableCell className="py-1 text-xs text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-9 w-9 rounded-full border border-slate-200 bg-white hover:bg-slate-100"
                                >
                                  <MoreVertical className="h-4 w-4 text-slate-600" />
                                  <span className="sr-only">Open staff actions</span>
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-48">
                                <DropdownMenuItem onClick={() => openAwardDialog(staffRow)}>
                                  <Award className="mr-2 h-4 w-4" />
                                  Award Marks
                                </DropdownMenuItem>
                                {staffRow.managedInDirectory ? (
                                  <>
                                    <DropdownMenuItem onClick={() => openEditStaffDialog(staffRow)}>
                                      <PencilLine className="mr-2 h-4 w-4" />
                                      Edit Staff
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleToggleStaffStatus(staffRow)}>
                                      <UserX className="mr-2 h-4 w-4" />
                                      {staffRow.status === "active" ? "Deactivate" : "Activate"}
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      onClick={() => handleDeleteStaff(staffRow)}
                                      className="text-red-600 focus:bg-red-50 focus:text-red-700"
                                    >
                                      <Trash2 className="mr-2 h-4 w-4" />
                                      Delete Staff
                                    </DropdownMenuItem>
                                  </>
                                ) : (
                                  <DropdownMenuItem disabled>
                                    Marks only
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      )) : (
                        <TableRow>
                          <TableCell colSpan={7} className="py-10 text-center text-slate-500">
                            No staff records found for the selected filters.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </div>

        </section>
      )}

      {hasSection("hr-distribution") && (
        <section>
          <div className="grid gap-6 md:grid-cols-2 mb-6 items-start">
            <div className="space-y-6">
              <Card className="border-0 shadow-lg bg-white">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2 text-gray-800">
                    <MapPin className="h-4 w-4 text-green-600" />
                    Top Location In Registration
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart
                      data={data.topLocations}
                      margin={{ top: 8, right: 12, left: 0, bottom: 44 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="#f3f4f6" />
                      <XAxis
                        dataKey="name"
                        axisLine={false}
                        tickLine={false}
                        interval={0}
                        angle={-18}
                        textAnchor="end"
                        height={56}
                        tick={{ fontSize: 11 }}
                      />
                      <YAxis type="number" allowDecimals={false} axisLine={false} tickLine={false} />
                      <Tooltip />
                      <Bar dataKey="value" radius={[4, 4, 0, 0]} barSize={24} fill={COLORS.green} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              <Card className="border-0 shadow-lg bg-white">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2 text-gray-800">
                    <TrendingUp className="h-4 w-4 text-teal-600" />
                    Breeds Distributed Per Subcounty
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={280}>
                    <AreaChart data={data.breedsBySubcountyData} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                      <XAxis dataKey="name" angle={-45} textAnchor="end" height={70} interval={0} tick={{ fontSize: 10 }} />
                      <YAxis />
                      <Tooltip />
                      <Area
                        type="monotone"
                        dataKey="value"
                        stroke={COLORS.teal}
                        strokeWidth={3}
                        fill={COLORS.teal}
                        fillOpacity={0.15}
                        activeDot={{ r: 5 }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>

            <Card className="border-0 shadow-lg bg-white">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2 text-gray-800">
                  <Award className="h-4 w-4 text-teal-600" />
                  Breeds Distributed By County
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie
                      data={data.breedsByCountyData}
                      cx="50%"
                      cy="50%"
                      outerRadius={90}
                      innerRadius={50}
                      paddingAngle={2}
                      dataKey="value"
                      label={renderCustomizedLabel}
                      labelLine={false}
                    >
                      {data.breedsByCountyData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={BAR_COLORS[index % BAR_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend verticalAlign="bottom" height={36} iconType="circle" />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>
        </section>
      )}

      <Dialog
        open={isCreateStaffOpen}
        onOpenChange={(open) => {
          setIsCreateStaffOpen(open);
          if (!open) {
            setCreateStaffForm(createDefaultStaffForm());
            setEditingStaffRow(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl bg-white">
          <DialogHeader>
            <DialogTitle>{editingStaffRow ? "Edit Staff" : "Create Staff"}</DialogTitle>
            <DialogDescription>
              {editingStaffRow ?
                `Update ${editingStaffRow.staffName} in the HR table for ${activeProgram || "the selected programme"}.` :
                `Add a staff member to the HR table for ${activeProgram || "the selected programme"}.`
              }
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="create-staff-name">Staff Name</Label>
              <Input
                id="create-staff-name"
                placeholder="Enter staff name"
                value={createStaffForm.staffName}
                onChange={(event) => setCreateStaffForm((current) => ({ ...current, staffName: event.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-staff-role">Role</Label>
              <Input
                id="create-staff-role"
                placeholder="Field Officer, Supervisor..."
                value={createStaffForm.role}
                onChange={(event) => setCreateStaffForm((current) => ({ ...current, role: event.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-staff-county">County</Label>
              <Input
                id="create-staff-county"
                placeholder="Assigned county"
                value={createStaffForm.county}
                onChange={(event) => setCreateStaffForm((current) => ({ ...current, county: event.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-staff-phone">Phone</Label>
              <Input
                id="create-staff-phone"
                placeholder="Optional phone number"
                value={createStaffForm.phone}
                onChange={(event) => setCreateStaffForm((current) => ({ ...current, phone: event.target.value }))}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="create-staff-notes">Notes</Label>
            <Textarea
              id="create-staff-notes"
              placeholder="Optional staff notes"
              value={createStaffForm.notes}
              onChange={(event) => setCreateStaffForm((current) => ({ ...current, notes: event.target.value }))}
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 px-4 py-3">
            <p className="text-xs text-slate-500">
              Programme: <span className="font-semibold text-slate-700">{activeProgram || "No programme selected"}</span>
            </p>
            <Button onClick={handleCreateStaff} disabled={isSavingStaffDirectory}>
              {isSavingStaffDirectory ? "Saving..." : editingStaffRow ? "Save Changes" : "Create Staff"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isAwardDialogOpen}
        onOpenChange={(open) => {
          setIsAwardDialogOpen(open);
          if (!open) {
            setSelectedStaffRow(null);
            setStaffMarkForm(createDefaultStaffMarkForm());
          }
        }}
      >
        <DialogContent className="max-w-2xl bg-white">
          <DialogHeader>
            <DialogTitle>Award Staff Marks</DialogTitle>
            <DialogDescription>
              Score {selectedStaffRow?.staffName || "the selected staff"} for the active reporting period.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="award-staff-name">Staff Name</Label>
              <Input
                id="award-staff-name"
                value={staffMarkForm.staffName}
                onChange={(event) => setStaffMarkForm((current) => ({ ...current, staffName: event.target.value }))}
                disabled={!!selectedStaffRow}
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="award-staff-marks">Marks</Label>
                <Input
                  id="award-staff-marks"
                  type="number"
                  min="1"
                  max="100"
                  placeholder="1 - 100"
                  value={staffMarkForm.marks}
                  onChange={(event) => setStaffMarkForm((current) => ({ ...current, marks: event.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="award-staff-date">Award Date</Label>
                <Input
                  id="award-staff-date"
                  type="date"
                  value={staffMarkForm.dateAwarded}
                  onChange={(event) => setStaffMarkForm((current) => ({ ...current, dateAwarded: event.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="award-staff-note">Performance Note</Label>
              <Textarea
                id="award-staff-note"
                placeholder="Add a short reason for the award"
                value={staffMarkForm.note}
                onChange={(event) => setStaffMarkForm((current) => ({ ...current, note: event.target.value }))}
              />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 px-4 py-3">
              <p className="text-xs text-slate-500">
                Saving to: <span className="font-semibold text-slate-700">{activeProgram || "No programme selected"}</span>
              </p>
              <Button onClick={handleStaffMarkSubmit} disabled={isSavingStaffMark}>
                {isSavingStaffMark ? "Saving..." : "Save Staff Marks"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {hasSection("project-manager-report") && (
      <section>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 mb-6">
          <StatsCard
            title="Total Registered Farmers"
            value={data.totalFarmers.toLocaleString()}
            icon={Users}
            color="blue"
          />

          <StatsCard
            title="Trained Farmers"
            value={data.totalTrainedFarmers.toLocaleString()}
            icon={GraduationCap}
            subtext={trainingStatsSubtext}
            color="yellow"
          />

          <StatsCard
            title="Animal Census"
            value={data.totalAnimals.toLocaleString()}
            subtext={`Purchased goats: ${data.totalGoatsPurchased.toLocaleString()}`}
            icon={Beef}
            color="orange"
          />
        </div>

        <div className="grid gap-6 md:grid-cols-2 mb-6">
          <Card className="border-0 shadow-lg bg-white">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-gray-800">
                <MapPin className="h-4 w-4 text-purple-600" />
                Registered Farmers per County
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={data.countyPerformanceData}
                    cx="50%"
                    cy="50%"
                    outerRadius={90}
                    innerRadius={52}
                    paddingAngle={2}
                    dataKey="value"
                    labelLine={false}
                  >
                    {data.countyPerformanceData.map((entry, index) => (
                      <Cell key={`county-cell-${index}`} fill={BAR_COLORS[index % BAR_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value: number | string) => [Number(value).toLocaleString(), "Registered Farmers"]} />
                  <Legend verticalAlign="bottom" height={36} iconType="circle" />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-lg bg-white">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-gray-800">
                <MapPin className="h-4 w-4 text-blue-600" />
                Registered Farmers per Subcounty
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart
                  data={data.subcountyPerformanceData}
                  margin={{ top: 8, right: 12, left: 0, bottom: 52 }}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                  <XAxis
                    dataKey="name"
                    axisLine={false}
                    tickLine={false}
                    interval={0}
                    angle={-18}
                    textAnchor="end"
                    height={60}
                    tick={{ fontSize: 11 }}
                  />
                  <YAxis allowDecimals={false} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(value: number | string) => [Number(value).toLocaleString(), "Registered Farmers"]} />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]} barSize={24} fill={COLORS.darkBlue} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <Card className="border-0 shadow-lg bg-white">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-gray-800">
                <TargetIcon className="h-4 w-4 text-teal-600" />
                Breeds Distributed per Location
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart
                  data={projectManagerBreedsByLocationData}
                  margin={{ top: 8, right: 12, left: 0, bottom: 52 }}
                >
                  <defs>
                    <linearGradient id="pmBreedsLocationFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.teal} stopOpacity={0.35} />
                      <stop offset="95%" stopColor={COLORS.teal} stopOpacity={0.04} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                  <XAxis
                    dataKey="name"
                    axisLine={false}
                    tickLine={false}
                    interval={0}
                    angle={-18}
                    textAnchor="end"
                    height={60}
                    tick={{ fontSize: 11 }}
                  />
                  <YAxis allowDecimals={false} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(value: number | string) => [Number(value).toLocaleString(), "Breeds Distributed"]} />
                  <Area
                    type="monotone"
                    dataKey="value"
                    name="Breeds Distributed"
                    stroke={COLORS.teal}
                    strokeWidth={3}
                    fill="url(#pmBreedsLocationFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-lg bg-white">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-gray-800">
                <Syringe className="h-4 w-4 text-red-600" />
                Administered Vaccines per Location
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart
                  data={projectManagerVaccinesByLocationData}
                  layout="vertical"
                  margin={HORIZONTAL_BAR_CHART_MARGIN}
                >
                  <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="#f3f4f6" />
                  <XAxis type="number" axisLine={false} tickLine={false} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={HORIZONTAL_BAR_CHART_Y_AXIS_WIDTH}
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 11 }}
                  />
                  <Tooltip formatter={(value: number | string) => [Number(value).toLocaleString(), "Administered Doses"]} />
                  <Bar
                    dataKey="value"
                    name="Administered Doses"
                    radius={[0, 4, 4, 0]}
                    barSize={12}
                    fill={COLORS.red}
                  />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
      </section>
      )}

      {hasSection("default-registration") && (
      <section>
        <SectionHeader title="Farmer Registration" />
        
        <div className="grid gap-4 md:grid-cols-3 mb-6">
          <StatsCard 
            title="Total Farmers Registered" 
            value={data.totalFarmers.toLocaleString()} 
            icon={Users}
            subtext={`${data.maleFarmers} Male (${data.malePercentage}%) | ${data.femaleFarmers} Female (${data.femalePercentage}%)`}
            color="blue"
          />

          <StatsCard 
            title="Animal Census" 
            value={data.totalAnimals.toLocaleString()} 
            icon={Beef}
            subtext={`Goats: ${data.totalGoats} (${data.goatsPercentage}%) | Sheep: ${data.totalSheep} (${data.sheepPercentage}%)`}
            color="orange"
          />

          <StatsCard 
            title="Total Trained Farmers" 
            value={data.totalTrainedFarmers.toLocaleString()} 
            icon={GraduationCap}
            subtext={trainingStatsSubtext}
            color="yellow"
          />
        </div>

        <div className="grid gap-6 md:grid-cols-2 mb-6">
          <Card className="border-0 shadow-lg bg-white h-[350px]">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2 text-gray-800">
                  <MapPin className="h-4 w-4 text-purple-600" />
                  Registration Per County
                </CardTitle>
              </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={data.countyPerformanceData}
                    cx="50%"
                    cy="50%"
                    outerRadius={90}
                    innerRadius={50}
                    paddingAngle={2}
                    dataKey="value"
                    label={renderCustomizedLabel}
                    labelLine={false}
                  >
                    {data.countyPerformanceData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={BAR_COLORS[index % BAR_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend verticalAlign="bottom" height={36} iconType="circle" />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-lg bg-white h-[350px]">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-sm flex items-center gap-2 text-gray-800">
                    <TrendingUp className="h-4 w-4 text-blue-600" />
                    Farmers Registration Trend
                  </CardTitle>
                  <Button
                    type="button"
                    variant={registrationTrendMode === "yearly" ? "default" : "outline"}
                    size="sm"
                    className="h-8 px-3 text-xs"
                    onClick={() =>
                      setRegistrationTrendMode((mode) => (mode === "yearly" ? "auto" : "yearly"))
                    }
                  >
                    Yearly
                  </Button>
                </div>
              </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={registrationTrendChartData}>
                  <defs>
                    <linearGradient id="colorReg" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.darkBlue} stopOpacity={0.8}/>
                      <stop offset="95%" stopColor={COLORS.darkBlue} stopOpacity={0.1}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="name" />
                  <YAxis />
                  <Tooltip />
                  <Area type="monotone" dataKey="registrations" stroke={COLORS.darkBlue} fillOpacity={1} fill="url(#colorReg)" />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <Card className="border-0 shadow-lg bg-white">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-gray-800">
                <MapPin className="h-4 w-4 text-green-600" />
                Top Locations in Registrations
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={data.topLocations} layout="vertical" margin={HORIZONTAL_BAR_CHART_MARGIN}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="#f3f4f6" />
                  <XAxis type="number" axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" width={HORIZONTAL_BAR_CHART_Y_AXIS_WIDTH} axisLine={false} tickLine={false} tick={{fontSize: 11}} />
                  <Tooltip />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={12}>
                    {data.topLocations.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS.green} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-lg bg-white">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-gray-800">
                <Users className="h-4 w-4 text-blue-600" />
                Top Farmers Per Herd Size
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[250px] space-y-3 overflow-y-auto pr-2">
                {data.topCustomers.length > 0 ? (
                  data.topCustomers.map((farmer, index) => {
                    const share = topCustomerPeak > 0 ? (farmer.value / topCustomerPeak) * 100 : 0;
                    return (
                      <div
                        key={`${farmer.name}-${index}`}
                        className="rounded-2xl border border-slate-200 bg-slate-50 p-3 shadow-sm"
                      >
                        <div className="flex items-center gap-4">
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white shadow-sm">
                            {index + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <p className="truncate text-sm font-semibold text-slate-900">{farmer.name}</p>
                              <p className="truncate text-xs text-slate-500">County: {farmer.county || "N/A"}</p>
                            </div>
                          </div>
                          <div className="min-w-[140px] max-w-[220px] flex-1">
                            <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                              <div
                                className="h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-700 transition-all"
                                style={{ width: `${Math.max(share, 10)}%` }}
                              />
                            </div>
                          </div>
                          <Badge className="shrink-0 whitespace-nowrap border-blue-200 bg-blue-50 px-3 py-1 text-blue-700 hover:bg-blue-50">
                            {Number(farmer.value).toLocaleString()} goats
                          </Badge>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500">
                    No farmer data available
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </section>
      )}

      {hasSection("default-animal-health") && (
      <section>
        <SectionHeader title="Animal Health" />

        <div className="grid gap-4 md:grid-cols-3 mb-6">
          <StatsCard 
            title="Total Doses" 
            value={data.totalDosesGivenOut.toLocaleString()} 
            icon={MapPin}
            subtext="Total vaccination doses administered"
            color="purple"
          />

          <StatsCard 
            title="Breeds Distributed" 
            value={data.totalBreedsDistributed.toLocaleString()} 
            icon={TargetIcon}
            subtext={`Male: ${data.breedsMale} (${data.breedsMalePercentage}%) | Female: ${data.breedsFemale} (${data.breedsFemalePercentage}%)`}
            color="teal"
          />

          <StatsCard 
            title="Vaccinated Animals" 
            value={data.vaccinatedAnimals.toLocaleString()} 
            icon={Syringe}
            subtext={`${data.vaccinationRate}% coverage rate (${data.vaccinatedFarmersCount} farmers)`}
            color={Number(data.vaccinationRate) >= 75 ? "green" : Number(data.vaccinationRate) >= 50 ? "yellow" : "red"}
          />
        </div>

        <div className="grid gap-6 md:grid-cols-2 mb-6">
          <Card className="border-0 shadow-lg bg-white h-[350px]">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-gray-800">
                <Award className="h-4 w-4 text-teal-600" />
                Breeds Distribution per County
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={data.breedsByCountyData}
                    cx="50%"
                    cy="50%"
                    outerRadius={90}
                    innerRadius={50}
                    paddingAngle={2}
                    dataKey="value"
                    label={renderCustomizedLabel}
                    labelLine={false}
                  >
                    {data.breedsByCountyData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={BAR_COLORS[index % BAR_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend verticalAlign="bottom" height={36} iconType="circle" />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-lg bg-white h-[350px]">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-gray-800">
                <TrendingUp className="h-4 w-4 text-teal-600" />
                Subcounty Performance (Breeds)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={data.breedsBySubcountyData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                  <XAxis dataKey="name" angle={-45} textAnchor="end" height={70} interval={0} tick={{fontSize: 10}} />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]} barSize={20} fill={COLORS.teal} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <Card className="border-0 shadow-lg bg-white">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-gray-800">
                <Syringe className="h-4 w-4 text-red-600" />
                Vaccinated Animals per County
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={data.vaccinationByCountyData} layout="vertical" margin={HORIZONTAL_BAR_CHART_MARGIN}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="#f3f4f6" />
                  <XAxis type="number" axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" width={HORIZONTAL_BAR_CHART_Y_AXIS_WIDTH} axisLine={false} tickLine={false} tick={{fontSize: 11}} />
                  <Tooltip />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={12} fill={COLORS.red} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-lg bg-white">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-gray-800">
                <Syringe className="h-4 w-4 text-red-600" />
                Vaccinated Animals per Subcounty
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={data.vaccinationBySubcountyData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                  <XAxis dataKey="name" angle={-45} textAnchor="end" height={70} interval={0} tick={{fontSize: 10}} />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]} barSize={20} fill={COLORS.maroon} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>

        <div className="mt-6">
          <Card className="border-0 shadow-lg bg-white">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-gray-800">
                <Syringe className="h-4 w-4 text-red-600" />
                Vaccination Monthly Trend (Full Year)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <VaccinationMonthlyTrendChart animalHealthRecords={animalHealthActivities} />
            </CardContent>
          </Card>
        </div>
      </section>
      )}

      {hasSection("default-animal-health") && (
      <section>
        <SectionHeader title="Infrastructure" />
        <div className="grid gap-4 md:grid-cols-3 mb-6">
          <StatsCard 
            title="Total Fodder Farmers Registered" 
            value={data.totalFarmers.toLocaleString()} 
            icon={Users}
            subtext="Across all programmes"
            color="blue"
          />
          <StatsCard 
            title="Total Bales Harvested" 
            value={totalBalesHarvested.toLocaleString()} 
            icon={TrendingUp}
            subtext={`${totalBalesSold.toLocaleString()} sold | ${totalBalesBalance.toLocaleString()} balance`}
            color="green"
          />
          <StatsCard 
            title="Revenue Generated" 
            value={`KES ${totalRevenue.toLocaleString()}`}
            icon={TrendingUp}
            subtext="From hay sales"
            color="orange"
          />
        </div>
        
        <div className="grid gap-6 md:grid-cols-2 mb-6">
          {/* Pie chart: Bales Sold vs Bales Balance */}
          <Card className="border-0 shadow-lg bg-white">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-gray-800">
                <Award className="h-4 w-4 text-green-600" />
                Bales Sold vs Balance
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={[
                      { name: "Bales Sold", value: totalBalesSold || 0 },
                      { name: "Bales Balance", value: Math.max(totalBalesBalance, 0) || 0 }
                    ]}
                    cx="50%"
                    cy="50%"
                    outerRadius={90}
                    innerRadius={50}
                    paddingAngle={2}
                    dataKey="value"
                    labelLine={false}
                  >
                    <Cell fill="#22c55e" />
                    <Cell fill="#f59e0b" />
                  </Pie>
                  <Tooltip formatter={(value: number) => [Number(value).toLocaleString(), ""]} />
                  <Legend verticalAlign="bottom" height={36} iconType="circle" />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* ApexCharts Combo Chart: Bales Trends */}
          <Card className="border-0 shadow-lg bg-white">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-gray-800">
                <TrendingUp className="h-4 w-4 text-blue-600" />
                Bales Trends
              </CardTitle>
            </CardHeader>
            <CardContent>
              <BalesTrendsComboChart hayStorageRecords={hayStorageRecords} />
            </CardContent>
          </Card>
        </div>
      </section>
      )}
    </div>
  );
};

export default PerformanceReport;
