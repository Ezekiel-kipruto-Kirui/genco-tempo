import { useState, useEffect, useCallback, useMemo, useRef, useTransition, useDeferredValue, ChangeEvent, memo } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { db, ref, set, update, remove, push, onValue, query, orderByChild, equalTo, startAt, endAt } from "@/lib/firebase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollableFilterBar } from "@/components/ScrollableFilterBar";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import {
  Download, Users, MapPin, Eye, Calendar, Scale, Phone,
  CreditCard, Edit, Trash2, ShieldCheck, Activity,
  ChevronRight, Upload, GraduationCap
} from "lucide-react";
import { useSharedProgrammeSelection } from "@/hooks/use-shared-programme-selection";
import { useToast } from "@/hooks/use-toast";
import { canViewAllProgrammes, isAdmin } from "@/contexts/authhelper";
import {
  ALL_PROGRAMMES_VALUE, normalizeProgramme,
  resolveAccessibleProgrammes
} from "@/lib/programme-access";

// --- Types ---

interface AgeDistribution {
  "1-4"?: number;
  "5-8"?: number;
  "8+": number;
}

interface GoatsData {
  female?: number;
  male?: number;
  total: number;
  idNumber?: string;
}

interface FarmerData {
  id: string;
  createdAt: number | string;
  farmerId: string;
  name: string;
  gender: string;
  idNumber?: string;
  phone: string;
  county: string;
  subcounty: string;
  location: string;
  cattle: string | number;
  goats: number | GoatsData;
  sheep: string | number;
  vaccinated: boolean;
  traceability: boolean;
  vaccines: string[];
  ageDistribution?: AgeDistribution;
  registrationDate: string;
  programme: string;
  username?: string;
  aggregationGroup?: string;
  bucksServed?: string;
  femaleBreeds?: string;
  maleBreeds?: string;
  tugNumber?: string;
  dewormed?: boolean;
  dewormingDate?: string;
  vaccinationDate?: string;
  acres?: number;
}

interface TrainingData {
  id: string;
  county?: string;
  subcounty?: string;
  location?: string;
  topicTrained?: string;
  totalFarmers?: number;
  startDate?: string;
  endDate?: string;
  createdAt?: string;
  rawTimestamp?: number;
  programme?: string;
  username?: string;
  fieldOfficer?: string;
}

interface Filters {
  search: string;
  startDate: string;
  endDate: string;
  county: string;
  subcounty: string;
  gender: string;
  location: string;
  duplicateStatus: "unique" | "repeated" | "all";
}

interface Stats {
  totalFarmers: number;
  totalGoats: number;
  totalSheep: number;
  totalCattle: number;
  totalAcres: number;
  vaccinatedCount: number;
  maleFarmers: number;
  femaleFarmers: number;
  totalTrainedFarmers: number;
}

interface Pagination {
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

interface EditForm {
  farmerId: string;
  name: string;
  gender: string;
  idNumber: string;
  phone: string;
  county: string;
  subcounty: string;
  location: string;
  cattle: number;
  goats: number;
  sheep: number;
  vaccinated: boolean;
  programme: string;
  bucksServed: string;
  maleBreeds: string;
  femaleBreeds: string;
  tugNumber: string;
}

const PAGE_LIMIT = 15;

// --- Utility Functions ---

const parseDate = (date: any): Date | null => {
  if (!date) return null;
  try {
    if (date instanceof Date) return date;
    if (typeof date === "number") return new Date(date);
    if (typeof date === "string") {
      const parsed = new Date(date);
      return isNaN(parsed.getTime()) ? null : parsed;
    }
  } catch (error) {
    console.error("Error parsing date:", error, date);
  }
  return null;
};

const formatDate = (date: any): string => {
  const parsedDate = parseDate(date);
  return parsedDate
    ? parsedDate.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "N/A";
};

const getFarmerTimestamp = (record: Partial<FarmerData> | null | undefined): number => {
  if (!record) return 0;
  const parsed = parseDate(record.createdAt) || parseDate(record.registrationDate);
  return parsed ? parsed.getTime() : 0;
};

const sortFarmersByLatest = (records: FarmerData[]): FarmerData[] =>
  [...records].sort((a, b) => getFarmerTimestamp(b) - getFarmerTimestamp(a));

const formatDateForExcel = (date: any): string => {
  const parsedDate = parseDate(date);
  if (!parsedDate) return "";
  const month = String(parsedDate.getMonth() + 1).padStart(2, "0");
  const day = String(parsedDate.getDate()).padStart(2, "0");
  const year = parsedDate.getFullYear();
  return `${month}/${day}/${year}`;
};

const escapeCsvCell = (value: unknown): string => {
  const stringValue = value === null || value === undefined ? "" : String(value);
  return `"${stringValue.replace(/"/g, '""')}"`;
};

const getGoatTotal = (goats: any): number => {
  if (typeof goats === "number") return goats;
  if (typeof goats === "object" && goats !== null) {
    return typeof goats.total === "number" ? goats.total : 0;
  }
  return 0;
};

const getAcreTotal = (item: Record<string, any>): number => {
  const rawAcreValue =
    item.acres ??
    item.totalAcres ??
    item.totalAcresPasture ??
    item.landSize ??
    item.land_under_pasture ??
    item.landUnderPasture;
  if (typeof rawAcreValue === "number")
    return Number.isFinite(rawAcreValue) ? rawAcreValue : 0;
  if (typeof rawAcreValue === "string") {
    const parsed = Number(rawAcreValue.replace(/,/g, "").trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

// --- Record Processors ---

const processFarmerRecord = (
  key: string,
  item: any,
  fallbackProgramme?: string
): FarmerData => {
  let dateValue = item.createdAt;
  if (typeof dateValue !== "number") {
    dateValue = parseDate(item.registrationDate)?.getTime() || Date.now();
  }

  return {
    id: key,
    createdAt: dateValue,
    farmerId: item.farmerId || "N/A",
    name: item.name || "",
    gender: item.gender || "",
    idNumber: item.idNumber || "",
    phone: item.phone || "",
    county: item.county || "",
    subcounty: item.subcounty || "",
    location: item.location || item.subcounty || "",
    cattle: item.cattle || "0",
    goats: item.goats || 0,
    sheep: item.sheep || "0",
    vaccinated: !!item.vaccinated,
    traceability: !!item.traceability,
    vaccines: Array.isArray(item.vaccines) ? item.vaccines : [],
    ageDistribution: item.ageDistribution || {},
    registrationDate: item.registrationDate || formatDate(dateValue),
    programme:
      normalizeProgramme(item.programme ?? item.Programme) ||
      fallbackProgramme ||
      "",
    username: item.username || "Unknown",
    aggregationGroup: item.aggregationGroup || "",
    bucksServed: item.bucksServed || "0",
    femaleBreeds: item.femaleBreeds || "0",
    maleBreeds: item.maleBreeds || "0",
    tugNumber: item.tugNumber || item.tagNumber || "",
    dewormed: !!item.dewormed,
    dewormingDate: item.dewormingDate || null,
    vaccinationDate: item.vaccinationDate || null,
    acres: getAcreTotal(item),
  };
};

// =============================================================================
// DEDUPLICATION HELPERS
//
// Key design decisions:
//   1. farmerId is NOT used as a dedup key — it is not a reliable unique
//      identifier and caused false duplicate detection.
//   2. phone is NOT used as a dedup key — multiple farmers can legitimately
//      share a phone number.
//   3. idNumber is the PRIMARY key when it is a real, non-zero value.
//      This correctly identifies the same farmer re-registered across
//      dates or programmes.
//   4. When idNumber is zero / blank / N/A, a PROFILE FINGERPRINT is used
//      instead: name + county + subcounty + location + programme.
//      This gives every distinct farmer their own bucket — 100 different
//      zero-ID farmers are never collapsed into a single record.
// =============================================================================

const normalizeDuplicateToken = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const isUsableIdentityValue = (value: unknown): boolean => {
  const normalized = normalizeDuplicateToken(value);
  return (
    Boolean(normalized) &&
    !["n/a", "na", "/a", "0", "0.0", "null", "undefined", ""].includes(normalized)
  );
};

// Stable profile-based fingerprint for farmers with no real ID number.
// Each distinct name + location combination gets its own unique bucket.
const buildProfileKey = (record: FarmerData): string =>
  [
    "profile",
    normalizeDuplicateToken(record.name),
    normalizeDuplicateToken(record.county),
    normalizeDuplicateToken(record.subcounty),
    normalizeDuplicateToken(record.location),
    normalizeDuplicateToken(record.programme),
  ].join(":");

// Returns the deduplication key for a farmer record.
//
// Priority:
//   1. Real idNumber (non-zero, non-blank) → "id:<idNumber>"
//   2. Zero / blank / N/A idNumber        → profile fingerprint
//
// farmerId intentionally excluded — not a reliable unique identifier.
// phone intentionally excluded — two farmers can share a number.
const getFarmerDuplicateKey = (record: FarmerData): string => {
  if (isUsableIdentityValue(record.idNumber)) {
    return `id:${normalizeDuplicateToken(record.idNumber)}`;
  }
  return buildProfileKey(record);
};

const dedupeFarmers = (records: FarmerData[]): FarmerData[] => {
  const uniqueRecords = new Map<string, FarmerData>();

  // Sort newest-first so the most recent registration wins when deduping
  sortFarmersByLatest(records).forEach((record) => {
    const key = getFarmerDuplicateKey(record);
    if (!uniqueRecords.has(key)) {
      uniqueRecords.set(key, record);
    }
  });

  return sortFarmersByLatest(Array.from(uniqueRecords.values()));
};

const getDuplicateKeyCounts = (records: FarmerData[]): Map<string, number> => {
  const counts = new Map<string, number>();
  records.forEach((record) => {
    const key = getFarmerDuplicateKey(record);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
};

const processTrainingRecord = (
  key: string,
  item: any,
  fallbackProgramme?: string
): TrainingData => ({
  id: key,
  ...item,
  programme:
    normalizeProgramme(item?.programme ?? item?.Programme) ||
    fallbackProgramme ||
    "",
});

// =============================================================================
// OPTIMIZATION #1: Incremental subscription
// =============================================================================

const CACHE_TTL_MS = 5 * 60 * 1000;
const FARMER_REGISTRATION_SMS =
  "You have been registered successfully with Genco Livestock. Thank you.";

interface SubscriptionOptions {
  debounceMs?: number;
  cacheKey?: string;
  dateChild?: string;
  startDate?: string;
  endDate?: string;
}

const formatLocalDateForInput = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const getCurrentMonthRange = () => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return {
    startDate: formatLocalDateForInput(startOfMonth),
    endDate: formatLocalDateForInput(endOfMonth),
  };
};

const getRangeBounds = (startDateStr?: string, endDateStr?: string) => {
  const start = startDateStr ? new Date(startDateStr) : null;
  const end = endDateStr ? new Date(endDateStr) : null;
  if (start) start.setHours(0, 0, 0, 0);
  if (end) end.setHours(23, 59, 59, 999);
  return {
    start: start?.getTime(),
    end: end?.getTime(),
  };
};

const subscribeToProgrammeRecords = <T,>(
  path: string,
  programmeValues: readonly string[],
  mapRecord: (key: string, item: any, fallbackProgramme: string) => T,
  onRecords: (records: T[]) => void,
  onError: (error: Error) => void,
  options?: SubscriptionOptions,
) => {
  const normalizedProgrammes = Array.from(new Set(programmeValues.map(normalizeProgramme).filter(Boolean)));
  if (normalizedProgrammes.length === 0) {
    onRecords([]);
    return () => {};
  }

  let cacheHit = false;
  if (options?.cacheKey) {
    try {
      const cached = localStorage.getItem(options.cacheKey);
      if (cached) {
        const { data, ts } = JSON.parse(cached) as { data: T[]; ts: number };
        if (Date.now() - ts < CACHE_TTL_MS) {
          onRecords(data);
          cacheHit = true;
        }
      }
    } catch { /* ignore corrupt cache */ }
  }

  const recordsById = new Map<string, T>();
  const initializedQueries = new Set<string>();
  let hasErrored = false;
  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  const debounceMs = options?.debounceMs ?? 80;

  const persistCache = () => {
    if (options?.cacheKey) {
      try {
        localStorage.setItem(
          options.cacheKey,
          JSON.stringify({ data: Array.from(recordsById.values()), ts: Date.now() })
        );
      } catch { /* storage full */ }
    }
  };

  const tryPublish = (isInitialLoad: boolean) => {
    if (publishTimer) clearTimeout(publishTimer);

    if (isInitialLoad && !cacheHit) {
      onRecords(Array.from(recordsById.values()));
      return;
    }

    publishTimer = setTimeout(() => {
      const merged = Array.from(recordsById.values());
      onRecords(merged);
      persistCache();
    }, debounceMs);
  };

  if (options?.dateChild && (options.startDate || options.endDate)) {
    const { start, end } = getRangeBounds(options.startDate, options.endDate);
    const programmeSet = new Set(normalizedProgrammes);
    const dateQuery = query(
      ref(db, path),
      orderByChild(options.dateChild),
      startAt(start ?? 0),
      endAt(end ?? Number.MAX_SAFE_INTEGER),
    );

    const unsubscribe = onValue(
      dateQuery,
      (snapshot) => {
        if (hasErrored) return;
        recordsById.clear();
        snapshot.forEach((childSnapshot) => {
          const item = childSnapshot.val();
          const recordProgramme = normalizeProgramme(item?.programme ?? item?.Programme);
          if (!programmeSet.has(recordProgramme)) return;
          recordsById.set(
            childSnapshot.key || "",
            mapRecord(childSnapshot.key || "", item, recordProgramme),
          );
        });
        tryPublish(!cacheHit);
      },
      (error) => {
        hasErrored = true;
        onError(error);
      },
    );

    return () => {
      if (publishTimer) clearTimeout(publishTimer);
      unsubscribe();
    };
  }

  const unsubscribers = normalizedProgrammes.flatMap((programmeValue) =>
    ["programme", "Programme"].map((fieldName) => {
      const queryKey = `${programmeValue}:${fieldName}`;
      const collectionQuery = query(
        ref(db, path),
        orderByChild(fieldName),
        equalTo(programmeValue)
      );

      return onValue(
        collectionQuery,
        (snapshot) => {
          if (hasErrored) return;

          const isFirstLoad = !initializedQueries.has(queryKey);
          initializedQueries.add(queryKey);

          snapshot.forEach((childSnapshot) => {
            recordsById.set(
              childSnapshot.key || "",
              mapRecord(childSnapshot.key || "", childSnapshot.val(), programmeValue)
            );
          });

          tryPublish(isFirstLoad);
        },
        (error) => {
          if (hasErrored) return;
          initializedQueries.add(queryKey);
          hasErrored = true;
          onError(error);
        }
      );
    })
  );

  return () => {
    if (publishTimer) clearTimeout(publishTimer);
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  };
};

// =============================================================================
// OPTIMIZATION #2: Date-range filter predicate
// =============================================================================

const matchesDateRange = (
  rawDate: any,
  startDateStr: string,
  endDateStr: string,
): boolean => {
  if (!startDateStr && !endDateStr) return true;

  const recordDate = parseDate(rawDate);
  if (!recordDate) {
    return !startDateStr && !endDateStr;
  }

  const recordDateOnly = new Date(recordDate);
  recordDateOnly.setHours(0, 0, 0, 0);

  if (startDateStr) {
    const startDate = new Date(startDateStr);
    startDate.setHours(0, 0, 0, 0);
    if (recordDateOnly < startDate) return false;
  }

  if (endDateStr) {
    const endDate = new Date(endDateStr);
    endDate.setHours(23, 59, 59, 999);
    if (recordDateOnly > endDate) return false;
  }

  return true;
};

// =============================================================================
// OPTIMIZATION #3: Filtering logic as pure function
// =============================================================================

const applyFiltersAndDedupe = (
  allFarmers: FarmerData[],
  trainingRecords: TrainingData[],
  filters: Filters,
): { filtered: FarmerData[]; filteredTraining: TrainingData[] } => {
  const filteredFarmersList = allFarmers.filter((record) => {
    if (!matchesDateRange(record.createdAt, filters.startDate, filters.endDate)) return false;
    if (filters.county !== "all" && record.county?.toLowerCase() !== filters.county.toLowerCase()) return false;
    if (filters.subcounty !== "all" && record.subcounty?.toLowerCase() !== filters.subcounty.toLowerCase()) return false;
    if (filters.location !== "all" && record.location?.toLowerCase() !== filters.location.toLowerCase()) return false;
    if (filters.gender !== "all" && record.gender?.toLowerCase() !== filters.gender.toLowerCase()) return false;
    if (filters.search) {
      const searchTerm = filters.search.toLowerCase();
      const searchMatch = [
        record.name, record.farmerId, record.location,
        record.county, record.idNumber, record.phone, record.username,
      ].some((field) => field?.toLowerCase().includes(searchTerm));
      if (!searchMatch) return false;
    }
    return true;
  });

  const duplicateKeyCounts = getDuplicateKeyCounts(filteredFarmersList);
  const sortedFilteredFarmers =
    filters.duplicateStatus === "repeated"
      ? sortFarmersByLatest(
          filteredFarmersList.filter(
            (record) => (duplicateKeyCounts.get(getFarmerDuplicateKey(record)) || 0) > 1
          )
        )
      : filters.duplicateStatus === "all"
        ? sortFarmersByLatest(filteredFarmersList)
        : dedupeFarmers(filteredFarmersList);

  const filteredTraining = trainingRecords.filter((record) =>
    matchesDateRange(record.startDate || record.createdAt || record.rawTimestamp, filters.startDate, filters.endDate)
  );

  return { filtered: sortedFilteredFarmers, filteredTraining };
};

// =============================================================================
// OPTIMIZATION #4: Stats derived from filtered farmers
// =============================================================================

const computeStats = (
  filteredFarmers: FarmerData[],
  filteredTraining: TrainingData[],
): Stats => {
  const totalFarmers = filteredFarmers.length;
  const totalGoats = filteredFarmers.reduce((sum, f) => sum + getGoatTotal(f.goats), 0);
  const totalSheep = filteredFarmers.reduce((sum, f) => sum + (Number(f.sheep) || 0), 0);
  const totalCattle = filteredFarmers.reduce((sum, f) => sum + (Number(f.cattle) || 0), 0);
  const totalAcres = filteredFarmers.reduce((sum, f) => sum + (Number(f.acres) || 0), 0);
  const vaccinatedCount = filteredFarmers.filter((f) => f.vaccinated).length;
  const maleFarmers = filteredFarmers.filter((f) => f.gender?.toLowerCase() === "male").length;
  const femaleFarmers = filteredFarmers.filter((f) => f.gender?.toLowerCase() === "female").length;
  const totalTrainedFarmers = filteredTraining.reduce((sum, t) => sum + (Number(t.totalFarmers) || 0), 0);

  return {
    totalFarmers, totalGoats, totalSheep, totalCattle, totalAcres,
    vaccinatedCount, maleFarmers, femaleFarmers, totalTrainedFarmers,
  };
};

// --- CSV helpers ---

const parseCSVLine = (line: string): string[] => {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
};

// --- Component ---

const LivestockFarmersPage = () => {
  const { user, userRole, userAttribute, userName, allowedProgrammes } = useAuth();
  const { toast } = useToast();

  // =========================================================================
  // State
  // =========================================================================

  const [allFarmers, setAllFarmers] = useState<FarmerData[]>([]);
  const [trainingRecords, setTrainingRecords] = useState<TrainingData[]>([]);
  const [availablePrograms, setAvailablePrograms] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [exportLoading, setExportLoading] = useState(false);
  const [selectedRecords, setSelectedRecords] = useState<string[]>([]);
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [isBulkSmsDialogOpen, setIsBulkSmsDialogOpen] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isSingleDeleteDialogOpen, setIsSingleDeleteDialogOpen] = useState(false);
  const [viewingRecord, setViewingRecord] = useState<FarmerData | null>(null);
  const [editingRecord, setEditingRecord] = useState<FarmerData | null>(null);
  const [recordToDelete, setRecordToDelete] = useState<FarmerData | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [bulkSmsMessage, setBulkSmsMessage] = useState("");
  const [bulkSmsSending, setBulkSmsSending] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentMonthRange = useMemo(() => getCurrentMonthRange(), []);

  const [filters, setFilters] = useState<Filters>({
    search: "",
    startDate: currentMonthRange.startDate,
    endDate: currentMonthRange.endDate,
    county: "all",
    subcounty: "all",
    gender: "all",
    location: "all",
    duplicateStatus: "all",
  });

  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: PAGE_LIMIT,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
  });

  const [editForm, setEditForm] = useState<EditForm>({
    farmerId: "", name: "", gender: "", idNumber: "", phone: "",
    county: "", subcounty: "", location: "", cattle: 0, goats: 0, sheep: 0,
    vaccinated: false, programme: "",
    bucksServed: "", maleBreeds: "", femaleBreeds: "", tugNumber: "",
  });

  // =========================================================================
  // OPTIMIZATION #5: useTransition for non-urgent filter updates
  // =========================================================================
  const [isPending, startTransition] = useTransition();

  const userIsAdmin = useMemo(() => isAdmin(userRole), [userRole]);
  const userCanViewAllProgrammeData = useMemo(
    () => canViewAllProgrammes(userRole, userAttribute, allowedProgrammes),
    [allowedProgrammes, userRole, userAttribute]
  );
  const accessibleProgrammes = useMemo(
    () => resolveAccessibleProgrammes(userCanViewAllProgrammeData, allowedProgrammes),
    [allowedProgrammes, userCanViewAllProgrammeData]
  );
  const [activeProgram, setActiveProgram] = useSharedProgrammeSelection(accessibleProgrammes, {
    allowAll: true,
    fallbackToAll: true,
  });

  const requireAdmin = () => {
    if (userIsAdmin) return true;
    toast({
      title: "Access denied",
      description: "Only Admin can create, edit, or delete records on this page.",
      variant: "destructive",
    });
    return false;
  };

  useEffect(() => {
    setAvailablePrograms(accessibleProgrammes);
  }, [accessibleProgrammes]);

  // =========================================================================
  // OPTIMIZATION #6: Deferred search value
  // =========================================================================
  const deferredSearch = useDeferredValue(filters.search);

  // =========================================================================
  // Farmers listener
  // =========================================================================
  useEffect(() => {
    if (!activeProgram) {
      setAllFarmers([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    const programmeValues =
      activeProgram === ALL_PROGRAMMES_VALUE
        ? accessibleProgrammes
        : [normalizeProgramme(activeProgram)];

    if (programmeValues.length === 0 || programmeValues.every((programme) => !normalizeProgramme(programme))) {
      setAllFarmers([]);
      setLoading(false);
      return;
    }

    const unsubscribe = subscribeToProgrammeRecords(
      "farmers",
      programmeValues,
      processFarmerRecord,
      (records) => {
        setAllFarmers(sortFarmersByLatest(records));
        setLoading(false);
      },
      (error) => {
        console.error("Error loading livestock farmers:", error);
        toast({
          title: "Error",
          description: "Failed to load livestock farmers.",
          variant: "destructive",
        });
        setLoading(false);
      },
      {
        debounceMs: 80,
        cacheKey: `farmers_cache_${activeProgram}_${filters.startDate}_${filters.endDate}`,
        dateChild: "createdAt",
        startDate: filters.startDate,
        endDate: filters.endDate,
      },
    );

    return () => {
      unsubscribe();
    };
  }, [accessibleProgrammes, activeProgram, filters.endDate, filters.startDate, toast]);

  // =========================================================================
  // Training records listener
  // =========================================================================
  useEffect(() => {
    if (!activeProgram) {
      setTrainingRecords([]);
      return;
    }

    const programmeValues =
      activeProgram === ALL_PROGRAMMES_VALUE
        ? accessibleProgrammes
        : [normalizeProgramme(activeProgram)];

    if (programmeValues.length === 0 || programmeValues.every((programme) => !normalizeProgramme(programme))) {
      setTrainingRecords([]);
      return;
    }

    const unsubscribe = subscribeToProgrammeRecords(
      "capacityBuilding",
      programmeValues,
      processTrainingRecord,
      setTrainingRecords,
      (error) => {
        console.error("Error loading training records:", error);
      },
      {
        debounceMs: 80,
        cacheKey: `training_cache_${activeProgram}_${filters.startDate}_${filters.endDate}`,
        dateChild: "rawTimestamp",
        startDate: filters.startDate,
        endDate: filters.endDate,
      },
    );

    return () => {
      unsubscribe();
    };
  }, [accessibleProgrammes, activeProgram, filters.endDate, filters.startDate]);

  // =========================================================================
  // OPTIMIZATION #7: Filtering + deduplication via useMemo
  // =========================================================================

  const effectiveFilters = useMemo(
    () => ({ ...filters, search: deferredSearch }),
    [filters, deferredSearch]
  );

  const { filtered: filteredFarmers, filteredTraining } = useMemo(
    () => applyFiltersAndDedupe(allFarmers, trainingRecords, effectiveFilters),
    [allFarmers, trainingRecords, effectiveFilters]
  );

  const stats = useMemo(
    () => computeStats(filteredFarmers, filteredTraining),
    [filteredFarmers, filteredTraining]
  );

  // =========================================================================
  // OPTIMIZATION #8: Pagination
  // =========================================================================

  const totalPages = useMemo(
    () => Math.ceil(filteredFarmers.length / PAGE_LIMIT),
    [filteredFarmers.length]
  );

  useEffect(() => {
    const currentPage = Math.min(pagination.page, Math.max(1, totalPages));
    setPagination((prev) => ({
      ...prev,
      page: currentPage,
      totalPages,
      hasNext: currentPage < totalPages,
      hasPrev: currentPage > 1,
    }));
  }, [totalPages, pagination.page]);

  // =========================================================================
  // Derived values for table rendering
  // =========================================================================

  const currentPageRecords = useMemo(() => {
    const startIndex = (pagination.page - 1) * pagination.limit;
    const endIndex = startIndex + pagination.limit;
    return filteredFarmers.slice(startIndex, endIndex);
  }, [filteredFarmers, pagination.page, pagination.limit]);

  const removeFarmersFromState = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const deletedIds = new Set(ids);
    setAllFarmers((prev) => prev.filter((record) => !deletedIds.has(record.id)));
    setSelectedRecords((prev) => prev.filter((id) => !deletedIds.has(id)));
  }, []);

  const uniqueCounties = useMemo(
    () => [...new Set(allFarmers.map((f) => f.county).filter(Boolean))],
    [allFarmers]
  );
  const uniqueSubcounties = useMemo(
    () => [...new Set(allFarmers.map((f) => f.subcounty).filter(Boolean))],
    [allFarmers]
  );
  const uniqueLocations = useMemo(
    () => [...new Set(allFarmers.map((f) => f.location).filter(Boolean))],
    [allFarmers]
  );
  const uniqueGenders = useMemo(
    () => [...new Set(allFarmers.map((f) => f.gender).filter(Boolean))],
    [allFarmers]
  );

  // =========================================================================
  // Handlers
  // =========================================================================

  const handleProgramChange = (program: string) => {
    setActiveProgram(program);
    setFilters({
      search: "", startDate: "", endDate: "",
      county: "all", subcounty: "all", gender: "all",
      location: "all", duplicateStatus: "all",
    });
    setSelectedRecords([]);
    setPagination((prev) => ({ ...prev, page: 1 }));
  };

  const handleSearchChange = useCallback((value: string) => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      startTransition(() => {
        setFilters((prev) => ({ ...prev, search: value }));
        setPagination((prev) => ({ ...prev, page: 1 }));
      });
    }, 300);
  }, []);

  const handleFilterChange = useCallback(<K extends keyof Filters>(key: K, value: Filters[K]) => {
    startTransition(() => {
      setFilters((prev) => ({ ...prev, [key]: value }));
      setPagination((prev) => ({ ...prev, page: 1 }));
    });
  }, []);

  const handlePageChange = useCallback((newPage: number) => {
    setPagination((prev) => {
      const validatedPage = Math.max(1, Math.min(newPage, totalPages));
      return {
        ...prev,
        page: validatedPage,
        hasNext: validatedPage < totalPages,
        hasPrev: validatedPage > 1,
      };
    });
  }, [totalPages]);

  const handleSelectRecord = useCallback((recordId: string) => {
    setSelectedRecords((prev) =>
      prev.includes(recordId) ? prev.filter((id) => id !== recordId) : [...prev, recordId]
    );
  }, []);

  const handleSelectAll = useCallback(() => {
    const pageIds = currentPageRecords.map((f) => f.id);
    setSelectedRecords((prev) =>
      prev.length === pageIds.length ? [] : pageIds
    );
  }, [currentPageRecords]);

  const openViewDialog = useCallback((record: FarmerData) => {
    setViewingRecord(record);
    setIsViewDialogOpen(true);
  }, []);

  const openEditDialog = useCallback((record: FarmerData) => {
    if (!userIsAdmin) return;
    setEditingRecord(record);
    const cattleVal = typeof record.cattle === "number" ? record.cattle : parseInt(record.cattle as string) || 0;
    const sheepVal = typeof record.sheep === "number" ? record.sheep : parseInt(record.sheep as string) || 0;
    const goatsVal = getGoatTotal(record.goats);

    setEditForm({
      farmerId: record.farmerId, name: record.name, gender: record.gender,
      idNumber: record.idNumber || "", phone: record.phone,
      county: record.county, subcounty: record.subcounty, location: record.location,
      cattle: cattleVal, goats: goatsVal, sheep: sheepVal,
      vaccinated: record.vaccinated, programme: record.programme,
      bucksServed: (record.bucksServed ?? "").toString(),
      maleBreeds: (record.maleBreeds ?? "").toString(),
      femaleBreeds: (record.femaleBreeds ?? "").toString(),
      tugNumber: (record.tugNumber ?? "").toString(),
    });
    setIsEditDialogOpen(true);
  }, [userIsAdmin]);

  const openSingleDeleteConfirm = useCallback((record: FarmerData) => {
    if (!userIsAdmin) return;
    setRecordToDelete(record);
    setIsSingleDeleteDialogOpen(true);
  }, [userIsAdmin]);

  const openBulkDeleteConfirm = useCallback(() => {
    if (!userIsAdmin) return;
    setIsDeleteConfirmOpen(true);
  }, [userIsAdmin]);

  const handleEditSubmit = async () => {
    if (!requireAdmin()) return;
    if (!editingRecord) return;
    try {
      await update(ref(db, `farmers/${editingRecord.id}`), {
        farmerId: editForm.farmerId, name: editForm.name, gender: editForm.gender,
        idNumber: editForm.idNumber, phone: editForm.phone,
        county: editForm.county, subcounty: editForm.subcounty, location: editForm.location,
        cattle: Number(editForm.cattle), goats: Number(editForm.goats), sheep: Number(editForm.sheep),
        vaccinated: editForm.vaccinated, programme: editForm.programme,
        bucksServed: editForm.bucksServed, maleBreeds: editForm.maleBreeds,
        femaleBreeds: editForm.femaleBreeds, tugNumber: editForm.tugNumber,
      });
      toast({ title: "Success", description: "Farmer record updated" });
      setIsEditDialogOpen(false);
      setEditingRecord(null);
    } catch (error) {
      toast({ title: "Error", description: "Update failed", variant: "destructive" });
    }
  };

  const handleSingleDelete = async () => {
    if (!requireAdmin()) return;
    if (!recordToDelete) return;
    try {
      setDeleteLoading(true);
      await remove(ref(db, `farmers/${recordToDelete.id}`));
      localStorage.removeItem(`farmers_cache_${activeProgram}`);
      removeFarmersFromState([recordToDelete.id]);
      toast({ title: "Success", description: "Record deleted" });
      setIsSingleDeleteDialogOpen(false);
      setRecordToDelete(null);
    } catch (error) {
      toast({ title: "Error", description: "Deletion failed", variant: "destructive" });
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleDeleteMultiple = async () => {
    if (!requireAdmin()) return;
    if (selectedRecords.length === 0) return;
    try {
      setDeleteLoading(true);
      const idsToDelete = [...selectedRecords];
      const updates: { [key: string]: null } = {};
      idsToDelete.forEach((id) => (updates[`farmers/${id}`] = null));
      await update(ref(db), updates);
      localStorage.removeItem(`farmers_cache_${activeProgram}`);
      removeFarmersFromState(idsToDelete);
      toast({ title: "Success", description: `${idsToDelete.length} records deleted` });
      setIsDeleteConfirmOpen(false);
    } catch (error) {
      toast({ title: "Error", description: "Bulk delete failed", variant: "destructive" });
    } finally {
      setDeleteLoading(false);
    }
  };

  const openBulkSmsDialog = () => {
    if (selectedRecords.length === 0) {
      toast({ title: "No Records Selected", description: "Select farmers to send bulk SMS.", variant: "destructive" });
      return;
    }
    setIsBulkSmsDialogOpen(true);
  };

  const handleSendBulkSms = async () => {
    const message = bulkSmsMessage.trim();
    if (!message) {
      toast({ title: "Message Required", description: "Enter the SMS message to send.", variant: "destructive" });
      return;
    }

    const selectedSet = new Set(selectedRecords);
    const recipients = allFarmers
      .filter((record) => selectedSet.has(record.id))
      .map((record) => String(record.phone || "").trim())
      .filter((phone) => phone.length > 0);
    const uniqueRecipients = Array.from(new Set(recipients));

    if (uniqueRecipients.length === 0) {
      toast({ title: "No Phone Numbers", description: "Selected farmers have no valid phone numbers.", variant: "destructive" });
      return;
    }

    setBulkSmsSending(true);
    try {
      const requestRef = push(ref(db, "smsOutbox"));
      await set(requestRef, {
        status: "pending",
        sourcePage: "livestock-farmers",
        programme: activeProgram,
        createdAt: Date.now(),
        createdBy: userName || user?.email || user?.uid || "unknown",
        message,
        recipients: uniqueRecipients,
        selectedRecordCount: selectedRecords.length,
      });
      toast({ title: "SMS Queued", description: `Bulk SMS queued for ${uniqueRecipients.length} farmers.` });
      setBulkSmsMessage("");
      setIsBulkSmsDialogOpen(false);
    } catch (error) {
      console.error("Failed to queue bulk SMS:", error);
      toast({ title: "Queue Failed", description: "Failed to queue bulk SMS.", variant: "destructive" });
    } finally {
      setBulkSmsSending(false);
    }
  };

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) setUploadFile(e.target.files[0]);
  };

  const handleUpload = async () => {
    if (!requireAdmin()) return;
    if (!uploadFile) return;
    if (activeProgram === ALL_PROGRAMMES_VALUE) {
      toast({
        title: "Select a programme",
        description: "Choose KPMD, RANGE, or KPMD 2 before uploading farmer records.",
        variant: "destructive",
      });
      return;
    }
    setUploadLoading(true);
    try {
      const text = await uploadFile.text();
      const isJSON = uploadFile.name.endsWith(".json");
      let parsedData: any[] = [];

      if (isJSON) {
        const jsonData = JSON.parse(text);
        parsedData = Array.isArray(jsonData) ? jsonData : Object.values(jsonData);
      } else {
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        if (lines.length < 2) throw new Error("CSV file is empty or has no data rows");

        const rawHeaders = parseCSVLine(lines[0]);
        const headers = rawHeaders.map((h) =>
          h.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/\(.*?\)/g, "")
            .replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ")
        );

        const findIndex = (keys: string[]) =>
          headers.findIndex((h) => keys.some((k) => h.includes(k)));

        const idxName = findIndex(["farmer name", "name"]);
        const idxGender = findIndex(["gender"]);
        const idxCounty = findIndex(["county"]);
        const idxSub = findIndex(["subcounty", "sub county"]);
        const idxLoc = findIndex(["location"]);
        const idxCattle = findIndex(["cattle"]);
        const idxSheep = findIndex(["sheep"]);
        const idxIdNumber = findIndex(["id number", "idnumber"]);
        const idxPhone = findIndex(["phone"]);
        const idxFarmerId = findIndex(["farmer id"]);
        const idxRegDate = findIndex(["registration date", "reg date", "date"]);
        const idxVaccinated = findIndex(["vaccinated"]);
        const idxTrace = findIndex(["traceability"]);
        const idxVaccines = findIndex(["vaccine"]);
        const idxDewormed = findIndex(["dewormed"]);
        const idxDewormingDate = findIndex(["deworming date", "deworm date"]);
        const idxAggregationGroup = findIndex(["aggregation group", "group"]);
        const idxVaccinationDate = findIndex(["vaccination date", "vaccine date", "vax date"]);
        const idxFieldOfficer = findIndex(["field officer", "officer", "officer name", "created by", "username"]);

        const idxGoatsTotal = findIndex([
          "goats", "goats total", "total goats", "no of goats",
          "number of goats", "goats number", "goat count", "total goat",
        ]);
        const idxGoatsMale = findIndex([
          "male", "male goats", "male goat", "goat male", "goats m", "m goats", "goatsmale",
        ]);
        const idxGoatsFemale = findIndex([
          "female", "female goats", "female goat", "goat female", "goats f", "f goats", "goatsfemale",
        ]);

        const parseBool = (val: string) => {
          const v = (val || "").toLowerCase().trim();
          return v === "yes" || v === "true" || v === "1";
        };
        const valAt = (values: string[], idx: number) =>
          idx >= 0 && idx < values.length ? values[idx] : "";

        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i]);
          if (!values.some((v) => v.trim() !== "")) continue;

          const obj: any = {};
          if (idxName !== -1) obj.name = valAt(values, idxName).trim();
          if (idxGender !== -1) obj.gender = valAt(values, idxGender).trim();
          if (idxCounty !== -1) obj.county = valAt(values, idxCounty).trim();
          if (idxSub !== -1) obj.subcounty = valAt(values, idxSub).trim();
          if (idxLoc !== -1) obj.location = valAt(values, idxLoc).trim();
          if (idxCattle !== -1) obj.cattle = Number(valAt(values, idxCattle)) || 0;
          if (idxSheep !== -1) obj.sheep = Number(valAt(values, idxSheep)) || 0;
          if (idxIdNumber !== -1) obj.idNumber = valAt(values, idxIdNumber).trim();
          if (idxPhone !== -1) obj.phone = valAt(values, idxPhone).trim();
          if (idxFarmerId !== -1) obj.farmerId = valAt(values, idxFarmerId).trim();

          let createdAtTimestamp = Date.now();
          if (idxRegDate !== -1) {
            const regDateStr = valAt(values, idxRegDate).trim();
            obj.registrationDate = regDateStr;
            const dateObj = new Date(regDateStr);
            if (!isNaN(dateObj.getTime())) createdAtTimestamp = dateObj.getTime();
          }
          obj.createdAt = createdAtTimestamp;

          if (idxVaccinated !== -1) obj.vaccinated = parseBool(valAt(values, idxVaccinated));
          if (idxTrace !== -1) obj.traceability = parseBool(valAt(values, idxTrace));
          if (idxVaccines !== -1) {
            const raw = valAt(values, idxVaccines).trim();
            obj.vaccines = raw ? raw.split(";").map((s) => s.trim()).filter((s) => s) : [];
          }
          if (idxDewormed !== -1) obj.dewormed = parseBool(valAt(values, idxDewormed));
          if (idxDewormingDate !== -1) obj.dewormingDate = valAt(values, idxDewormingDate).trim();
          if (idxAggregationGroup !== -1) obj.aggregationGroup = valAt(values, idxAggregationGroup).trim();
          if (idxVaccinationDate !== -1) obj.vaccinationDate = valAt(values, idxVaccinationDate).trim();
          if (idxFieldOfficer !== -1) obj.username = valAt(values, idxFieldOfficer).trim();

          const foundGoatsMale = idxGoatsMale > -1;
          const foundGoatsFemale = idxGoatsFemale > -1;
          const foundGoatsTotal = idxGoatsTotal > -1;

          if (foundGoatsMale || foundGoatsFemale) {
            const maleCount = foundGoatsMale ? Number(valAt(values, idxGoatsMale)) || 0 : 0;
            const femaleCount = foundGoatsFemale ? Number(valAt(values, idxGoatsFemale)) || 0 : 0;
            const totalGoats = foundGoatsTotal ? Number(valAt(values, idxGoatsTotal)) || 0 : maleCount + femaleCount;
            obj.goats = { male: maleCount, female: femaleCount, total: totalGoats };
          } else if (foundGoatsTotal) {
            obj.goats = { total: Number(valAt(values, idxGoatsTotal)) || 0, male: 0, female: 0 };
          }
          parsedData.push(obj);
        }
      }

      let count = 0;
      const registrationSmsRecipients = new Set<string>();
      const collectionRef = ref(db, "farmers");
      for (const item of parsedData) {
        const phone = String(item.phone || item.phoneNumber || item.phoneNo || "").trim();
        await push(collectionRef, {
          ...item,
          programme: activeProgram,
          username: item.username || "Unknown",
        });
        if (phone) registrationSmsRecipients.add(phone);
        count++;
      }

      let queuedSmsCount = 0;
      if (registrationSmsRecipients.size > 0) {
        try {
          const requestRef = push(ref(db, "smsOutbox"));
          const recipients = Array.from(registrationSmsRecipients);
          await set(requestRef, {
            status: "pending",
            sourcePage: "livestock-farmers-registration",
            programme: activeProgram,
            createdAt: Date.now(),
            createdBy: userName || user?.email || user?.uid || "unknown",
            message: FARMER_REGISTRATION_SMS,
            recipients,
            selectedRecordCount: count,
          });
          queuedSmsCount = recipients.length;
        } catch (smsError) {
          console.error("Failed to queue farmer registration SMS:", smsError);
          toast({
            title: "SMS Queue Failed",
            description: "Farmers were uploaded, but registration SMS was not queued.",
            variant: "destructive",
          });
        }
      }

      localStorage.removeItem(`farmers_cache_${activeProgram}`);
      toast({
        title: "Success",
        description: `Uploaded ${count} records to ${activeProgram}.${queuedSmsCount ? ` SMS queued for ${queuedSmsCount} farmers.` : ""}`,
      });
      setIsUploadDialogOpen(false);
      setUploadFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (error) {
      console.error(error);
      toast({ title: "Error", description: "Upload failed. Please check file format.", variant: "destructive" });
    } finally {
      setUploadLoading(false);
    }
  };

  const handleExport = async () => {
    try {
      setExportLoading(true);
      if (filteredFarmers.length === 0) return;

      const headers = [
        "Farmer ID", "Name", "Gender", "Phone", "ID Number",
        "County", "Subcounty", "Location",
        "Cattle", "Goats (Total)", "Goats (Male)", "Goats (Female)", "Sheep",
        "Vaccinated", "Traceability", "Vaccines",
        "Programme", "Field Officer", "Created By", "Registration Date",
        "Dewormed", "Deworming Date", "Vaccination Date",
        "Aggregation Group", "Bucks Served", "Female Breeds", "Male Breeds", "Tag Number",
        "Age 1-4", "Age 5-8", "Age 8+",
      ];

      const csvData = filteredFarmers.map((f) => [
        f.farmerId, f.name, f.gender, f.phone, f.idNumber,
        f.county, f.subcounty, f.location,
        f.cattle, getGoatTotal(f.goats),
        (typeof f.goats === "object" && f.goats?.male) || 0,
        (typeof f.goats === "object" && f.goats?.female) || 0,
        f.sheep,
        f.vaccinated ? "Yes" : "No",
        f.traceability ? "Yes" : "No",
        f.vaccines.join("; "),
        f.programme, f.username, f.username,
        formatDateForExcel(f.createdAt),
        f.dewormed ? "Yes" : "No",
        formatDateForExcel(f.dewormingDate),
        formatDateForExcel(f.vaccinationDate),
        f.aggregationGroup || "",
        f.bucksServed || "",
        f.femaleBreeds || "",
        f.maleBreeds || "",
        f.tugNumber || "",
        f.ageDistribution?.["1-4"] || "",
        f.ageDistribution?.["5-8"] || "",
        f.ageDistribution?.["8+"] || "",
      ]);

      const dateColumns = new Set([19, 21, 22]);
      const csvContent = [
        headers.map(escapeCsvCell).join(","),
        ...csvData.map((row) =>
          row.map((cell, index) =>
            dateColumns.has(index) ? String(cell ?? "") : escapeCsvCell(cell)
          ).join(",")
        ),
      ].join("\n");

      const blob = new Blob([`\uFEFF${csvContent}`], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `farmers_export_${activeProgram}_${new Date().toISOString().split("T")[0]}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      toast({ title: "Success", description: "Data exported successfully" });
    } catch (error) {
      toast({ title: "Error", description: "Export failed", variant: "destructive" });
    } finally {
      setExportLoading(false);
    }
  };

  // =========================================================================
  // UI
  // =========================================================================

  const StatsCard = memo(
    ({ title, value, icon: Icon, description, color = "blue", children, maleCount, femaleCount, totalCount }: any) => (
      <Card className="bg-white text-slate-900 shadow-lg border border-gray-200 relative overflow-hidden">
        <div className={`absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-${color}-600 to-purple-800`}></div>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 pt-4 pl-6">
          <CardTitle className="text-sm font-medium text-gray-400">{title}</CardTitle>
        </CardHeader>
        <CardContent className="pl-6 pb-4 flex flex-col">
          <div className="flex items-center gap-3 mb-1">
            <div className="rounded-full bg-gray-50 p-2">
              <Icon className={`h-5 w-5 text-${color}-600`} />
            </div>
            <div className="text-xl font-bold text-gray-800">{value}</div>
          </div>
          {maleCount !== undefined && femaleCount !== undefined ? (
            <div className="mt-3 flex items-center justify-between w-full bg-gray-50 text-xs">
              <div className="flex flex-row">
                <span className="text-gray-500">Male</span>
                <span className="font-bold text-blue-600 text-sm">
                  {maleCount} |{" "}
                  <span className="text-gray-400 font-normal">
                    ({totalCount > 0 ? Math.round((maleCount / totalCount) * 100) : 0}%)
                  </span>
                </span>
              </div>
              <div className="h-8 w-[1px] bg-gray-100"></div>
              <div className="flex flex-row text-right">
                <span className="text-gray-500">Female</span>
                <span className="font-bold text-pink-600 text-sm">
                  {femaleCount} |
                  <span className="text-gray-400 font-normal">
                    ({totalCount > 0 ? Math.round((femaleCount / totalCount) * 100) : 0}%)
                  </span>
                </span>
              </div>
            </div>
          ) : children ? (
            children
          ) : (
            description && (
              <p className="text-xs mt-2 bg-gray-50 px-2 py-1 rounded-md border border-slate-100">{description}</p>
            )
          )}
        </CardContent>
      </Card>
    )
  );

  return (
    <div className="space-y-6 px-2 sm:px-4 md:px-0">
      {/* ── Header ── */}
      <div className="flex flex-col justify-between items-start gap-4">
        <div className="w-full md:w-auto">
          <h2 className="text-md font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
            Livestock Farmers
          </h2>
          <div className="flex items-center gap-2">
            <div className="bg-blue-50 text-blue-700 border-blue-200 text-xs w-fit">
              {activeProgram === ALL_PROGRAMMES_VALUE ? "ALL PROGRAMMES" : activeProgram || "No Access"} PROJECT
            </div>
            {isPending && (
              <span className="text-xs text-gray-400 animate-pulse">Updating...</span>
            )}
          </div>
        </div>

        <div className="flex flex-col md:flex-row xl:flex-row lg:flex-row gap-2 w-full">
          <div className="flex flex-col md:flex-row lg:flex-row gap-2 items-center">
            <Input
              id="startDate"
              type="date"
              value={filters.startDate}
              onChange={(e) => handleFilterChange("startDate", e.target.value)}
              className="border-gray-300 focus:border-blue-500 bg-white w-full text-sm pr-6 cursor-pointer appearance-auto"
            />
            <Input
              id="endDate"
              type="date"
              value={filters.endDate}
              onChange={(e) => handleFilterChange("endDate", e.target.value)}
              className="border-gray-300 focus:border-blue-500 bg-white w-full text-sm pr-6 cursor-pointer appearance-auto"
            />
            {availablePrograms.length > 1 ? (
              <div className="space-y-2 w-full lg:w-[180px]">
                <Select value={activeProgram} onValueChange={handleProgramChange} disabled={availablePrograms.length === 0}>
                  <SelectTrigger className="border-gray-300 focus:border-blue-500 bg-white h-10 font-bold w-full">
                    <SelectValue placeholder="Select Programme" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_PROGRAMMES_VALUE}>All Programmes</SelectItem>
                    {availablePrograms.map((p) => (
                      <SelectItem key={p} value={p}>{p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="hidden lg:block w-[180px]"></div>
            )}
          </div>

          <div className="flex flex-row xl:flex-row gap-2 items-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                startTransition(() => {
                  setFilters({
                    search: "", startDate: "", endDate: "",
                    county: "all", subcounty: "all", gender: "all",
                    location: "all", duplicateStatus: "all",
                  });
                  setPagination((prev) => ({ ...prev, page: 1 }));
                });
              }}
              className="h-10 px-6 w-full xl:w-auto"
            >
              Clear Filters
            </Button>

            {selectedRecords.length > 0 && userIsAdmin && (
              <Button variant="destructive" size="sm" onClick={openBulkDeleteConfirm} disabled={deleteLoading} className="text-xs h-10">
                <Trash2 className="h-4 w-4 mr-2" /> Delete ({selectedRecords.length})
              </Button>
            )}
            {selectedRecords.length > 0 && (
              <Button variant="outline" size="sm" onClick={openBulkSmsDialog} className="border-green-300 text-green-700 h-10 hover:bg-green-50">
                <Phone className="h-4 w-4 mr-2" /> Send SMS ({selectedRecords.length})
              </Button>
            )}
            {userIsAdmin && (
              <>
                <Button variant="outline" size="sm" onClick={() => setIsUploadDialogOpen(true)} className="border-green-300 text-green-700 h-10">
                  <Upload className="h-4 w-4 mr-2" /> Upload
                </Button>
                <Button
                  onClick={handleExport}
                  disabled={exportLoading || filteredFarmers.length === 0}
                  className="bg-gradient-to-r from-blue-800 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white shadow-md text-xs h-10"
                >
                  <Download className="h-4 w-4 mr-2" /> Export ({filteredFarmers.length})
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Stats Cards ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-3 gap-4">
        <StatsCard
          title="FARMERS REGISTERED"
          value={stats.totalFarmers.toLocaleString()}
          icon={Users}
          color="blue"
          maleCount={stats.maleFarmers}
          femaleCount={stats.femaleFarmers}
          totalCount={stats.totalFarmers}
        />
        <StatsCard
          title="ANIMAL CENSUS"
          value={(stats.totalSheep + stats.totalGoats).toLocaleString()}
          icon={Activity}
          color="blue"
        >
          <div className="flex items-center justify-between w-full mt-3 text-xs border-t border-gray-100 pt-2">
            <div className="flex flex-row text-left">
              <span className="text-gray-500 font-medium">Goats</span>
              <span className="font-bold text-purple-600">
                {stats.totalGoats} |
                <span className="text-gray-400 font-normal ml-1">
                  {stats.totalSheep + stats.totalGoats > 0
                    ? Math.round((stats.totalGoats / (stats.totalSheep + stats.totalGoats)) * 100)
                    : 0}
                  %
                </span>
              </span>
            </div>
            <div className="flex flex-row text-right">
              <span className="text-gray-500 font-medium">Sheep</span>
              <span className="font-bold text-indigo-600">
                {stats.totalSheep} |
                <span className="text-gray-400 font-normal ml-1">
                  {stats.totalSheep + stats.totalGoats > 0
                    ? Math.round((stats.totalSheep / (stats.totalSheep + stats.totalGoats)) * 100)
                    : 0}
                  %
                </span>
              </span>
            </div>
          </div>
        </StatsCard>
        <StatsCard
          title="TRAINED FARMERS"
          value={stats.totalTrainedFarmers.toLocaleString()}
          icon={GraduationCap}
          color="blue"
          description="Participants in training sessions"
        />
      </div>

      {/* ── Filters ── */}
      <Card className="shadow-lg border-0 bg-white">
        <CardContent className="space-y-6 pt-6">
          <ScrollableFilterBar ariaLabel="Livestock farmer filters" contentClassName="sm:grid-cols-2 lg:grid-cols-6">
            <div className="w-[190px] shrink-0 space-y-2 sm:w-auto">
              <Label className="font-semibold text-gray-700 text-xs uppercase">County</Label>
              <Select value={filters.county} onValueChange={(value) => handleFilterChange("county", value)}>
                <SelectTrigger className="border-gray-300 focus:border-blue-500 bg-white h-9">
                  <SelectValue placeholder="All Counties" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Counties</SelectItem>
                  {uniqueCounties.map((county) => (
                    <SelectItem key={county} value={county}>{county}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="w-[190px] shrink-0 space-y-2 sm:w-auto">
              <Label className="font-semibold text-gray-700 text-xs uppercase">Subcounty</Label>
              <Select value={filters.subcounty} onValueChange={(value) => handleFilterChange("subcounty", value)}>
                <SelectTrigger className="border-gray-300 focus:border-blue-500 bg-white h-9">
                  <SelectValue placeholder="All Subcounties" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Subcounties</SelectItem>
                  {uniqueSubcounties.map((sub) => (
                    <SelectItem key={sub} value={sub}>{sub}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="w-[190px] shrink-0 space-y-2 sm:w-auto">
              <Label className="font-semibold text-gray-700 text-xs uppercase">Location</Label>
              <Select value={filters.location} onValueChange={(value) => handleFilterChange("location", value)}>
                <SelectTrigger className="border-gray-300 focus:border-blue-500 bg-white h-9">
                  <SelectValue placeholder="All Locations" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Locations</SelectItem>
                  {uniqueLocations.map((loc) => (
                    <SelectItem key={loc} value={loc}>{loc}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="w-[190px] shrink-0 space-y-2 sm:w-auto">
              <Label className="font-semibold text-gray-700 text-xs uppercase">Gender</Label>
              <Select value={filters.gender} onValueChange={(value) => handleFilterChange("gender", value)}>
                <SelectTrigger className="border-gray-300 focus:border-blue-500 bg-white h-9">
                  <SelectValue placeholder="All Genders" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Genders</SelectItem>
                  {uniqueGenders.map((g) => (
                    <SelectItem key={g} value={g}>{g}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="w-[210px] shrink-0 space-y-2 sm:w-auto">
              <Label className="font-semibold text-gray-700 text-xs uppercase">Registration Repetition</Label>
              <Select value={filters.duplicateStatus} onValueChange={(value) => handleFilterChange("duplicateStatus", value as Filters["duplicateStatus"])}>
                <SelectTrigger className="border-gray-300 focus:border-blue-500 bg-white h-9">
                  <SelectValue placeholder="All Registrations" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Registrations</SelectItem>
                  <SelectItem value="unique">Unique Farmers</SelectItem>
                  <SelectItem value="repeated">Repeated Registrations</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="w-[240px] shrink-0 space-y-2 sm:w-auto">
              <Label className="font-semibold text-gray-700 text-xs uppercase">Search</Label>
              <Input
                placeholder="Name, ID, Phone, Officer..."
                defaultValue={filters.search}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="border-gray-300 focus:border-blue-500 bg-white h-9"
              />
            </div>
          </ScrollableFilterBar>
        </CardContent>
      </Card>

      {/* ── Table ── */}
      <Card className="shadow-lg border-0 bg-white">
        <CardContent className="p-0">
          {loading ? (
            <div className="text-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
              <p className="text-muted-foreground mt-2">Loading farmers registry...</p>
            </div>
          ) : currentPageRecords.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              {activeProgram ? "No records found matching your criteria" : "You do not have access to any programme data."}
            </div>
          ) : (
            <>
              <div className="w-full overflow-x-auto rounded-md">
                <table className="w-full border-collapse border border-gray-300 text-sm text-left whitespace-nowrap">
                  <thead>
                    <tr className="bg-blue-50 text-xs">
                      <th className="py-3 px-3">
                        <Checkbox
                          checked={selectedRecords.length === currentPageRecords.length && currentPageRecords.length > 0}
                          onCheckedChange={handleSelectAll}
                        />
                      </th>
                      <th className="py-3 px-3 font-semibold text-gray-700">Date</th>
                      <th className="py-3 px-3 font-semibold text-gray-700">Farmer Name</th>
                      <th className="py-3 px-3 font-semibold text-gray-700">Gender</th>
                      <th className="py-3 px-3 font-semibold text-gray-700">Phone</th>
                      <th className="py-3 px-3 font-semibold text-gray-700 hidden sm:table-cell">ID</th>
                      <th className="py-3 px-3 font-semibold text-gray-700">County</th>
                      <th className="py-3 px-3 font-semibold text-gray-700">Subcounty</th>
                      <th className="py-3 px-3 font-semibold text-gray-700">Location</th>
                      <th className="py-3 px-3 font-semibold text-gray-700">Cattle</th>
                      <th className="py-3 px-3 font-semibold text-gray-700">Goats</th>
                      <th className="py-3 px-3 font-semibold text-gray-700">Sheep</th>
                      <th className="py-3 px-3 font-semibold text-gray-700">Vaccinated</th>
                      <th className="py-3 px-3 font-semibold text-gray-700">PROJECT</th>
                      <th className="py-3 px-3 font-semibold text-gray-700 hidden sm:table-cell">Field Officer</th>
                      <th className="py-3 px-3 font-semibold text-gray-700">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentPageRecords.map((record) => (
                      <tr key={record.id} className="border-b hover:bg-blue-50 transition-colors group">
                        <td className="py-2 px-3">
                          <Checkbox
                            checked={selectedRecords.includes(record.id)}
                            onCheckedChange={() => handleSelectRecord(record.id)}
                          />
                        </td>
                        <td className="py-2 px-3 text-xs text-gray-500">{formatDate(record.createdAt)}</td>
                        <td className="py-2 px-3 text-sm">{record.name}</td>
                        <td className="py-2 px-3">{record.gender}</td>
                        <td className="py-2 px-3 text-xs">{record.phone}</td>
                        <td className="py-2 px-3 text-xs font-mono hidden sm:table-cell">{record.idNumber}</td>
                        <td className="py-2 px-3 text-xs">{record.county}</td>
                        <td className="py-2 px-3 text-xs">{record.subcounty}</td>
                        <td className="py-2 px-3 text-xs">{record.location}</td>
                        <td className="py-2 px-3 text-xs">{record.cattle}</td>
                        <td className="py-2 px-3 text-xs font-semibold text-green-700">{getGoatTotal(record.goats)}</td>
                        <td className="py-2 px-3 text-xs font-semibold text-purple-700">{record.sheep}</td>
                        <td className="py-2 px-3">
                          {record.vaccinated ? (
                            <Badge className="bg-green-100 text-green-800 hover:bg-green-100 text-[10px]">Yes</Badge>
                          ) : (
                            <Badge variant="outline" className="text-gray-400 text-[10px]">No</Badge>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          <Badge variant="outline" className="border-blue-200 text-blue-700 text-[10px]">
                            {record.programme || activeProgram}
                          </Badge>
                        </td>
                        <td className="py-2 px-3 text-xs italic text-gray-500 hidden sm:table-cell">{record.username}</td>
                        <td className="py-2 px-3">
                          <div className="flex gap-1">
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-green-600 hover:bg-green-50"
                              onClick={() => openViewDialog(record)}>
                              <Eye className="h-3.5 w-3.5" />
                            </Button>
                            {userIsAdmin && (
                              <>
                                <Button variant="ghost" size="icon" className="h-7 w-7 text-blue-600 hover:bg-blue-50"
                                  onClick={() => openEditDialog(record)}>
                                  <Edit className="h-3.5 w-3.5" />
                                </Button>
                                <Button variant="ghost" size="icon" className="h-7 w-7 text-red-600 hover:bg-red-50"
                                  onClick={() => openSingleDeleteConfirm(record)}>
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-col sm:flex-row items-center justify-between p-4 border-t bg-gray-50 gap-4">
                <div className="text-sm text-muted-foreground">
                  {filteredFarmers.length} total records &bull; Page {pagination.page} of {pagination.totalPages}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={!pagination.hasPrev} onClick={() => handlePageChange(pagination.page - 1)}>
                    Previous
                  </Button>
                  <Button variant="outline" size="sm" disabled={!pagination.hasNext} onClick={() => handlePageChange(pagination.page + 1)}>
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── View Dialog ── */}
      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent className="sm:max-w-3xl bg-white rounded-2xl max-h-[90vh] overflow-y-auto w-[95vw] sm:w-full">
          <DialogHeader>
            <DialogTitle>Farmer Profile Details</DialogTitle>
            <DialogDescription>Complete information for {viewingRecord?.name}</DialogDescription>
          </DialogHeader>
          {viewingRecord && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 py-4">
              <div className="col-span-1 sm:col-span-2 bg-blue-50 p-4 rounded-lg flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="bg-blue-100 p-3 rounded-full"><Users className="h-6 w-6 text-blue-600" /></div>
                  <div>
                    <h3 className="font-bold text-lg">{viewingRecord.name}</h3>
                    <p className="text-sm text-gray-600">{viewingRecord.farmerId} &bull; {viewingRecord.programme}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-xs text-gray-500 uppercase font-bold">Created By</p>
                  <p className="text-sm font-medium">{viewingRecord.username}</p>
                </div>
              </div>
              <DetailRow label="County" value={viewingRecord.county} />
              <DetailRow label="Subcounty" value={viewingRecord.subcounty} />
              <DetailRow label="Location" value={viewingRecord.location} />
              <DetailRow label="Phone" value={viewingRecord.phone} />
              <DetailRow label="Gender" value={viewingRecord.gender} />
              <DetailRow label="ID Number" value={viewingRecord.idNumber || "N/A"} />
              <DetailRow label="Registration Date" value={viewingRecord.registrationDate} />
              <div className="col-span-1 sm:col-span-2 border-t pt-4 mt-2">
                <h4 className="font-semibold text-gray-700 mb-3 flex items-center gap-2">
                  <Scale className="h-4 w-4" />Livestock Ownership
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                  <div className="bg-gray-50 p-4 rounded text-center border">
                    <span className="block font-bold text-2xl text-orange-600">{viewingRecord.cattle}</span>
                    <span className="text-xs text-gray-500 uppercase">Cattle</span>
                  </div>
                  <div className="bg-gray-50 p-4 rounded text-center border">
                    <span className="block font-bold text-2xl text-green-600">{getGoatTotal(viewingRecord.goats)}</span>
                    <span className="text-xs text-gray-500 uppercase">Goats</span>
                  </div>
                  <div className="bg-gray-50 p-4 rounded text-center border">
                    <span className="block font-bold text-2xl text-purple-600">{viewingRecord.sheep}</span>
                    <span className="text-xs text-gray-500 uppercase">Sheep</span>
                  </div>
                </div>
              </div>
              <div className="col-span-1 sm:col-span-2 border-t pt-4">
                <h4 className="font-semibold text-gray-700 mb-3 flex items-center gap-2">
                  <Activity className="h-4 w-4" />Health Status
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="p-4 border rounded flex items-center justify-between">
                    <div>
                      <p className="text-xs text-gray-500 font-bold uppercase">Vaccinated</p>
                      <p className="font-medium">{viewingRecord.vaccinated ? "Yes" : "No"}</p>
                    </div>
                    <ShieldCheck className={`h-5 w-5 ${viewingRecord.vaccinated ? "text-green-600" : "text-gray-300"}`} />
                  </div>
                  {viewingRecord.vaccinationDate && (
                    <div className="p-4 border rounded">
                      <p className="text-xs text-gray-500 font-bold uppercase">Vaccination Date</p>
                      <p className="font-medium">{viewingRecord.vaccinationDate}</p>
                    </div>
                  )}
                  <div className="p-4 border rounded flex items-center justify-between">
                    <div>
                      <p className="text-xs text-gray-500 font-bold uppercase">Dewormed</p>
                      <p className="font-medium">{viewingRecord.dewormed ? "Yes" : "No"}</p>
                    </div>
                    <ShieldCheck className={`h-5 w-5 ${viewingRecord.dewormed ? "text-blue-600" : "text-gray-300"}`} />
                  </div>
                  {viewingRecord.dewormingDate && (
                    <div className="p-4 border rounded">
                      <p className="text-xs text-gray-500 font-bold uppercase">Deworming Date</p>
                      <p className="font-medium">{viewingRecord.dewormingDate}</p>
                    </div>
                  )}
                </div>
              </div>
              <div className="col-span-1 sm:col-span-2 border-t pt-4">
                <h4 className="font-semibold text-gray-700 mb-2 flex items-center gap-2">
                  <Scale className="h-4 w-4" />Breeding
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <DetailRow label="Bucks Served" value={viewingRecord.bucksServed || "N/A"} />
                  <DetailRow label="Male Breeds" value={viewingRecord.maleBreeds || "N/A"} />
                  <DetailRow label="Female Breeds" value={viewingRecord.femaleBreeds || "N/A"} />
                  <DetailRow label="Tag Number" value={viewingRecord.tugNumber || "N/A"} />
                </div>
              </div>
              <div className="col-span-1 sm:col-span-2 border-t pt-4">
                <div className="p-4 border rounded flex items-center gap-3">
                  <Activity className={`h-5 w-5 ${viewingRecord.traceability ? "text-blue-600" : "text-gray-300"}`} />
                  <div>
                    <p className="text-xs text-gray-500 font-bold uppercase">Traceability</p>
                    <p className="font-medium">{viewingRecord.traceability ? "Enabled" : "Disabled"}</p>
                  </div>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setIsViewDialogOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit Dialog ── */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="sm:max-w-2xl bg-white rounded-2xl w-[95vw] sm:w-full max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Edit Farmer Details</DialogTitle></DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-4">
            <div className="space-y-2">
              <Label>Farmer ID</Label>
              <Input value={editForm.farmerId} onChange={(e) => setEditForm({ ...editForm, farmerId: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Gender</Label>
              <Select value={editForm.gender} onValueChange={(val) => setEditForm({ ...editForm, gender: val })}>
                <SelectTrigger><SelectValue placeholder="Select Gender" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Male">Male</SelectItem>
                  <SelectItem value="Female">Female</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Phone</Label>
              <Input value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>ID Number</Label>
              <Input value={editForm.idNumber} onChange={(e) => setEditForm({ ...editForm, idNumber: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>County</Label>
              <Input value={editForm.county} onChange={(e) => setEditForm({ ...editForm, county: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Subcounty</Label>
              <Input value={editForm.subcounty} onChange={(e) => setEditForm({ ...editForm, subcounty: e.target.value })} />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Location</Label>
              <Input value={editForm.location} onChange={(e) => setEditForm({ ...editForm, location: e.target.value })} />
            </div>
            <div className="col-span-1 sm:col-span-2 my-2 border-t pt-2">
              <h4 className="text-sm font-semibold text-gray-500 uppercase">Livestock Counts</h4>
            </div>
            <div className="space-y-2">
              <Label>Cattle</Label>
              <Input type="number" value={editForm.cattle} onChange={(e) => setEditForm({ ...editForm, cattle: parseInt(e.target.value) || 0 })} />
            </div>
            <div className="space-y-2">
              <Label>Goats</Label>
              <Input type="number" value={editForm.goats} onChange={(e) => setEditForm({ ...editForm, goats: parseInt(e.target.value) || 0 })} />
            </div>
            <div className="space-y-2">
              <Label>Sheep</Label>
              <Input type="number" value={editForm.sheep} onChange={(e) => setEditForm({ ...editForm, sheep: parseInt(e.target.value) || 0 })} />
            </div>
            <div className="col-span-1 sm:col-span-2 my-2 border-t pt-2">
              <h4 className="text-sm font-semibold text-gray-500 uppercase">Breeding</h4>
            </div>
            <div className="space-y-2">
              <Label>Bucks Served</Label>
              <Input type="number" value={editForm.bucksServed} onChange={(e) => setEditForm({ ...editForm, bucksServed: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Male Breeds</Label>
              <Input type="number" value={editForm.maleBreeds} onChange={(e) => setEditForm({ ...editForm, maleBreeds: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Female Breeds</Label>
              <Input type="number" value={editForm.femaleBreeds} onChange={(e) => setEditForm({ ...editForm, femaleBreeds: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Tag Number</Label>
              <Input value={editForm.tugNumber} onChange={(e) => setEditForm({ ...editForm, tugNumber: e.target.value })} />
            </div>
            <div className="col-span-1 sm:col-span-2 my-2 border-t pt-2">
              <h4 className="text-sm font-semibold text-gray-500 uppercase">Status & PROJECT</h4>
            </div>
            <div className="space-y-2">
              <Label>PROJECT</Label>
              <Select value={editForm.programme} onValueChange={(val) => setEditForm({ ...editForm, programme: val })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {availablePrograms.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2 border p-3 rounded h-fit mt-6">
              <Checkbox checked={editForm.vaccinated} onCheckedChange={(c) => setEditForm({ ...editForm, vaccinated: !!c })} id="edit-vaccinated" />
              <Label htmlFor="edit-vaccinated" className="cursor-pointer">Vaccinated</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleEditSubmit} className="bg-blue-600 hover:bg-blue-700">Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Upload Dialog ── */}
      <Dialog open={isUploadDialogOpen} onOpenChange={setIsUploadDialogOpen}>
        <DialogContent className="sm:max-w-md w-[95vw] sm:w-full">
          <DialogHeader>
            <DialogTitle>Upload Farmers Data</DialogTitle>
            <DialogDescription>
              Upload CSV or JSON file. Data will be assigned to <strong>{activeProgram}</strong> PROJECT.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input type="file" ref={fileInputRef} accept=".csv,.json" onChange={handleFileSelect} className="mb-4" />
            {uploadFile && <p className="text-sm text-gray-600">Selected: {uploadFile.name}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setIsUploadDialogOpen(false); setUploadFile(null); }}>Cancel</Button>
            <Button onClick={handleUpload} disabled={!uploadFile || uploadLoading}>
              {uploadLoading ? "Uploading..." : "Upload Data"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Single Delete Dialog ── */}
      <Dialog open={isSingleDeleteDialogOpen} onOpenChange={setIsSingleDeleteDialogOpen}>
        <DialogContent className="sm:max-w-md w-[95vw] sm:w-full">
          <DialogHeader><DialogTitle>Confirm Deletion</DialogTitle></DialogHeader>
          <p>Are you sure you want to delete <strong>{recordToDelete?.name}</strong>? This cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsSingleDeleteDialogOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleSingleDelete} disabled={deleteLoading}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Bulk Delete Dialog ── */}
      <Dialog open={isDeleteConfirmOpen} onOpenChange={setIsDeleteConfirmOpen}>
        <DialogContent className="sm:max-w-md w-[95vw] sm:w-full">
          <DialogHeader><DialogTitle>Bulk Delete</DialogTitle></DialogHeader>
          <p>Are you sure you want to delete {selectedRecords.length} selected records?</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDeleteConfirmOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDeleteMultiple} disabled={deleteLoading}>Delete All</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Bulk SMS Dialog ── */}
      <Dialog
        open={isBulkSmsDialogOpen}
        onOpenChange={(open) => {
          if (!bulkSmsSending) setIsBulkSmsDialogOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-lg w-[95vw] sm:w-full">
          <DialogHeader>
            <DialogTitle>Send Bulk SMS to Farmers</DialogTitle>
            <DialogDescription>This message will be sent to selected farmers with valid phone numbers.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="farmers-bulk-sms-message">SMS Message</Label>
            <Textarea
              id="farmers-bulk-sms-message"
              rows={5}
              value={bulkSmsMessage}
              onChange={(event) => setBulkSmsMessage(event.target.value)}
              placeholder="Type SMS message..."
              disabled={bulkSmsSending}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsBulkSmsDialogOpen(false)} disabled={bulkSmsSending}>
              Cancel
            </Button>
            <Button onClick={handleSendBulkSms} disabled={bulkSmsSending}>
              {bulkSmsSending ? "Sending..." : "Send SMS"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

const DetailRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex flex-col">
    <span className="text-xs text-gray-500 font-bold uppercase">{label}</span>
    <span className="text-sm font-medium text-gray-900">{value || "N/A"}</span>
  </div>
);

export default LivestockFarmersPage;
