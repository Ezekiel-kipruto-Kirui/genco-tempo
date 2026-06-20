import { useState, useEffect, useCallback, useMemo, useRef, ChangeEvent } from "react";
import { useAuth } from "@/contexts/AuthContext";
type Unsubscribe = () => void;
import { db, ref, set, update, remove, push, onValue, query, orderByChild, equalTo } from "@/lib/firebase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollableFilterBar } from "@/components/ScrollableFilterBar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Download, Users, BookOpen, Edit, Trash2, Calendar, Eye, MapPin,
  Upload, User, UserCircle, MoreHorizontal, FileText, ExternalLink,
} from "lucide-react";
import { useSharedProgrammeSelection } from "@/hooks/use-shared-programme-selection";
import { useToast } from "@/hooks/use-toast";
import { canViewAllProgrammes, isAdmin } from "@/contexts/authhelper";
import { cacheKey, readCachedValue, removeCachedValue, writeCachedValue } from "@/lib/data-cache";
import { matchesActiveProgramme, normalizeProgramme, resolveAccessibleProgrammes, resolveActiveProgramme } from "@/lib/programme-access";

// ──────────────────────────────────────────────
// Utility: Format large numbers
// ──────────────────────────────────────────────
const formatNumber = (num: number): string => {
  if (num == null || !Number.isFinite(num)) return "0";
  const abs = Math.abs(num);
  if (abs >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (abs >= 1_000_000) return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return num.toLocaleString();
};

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

/** A single entry inside a weekly capacity report's `entries` array. */
interface WeeklyReportEntry {
  createdAt?: string;
  endDateISO?: string;
  endDateLabel?: string;
  fieldOfficer?: string;
  id?: string;
  location?: string;
  startDateISO?: string;
  startDateLabel?: string;
  topicDiscussed?: string;
  totalFarmers?: number;
  county?: string;
  subcounty?: string;
}

/** Metadata about the uploaded PDF file. */
interface PdfFileInfo {
  mimeType?: string;
  name?: string;
  uri?: string;
}

/** Unified training / weekly-report record used throughout the component. */
interface TrainingRecord {
  id: string;

  // Common fields (may come from flat record or normalised from entry)
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
  Programme?: string;
  username?: string;
  fieldOfficer?: string;

  // Manual fields (optional)
  numberOfTrainers?: number;
  numberOfSubCounties?: number;

  // Legacy flat-record fields
  Gender?: string;
  Modules?: string;
  Name?: string;
  Phone?: string;
  region?: string;
  maleFarmers?: number;
  femaleFarmers?: number;

  // ── Weekly capacity report fields ──
  recordType?: string;           // e.g. "weeklyCapacityReport"
  reportId?: string;             // e.g. "CB-1777532544049"
  entries?: WeeklyReportEntry[];
  pdfUrl?: string;               // Firebase Storage download URL
  validationDocumentPdfUrl?: string;
  validationDocumentUrl?: string;
  documentPdfUrl?: string;
  pdfDownloadUrl?: string;
  pdfFile?: PdfFileInfo | null;  // Local file metadata (mobile)
  generatedAt?: number;          // Timestamp when report was generated
  uploadedAtISO?: string;        // ISO string when report was uploaded
}

const getStringField = (
  source: Record<string, unknown>,
  keys: string[],
): string => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
};

const getNestedStringField = (
  source: Record<string, unknown>,
  parentKeys: string[],
  childKeys: string[],
): string => {
  for (const parentKey of parentKeys) {
    const parent = source[parentKey];
    if (!parent || typeof parent !== "object") continue;
    const value = getStringField(parent as Record<string, unknown>, childKeys);
    if (value) return value;
  }
  return "";
};

interface Filters {
  search: string;
  startDate: string;
  endDate: string;
  modules: string;
  region: string;
}

interface Stats {
  totalParticipants: number;
  totalTrainers: number;
  totalSubCounties: number;
}

interface EditForm {
  Name: string;
  topicTrained: string;
  county: string;
  subcounty: string;
  startDate: string;
  endDate: string;
  totalFarmers: number;
  programme: string;
  numberOfTrainers: number;
  numberOfSubCounties: number;
}

// ──────────────────────────────────────────────
// Constants & Helpers
// ──────────────────────────────────────────────

const PAGE_LIMIT = 15;

const EXPORT_HEADERS = [
  "Date Created", "Report ID", "Topic/Module", "County", "Subcounty",
  "Village", "Start Date", "End Date", "Total Farmers",
  "Officer", "Programme", "PDF Link",
];

const INVALID_FIREBASE_KEY_CHARS = /[.#$/[\]]/g;

const sanitizeFirebaseKey = (key: string, fallback: string): string => {
  const sanitized = key
    .replace(/^\uFEFF/, "")
    .replace(INVALID_FIREBASE_KEY_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();

  return sanitized || fallback;
};

const sanitizeFirebaseValue = (value: unknown): unknown => {
  if (value === undefined) return null;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(sanitizeFirebaseValue);
  if (typeof value !== "object") return value;

  const sanitizedObject: Record<string, unknown> = {};
  Object.entries(value as Record<string, unknown>).forEach(([key, childValue], index) => {
    const baseKey = sanitizeFirebaseKey(key, `field_${index + 1}`);
    let safeKey = baseKey;
    let suffix = 2;

    while (Object.prototype.hasOwnProperty.call(sanitizedObject, safeKey)) {
      safeKey = `${baseKey}_${suffix}`;
      suffix += 1;
    }

    sanitizedObject[safeKey] = sanitizeFirebaseValue(childValue);
  });

  return sanitizedObject;
};

const parseDate = (date: unknown): Date | null => {
  if (!date) return null;
  try {
    if (date instanceof Date) return date;
    if (typeof date === "string") {
      const parsed = new Date(date);
      return isNaN(parsed.getTime()) ? null : parsed;
    }
    if (typeof date === "number") return new Date(date);
  } catch (error) {
    console.error("Error parsing date:", error);
  }
  return null;
};

const formatDate = (date: unknown): string => {
  const parsedDate = parseDate(date);
  return parsedDate
    ? parsedDate.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "N/A";
};

const getTrainingTimestamp = (
  record: Partial<TrainingRecord> | null | undefined,
): number => {
  if (!record) return 0;
  const parsed =
    parseDate(record.createdAt) ||
    parseDate(record.uploadedAtISO) ||
    parseDate(record.rawTimestamp) ||
    parseDate(record.generatedAt) ||
    parseDate(record.startDate);
  return parsed ? parsed.getTime() : 0;
};

const getRecordCreationDate = (
  record: Partial<TrainingRecord> | null | undefined,
): unknown => {
  if (!record) return "";
  return (
    record.createdAt ||
    record.uploadedAtISO ||
    record.rawTimestamp ||
    record.generatedAt ||
    record.startDate ||
    ""
  );
};

const sortTrainingByLatest = (records: TrainingRecord[]): TrainingRecord[] =>
  [...records].sort(
    (a, b) => getTrainingTimestamp(b) - getTrainingTimestamp(a),
  );

const formatDateForExcel = (date: unknown): string => {
  const parsedDate = parseDate(date);
  if (!parsedDate) return "";
  const month = String(parsedDate.getMonth() + 1).padStart(2, "0");
  const day = String(parsedDate.getDate()).padStart(2, "0");
  const year = parsedDate.getFullYear();
  return `${month}/${day}/${year}`;
};

const escapeCsvCell = (value: unknown): string => {
  const stringValue =
    value === null || value === undefined ? "" : String(value);
  return `"${stringValue.replace(/"/g, '""')}"`;
};

const getCurrentMonthDates = () => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const formatLocalDate = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return {
    startDate: formatLocalDate(startOfMonth),
    endDate: formatLocalDate(endOfMonth),
  };
};

const useDebounce = (value: string, delay: number) => {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
};

const getRecordPdfUrl = (record: TrainingRecord | null | undefined): string => {
  if (!record) return "";
  const source = record as unknown as Record<string, unknown>;
  return (
    getStringField(source, [
      "pdfUrl",
      "pdfURL",
      "validationDocumentPdfUrl",
      "validationDocumentPdfURL",
      "validationDocumentUrl",
      "validationDocumentURL",
      "documentPdfUrl",
      "documentPdfURL",
      "pdfDownloadUrl",
      "pdfDownloadURL",
      "pdfLink",
      "pdfLINK",
      "PDFLink",
      "PDF_Link",
      "PDF link",
      "PDF Link",
      "Pdf Link",
      "Pdf_Link",
      "pdf_link",
      "downloadUrl",
      "downloadURL",
      "url",
      "uri",
    ]) ||
    getNestedStringField(
      source,
      ["pdfFile", "validationDocument", "validationDocumentPdf", "document", "file"],
      ["url", "uri", "downloadUrl", "downloadURL", "pdfUrl", "pdfURL"],
    )
  );
};

const getRecordPdfName = (record: TrainingRecord | null | undefined): string => {
  if (!record) return "Validation document.pdf";
  const source = record as unknown as Record<string, unknown>;
  return (
    record.pdfFile?.name ||
    getNestedStringField(
      source,
      ["pdfFile", "validationDocument", "validationDocumentPdf", "document", "file"],
      ["name", "fileName", "filename"],
    ) ||
    "Validation document.pdf"
  );
};

const normalizeGeneratedDate = (
  raw: Record<string, unknown>,
  fallbackCreatedAt: unknown,
): string => {
  const uploadedAtISO = getStringField(raw, ["uploadedAtISO", "uploadedAt", "createdAt"]);
  if (uploadedAtISO) return uploadedAtISO;

  const generatedAt =
    typeof raw.generatedAt === "number"
      ? raw.generatedAt
      : typeof raw.generatedAt === "string"
        ? Number(raw.generatedAt)
        : NaN;

  if (Number.isFinite(generatedAt)) {
    return new Date(generatedAt).toISOString();
  }

  return typeof fallbackCreatedAt === "string" ? fallbackCreatedAt : "";
};

// ──────────────────────────────────────────────
// Normalisation: weekly capacity report -> flat
// ──────────────────────────────────────────────

/**
 * Takes a raw Firebase snapshot value and returns a normalised TrainingRecord.
 * Handles both:
 *  - Legacy flat training records (programme, topicTrained, ...)
 *  - Weekly capacity reports (recordType, entries[], pdfUrl, ...)
 */
const normalizeRecord = (
  id: string,
  raw: Record<string, unknown>,
): TrainingRecord => {
  const recordType = raw.recordType as string | undefined;

  if (
    recordType === "weeklyCapacityReport" &&
    Array.isArray(raw.entries) &&
    (raw.entries as unknown[]).length > 0
  ) {
    const entries = raw.entries as WeeklyReportEntry[];
    const first = entries[0];

    return {
      id,
      county: getStringField(raw, ["county", "County", "region", "Region"]) || (first.county as string) || "",
      subcounty: getStringField(raw, ["subcounty", "subCounty", "Subcounty", "Sub County"]) || (first.subcounty as string) || "",
      location: getStringField(raw, ["ward", "Ward", "location", "Location", "village", "Village"]) || (first.location as string) || "",
      topicTrained: getStringField(raw, ["topicTrained", "topic", "topicDiscussed", "Modules"]) || (first.topicDiscussed as string) || "",
      totalFarmers: Number(first.totalFarmers) || Number(raw.totalFarmers) || 0,
      startDate: getStringField(raw, ["startDate", "startDateISO"]) || (first.startDateISO as string) || (first.startDateLabel as string) || "",
      endDate: getStringField(raw, ["endDate", "endDateISO"]) || (first.endDateISO as string) || (first.endDateLabel as string) || "",
      fieldOfficer: (raw.fieldOfficer as string) || (first.fieldOfficer as string) || "",
      username: (raw.fieldOfficer as string) || (first.fieldOfficer as string) || "",
      createdAt: normalizeGeneratedDate(raw, first.createdAt),
      rawTimestamp: Number(raw.generatedAt) || 0,

      recordType,
      reportId: (raw.reportId as string) || "",
      entries,
      pdfUrl:
        getStringField(raw, [
          "pdfUrl",
          "pdfURL",
          "pdfLink",
          "pdfLINK",
          "PDFLink",
          "PDF_Link",
          "PDF link",
          "PDF Link",
          "Pdf Link",
          "Pdf_Link",
          "pdf_link",
          "downloadUrl",
          "downloadURL",
          "url",
        ]) ||
        getNestedStringField(
          raw,
          ["pdfFile", "validationDocument", "validationDocumentPdf", "document", "file"],
          ["url", "uri", "downloadUrl", "downloadURL", "pdfUrl", "pdfURL"],
        ),
      validationDocumentPdfUrl: getStringField(raw, [
        "validationDocumentPdfUrl",
        "validationDocumentPdfURL",
      ]),
      validationDocumentUrl: getStringField(raw, [
        "validationDocumentUrl",
        "validationDocumentURL",
      ]),
      documentPdfUrl: getStringField(raw, ["documentPdfUrl", "documentPdfURL"]),
      pdfDownloadUrl: getStringField(raw, ["pdfDownloadUrl", "pdfDownloadURL"]),
      pdfFile: (raw.pdfFile as PdfFileInfo) || null,
      generatedAt: Number(raw.generatedAt) || 0,
      uploadedAtISO: getStringField(raw, ["uploadedAtISO", "uploadedAt"]),

      // FIX: Also check for "Programme" (legacy capital-P field) on weekly reports
      programme: (raw.programme as string) || (raw.Programme as string) || "",
    };
  }

  // Flat / legacy record – spread as-is
  return {
    id,
    ...(raw as Omit<TrainingRecord, "id">),
  } as TrainingRecord;
};

// ──────────────────────────────────────────────────────────────────────────────
// FIX: StatsCard moved OUTSIDE CapacityBuildingPage to prevent re-creation
// on every render. Previously defined inline, causing unnecessary re-renders.
// ──────────────────────────────────────────────────────────────────────────────
const StatsCard = ({
  title,
  value,
  icon: Icon,
  description,
}: {
  title: string;
  value: string | number;
  icon: React.ElementType;
  description?: string;
  children?: React.ReactNode;
}) => (
  <Card className="bg-white text-slate-900 shadow-lg border border-gray-200 relative overflow-hidden">
    <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-blue-500 to-purple-600" />
    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 pt-4 pl-6">
      <CardTitle className="text-sm font-medium text-gray-500">
        {title}
      </CardTitle>
    </CardHeader>
    <CardContent className="pl-6 pb-4 flex flex-row">
      <div className="mr-2 rounded-full">
        <Icon className="h-8 w-8 text-blue-600" />
      </div>
      <div>
        <div className="text-2xl font-bold text-slate-900 mb-2">{value}</div>
        {description && (
          <p className="text-xs text-slate-600 mt-2 bg-slate-50 px-2 py-1 rounded border border-slate-100">
            {description}
          </p>
        )}
      </div>
    </CardContent>
  </Card>
);

// ──────────────────────────────────────────────
// Main Component
// ──────────────────────────────────────────────

const CapacityBuildingPage = () => {
  const { user, userRole, userAttribute, allowedProgrammes } = useAuth();
  const { toast } = useToast();

  // ── FIX: Stable toast ref to avoid stale closures in useEffect ──
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // ── FIX: Refs for memory-leak-safe cleanup ──
  const unsubscribeRef = useRef<Unsubscribe | null>(null);
  const mountedRef = useRef(true);

  // ── FIX: Refs for two-query merge strategy ──
  // Tracks records from both "programme" and "Programme" (legacy) queries,
  // merging them into a single deduplicated set.
  const mergedRecordsRef = useRef<Map<string, TrainingRecord>>(new Map());
  const q1IdsRef = useRef<Set<string>>(new Set());
  const q2IdsRef = useRef<Set<string>>(new Set());

  // ── FIX: Retry state for error recovery ──
  const [retryTrigger, setRetryTrigger] = useState(0);
  const retryCountRef = useRef(0);
  const MAX_RETRIES = 3;

  // ── FIX: Error state for meaningful per-programme error display ──
  const [fetchError, setFetchError] = useState<string | null>(null);

  // ── State ──
  const [allRecords, setAllRecords] = useState<TrainingRecord[]>([]);

  // NOTE: filteredRecords is now derived via useMemo (see below), no longer useState
  // NOTE: stats is now derived via useMemo (see below), no longer useState

  const [loading, setLoading] = useState(true);
  const [exportLoading, setExportLoading] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // UI State
  const [selectedRecords, setSelectedRecords] = useState<string[]>([]);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isPdfDialogOpen, setIsPdfDialogOpen] = useState(false);

  const [viewingRecord, setViewingRecord] = useState<TrainingRecord | null>(null);
  const [editingRecord, setEditingRecord] = useState<TrainingRecord | null>(null);
  const [pdfRecord, setPdfRecord] = useState<TrainingRecord | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);

  // FIX: Simplified pagination — only page number is state; rest is derived via useMemo
  const [page, setPage] = useState(1);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const userIsAdmin = useMemo(
    () => isAdmin(userRole),
    [userRole],
  );
  const userCanViewAllProgrammeData = useMemo(
    () =>
      canViewAllProgrammes(userRole, userAttribute, allowedProgrammes),
    [allowedProgrammes, userRole, userAttribute],
  );
  const accessibleProgrammes = useMemo(
    () => resolveAccessibleProgrammes(userCanViewAllProgrammeData, allowedProgrammes),
    [allowedProgrammes, userCanViewAllProgrammeData],
  );

  // ── FIX TS 2345 ──
  const sharedSelection = useSharedProgrammeSelection(accessibleProgrammes);
  const activeProgram: string = String(sharedSelection[0] ?? "");
  const setActiveProgram = sharedSelection[1];

  const availablePrograms = accessibleProgrammes;

  const requireAdmin = useCallback(() => {
    if (userIsAdmin) return true;
    toastRef.current({
      title: "Access denied",
      description:
        "Only Admin can create, edit, or delete records on this page.",
      variant: "destructive",
    });
    return false;
  }, [userIsAdmin]);

  const trainingCacheKey = useMemo(
    () => cacheKey("admin-page", "capacity-building", activeProgram),
    [activeProgram],
  );
  const currentMonth = useMemo(getCurrentMonthDates, []);

  const [searchValue, setSearchValue] = useState("");
  const debouncedSearch = useDebounce(searchValue, 300);

  const [filters, setFilters] = useState<Filters>({
    search: "",
    startDate: currentMonth.startDate,
    endDate: currentMonth.endDate,
    modules: "all",
    region: "all",
  });

  const [editForm, setEditForm] = useState<EditForm>({
    Name: "",
    topicTrained: "",
    county: "",
    subcounty: "",
    startDate: "",
    endDate: "",
    totalFarmers: 0,
    programme: "",
    numberOfTrainers: 0,
    numberOfSubCounties: 0,
  });

  // ────────────────────────────────────────────────────────────────────
  // FIX [CRITICAL]: Data Fetching — DB-level programme filtering
  // ────────────────────────────────────────────────────────────────────
  // PREVIOUS: Fetched the ENTIRE capacityBuilding collection with
  //   const dbRef = ref(db, "capacityBuilding");
  //   onValue(dbRef, ...)  ← no filter, loads ALL records
  //
  // NOW: Two parallel Firebase queries filter at the database level:
  //   Query 1: orderByChild("programme").equalTo(activeProgram)
  //   Query 2: orderByChild("Programme").equalTo(activeProgram)  (legacy field)
  //
  // Results are merged and deduplicated by record ID.
  // When programme changes: old listener unsubscribed → records cleared →
  // loading state shown → new queries fire → results displayed.
  //
  // NOTE: Firebase Realtime Database requires .indexOn rules for these
  // queries to be efficient. Add to your database rules:
  //   { "rules": { "capacityBuilding": { ".indexOn": ["programme", "Programme"] } } }
  //
  // NOTE: Weekly capacity reports that have neither "programme" nor "Programme"
  // field will NOT appear in filtered results. Ensure all weekly reports have
  // the programme field set at creation/upload time.
  // ────────────────────────────────────────────────────────────────────

  useEffect(() => {
    // Track component mount status to prevent state updates after unmount
    mountedRef.current = true;

    // Reset merge tracking refs
    mergedRecordsRef.current.clear();
    q1IdsRef.current.clear();
    q2IdsRef.current.clear();

    // ── Cleanup previous listener before setting up new one ──
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }

    // Handle empty programme gracefully
    if (!activeProgram) {
      setAllRecords([]);
      setLoading(false);
      setFetchError(null);
      return;
    }

    // ── Clear records immediately for responsive UI ──
    setAllRecords([]);
    setLoading(true);
    setFetchError(null);
    retryCountRef.current = 0;

    // ── Check cache for instant display ──
    const cached = readCachedValue<TrainingRecord[]>(trainingCacheKey);
    const hasCache = !!cached;

    if (hasCache && cached) {
      setAllRecords(sortTrainingByLatest(cached));
      setLoading(false);
    }

    // ── Set up the DB-level filtered queries ──
    const dbRef = ref(db, "capacityBuilding");

    // Track how many of the 2 queries have completed their initial load
    let initialLoadCount = 0;
    const TOTAL_QUERIES = 2;

    const trySetLoadingDone = () => {
      initialLoadCount++;
      if (!hasCache && initialLoadCount >= TOTAL_QUERIES && mountedRef.current) {
        setLoading(false);
      }
    };

    const handleQueryError = (queryLabel: string) => (error: Error) => {
      console.error(`Error fetching data (${queryLabel}):`, error);

      if (!mountedRef.current) return;

      // FIX: Retry logic with exponential backoff
      if (retryCountRef.current < MAX_RETRIES) {
        retryCountRef.current++;
        const delay = Math.pow(2, retryCountRef.current) * 1000; // 2s, 4s, 8s
        console.warn(`Retrying ${queryLabel} query in ${delay}ms (attempt ${retryCountRef.current}/${MAX_RETRIES})`);
        // Re-trigger the effect by bumping retryTrigger
        setTimeout(() => {
          if (mountedRef.current) {
            setRetryTrigger((prev) => prev + 1);
          }
        }, delay);
      } else {
        setFetchError(`Failed to load ${activeProgram} training records after ${MAX_RETRIES} attempts. Please check your connection and try again.`);
        setLoading(false);
        toastRef.current({
          title: "Error",
          description: `Failed to load ${activeProgram} training records.`,
          variant: "destructive",
        });
      }
    };

    // ── Query 1: Filter by "programme" field (lowercase, primary) ──
    const q1 = query(dbRef, orderByChild("programme"), equalTo(activeProgram));

    const unsub1 = onValue(
      q1,
      (snapshot) => {
        if (!mountedRef.current) return;

        const data = snapshot.val();
        const newQ1Ids = new Set<string>();

        if (data && typeof data === "object") {
          Object.keys(data).forEach((key) => {
            newQ1Ids.add(key);
            mergedRecordsRef.current.set(
              key,
              normalizeRecord(key, data[key] as Record<string, unknown>),
            );
          });
        }

        // Remove old q1 records that are no longer in the result
        // (but keep if they're from q2 / legacy query)
        for (const oldId of q1IdsRef.current) {
          if (!newQ1Ids.has(oldId) && !q2IdsRef.current.has(oldId)) {
            mergedRecordsRef.current.delete(oldId);
          }
        }
        q1IdsRef.current = newQ1Ids;

        // Update state from merged results
        const records = Array.from(mergedRecordsRef.current.values());
        const sorted = sortTrainingByLatest(records);
        setAllRecords(sorted);
        writeCachedValue(trainingCacheKey, sorted);

        trySetLoadingDone();
      },
      handleQueryError("programme"),
    );

    // ── Query 2: Filter by "Programme" field (capital P, legacy) ──
    const q2 = query(dbRef, orderByChild("Programme"), equalTo(activeProgram));

    const unsub2 = onValue(
      q2,
      (snapshot) => {
        if (!mountedRef.current) return;

        const data = snapshot.val();
        const newQ2Ids = new Set<string>();

        if (data && typeof data === "object") {
          Object.keys(data).forEach((key) => {
            newQ2Ids.add(key);
            // Only add if not already present from q1 (avoid overwriting)
            if (!mergedRecordsRef.current.has(key)) {
              mergedRecordsRef.current.set(
                key,
                normalizeRecord(key, data[key] as Record<string, unknown>),
              );
            }
          });
        }

        // Remove old q2 records that are no longer in the result
        // (but keep if they're from q1 / primary query)
        for (const oldId of q2IdsRef.current) {
          if (!newQ2Ids.has(oldId) && !q1IdsRef.current.has(oldId)) {
            mergedRecordsRef.current.delete(oldId);
          }
        }
        q2IdsRef.current = newQ2Ids;

        // Update state from merged results
        const records = Array.from(mergedRecordsRef.current.values());
        const sorted = sortTrainingByLatest(records);
        setAllRecords(sorted);
        writeCachedValue(trainingCacheKey, sorted);

        trySetLoadingDone();
      },
      handleQueryError("Programme"),
    );

    // Store combined unsubscribe function
    unsubscribeRef.current = () => {
      unsub1();
      unsub2();
    };

    return () => {
      mountedRef.current = false;
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, [activeProgram, trainingCacheKey, retryTrigger]);

  // ────────────────────────────────────────────────────────────────────
  // FIX: filteredRecords derived via useMemo (was useState + useEffect)
  // Since data is now pre-filtered at DB level by programme, the client-side
  // filter only needs to handle: search, date range, region, and module.
  // The redundant programme check has been removed.
  // ────────────────────────────────────────────────────────────────────
  const filteredRecords = useMemo(() => {
    if (allRecords.length === 0) return [];

    return sortTrainingByLatest(
      allRecords.filter((record) => {
        // FIX: Programme check removed — data is already filtered at DB level.
        // Keeping this as a safety net for edge cases (e.g., cached data
        // from before the fix, or records that appear via legacy field only).
        // This is a no-op in the common case since the DB query handles it.
        const recProg = normalizeProgramme(record.programme || record.Programme);
        const targetProg = normalizeProgramme(activeProgram);
        if (recProg && targetProg && recProg !== targetProg) return false;

        // ── Region / county filter ──
        const recordRegion = record.county || record.region;
        if (
          filters.region !== "all" &&
          recordRegion?.toLowerCase() !== filters.region.toLowerCase()
        ) {
          return false;
        }

        // ── Module / topic filter ──
        const recordModules = record.topicTrained || record.Modules;
        if (
          filters.modules !== "all" &&
          recordModules?.toLowerCase() !== filters.modules.toLowerCase()
        ) {
          return false;
        }

        // ── Date range filter ──
        const recordDate = parseDate(getRecordCreationDate(record));

        if (filters.startDate || filters.endDate) {
          if (recordDate) {
            const recordDateOnly = new Date(recordDate);
            recordDateOnly.setHours(0, 0, 0, 0);

            const startDate = filters.startDate
              ? new Date(filters.startDate)
              : null;
            const endDate = filters.endDate ? new Date(filters.endDate) : null;
            if (startDate) startDate.setHours(0, 0, 0, 0);
            if (endDate) endDate.setHours(23, 59, 59, 999);

            if (startDate && recordDateOnly < startDate) return false;
            if (endDate && recordDateOnly > endDate) return false;
          } else {
            return false;
          }
        }

        // ── Search filter ──
        if (debouncedSearch) {
          const lowerTerm = debouncedSearch.toLowerCase();
          const searchable = [
            record.topicTrained,
            record.county,
            record.subcounty,
            record.fieldOfficer,
            record.username,
            record.location,
            record.reportId,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

          if (!searchable.includes(lowerTerm)) return false;
        }

        return true;
      }),
    );
  }, [allRecords, filters, debouncedSearch, activeProgram]);

  // ────────────────────────────────────────────────────────────────────
  // FIX: Stats derived via useMemo (was useState + useEffect)
  // Previously calculated inside a filter useEffect causing double renders.
  // Now derived directly from filteredRecords with no state overhead.
  // ────────────────────────────────────────────────────────────────────
  const stats = useMemo((): Stats => {
    if (filteredRecords.length === 0) {
      return { totalParticipants: 0, totalTrainers: 0, totalSubCounties: 0 };
    }

    const totalParticipants = filteredRecords.reduce(
      (sum, r) => sum + (Number(r.totalFarmers) || 0),
      0,
    );

    const totalTrainers = new Set(
      filteredRecords
        .map((r) => r.fieldOfficer || r.username)
        .filter(Boolean),
    ).size;

    const totalSubCounties = new Set(
      filteredRecords.map((r) => r.subcounty).filter(Boolean),
    ).size;

    return { totalParticipants, totalTrainers, totalSubCounties };
  }, [filteredRecords]);

  // ────────────────────────────────────────────────────────────────────
  // FIX: Pagination derived with useMemo (was full object in useState)
  // totalPages, hasNext, hasPrev are now computed, not stored in state.
  // ────────────────────────────────────────────────────────────────────
  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(filteredRecords.length / PAGE_LIMIT)),
    [filteredRecords.length],
  );

  const pagination = useMemo(() => {
    const safePage = Math.min(page, totalPages);
    return {
      page: safePage,
      limit: PAGE_LIMIT,
      totalPages,
      hasNext: safePage < totalPages,
      hasPrev: safePage > 1,
    };
  }, [page, totalPages]);

  // ────────────────────────────────────────────────────────────────────
  // FIX: currentPageRecords with correct useMemo pattern
  // Previously broken: useMemo(getCurrentPageRecords, [...]) — passed the
  // function reference directly instead of a factory function.
  // ────────────────────────────────────────────────────────────────────
  const currentPageRecords = useMemo(() => {
    const start = (pagination.page - 1) * pagination.limit;
    return filteredRecords.slice(start, start + pagination.limit);
  }, [filteredRecords, pagination.page, pagination.limit]);

  // ────────────────────────────────────────────
  // FIX: Handlers wrapped in useCallback
  // Prevents re-creation on every render.
  // ────────────────────────────────────────────

  const handleProgramChange = useCallback((program: string) => {
    setActiveProgram(program);
    setFilters({
      search: "",
      startDate: currentMonth.startDate,
      endDate: currentMonth.endDate,
      modules: "all",
      region: "all",
    });
    // FIX: Reset to page 1 when programme changes
    setPage(1);
    setSelectedRecords([]);
    setFetchError(null);
  }, [setActiveProgram, currentMonth.startDate, currentMonth.endDate]);

  const handleSearch = useCallback((value: string) => {
    setSearchValue(value);
    // FIX: Reset to page 1 when search changes
    setPage(1);
  }, []);

  const getSelectedProgramme = useCallback(() => {
    const selectedProgramme = normalizeProgramme(activeProgram);
    if (!selectedProgramme) {
      toastRef.current({
        title: "Programme required",
        description: "Select a valid programme before saving capacity building data.",
        variant: "destructive",
      });
      return "";
    }
    return selectedProgramme;
  }, [activeProgram]);

  const handleFilterChange = useCallback((key: keyof Filters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    // FIX: Reset to page 1 when any filter changes
    setPage(1);
  }, []);

  const handleSelectRecord = useCallback((id: string) => {
    setSelectedRecords((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id],
    );
  }, []);

  // FIX: handleSelectAll now uses currentPageRecords from useMemo instead
  // of calling a function reference
  const handleSelectAll = useCallback(() => {
    const currentPageIds = currentPageRecords.map((r) => r.id);
    setSelectedRecords((prev) =>
      prev.length === currentPageIds.length && currentPageIds.length > 0
        ? []
        : currentPageIds,
    );
  }, [currentPageRecords]);

  const handlePageChange = useCallback(
    (newPage: number) => {
      const safePage = Math.max(1, Math.min(newPage, totalPages));
      setPage(safePage);
    },
    [totalPages],
  );

  const openViewDialog = useCallback((record: TrainingRecord) => {
    setViewingRecord(record);
    setIsViewDialogOpen(true);
  }, []);

  const openPdfDialog = useCallback((record: TrainingRecord) => {
    if (!getRecordPdfUrl(record)) {
      toastRef.current({
        title: "No PDF",
        description: "This record does not have an associated validation document PDF.",
        variant: "destructive",
      });
      return;
    }
    setPdfRecord(record);
    setIsPdfDialogOpen(true);
  }, []);

  const handleDownloadPdf = useCallback(
    (record: TrainingRecord | null = null) => {
      const targetRecord = record || pdfRecord;
      const pdfUrl = getRecordPdfUrl(targetRecord);
      if (!pdfUrl) {
        toastRef.current({
          title: "No PDF",
          description: "This record does not have an associated validation document PDF.",
          variant: "destructive",
        });
        return;
      }
      window.open(pdfUrl, "_blank", "noopener,noreferrer");
    },
    [pdfRecord],
  );

  const openEditDialog = useCallback(
    (record: TrainingRecord) => {
      if (!userIsAdmin) return;
      setEditingRecord(record);
      setEditForm({
        Name: record.username || record.Name || "",
        topicTrained: record.topicTrained || record.Modules || "",
        county: record.county || record.region || "",
        subcounty: record.subcounty || record.location || "",
        startDate: record.startDate || "",
        endDate: record.endDate || "",
        totalFarmers: record.totalFarmers || 0,
        programme: record.programme || activeProgram,
        numberOfTrainers: record.numberOfTrainers || 0,
        numberOfSubCounties: record.numberOfSubCounties || 0,
      });
      setIsEditDialogOpen(true);
    },
    [userIsAdmin, activeProgram],
  );

  const handleEditSubmit = useCallback(async () => {
    if (!requireAdmin()) return;
    if (!editingRecord) return;
    const selectedProgramme =
      normalizeProgramme(editForm.programme) || getSelectedProgramme();
    if (!selectedProgramme) return;
    try {
      await update(ref(db, `capacityBuilding/${editingRecord.id}`), {
        username: editForm.Name,
        topicTrained: editForm.topicTrained,
        county: editForm.county,
        subcounty: editForm.subcounty,
        startDate: editForm.startDate,
        endDate: editForm.endDate,
        totalFarmers: Number(editForm.totalFarmers),
        programme: selectedProgramme,
        Programme: selectedProgramme,
        numberOfTrainers: Number(editForm.numberOfTrainers),
        numberOfSubCounties: Number(editForm.numberOfSubCounties),
      });

      toastRef.current({ title: "Success", description: "Record updated." });
      removeCachedValue(trainingCacheKey);
      setIsEditDialogOpen(false);
      setEditingRecord(null);
    } catch (error) {
      console.error(error);
      toastRef.current({
        title: "Error",
        description: "Failed to update.",
        variant: "destructive",
      });
    }
  }, [requireAdmin, editingRecord, editForm, getSelectedProgramme, trainingCacheKey]);

  const openDeleteConfirm = useCallback(() => {
    if (!requireAdmin()) return;
    if (selectedRecords.length === 0) {
      toastRef.current({
        title: "Warning",
        description: "No records selected",
        variant: "destructive",
      });
      return;
    }
    setIsDeleteConfirmOpen(true);
  }, [requireAdmin, selectedRecords.length]);

  const handleDeleteMultiple = useCallback(async () => {
    if (!requireAdmin()) return;
    try {
      setDeleteLoading(true);
      const updates: { [key: string]: null } = {};
      selectedRecords.forEach(
        (id) => (updates[`capacityBuilding/${id}`] = null),
      );

      await update(ref(db), updates);

      toastRef.current({
        title: "Success",
        description: `Deleted ${selectedRecords.length} records.`,
      });
      removeCachedValue(trainingCacheKey);
      setSelectedRecords([]);
      setIsDeleteConfirmOpen(false);
    } catch (error) {
      console.error(error);
      toastRef.current({
        title: "Error",
        description: "Failed to delete.",
        variant: "destructive",
      });
    } finally {
      setDeleteLoading(false);
    }
  }, [requireAdmin, selectedRecords, trainingCacheKey]);

  const handleDeleteSingle = useCallback(
    async (id: string) => {
      if (!requireAdmin()) return;
      try {
        await remove(ref(db, `capacityBuilding/${id}`));
        toastRef.current({ title: "Success", description: "Record deleted." });
        removeCachedValue(trainingCacheKey);
      } catch (error) {
        console.error(error);
        toastRef.current({
          title: "Error",
          description: "Failed to delete.",
          variant: "destructive",
        });
      }
    },
    [requireAdmin, trainingCacheKey],
  );

  // ── FIX: Handle retry from error state ──
  const handleRetry = useCallback(() => {
    setFetchError(null);
    retryCountRef.current = 0;
    setRetryTrigger((prev) => prev + 1);
  }, []);

  // ── CSV parsing helpers ──

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

  const handleFileSelect = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) setUploadFile(e.target.files[0]);
  }, []);

  const handleUpload = useCallback(async () => {
    if (!requireAdmin()) return;
    if (!uploadFile) return;
    const selectedProgramme = getSelectedProgramme();
    if (!selectedProgramme) return;
    setUploadLoading(true);
    try {
      const text = await uploadFile.text();
      const isJSON = uploadFile.name.endsWith(".json");
      let parsedData: Record<string, unknown>[] = [];

      if (isJSON) {
        parsedData = JSON.parse(text) as Record<string, unknown>[];
      } else {
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        if (lines.length < 2)
          throw new Error("CSV file is empty or has no data rows");

        const rawHeaders = parseCSVLine(lines[0]);
        const headers = rawHeaders.map((h) => h.trim());
        const cleanHeaders = headers.map((h) =>
          h
            .replace(/^\uFEFF/, "")
            .trim()
            .toLowerCase()
            .replace(/\(.*?\)/g, "")
            .replace(/[^a-z0-9 ]/g, "")
            .replace(/\s+/g, " "),
        );

        const findIndex = (keys: string[]) =>
          cleanHeaders.findIndex((h) => keys.some((k) => h.includes(k)));

        const idxCreated = findIndex([
          "date created",
          "created at",
          "created",
          "upload date",
          "uploaded",
        ]);
        const idxTopic = findIndex([
          "topic trained",
          "topic",
          "module",
          "modules",
          "training",
        ]);
        const idxCounty = findIndex(["county", "region"]);
        const idxSub = findIndex([
          "subcounty",
          "sub county",
          "location",
          "ward",
        ]);
        const idxStart = findIndex(["start date", "start"]);
        const idxEnd = findIndex(["end date", "end"]);
        const idxTotal = findIndex([
          "total farmers",
          "farmers",
          "participants",
          "number of farmers",
          "no of farmers",
        ]);
        const idxOfficer = findIndex([
          "field officer",
          "trainer",
          "facilitator",
          "officer",
          "username",
        ]);

        const valAt = (values: string[], idx: number) =>
          idx >= 0 && idx < values.length ? values[idx].trim() : "";

        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i]);
          if (!values.some((v) => v.trim() !== "")) continue;

          const obj: Record<string, unknown> = {};

          headers.forEach((h, idx) => {
            obj[sanitizeFirebaseKey(h, `field_${idx + 1}`)] =
              values[idx] !== undefined ? values[idx].trim() : "";
          });

          if (idxTopic !== -1) obj.topicTrained = valAt(values, idxTopic);
          if (idxCreated !== -1) obj.createdAt = valAt(values, idxCreated);
          if (idxCounty !== -1) obj.county = valAt(values, idxCounty);
          if (idxSub !== -1) obj.subcounty = valAt(values, idxSub);
          if (idxStart !== -1) obj.startDate = valAt(values, idxStart);
          if (idxEnd !== -1) obj.endDate = valAt(values, idxEnd);
          if (idxTotal !== -1)
            obj.totalFarmers = Number(valAt(values, idxTotal)) || 0;
          if (idxOfficer !== -1)
            obj.fieldOfficer = valAt(values, idxOfficer);

          parsedData.push(obj);
        }
      }

      let count = 0;
      const collectionRef = ref(db, "capacityBuilding");

      for (const item of parsedData) {
        const safeItem = sanitizeFirebaseValue(item) as Record<string, unknown>;
        const createdDate = parseDate(safeItem.createdAt) || new Date();
        await push(collectionRef, {
          ...safeItem,
          programme: selectedProgramme,
          Programme: selectedProgramme,
          createdAt: createdDate.toISOString(),
          rawTimestamp: createdDate.getTime(),
        });
        count++;
      }

      toastRef.current({
        title: "Success",
        description: `Uploaded ${count} records to ${selectedProgramme}.`,
      });
      removeCachedValue(trainingCacheKey);
      setIsUploadDialogOpen(false);
      setUploadFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (error) {
      console.error(error);
      toastRef.current({
        title: "Error",
        description: "Invalid file format",
        variant: "destructive",
      });
    } finally {
      setUploadLoading(false);
    }
  }, [requireAdmin, uploadFile, getSelectedProgramme, trainingCacheKey]);

  // ── Export ──

  const handleExport = useCallback(async () => {
    try {
      setExportLoading(true);
      if (filteredRecords.length === 0) return;

      const csvData = filteredRecords.map((r) => [
        formatDateForExcel(r.createdAt || r.rawTimestamp || r.generatedAt),
        r.reportId || "N/A",
        r.topicTrained || r.Modules || "N/A",
        r.county || r.region || "N/A",
        r.subcounty || "N/A",
        r.location || "N/A",
        formatDateForExcel(r.startDate),
        formatDateForExcel(r.endDate),
        r.totalFarmers || 0,
        r.fieldOfficer || r.username || "N/A",
        r.programme || activeProgram || "N/A",
        getRecordPdfUrl(r) || "",
      ]);

      const dateColumns = new Set([0, 6, 7]);
      const csvContent = [
        EXPORT_HEADERS.map(escapeCsvCell).join(","),
        ...csvData.map((row) =>
          row
            .map((field, index) =>
              dateColumns.has(index)
                ? String(field ?? "")
                : escapeCsvCell(field),
            )
            .join(","),
        ),
      ].join("\n");

      const blob = new Blob([`\uFEFF${csvContent}`], {
        type: "text/csv;charset=utf-8;",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `capacity-building-${activeProgram}-${new Date().toISOString().split("T")[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      toastRef.current({
        title: "Error",
        description: "Export failed",
        variant: "destructive",
      });
    } finally {
      setExportLoading(false);
    }
  }, [filteredRecords, activeProgram]);

  // ── Derived values ──

  const uniqueRegions = useMemo(
    () => [
      ...new Set(
        allRecords.map((r) => r.county || r.region).filter(Boolean),
      ),
    ],
    [allRecords],
  );
  const uniqueModules = useMemo(
    () => [
      ...new Set(
        allRecords.map((r) => r.topicTrained || r.Modules).filter(Boolean),
      ),
    ],
    [allRecords],
  );

  // ────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* ─── Header ─── */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
            Capacity Building
          </h2>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="bg-blue-50 text-blue-700 border-blue-200 font-bold px-3 py-1 w-fit"
            >
              {activeProgram || "No Access"} PROGRAMME
            </Badge>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {selectedRecords.length > 0 && userIsAdmin && (
            <Button
              variant="destructive"
              size="sm"
              onClick={openDeleteConfirm}
              disabled={deleteLoading}
            >
              <Trash2 className="h-4 w-4 mr-2" /> Delete ({selectedRecords.length})
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setFilters({
                search: "",
                startDate: "",
                endDate: "",
                modules: "all",
                region: "all",
              });
              // FIX: Reset page when clearing filters
              setPage(1);
            }}
          >
            Clear Filters
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setFilters((prev) => ({ ...prev, ...currentMonth }));
              setPage(1);
            }}
          >
            This Month
          </Button>
          {availablePrograms.length > 1 && (
            <div className="flex justify-end">
              <Select
                value={activeProgram}
                onValueChange={handleProgramChange}
              >
                <SelectTrigger className="w-full sm:w-[200px] border-gray-300 focus:border-blue-500 bg-white">
                  <SelectValue placeholder="Select Programme" />
                </SelectTrigger>
                <SelectContent>
                  {availablePrograms.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {userIsAdmin && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsUploadDialogOpen(true)}
                className="border-green-300 text-green-700"
              >
                <Upload className="h-4 w-4 mr-2" /> Upload
              </Button>
              <Button
                onClick={handleExport}
                disabled={exportLoading || filteredRecords.length === 0}
                className="bg-gradient-to-r from-blue-800 to-purple-600 text-white"
              >
                <Download className="h-4 w-4 mr-2" /> Export ({filteredRecords.length})
              </Button>
            </>
          )}
        </div>
      </div>

      {/* ─── Stats Cards ─── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatsCard
          title="TOTAL PARTICIPANTS"
          value={formatNumber(stats.totalParticipants)}
          icon={Users}
          description="Total farmers trained"
        />
        <StatsCard
          title="TOTAL OFFICERS (TRAINERS)"
          value={formatNumber(stats.totalTrainers)}
          icon={User}
          description="Officers Involved"
        />
        <StatsCard
          title="AVERAGE ATTENDANCE"
          value={stats.totalParticipants > 0 && allRecords.length > 0 ? (stats.totalParticipants / allRecords.length).toFixed(1) : "0"}
          icon={Users}
          description="Average farmers per training session"
        />
      </div>

      {/* ─── Filters ─── */}
      <Card className="shadow-lg bg-white">
        <CardContent className="pt-6">
          <ScrollableFilterBar ariaLabel="Capacity building filters" contentClassName="sm:grid-cols-2 lg:grid-cols-3">
            <div className="w-[240px] shrink-0 space-y-2 sm:w-auto">
              <Label>Search</Label>
              <Input
                placeholder="Topic, county, officer, report ID..."
                value={searchValue}
                onChange={(e) => handleSearch(e.target.value)}
              />
            </div>
            <div className="w-[190px] shrink-0 space-y-2 sm:w-auto">
              <Label>County</Label>
              <Select
                value={filters.region}
                onValueChange={(v) => handleFilterChange("region", v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select County" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Counties</SelectItem>
                  {uniqueRegions.slice(0, 20).map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-[280px] shrink-0 space-y-2 sm:w-auto">
              <Label>Date Range</Label>
              <div className="flex gap-2">
                <Input
                  type="date"
                  value={filters.startDate}
                  onChange={(e) =>
                    handleFilterChange("startDate", e.target.value)
                  }
                  className="flex-1"
                />
                <Input
                  type="date"
                  value={filters.endDate}
                  onChange={(e) =>
                    handleFilterChange("endDate", e.target.value)
                  }
                  className="flex-1"
                />
              </div>
            </div>
          </ScrollableFilterBar>
        </CardContent>
      </Card>

      {/* ─── Data Table ─── */}
      <Card className="shadow-lg bg-white">
        <CardContent className="p-0">
          {/* FIX: Error state with retry option */}
          {fetchError ? (
            <div className="text-center py-12 px-4">
              <div className="text-red-500 mb-4">
                <FileText className="h-10 w-10 mx-auto mb-3 opacity-50" />
                <p className="text-sm font-medium text-red-700">{fetchError}</p>
              </div>
              <Button variant="outline" size="sm" onClick={handleRetry}>
                Retry
              </Button>
            </div>
          ) : loading ? (
            <div className="text-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" />
              <p className="text-sm text-muted-foreground mt-3">
                Loading {activeProgram} records...
              </p>
            </div>
          ) : currentPageRecords.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              {activeProgram
                ? "No records found for this programme"
                : "You do not have access to any programme data."}
            </div>
          ) : (
            <>
              <div className="w-full overflow-x-auto rounded-md">
                <table className="w-full border-collapse border border-gray-300 text-sm text-left whitespace-nowrap">
                  <thead>
                    <tr className="bg-blue-50 text-xs">
                      <th className="py-3 px-3">
                        <Checkbox
                          checked={
                            selectedRecords.length ===
                              currentPageRecords.length &&
                            currentPageRecords.length > 0
                          }
                          onCheckedChange={handleSelectAll}
                        />
                      </th>
                      <th className="py-3 px-3 font-semibold text-gray-700">
                        Date
                      </th>
                      <th className="py-3 px-3 font-semibold text-gray-700">
                        County
                      </th>
                      <th className="py-3 px-3 font-semibold text-gray-700">
                        Location
                      </th>
                      <th className="py-3 px-3 font-semibold text-gray-700">
                        Farmers
                      </th>
                      <th className="py-3 px-3 font-semibold text-gray-700">
                        Officer
                      </th>
                      <th className="py-3 px-3 font-semibold text-gray-700">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentPageRecords.map((record) => (
                      <tr
                        key={record.id}
                        className="border-b hover:bg-blue-50 transition-colors group"
                      >
                        <td className="py-2 px-3">
                          <Checkbox
                            checked={selectedRecords.includes(record.id)}
                            onCheckedChange={() =>
                              handleSelectRecord(record.id)
                            }
                          />
                        </td>
                        <td className="py-2 px-3 text-xs text-gray-500">
                          {formatDate(getRecordCreationDate(record))}
                        </td>
                        <td className="py-2 px-3 text-xs font-medium">
                          {record.county || record.region || "N/A"}
                        </td>
                        <td className="py-2 px-3 text-xs">
                          {record.subcounty || record.location || "N/A"}
                        </td>
                        <td className="py-2 px-3">
                          <Badge variant="outline" className="text-[10px]">
                            {record.totalFarmers || 0}
                          </Badge>
                        </td>
                        <td className="py-2 px-3 text-xs text-gray-600">
                          {record.fieldOfficer || record.username || "N/A"}
                        </td>
                        {/* ── Actions Dropdown ── */}
                        <td className="py-2 px-3">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8"
                              >
                                <MoreHorizontal className="h-4 w-4" />
                                <span className="sr-only">Actions</span>
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => openViewDialog(record)}
                              >
                                <Eye className="h-4 w-4 mr-2" />
                                View Details
                              </DropdownMenuItem>

                              {getRecordPdfUrl(record) && (
                                <DropdownMenuItem
                                  onClick={() => openPdfDialog(record)}
                                >
                                  <FileText className="h-4 w-4 mr-2" />
                                  View Validation Document PDF
                                </DropdownMenuItem>
                              )}

                              {getRecordPdfUrl(record) && (
                                <DropdownMenuItem
                                  onClick={() => handleDownloadPdf(record)}
                                >
                                  <Download className="h-4 w-4 mr-2" />
                                  Download Validation Document PDF
                                </DropdownMenuItem>
                              )}

                              {userIsAdmin && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    onClick={() => openEditDialog(record)}
                                  >
                                    <Edit className="h-4 w-4 mr-2" />
                                    Edit
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    className="text-red-600 focus:text-red-600"
                                    onClick={() =>
                                      handleDeleteSingle(record.id)
                                    }
                                  >
                                    <Trash2 className="h-4 w-4 mr-2" />
                                    Delete
                                  </DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex flex-col sm:flex-row items-center justify-between p-4 border-t bg-gray-50 gap-4">
                <span className="text-sm text-muted-foreground">
                  {filteredRecords.length} total records &bull; Page{" "}
                  {pagination.page} of {pagination.totalPages}
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!pagination.hasPrev}
                    onClick={() =>
                      handlePageChange(pagination.page - 1)
                    }
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!pagination.hasNext}
                    onClick={() =>
                      handlePageChange(pagination.page + 1)
                    }
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ────────────────────────────────────────────────────── */}
      {/* VIEW DIALOG                                               */}
      {/* ────────────────────────────────────────────────────── */}
      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent className="sm:max-w-[600px] bg-white rounded-2xl border-0 shadow-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex justify-between items-center">
              <span>Session Details</span>
              <div className="flex items-center gap-2">
                {viewingRecord?.recordType && (
                  <Badge
                    variant="secondary"
                    className="bg-amber-100 text-amber-800 text-xs font-semibold"
                  >
                    {viewingRecord.recordType === "weeklyCapacityReport"
                      ? "Weekly Report"
                      : viewingRecord.recordType}
                  </Badge>
                )}
                <Badge
                  variant="secondary"
                  className="bg-blue-100 text-blue-800 text-xs font-semibold px-2.5 py-0.5"
                >
                  {viewingRecord?.programme || activeProgram}
                </Badge>
              </div>
            </DialogTitle>
            <DialogDescription className="sr-only">
              View full training session details
            </DialogDescription>
          </DialogHeader>

          {viewingRecord && (
            <div className="grid gap-4 py-4">
              {/* Report ID (weekly reports) */}
              {viewingRecord.reportId && (
                <div className="border border-slate-200 rounded-xl bg-slate-50 p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <BookOpen className="h-3.5 w-3.5 text-blue-500" />
                    <Label className="text-xs text-slate-500 uppercase tracking-wide font-semibold">
                      Report ID
                    </Label>
                  </div>
                  <p className="text-sm font-mono font-semibold text-slate-800">
                    {viewingRecord.reportId}
                  </p>
                </div>
              )}

              {/* Topic / Module */}
              <div className="border border-indigo-100 rounded-xl bg-indigo-50/50 p-4">
                <div className="flex items-start gap-3">
                  <div className="rounded-full bg-indigo-100 p-2 mt-0.5">
                    <BookOpen className="h-4 w-4 text-indigo-600" />
                  </div>
                  <div className="flex-1">
                    <Label className="text-xs text-indigo-500 uppercase tracking-wide font-semibold">
                      Topic / Module
                    </Label>
                    <p className="text-base font-semibold text-slate-900 mt-1">
                      {viewingRecord.topicTrained ||
                        viewingRecord.Modules ||
                        "N/A"}
                    </p>
                  </div>
                </div>
              </div>

              {/* Location */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="border border-slate-200 rounded-xl bg-slate-50 p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <MapPin className="h-3.5 w-3.5 text-emerald-500" />
                    <Label className="text-xs text-slate-500 uppercase tracking-wide font-semibold">
                      County
                    </Label>
                  </div>
                  <p className="text-sm font-semibold text-slate-800">
                    {viewingRecord.county ||
                      viewingRecord.region ||
                      "N/A"}
                  </p>
                </div>
                <div className="border border-slate-200 rounded-xl bg-slate-50 p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <MapPin className="h-3.5 w-3.5 text-blue-500" />
                    <Label className="text-xs text-slate-500 uppercase tracking-wide font-semibold">
                      Subcounty
                    </Label>
                  </div>
                  <p className="text-sm font-semibold text-slate-800">
                    {viewingRecord.subcounty || "N/A"}
                  </p>
                </div>
              </div>
              {viewingRecord.location && (
                <div className="border border-slate-200 rounded-xl bg-slate-50 p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <MapPin className="h-3.5 w-3.5 text-amber-500" />
                    <Label className="text-xs text-slate-500 uppercase tracking-wide font-semibold">
                      Village
                    </Label>
                  </div>
                  <p className="text-sm font-semibold text-slate-800">
                    {viewingRecord.location}
                  </p>
                </div>
              )}

              {/* Dates */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="border border-slate-200 rounded-xl bg-slate-50 p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <Calendar className="h-3.5 w-3.5 text-blue-500" />
                    <Label className="text-xs text-slate-500 uppercase tracking-wide font-semibold">
                      Start Date
                    </Label>
                  </div>
                  <p className="text-sm font-semibold text-slate-800">
                    {viewingRecord.startDate ||
                      viewingRecord.entries?.[0]?.startDateLabel ||
                      "N/A"}
                  </p>
                </div>
                <div className="border border-slate-200 rounded-xl bg-slate-50 p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <Calendar className="h-3.5 w-3.5 text-purple-500" />
                    <Label className="text-xs text-slate-500 uppercase tracking-wide font-semibold">
                      End Date
                    </Label>
                  </div>
                  <p className="text-sm font-semibold text-slate-800">
                    {viewingRecord.endDate ||
                      viewingRecord.entries?.[0]?.endDateLabel ||
                      "N/A"}
                  </p>
                </div>
              </div>

              {/* Summary */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="border border-green-100 rounded-xl bg-green-50 p-4 text-center">
                  <Users className="h-5 w-5 text-green-500 mx-auto mb-1" />
                  <Label className="text-xs text-green-600 uppercase tracking-wide font-semibold">
                    Farmers Trained
                  </Label>
                  <p className="text-xl font-bold text-green-700 mt-1">
                    {formatNumber(viewingRecord.totalFarmers || 0)}
                  </p>
                </div>
                <div className="border border-blue-100 rounded-xl bg-blue-50 p-4 text-center">
                  <UserCircle className="h-5 w-5 text-blue-500 mx-auto mb-1" />
                  <Label className="text-xs text-blue-600 uppercase tracking-wide font-semibold">
                    Officer
                  </Label>
                  <p className="text-sm font-bold text-blue-700 mt-1">
                    {viewingRecord.fieldOfficer ||
                      viewingRecord.username ||
                      "N/A"}
                  </p>
                </div>
              </div>

              {/* Entries list (weekly reports) */}
              {viewingRecord.entries &&
                viewingRecord.entries.length > 0 && (
                  <div className="border border-slate-200 rounded-xl bg-slate-50 p-4">
                    <Label className="text-xs text-slate-500 uppercase tracking-wide font-semibold mb-2 block">
                      Report Entries ({viewingRecord.entries.length})
                    </Label>
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {viewingRecord.entries.map((entry, idx) => (
                        <div
                          key={entry.id || idx}
                          className="flex items-center justify-between text-xs bg-white rounded-lg border border-slate-100 px-3 py-2"
                        >
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-slate-800 truncate">
                              {entry.topicDiscussed || "Untitled entry"}
                            </p>
                            <p className="text-slate-500">
                              {entry.location || "No location"} &bull;{" "}
                              {entry.startDateLabel || entry.startDateISO || ""}
                              {" — "}
                              {entry.endDateLabel || entry.endDateISO || ""}
                            </p>
                          </div>
                          <Badge
                            variant="outline"
                            className="text-[10px] shrink-0 ml-2"
                          >
                            {entry.totalFarmers || 0} farmers
                          </Badge>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              {/* Meta */}
              <div className="border border-slate-100 rounded-lg bg-slate-50 p-3">
                <p className="text-xs text-slate-400">
                  Record created:{" "}
                  {formatDate(
                    viewingRecord.uploadedAtISO ||
                      viewingRecord.createdAt ||
                      viewingRecord.generatedAt ||
                      viewingRecord.rawTimestamp,
                  )}
                </p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ────────────────────────────────────────────────────── */}
      {/* PDF VIEWER DIALOG                                         */}
      {/* ────────────────────────────────────────────────────── */}
      <Dialog open={isPdfDialogOpen} onOpenChange={setIsPdfDialogOpen}>
        <DialogContent className="sm:max-w-[900px] bg-white rounded-2xl border-0 shadow-2xl h-[90vh] flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="rounded-full bg-red-100 p-2">
                  <FileText className="h-5 w-5 text-red-600" />
                </div>
                <div>
                  <span className="text-base font-bold">
                    Validation Document PDF
                  </span>
                  {pdfRecord?.reportId && (
                    <p className="text-xs text-slate-500 font-mono mt-0.5">
                      {pdfRecord.reportId}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {pdfRecord?.pdfFile?.name && (
                  <Badge
                    variant="secondary"
                    className="text-xs bg-slate-100 text-slate-700"
                  >
                    {pdfRecord.pdfFile.name}
                  </Badge>
                )}
                <Button
                  size="sm"
                  onClick={() => handleDownloadPdf()}
                  className="bg-red-600 hover:bg-red-700 text-white gap-1.5"
                >
                  <Download className="h-4 w-4" />
                  Download PDF
                </Button>
              </div>
            </DialogTitle>
            <DialogDescription className="sr-only">
              View and download the validation document PDF
            </DialogDescription>
          </DialogHeader>

          {/* Report meta bar */}
          {pdfRecord && (
            <div className="shrink-0 flex flex-wrap items-center gap-3 px-1 py-2 text-xs text-slate-600 border-b">
              <span className="flex items-center gap-1">
                <User className="h-3 w-3" />
                {pdfRecord.fieldOfficer || pdfRecord.username || "N/A"}
              </span>
              {pdfRecord.totalFarmers !== undefined && (
                <span className="flex items-center gap-1">
                  <Users className="h-3 w-3" />
                  {pdfRecord.totalFarmers} farmers
                </span>
              )}
              <span className="flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                Uploaded{" "}
                {formatDate(
                  pdfRecord.uploadedAtISO ||
                    pdfRecord.createdAt ||
                    pdfRecord.generatedAt,
                )}
              </span>
            </div>
          )}

          {/* PDF iframe */}
          <div className="flex-1 min-h-0 rounded-lg border border-slate-200 overflow-hidden bg-slate-50">
            {getRecordPdfUrl(pdfRecord) ? (
              <iframe
                src={getRecordPdfUrl(pdfRecord)}
                title={getRecordPdfName(pdfRecord)}
                className="w-full h-full border-0"
              />
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-slate-400">
                <FileText className="h-12 w-12 mb-2" />
                <p className="text-sm">No PDF available for this record.</p>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ────────────────────────────────────────────────────── */}
      {/* EDIT DIALOG                                               */}
      {/* ────────────────────────────────────────────────────── */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="sm:max-w-[550px] bg-white rounded-2xl border-0 shadow-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Session</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label>Officer Name</Label>
                <Input
                  value={editForm.Name}
                  onChange={(e) =>
                    setEditForm({ ...editForm, Name: e.target.value })
                  }
                />
              </div>
              <div>
                <Label>Topic</Label>
                <Input
                  value={editForm.topicTrained}
                  onChange={(e) =>
                    setEditForm({
                      ...editForm,
                      topicTrained: e.target.value,
                    })
                  }
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label>County</Label>
                <Input
                  value={editForm.county}
                  onChange={(e) =>
                    setEditForm({ ...editForm, county: e.target.value })
                  }
                />
              </div>
              <div>
                <Label>Subcounty</Label>
                <Input
                  value={editForm.subcounty}
                  onChange={(e) =>
                    setEditForm({ ...editForm, subcounty: e.target.value })
                  }
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label>Start Date</Label>
                <Input
                  type="date"
                  value={editForm.startDate}
                  onChange={(e) =>
                    setEditForm({ ...editForm, startDate: e.target.value })
                  }
                />
              </div>
              <div>
                <Label>End Date</Label>
                <Input
                  type="date"
                  value={editForm.endDate}
                  onChange={(e) =>
                    setEditForm({ ...editForm, endDate: e.target.value })
                  }
                />
              </div>
            </div>
            <div>
              <Label>Total Farmers</Label>
              <Input
                type="number"
                value={editForm.totalFarmers}
                onChange={(e) =>
                  setEditForm({
                    ...editForm,
                    totalFarmers: Number(e.target.value),
                  })
                }
              />
            </div>
            {userIsAdmin && (
              <div>
                <Label>Programme</Label>
                <Select
                  value={editForm.programme}
                  onValueChange={(val) =>
                    setEditForm({ ...editForm, programme: val })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availablePrograms.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsEditDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button onClick={handleEditSubmit}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ────────────────────────────────────────────────────── */}
      {/* UPLOAD DIALOG                                             */}
      {/* ────────────────────────────────────────────────────── */}
      <Dialog
        open={isUploadDialogOpen}
        onOpenChange={setIsUploadDialogOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload Data</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-gray-600 mb-2">
              Data will be assigned to the{" "}
              <strong>{activeProgram}</strong> programme.
            </p>
            <Input
              type="file"
              ref={fileInputRef}
              accept=".csv,.json"
              onChange={handleFileSelect}
            />
            {uploadFile && (
              <p className="mt-2 text-sm text-gray-600">
                {uploadFile.name}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsUploadDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleUpload}
              disabled={!uploadFile || uploadLoading}
            >
              Upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ────────────────────────────────────────────────────── */}
      {/* DELETE CONFIRM DIALOG                                     */}
      {/* ────────────────────────────────────────────────────── */}
      <Dialog
        open={isDeleteConfirmOpen}
        onOpenChange={setIsDeleteConfirmOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Deletion</DialogTitle>
          </DialogHeader>
          <p>
            Are you sure you want to delete {selectedRecords.length}{" "}
            records?
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsDeleteConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteMultiple}
              disabled={deleteLoading}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default CapacityBuildingPage;


