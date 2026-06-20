import { memo, type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState, startTransition, useDeferredValue } from "react";
import * as XLSX from "xlsx";
import { useAuth } from "@/contexts/AuthContext";
import { db, fetchCollection, fetchCollectionByProgramme, subscribeCollectionByProgramme, ref, remove, update, push, set } from "@/lib/firebase";
import { canViewAllProgrammes, isAdmin, isOfftakeOfficer, resolvePermissionPrincipal } from "@/contexts/authhelper";
import { cacheKey, readCachedValue, removeCachedValue, writeCachedValue } from "@/lib/data-cache";
import { useToast } from "@/hooks/use-toast";
import { matchesActiveProgramme, resolveAccessibleProgrammes } from "@/lib/programme-access";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollableFilterBar } from "@/components/ScrollableFilterBar";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ChevronDown,
  Eye,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  Save,
  ShoppingCart,
  Trash2,
  TrendingUp,
  Upload,
  Users,
  X,
} from "lucide-react";
import { useSharedProgrammeSelection } from "@/hooks/use-shared-programme-selection";

/* ------------------------------------------------------------------ */
/* Interfaces                                                          */
/* ------------------------------------------------------------------ */

interface OrderItem {
  id?: string;
  date?: string | number;
  goats?: number;
  location?: string;
  subcounty?: string;
  village?: string;
  county?: string;
  fieldOfficer?: string;
  fieldOfficerName?: string;
  officer?: string;
  officerName?: string;
  createdBy?: string;
  username?: string;
  word?: string;
}

interface PurchaseHistoryEntry {
  id?: string;
  date?: string | number;
  goats?: number;
  createdAt?: string | number;
  recordedBy?: string;
}

interface MobileAppDataItem extends OrderItem {
  word?: string;
}

interface OrderRecord {
  id: string;
  batchId?: string;
  fieldOfficer?: string;
  fieldOfficerName?: string;
  purchaseDate?: string | number;
  recordId?: string;
  completedAt?: string | number;
  county?: string;
  counties?: string[];
  createdAt?: string | number;
  createdBy?: string;
  date?: string | number;
  goats?: number;
  goatsBought?: number;
  location?: string;
  mobileAppdata?: MobileAppDataItem[] | Record<string, MobileAppDataItem>;
  offtakeTeamIds?: string[] | Record<string, string | boolean>;
  offtakeTeamMembers?: Partial<OfftakeTeamMember>[] | Record<string, Partial<OfftakeTeamMember>>;
  orderId?: string;
  officer?: string;
  officerName?: string;
  orders?: OrderItem[] | Record<string, OrderItem>;
  offtakeOrderId?: string;
  parentOrderId?: string;
  purchaseHistory?: PurchaseHistoryEntry[] | Record<string, PurchaseHistoryEntry>;
  programme?: string;
  requestId?: string;
  remainingGoats?: number;
  status?: string;
  subcounty?: string;
  targetGoats?: number;
  timestamp?: number;
  totalGoats?: number;
  targetOrderId?: string;
  username?: string;
  village?: string;
}

interface NormalizedOrderItem {
  id: string;
  date: string | number;
  goats: number;
  location: string;
  village: string;
  subcounty: string;
  officer: string;
  raw?: OrderItem;
}

interface NormalizedPurchaseHistoryEntry {
  id: string;
  date: string | number;
  goats: number;
  createdAt: string | number;
  recordedBy: string;
}

interface BatchOrderRow {
  batchId: string;
  orderCode: string;
  batchDate: string | number;
  createdAt: string | number;
  completedAt: string | number;
  targetGoats: number;
  totalGoats: number;
  recordedGoats: number;
  goatsBought: number;
  remainingGoats: number;
  status: string;
  county: string;
  subcounty: string;
  location: string;
  programme: string;
  username: string;
  sortTimestamp: number;
  isReadyForCompletion: boolean;
  items: NormalizedOrderItem[];
  purchaseEntries: NormalizedPurchaseHistoryEntry[];
  searchableText: string;
}

interface OrderSummaryItem {
  label: string;
  value?: string;
  badge?: string;
  sub?: string;
}

interface ParsedOrderCsvResult {
  items: NormalizedOrderItem[];
  skippedRows: number;
}

interface OfftakeTeamMember {
  id: string;
  name: string;
  phone: string;
  email: string;
  counties: string[];
  purchaseDate: string;
  subcounty: string;
}

type OrdersDialogMode = "view" | "edit";

interface Filters {
  search: string;
  startDate: string;
  endDate: string;
  status: string;
}

interface Pagination {
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

interface NewOrderForm {
  date: string;
  goats: string;
  counties: string[];
  programme: string;
  orderCode: string;
}

interface FieldOfficerRecord {
  id?: string;
  name?: string;
  userName?: string;
  username?: string;
  displayName?: string;
  email?: string;
  phoneNumber?: string;
  phone?: string;
  mobile?: string;
  telephone?: string;
  contact?: string;
  county?: string;
  subcounty?: string;
  role?: string;
  allowedProgrammes?: Record<string, boolean>;
  accessControl?: {
    customAttribute?: string;
    customAttributes?: Record<string, string>;
  };
}

interface FieldOfficerOption {
  id: string;
  name: string;
  phone: string;
  counties: string[];
  aliases: string[];
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const PAGE_LIMIT = 15;
const ORDERS_CACHE_TTL_MS = 5 * 60 * 1000;
const PROGRAMME_OPTIONS = ["KPMD", "RANGE", "KPMD 2"] as const;

/* ------------------------------------------------------------------ */
/* Pure utility functions (outside component)                          */
/* ------------------------------------------------------------------ */

const parseDate = (value: unknown): Date | null => {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

const formatDate = (value: unknown): string => {
  const date = parseDate(value);
  if (!date) return "N/A";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

const resolveOrderDate = (
  record: Pick<OrderRecord, "date" | "createdAt" | "timestamp"> | null | undefined,
  fallback: string | number = "",
): string | number => {
  if (!record) return fallback;
  return record.date || record.createdAt || record.timestamp || fallback;
};

const resolveLatestPurchaseDate = (
  record: Pick<OrderRecord, "purchaseDate" | "date" | "completedAt" | "createdAt" | "timestamp" | "purchaseHistory" | "id" | "goatsBought" | "username"> | null | undefined,
  fallback: string | number = "",
): string | number => {
  if (!record) return fallback;
  const purchaseEntries = getPurchaseHistoryEntries(record as OrderRecord);
  return purchaseEntries[0]?.date || getStoredPurchaseDate(record) || fallback;
};

const sortOrdersByLatest = (records: OrderRecord[]): OrderRecord[] =>
  [...records].sort((a, b) => {
    const aDate = parseDate(a.completedAt || a.createdAt || a.timestamp)?.getTime() || 0;
    const bDate = parseDate(b.completedAt || b.createdAt || b.timestamp)?.getTime() || 0;
    return bDate - aDate;
  });

const normalizeStatus = (value: string | undefined): string => {
  if (!value) return "pending";
  return value.toLowerCase();
};

const getStatusBadgeClass = (status: string): string => {
  if (status === "completed") return "bg-emerald-100 text-emerald-700 border-emerald-200";
  if (status === "pending") return "bg-amber-100 text-amber-700 border-amber-200";
  if (status === "in-progress") return "bg-blue-100 text-blue-700 border-blue-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
};

const getCurrentMonthDates = () => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const toInput = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return { startDate: toInput(startOfMonth), endDate: toInput(endOfMonth) };
};

const getCurrentYearDates = () => {
  const now = new Date();
  return {
    startDate: `${now.getFullYear()}-01-01`,
    endDate: `${now.getFullYear()}-12-31`,
  };
};

const toInputDate = (value: unknown): string => {
  const date = parseDate(value);
  if (!date) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

const getTodayInputDate = (): string => toInputDate(Date.now());

const getStoredPurchaseDate = (
  record: Pick<OrderRecord, "purchaseDate" | "date" | "completedAt" | "createdAt" | "timestamp"> | null | undefined,
): string | number => {
  if (!record) return "";
  return record.purchaseDate || record.completedAt || record.createdAt || record.timestamp || "";
};

const getStoredPurchaseHistoryEntries = (
  purchaseHistory: OrderRecord["purchaseHistory"],
): PurchaseHistoryEntry[] => {
  if (Array.isArray(purchaseHistory)) return purchaseHistory.filter(Boolean);
  if (purchaseHistory && typeof purchaseHistory === "object") {
    return Object.values(purchaseHistory).filter(Boolean);
  }
  return [];
};

const sortPurchaseHistoryEntries = <T extends { date: string | number; createdAt?: string | number }>(
  entries: T[],
): T[] =>
  [...entries].sort((left, right) => {
    const leftDate = parseDate(left.date)?.getTime() || parseDate(left.createdAt)?.getTime() || 0;
    const rightDate = parseDate(right.date)?.getTime() || parseDate(right.createdAt)?.getTime() || 0;
    return rightDate - leftDate;
  });

const getPurchaseHistoryEntries = (record: OrderRecord): NormalizedPurchaseHistoryEntry[] => {
  const explicitEntries = sortPurchaseHistoryEntries(
    getStoredPurchaseHistoryEntries(record.purchaseHistory)
      .map((entry, index) => ({
        id: entry.id || `${record.id}-purchase-${index + 1}`,
        date: entry.date || getStoredPurchaseDate(record) || resolveOrderDate(record),
        goats: Math.max(0, Number(entry.goats || 0)),
        createdAt: entry.createdAt || record.createdAt || "",
        recordedBy: typeof entry.recordedBy === "string" ? entry.recordedBy.trim() : "",
      }))
      .filter((entry) => entry.goats > 0),
  );

  if (explicitEntries.length > 0) return explicitEntries;

  const legacyGoatsBought = Math.max(0, Number(record.goatsBought || 0));
  if (legacyGoatsBought <= 0) return [];

  return [
    {
      id: `${record.id}-legacy-purchase`,
      date: getStoredPurchaseDate(record) || resolveOrderDate(record),
      goats: legacyGoatsBought,
      createdAt: record.createdAt || "",
      recordedBy: typeof record.username === "string" ? record.username.trim() : "",
    },
  ];
};

const generateCountyCode = (countyName: string): string => {
  if (!countyName) return "XX";
  const normalized = countyName
    .trim()
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "XX";

  const words = normalized.split(" ").filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`;
  }

  const word = words[0];
  if (word.length === 1) return `${word}X`;

  const first = word[0];
  const rest = word.slice(1);
  const vowels = new Set(["A", "E", "I", "O", "U"]);
  const next =
    vowels.has(first)
      ? rest[0] || "X"
      : rest.split("").find((char) => !vowels.has(char)) || rest[0] || "X";

  return `${first}${next}`;
};

const generateOrderCode = async (county: string, programme: string): Promise<string> => {
  const countyCode = generateCountyCode(county);
  const existingOrders = await fetchCollectionByProgramme<Record<string, unknown>>("orders", programme);
  let maxNumber = 0;

  if (existingOrders.length > 0) {
    existingOrders.forEach((record) => {
      const rec = record as Record<string, unknown>;
      const existingCode = String(rec?.orderId || "");
      if (existingCode.startsWith(countyCode)) {
        const match = existingCode.match(new RegExp(`^${countyCode}(\\d+)$`));
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxNumber) maxNumber = num;
        }
      }
    });
  }

  return `${countyCode}${String(maxNumber + 1).padStart(3, "0")}`;
};

const formatSelectedCounties = (counties: string[]): string =>
  counties.map((county) => county.trim()).filter(Boolean).join(", ");

const getDefaultOrderForm = (programme: string): NewOrderForm => ({
  date: toInputDate(new Date()),
  goats: "",
  counties: [],
  programme,
  orderCode: "",
});

const formatCompactNumber = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
};

const normalizeText = (value: unknown): string =>
  typeof value === "string"
    ? value.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ")
    : "";

const parseCSVLine = (line: string): string[] => {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        current += "\"";
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

const normalizeCsvHeader = (value: string): string =>
  normalizeText(value).replace(/[./]+/g, " ").replace(/\s+/g, " ").trim();

const findCsvHeaderIndex = (headers: string[], aliases: readonly string[]): number => {
  const aliasSet = new Set(aliases.map(normalizeCsvHeader));
  return headers.findIndex((header) => aliasSet.has(normalizeCsvHeader(header)));
};

const getCsvCell = (values: string[], index: number): string =>
  index >= 0 && index < values.length ? values[index].trim() : "";

const parseNumericCell = (value: string): number => {
  const parsed = Number(value.replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

const isValidDateParts = (year: number, month: number, day: number): boolean => {
  const date = new Date(year, month - 1, day);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
};

const parseAmbiguousDate = (value: string): Date | null => {
  const match = value.trim().match(/^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})$/);
  if (!match) return null;

  const [, first, second, third] = match;
  let year = 0;
  let month = 0;
  let day = 0;

  if (first.length === 4) {
    year = Number(first);
    month = Number(second);
    day = Number(third);
  } else {
    day = Number(first);
    month = Number(second);
    year = Number(third);
    if (year < 100) year += 2000;

    if (day <= 12 && month > 12) {
      [day, month] = [month, day];
    }
  }

  return isValidDateParts(year, month, day) ? new Date(year, month - 1, day) : null;
};

const excelSerialToDate = (serial: number): Date | null => {
  if (!Number.isFinite(serial)) return null;
  const utcTime = Date.UTC(1899, 11, 30) + Math.round(serial) * 24 * 60 * 60 * 1000;
  const date = new Date(utcTime);
  return Number.isNaN(date.getTime()) ? null : date;
};

const normalizeImportedDateValue = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (numeric > 20_000 && numeric < 70_000) {
      const excelDate = excelSerialToDate(numeric);
      if (excelDate) return toInputDate(excelDate);
    }
    if (numeric > 1_000_000_000_000) return toInputDate(new Date(numeric));
    if (numeric > 1_000_000_000) return toInputDate(new Date(numeric * 1000));
  }

  const manualDate = parseAmbiguousDate(trimmed);
  if (manualDate) return toInputDate(manualDate);

  const parsed = parseDate(trimmed);
  return parsed ? toInputDate(parsed) : trimmed;
};

const getImportedSubmissionSignature = (
  item: Pick<NormalizedOrderItem, "date" | "goats" | "location" | "subcounty" | "officer">
): string => {
  const normalizedDate = normalizeImportedDateValue(String(item.date || ""));
  const goats = Math.max(0, Number(item.goats || 0));
  const location = normalizeText(item.location);
  const subcounty = normalizeText(item.subcounty);
  const officer = normalizeText(item.officer);
  return `${normalizedDate}|${goats}|${location}|${subcounty}|${officer}`;
};

const ORDER_CSV_ID_HEADERS = ["id", "record id", "submission id", "reference", "reference id", "entry id"] as const;
const ORDER_CSV_DATE_HEADERS = ["date", "purchase date", "order date", "submission date", "recorded date", "created at", "completed at"] as const;
const ORDER_CSV_GOATS_HEADERS = ["goats", "goat", "quantity", "qty", "goats bought", "number of goats", "total goats", "goat count"] as const;
const ORDER_CSV_LOCATION_HEADERS = ["location", "village", "market", "trading center", "trading centre", "ward"] as const;
const ORDER_CSV_SUBCOUNTY_HEADERS = ["subcounty", "sub county", "sub-county", "subcounty name", "sub county name"] as const;
const ORDER_CSV_OFFICER_HEADERS = ["field officer", "field officer name", "officer", "officer name", "username", "created by"] as const;

const parseOrderCsvText = (
  text: string,
  row: Pick<BatchOrderRow, "batchId" | "batchDate" | "location" | "subcounty">
): ParsedOrderCsvResult => {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (lines.length < 2) {
    throw new Error("The CSV needs a header row and at least one data row.");
  }

  const headers = parseCSVLine(lines[0].replace(/^\uFEFF/, ""));
  const goatsIndex = findCsvHeaderIndex(headers, ORDER_CSV_GOATS_HEADERS);
  if (goatsIndex === -1) {
    throw new Error("The CSV must include a goats column. Supported headers: goats, qty, quantity, total goats.");
  }

  const idIndex = findCsvHeaderIndex(headers, ORDER_CSV_ID_HEADERS);
  const dateIndex = findCsvHeaderIndex(headers, ORDER_CSV_DATE_HEADERS);
  const locationIndex = findCsvHeaderIndex(headers, ORDER_CSV_LOCATION_HEADERS);
  const subcountyIndex = findCsvHeaderIndex(headers, ORDER_CSV_SUBCOUNTY_HEADERS);
  const officerIndex = findCsvHeaderIndex(headers, ORDER_CSV_OFFICER_HEADERS);

  const items: NormalizedOrderItem[] = [];
  let skippedRows = 0;

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
    const values = parseCSVLine(lines[lineIndex]);
    if (!values.some((value) => value.trim().length > 0)) continue;

    const goats = parseNumericCell(getCsvCell(values, goatsIndex));
    if (!Number.isFinite(goats) || goats <= 0) {
      skippedRows++;
      continue;
    }

    const explicitId = getCsvCell(values, idIndex);
    const date = normalizeImportedDateValue(getCsvCell(values, dateIndex)) || toInputDate(row.batchDate);
    const location = getCsvCell(values, locationIndex) || row.location || "N/A";
    const subcounty = getCsvCell(values, subcountyIndex) || row.subcounty || "";
    const officer = getCsvCell(values, officerIndex) || "N/A";
    const generatedId = explicitId || `csv-${row.batchId}-${lineIndex}`;

    items.push({
      id: generatedId,
      date,
      goats,
      location,
      village: location,
      subcounty,
      officer,
      raw: {
        id: generatedId,
        date,
        goats,
        location,
        village: location,
        subcounty,
        fieldOfficerName: officer !== "N/A" ? officer : undefined,
        officer,
      },
    });
  }

  if (items.length === 0) {
    throw new Error("No valid submissions were found. Make sure the goats column has values greater than zero.");
  }

  return { items, skippedRows };
};

const parseAssignedCounties = (value: unknown): string[] => {
  if (typeof value !== "string") return [];

  const countyMap = new Map<string, string>();
  value
    .split(/[,\n;|]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((county) => {
      const token = normalizeText(county);
      if (token && !countyMap.has(token)) countyMap.set(token, county);
    });

  return Array.from(countyMap.values());
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeOfftakeTeamMember = (value: unknown): OfftakeTeamMember | null => {
  if (!isObjectRecord(value)) return null;

  const name = typeof value.name === "string" ? value.name.trim() : "";
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const phone = typeof value.phone === "string" ? value.phone.trim() : "";
  const email = typeof value.email === "string" ? value.email.trim() : "";
  const subcounty = typeof value.subcounty === "string" ? value.subcounty.trim() : "";
  const purchaseDate = toInputDate(value.purchaseDate);
  const countiesSource = value.counties;

  const countyMap = new Map<string, string>();
  if (Array.isArray(countiesSource)) {
    countiesSource
      .filter((county): county is string => typeof county === "string" && county.trim().length > 0)
      .map((county) => county.trim())
      .forEach((county) => {
        const token = normalizeText(county);
        if (token && !countyMap.has(token)) countyMap.set(token, county);
      });
  } else {
    parseAssignedCounties(countiesSource).forEach((county) => {
      const token = normalizeText(county);
      if (token && !countyMap.has(token)) countyMap.set(token, county);
    });
  }

  const memberId = id || name || email || phone;
  if (!memberId) return null;

  return {
    id: memberId,
    name: name || id || email || phone || "Offtake Team Member",
    phone,
    email,
    counties: Array.from(countyMap.values()),
    purchaseDate,
    subcounty,
  };
};

const getStoredOfftakeTeamMembers = (value: OrderRecord["offtakeTeamMembers"]): OfftakeTeamMember[] => {
  const entries = Array.isArray(value)
    ? value
    : isObjectRecord(value)
      ? Object.values(value)
      : [];
  const members = new Map<string, OfftakeTeamMember>();

  entries.forEach((entry) => {
    const member = normalizeOfftakeTeamMember(entry);
    if (member) members.set(member.id, member);
  });

  return Array.from(members.values()).sort((a, b) => a.name.localeCompare(b.name));
};

const getStoredOfftakeTeamIds = (record: OrderRecord | null | undefined): string[] => {
  if (!record) return [];

  const ids = new Set<string>();
  const rawIds = record.offtakeTeamIds;

  if (Array.isArray(rawIds)) {
    rawIds
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim())
      .forEach((id) => ids.add(id));
  } else if (isObjectRecord(rawIds)) {
    Object.entries(rawIds).forEach(([key, value]) => {
      const normalizedValue = typeof value === "string" ? value.trim() : "";
      const nextId = normalizedValue || (value ? key.trim() : "");
      if (nextId) ids.add(nextId);
    });
  }

  getStoredOfftakeTeamMembers(record.offtakeTeamMembers).forEach((member) => ids.add(member.id));

  return Array.from(ids.values());
};

const resolveAssignedOfftakeTeam = (
  record: OrderRecord | null | undefined,
  pool: OfftakeTeamMember[],
): OfftakeTeamMember[] => {
  if (!record) return [];

  const storedMembers = getStoredOfftakeTeamMembers(record.offtakeTeamMembers);
  const storedIds = getStoredOfftakeTeamIds(record);
  const poolMap = new Map(pool.map((member) => [member.id, member]));
  const resolved = new Map(storedMembers.map((member) => [member.id, member]));

  storedIds.forEach((id) => {
    resolved.set(
      id,
      poolMap.get(id) ||
        resolved.get(id) || {
          id,
          name: id,
          phone: "",
          email: "",
          counties: [],
          purchaseDate: "",
          subcounty: "",
        },
    );
  });

  return Array.from(resolved.values()).sort((a, b) => a.name.localeCompare(b.name));
};

const getAvailableOfftakeTeamMembers = (
  row: Pick<BatchOrderRow, "county"> | null,
  pool: OfftakeTeamMember[],
): OfftakeTeamMember[] => {
  if (!row) return pool;

  const countyToken = normalizeText(row.county);
  if (!countyToken) return pool;

  const countyMatches = pool.filter((member) =>
    member.counties.some((county) => normalizeText(county) === countyToken),
  );

  return countyMatches.length > 0 ? countyMatches : pool;
};

const createManualOfftakeTeamMember = (
  name: string,
  purchaseDate: string,
  usedIds: Iterable<string>,
): OfftakeTeamMember => {
  const trimmedName = name.trim();
  const baseSlug = normalizeText(trimmedName).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "member";
  const usedIdSet = new Set(usedIds);
  let nextId = `manual:${baseSlug}`;
  let suffix = 2;

  while (usedIdSet.has(nextId)) {
    nextId = `manual:${baseSlug}-${suffix}`;
    suffix += 1;
  }

  return {
    id: nextId,
    name: trimmedName,
    phone: "",
    email: "",
    counties: [],
    purchaseDate,
    subcounty: "",
  };
};

const normalizeIdValue = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
};

const getRoleTokens = (record: FieldOfficerRecord): string[] => {
  const tokens = new Set<string>();
  const roleToken = normalizeText(record.role);
  if (roleToken) tokens.add(roleToken);

  const customAttribute = normalizeText(record.accessControl?.customAttribute);
  if (customAttribute) tokens.add(customAttribute);

  const legacy = record.accessControl?.customAttributes;
  if (legacy && typeof legacy === "object") {
    for (const key of Object.keys(legacy)) {
      const token = normalizeText(key);
      if (token) tokens.add(token);
    }
  }

  return Array.from(tokens);
};

const isMobileUserRecord = (record: FieldOfficerRecord): boolean =>
  getRoleTokens(record).some(
    (token) =>
      token === "mobile" ||
      token === "field officer" ||
      token === "field officer" ||
      token === "fieldofficer"
  );

const isOfftakeUserRecord = (record: FieldOfficerRecord): boolean =>
  getRoleTokens(record).some((token) => isOfftakeOfficer(token));

const getOfficerDisplayName = (record: FieldOfficerRecord): string => {
  const candidates = [record.name, record.userName, record.username, record.displayName, record.email];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "Field Officer";
};

const formatRecordName = (value: string | null | undefined): string => {
  const trimmed = value?.trim();
  if (!trimmed) return "N/A";
  if (trimmed === "N/A" || trimmed.toLowerCase() === "unknown" || trimmed.includes("@")) return trimmed;

  return trimmed
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => {
      const lower = part.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
};

const getOfficerPhone = (record: FieldOfficerRecord): string => {
  const candidates = [record.phoneNumber, record.phone, record.mobile, record.telephone, record.contact];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const getBatchTotalGoats = (record: OrderRecord, itemsTotal: number): number => {
  const target = Number(record.targetGoats || 0);
  if (target > 0) return target;
  const storedTotal = Number(record.totalGoats || 0);
  const bought = Math.max(
    Number(record.goatsBought || 0),
    getPurchaseHistoryEntries(record).reduce((sum, entry) => sum + entry.goats, 0),
  );
  const remaining = Number(record.remainingGoats || 0);
  return Math.max(itemsTotal, storedTotal, bought + remaining, 0);
};

const getRecordOfficerCandidates = (record: OrderRecord): unknown[] => [
  record.username,
  record.createdBy,
  record.fieldOfficer,
  record.fieldOfficerName,
  record.officer,
  record.officerName,
];

const getOrderEntries = (record: OrderRecord): OrderItem[] => {
  const mobileData = record.mobileAppdata;
  if (mobileData) {
    if (Array.isArray(mobileData)) return mobileData.filter(Boolean) as OrderItem[];
    if (mobileData && typeof mobileData === "object") return Object.values(mobileData).filter(Boolean) as OrderItem[];
  }
  const orders = record.orders;
  if (Array.isArray(orders)) return orders.filter(Boolean);
  if (orders && typeof orders === "object") return Object.values(orders).filter(Boolean);
  return [];
};

const getBatchIdentifiers = (record: OrderRecord): string[] => {
  const identifiers = new Set<string>();
  [
    record.id,
    record.recordId,
    record.batchId,
    record.orderId,
    record.parentOrderId,
    record.requestId,
    record.targetOrderId,
    record.offtakeOrderId,
  ].forEach((value) => {
    const normalized = normalizeIdValue(value);
    if (normalized) identifiers.add(normalized);
  });
  return Array.from(identifiers);
};

const getBatchReferenceId = (record: OrderRecord): string | null => {
  const recordId = normalizeIdValue(record.id);
  const candidates = [
    record.parentOrderId,
    record.batchId,
    record.requestId,
    record.targetOrderId,
    record.offtakeOrderId,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeIdValue(candidate);
    if (normalized && normalized !== recordId) return normalized;
  }
  return null;
};

const hasDirectGoatsOnly = (record: OrderRecord): boolean => {
  const hasGoats = Number.isFinite(Number(record.goats)) && Number(record.goats) > 0;
  const hasOrders = getOrderEntries(record).length > 0;
  const hasTarget = Number.isFinite(Number(record.targetGoats)) && Number(record.targetGoats) > 0;
  if (!hasGoats) return false;
  if (!hasOrders) return true;
  return !hasTarget;
};

const isSubmissionRecord = (record: OrderRecord): boolean => {
  if (getBatchReferenceId(record)) return true;
  if (hasDirectGoatsOnly(record)) return true;

  const ordersCount = getOrderEntries(record).length;
  const hasBatchCharacteristics =
    Number.isFinite(Number(record.targetGoats)) && Number(record.targetGoats) > 0 ||
    Number.isFinite(Number(record.remainingGoats)) ||
    Number.isFinite(Number(record.goatsBought));

  if (hasBatchCharacteristics) return false;

  const hasStatus = typeof record.status === "string" && record.status.trim().length > 0;

  return ordersCount > 0 && hasStatus;
};

const isBatchRecord = (record: OrderRecord): boolean => {
  if (isSubmissionRecord(record)) return false;

  const hasOrders = getOrderEntries(record).length > 0;
  const target = Number(record.targetGoats) || Number(record.totalGoats);
  const hasTarget = Number.isFinite(target) && target > 0;
  const hasProgress =
    Number.isFinite(Number(record.remainingGoats)) || Number.isFinite(Number(record.goatsBought));
  const hasStatus = typeof record.status === "string" && record.status.trim().length > 0;

  if (hasOrders) return true;
  if (hasTarget && (hasProgress || hasStatus)) return true;
  return false;
};

const getSubmissionItems = (record: OrderRecord): NormalizedOrderItem[] => {
  const orderEntries = getOrderEntries(record);
  if (orderEntries.length > 0) {
    return orderEntries.map((item, index) => {
      const itemLocation = item.location || item.village || record.location || record.village || "N/A";
      const itemSubcounty = item.subcounty || record.subcounty || "";
      const officer =
        item.fieldOfficer ||
        item.fieldOfficerName ||
        item.officer ||
        item.officerName ||
        item.createdBy ||
        item.username ||
        record.username ||
        record.createdBy ||
        "N/A";
      return {
        id: item.id || `${record.id}-${index + 1}`,
        date: item.date || record.date || record.completedAt || record.createdAt || record.timestamp || "",
        goats: Number(item.goats || record.goats || 0),
        location: itemLocation,
        village: item.village || itemLocation,
        subcounty: itemSubcounty,
        officer,
        raw: item,
      };
    });
  }

  const goatsValue = Number(record.goats || record.totalGoats || record.goatsBought || 0);
  if (!Number.isFinite(goatsValue) || goatsValue <= 0) return [];
  const dateValue = record.date || record.completedAt || record.createdAt || record.timestamp || "";
  const location = record.location || record.village || "N/A";
  const subcounty = record.subcounty || "";
  const officer = record.username || record.createdBy || "N/A";
  return [
    {
      id: record.id,
      date: dateValue,
      goats: goatsValue,
      location,
      village: location,
      subcounty,
      officer,
    },
  ];
};

const getNormalizedItems = (record: OrderRecord): NormalizedOrderItem[] => {
  const orderEntries = getOrderEntries(record);
  if (orderEntries.length > 0) {
    return orderEntries.map((item, index) => {
      const itemLocation = item.location || item.village || record.location || "N/A";
      const itemSubcounty = item.subcounty || record.subcounty || "";
      const officer =
        item.fieldOfficer ||
        item.fieldOfficerName ||
        item.officer ||
        item.officerName ||
        item.createdBy ||
        item.username ||
        "N/A";
      return {
        id: item.id || `${record.id}-${index + 1}`,
        date: item.date || record.completedAt || record.createdAt || record.timestamp || "",
        goats: Number(item.goats || 0),
        location: itemLocation,
        village: item.village || itemLocation,
        subcounty: itemSubcounty,
        officer,
        raw: item,
      };
    });
  }

  return [];
};

/* ------------------------------------------------------------------ */
/* Lightweight pre-computation helpers (pure, outside component)       */
/* ------------------------------------------------------------------ */

interface PrecomputedRecord {
  id: string;
  record: OrderRecord;
  isBatch: boolean;
  isSubmission: boolean;
  refId: string | null;
  identifiers: string[];
  normalizedItems: NormalizedOrderItem[];
  normProgramme: string;
  normCounty: string;
  normLocation: string;
  dateMs: number;
  goatsTotal: number;
  officerTokens: string[];
  sortDate: string | number;
}

const getOrderEntryFingerprint = (item: OrderItem | undefined, index: number): string => {
  if (!item) return `missing:${index}`;

  return [
    normalizeIdValue(item.id) || `idx:${index}`,
    item.date ?? "",
    Number(item.goats || 0),
    normalizeText(item.location || item.village),
    normalizeText(item.subcounty),
    normalizeText(
      item.fieldOfficer ||
      item.fieldOfficerName ||
      item.officer ||
      item.officerName ||
      item.createdBy ||
      item.username
    ),
  ].join(":");
};

const getOrderEntriesFingerprint = (record: OrderRecord): string => {
  const items = getOrderEntries(record);
  if (items.length === 0) return "";
  return items.map(getOrderEntryFingerprint).join("|");
};

const getOfftakeTeamIdsFingerprint = (record: OrderRecord): string =>
  getStoredOfftakeTeamIds(record).sort().join("|");

const getOfftakeTeamMembersFingerprint = (record: OrderRecord): string =>
  getStoredOfftakeTeamMembers(record.offtakeTeamMembers)
    .map((member) => [
      member.id,
      member.name,
      member.phone,
      member.email,
      member.purchaseDate,
      member.subcounty,
      member.counties.map((county) => normalizeText(county)).sort().join(","),
    ].join(":"))
    .join("|");

const getRecordFingerprint = (r: OrderRecord): string =>
  [
    normalizeText(r.programme),
    normalizeText(r.county),
    normalizeText(r.subcounty),
    normalizeText(r.location),
    normalizeText(r.status),
    r.targetGoats ?? "",
    r.totalGoats ?? "",
    r.goatsBought ?? "",
    r.remainingGoats ?? "",
    r.purchaseDate ?? "",
    r.date ?? "",
    r.completedAt ?? "",
    r.parentOrderId ?? "",
    r.orderId ?? "",
    r.batchId ?? "",
    r.requestId ?? "",
    r.targetOrderId ?? "",
    r.offtakeOrderId ?? "",
    r.goats ?? "",
    getOrderEntriesFingerprint(r),
    getPurchaseHistoryEntries(r).map((entry) => [entry.id, entry.date, entry.goats, entry.createdAt, entry.recordedBy].join(":")).join("|"),
    getOfftakeTeamIdsFingerprint(r),
    getOfftakeTeamMembersFingerprint(r),
  ].join("::");

/**
 * Incremental precompute: reuses cached precomputed records when unchanged.
 * Returns an array for indexed iteration.
 */
const buildPrecomputedMap = (
  records: OrderRecord[],
  prevCache: Map<string, { pc: PrecomputedRecord; fp: string }>
): PrecomputedRecord[] => {
  const result: PrecomputedRecord[] = new Array(records.length);
  const nextCache = new Map<string, { pc: PrecomputedRecord; fp: string }>();
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const fp = getRecordFingerprint(record);
    const cached = prevCache.get(record.id);
    const pc = cached && cached.fp === fp ? cached.pc : precomputeRecord(record);
    result[i] = pc;
    nextCache.set(record.id, { pc, fp });
  }
  prevCache.clear();
  for (const [k, v] of nextCache) prevCache.set(k, v);
  return result;
}

const precomputeRecord = (record: OrderRecord): PrecomputedRecord => {
  const id = record.id;
  const isBatch = isBatchRecord(record);
  const isSubmission = !isBatch && isSubmissionRecord(record);
  const refId = getBatchReferenceId(record);
  const identifiers = isBatch ? getBatchIdentifiers(record) : [];
  const normalizedItems = isBatch ? getNormalizedItems(record) : [];
  const normProgramme = normalizeText(record.programme);
  const normCounty = normalizeText(record.county);
  const normLocation = normalizeText(record.location || record.village || record.subcounty);
  const dateMs = parseDate(resolveOrderDate(record))?.getTime() || 0;
  const goatsTotal = Number(record.targetGoats || record.totalGoats || record.goatsBought || record.goats || 0);
  const officerTokens = getRecordOfficerCandidates(record)
    .map((v) => (typeof v === "number" && Number.isFinite(v) ? String(v) : normalizeText(v)))
    .filter((t) => t.length > 0);
  const sortDate = resolveOrderDate(record);
  return { id, record, isBatch, isSubmission, refId, identifiers, normalizedItems, normProgramme, normCounty, normLocation, dateMs, goatsTotal, officerTokens, sortDate };
};

const BATCH_REFERENCE_KEYS: readonly (keyof OrderRecord)[] = [
  "parentOrderId",
  "orderId",
  "batchId",
  "requestId",
  "targetOrderId",
  "offtakeOrderId",
];

/* ------------------------------------------------------------------ */
/* Memoized table row component                                        */
/* ------------------------------------------------------------------ */

interface OrderTableRowProps {
  row: BatchOrderRow;
  userCanEditOrders: boolean;
  userIsAdmin: boolean;
  onView: (batchId: string) => void;
  onEdit: (batchId: string) => void;
  onOpenTeam: (batchId: string) => void;
  onMarkComplete: (row: BatchOrderRow) => void;
  onDelete: (row: BatchOrderRow) => void;
}

const OrderTableRow = memo(function OrderTableRow({
  row, userCanEditOrders, userIsAdmin, onView, onEdit, onOpenTeam, onMarkComplete, onDelete,
}: OrderTableRowProps) {
  return (
    <tr className="border-b hover:bg-blue-50 transition-colors group">
      <td className="py-2 px-4 text-xs text-gray-500">{formatDate(row.batchDate)}</td>
      <td className="py-2 px-4 font-medium text-sm">{row.county}</td>
      <td className="py-2 px-4 text-xs text-gray-600 max-w-[140px] truncate">{formatRecordName(row.username)}</td>
      <td className="py-2 px-4 font-semibold text-xs">{row.targetGoats.toLocaleString()}</td>
      <td className="py-2 px-4 text-xs text-gray-600">{row.recordedGoats.toLocaleString()}</td>
      <td className="py-2 px-4 font-semibold text-xs">{row.goatsBought.toLocaleString()}</td>
      <td className="py-2 px-4">
        <span className={getStatusBadgeClass(row.status)}>{row.status}</span>
      </td>
      <td className="py-2 px-4">
        <div className="flex gap-1">
          <Button variant="ghost" size="icon" onClick={() => onView(row.batchId)} className="h-7 w-7 text-green-600 hover:bg-green-50" title="View">
            <Eye className="h-3.5 w-3.5" />
          </Button>
          {userCanEditOrders && (
            <>
              <Button variant="ghost" size="icon" onClick={() => onEdit(row.batchId)} className="h-7 w-7 text-blue-600 hover:bg-blue-50" title="Edit">
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" onClick={() => onOpenTeam(row.batchId)} className="h-7 w-7 text-purple-600 hover:bg-purple-50" title="Offtake Team">
                <Users className="h-3.5 w-3.5" />
              </Button>
              {row.status !== "completed" && (
                <Button variant="ghost" size="icon" onClick={() => onMarkComplete(row)} className="h-7 w-7 text-emerald-600 hover:bg-emerald-50" title="Mark Complete">
                  <Save className="h-3.5 w-3.5" />
                </Button>
              )}
            </>
          )}
          {!userCanEditOrders && (
            <Button variant="ghost" size="icon" onClick={() => onOpenTeam(row.batchId)} className="h-7 w-7 text-purple-600 hover:bg-purple-50" title="Offtake Team">
              <Users className="h-3.5 w-3.5" />
            </Button>
          )}
          {userIsAdmin && (
            <Button variant="ghost" size="icon" onClick={() => onDelete(row)} className="h-7 w-7 text-red-600 hover:bg-red-50" title="Delete">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
});

/* ================================================================== */
/* Main Component                                                      */
/* ================================================================== */

const OrdersPage = () => {
  const { userRole, userAttribute, allowedProgrammes, userName } = useAuth();
  const { toast } = useToast();

  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */

  const [allRecords, setAllRecords] = useState<OrderRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [ordersDialogBatchId, setOrdersDialogBatchId] = useState<string | null>(null);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [newOrder, setNewOrder] = useState<NewOrderForm>(() => getDefaultOrderForm(""));
  const [fieldOfficers, setFieldOfficers] = useState<FieldOfficerOption[]>([]);
  const [offtakeTeam, setOfftakeTeam] = useState<OfftakeTeamMember[]>([]);
  const [fieldOfficersLoading, setFieldOfficersLoading] = useState(false);
  const fieldOfficersLoadedRef = useRef(false);
  const [selectedFieldOfficerIds, setSelectedFieldOfficerIds] = useState<string[]>([]);
  const [ordersDialogMode, setOrdersDialogMode] = useState<OrdersDialogMode>("view");
  const [offtakeTeamDialogBatchId, setOfftakeTeamDialogBatchId] = useState<string | null>(null);
  const [offtakeTeamDraftMembers, setOfftakeTeamDraftMembers] = useState<OfftakeTeamMember[]>([]);
  const [offtakeTeamFormName, setOfftakeTeamFormName] = useState<string>("");
  const [offtakeTeamFormPurchaseDate, setOfftakeTeamFormPurchaseDate] = useState<string>("");
  const [offtakeTeamSaving, setOfftakeTeamSaving] = useState(false);

  const [editingOrderKey, setEditingOrderKey] = useState<string | null>(null);
  const [orderGoatsDraft, setOrderGoatsDraft] = useState<string>("");
  const [orderDateDraft, setOrderDateDraft] = useState<string>("");
  const [orderOfficerDraft, setOrderOfficerDraft] = useState<string>("");
  const [orderLocationDraft, setOrderLocationDraft] = useState<string>("");
  const [orderSubcountyDraft, setOrderSubcountyDraft] = useState<string>("");

  const [dialogGoatsBoughtDraft, setDialogGoatsBoughtDraft] = useState<string>("");
  const [dialogPurchaseDateDraft, setDialogPurchaseDateDraft] = useState<string>("");
  const orderCsvInputRef = useRef<HTMLInputElement | null>(null);
  const [orderCsvFile, setOrderCsvFile] = useState<File | null>(null);
  const [orderCsvPreviewItems, setOrderCsvPreviewItems] = useState<NormalizedOrderItem[]>([]);
  const [orderCsvSkippedRows, setOrderCsvSkippedRows] = useState(0);
  const [orderCsvUploading, setOrderCsvUploading] = useState(false);

  /* FIX: Default date filters are empty — show ALL orders on initial load.
     The previous code used getCurrentMonthDates() which filtered out orders
     whose `date` field was in a different month, causing "No orders found". */
  const [filters, setFilters] = useState<Filters>({
    search: "",
    startDate: "",
    endDate: "",
    status: "all",
  });

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const deferredSearch = useDeferredValue(debouncedSearch);

  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: PAGE_LIMIT,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
  });

  /* ---------------------------------------------------------------- */
  /* Permissions                                                       */
  /* ---------------------------------------------------------------- */

  const userCanViewAllProgrammeData = useMemo(
    () => canViewAllProgrammes(userRole, userAttribute, allowedProgrammes),
    [allowedProgrammes, userRole, userAttribute]
  );
  const accessibleProgrammes = useMemo(
    () => resolveAccessibleProgrammes(userCanViewAllProgrammeData, allowedProgrammes),
    [allowedProgrammes, userCanViewAllProgrammeData]
  );
  const [activeProgram, setActiveProgram] = useSharedProgrammeSelection(accessibleProgrammes);
  const availablePrograms = accessibleProgrammes;
  const userIsAdmin = useMemo(() => isAdmin(userRole), [userRole]);
  const userCanCreateOrders = useMemo(
    () => isAdmin(userRole) || isOfftakeOfficer(userRole) || isOfftakeOfficer(userAttribute),
    [userRole, userAttribute]
  );
  const userCanEditOrders = useMemo(
    () => isAdmin(userRole) || isOfftakeOfficer(userRole) || isOfftakeOfficer(userAttribute),
    [userRole, userAttribute]
  );
  const permissionPrincipal = useMemo(
    () => resolvePermissionPrincipal(userRole, userAttribute),
    [userAttribute, userRole],
  );
  const ordersCacheKey = useMemo(
    () => cacheKey("admin-page", "orders", permissionPrincipal || "no-access", activeProgram || "no-program"),
    [activeProgram, permissionPrincipal],
  );

  const ensureOrderCreateAccess = useCallback(() => {
    if (userCanCreateOrders) return true;
    toast({ title: "Unauthorized", description: "Only offtake officer or Admin can create orders.", variant: "destructive" });
    return false;
  }, [userCanCreateOrders, toast]);

  const ensureOrderEditAccess = useCallback(() => {
    if (userCanEditOrders) return true;
    toast({ title: "Unauthorized", description: "Only offtake officer or Admin can edit orders.", variant: "destructive" });
    return false;
  }, [userCanEditOrders, toast]);

  const ensureBatchDeleteAccess = useCallback(() => {
    if (userIsAdmin) return true;
    toast({ title: "Unauthorized", description: "Only Admin can delete batches.", variant: "destructive" });
    return false;
  }, [userIsAdmin, toast]);

  /* ---------------------------------------------------------------- */
  /* Firebase listener — delta-aware                                   */
  /* ---------------------------------------------------------------- */

  const prevRecordsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!activeProgram) {
      setAllRecords([]);
      setLoading(false);
      prevRecordsRef.current.clear();
      return;
    }
    const cachedRecords = readCachedValue<OrderRecord[]>(ordersCacheKey, ORDERS_CACHE_TTL_MS);
    if (cachedRecords) {
      const sortedCachedRecords = sortOrdersByLatest(cachedRecords);
      prevRecordsRef.current = new Map(
        sortedCachedRecords.map((record) => [record.id, getRecordFingerprint(record)]),
      );
      startTransition(() => setAllRecords(sortedCachedRecords));
      setLoading(false);
    } else {
      prevRecordsRef.current.clear();
      startTransition(() => setAllRecords([]));
      setLoading(true);
    }

    const syncRecords = (rawData: Record<string, Partial<OrderRecord>> | null) => {
      const entries = Object.entries(rawData || {}).filter(([, value]) => {
        const recordProgramme = value?.programme;
        return (
          matchesActiveProgramme(recordProgramme, activeProgram) ||
          recordProgramme === "" ||
          recordProgramme === null ||
          recordProgramme === undefined
        );
      });
      if (entries.length === 0) {
        prevRecordsRef.current.clear();
        startTransition(() => setAllRecords([]));
        removeCachedValue(ordersCacheKey);
        setLoading(false);
        return;
      }

      const records = sortOrdersByLatest(
        entries.map(([key, val]) => ({
          ...(val as Partial<OrderRecord> & { id?: string }),
          id: key,
          recordId: val?.id || key,
        })),
      );

      const newFingerprints = new Map<string, string>();
      let hasChanges = records.length !== prevRecordsRef.current.size;

      for (const record of records) {
        const fingerprint = getRecordFingerprint(record);
        newFingerprints.set(record.id, fingerprint);
        if (prevRecordsRef.current.get(record.id) !== fingerprint) {
          hasChanges = true;
        }
      }

      if (!hasChanges) {
        setLoading(false);
        return;
      }

      prevRecordsRef.current = newFingerprints;
      startTransition(() => setAllRecords(records));
      writeCachedValue(ordersCacheKey, records);
      setLoading(false);
    };

    const unsubscribe = subscribeCollectionByProgramme<Partial<OrderRecord>>(
      "orders",
      activeProgram,
      (data) => {
        syncRecords(data && typeof data === "object" ? data : {});
      },
      (error) => {
        toast({
          title: "Error loading orders",
          description: error.message,
          variant: "destructive"
        });
        setLoading(false);
      },
    );

    return () => {
      unsubscribe();
    };
  }, [activeProgram, ordersCacheKey, toast]);

  /* ---------------------------------------------------------------- */
  /* Reset dialogs on programme change                                 */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    setOrdersDialogBatchId(null);
    setOrdersDialogMode("view");
    setOfftakeTeamDialogBatchId(null);
    setOfftakeTeamDraftMembers([]);
    setOfftakeTeamFormName("");
    setOfftakeTeamFormPurchaseDate("");
    setOfftakeTeamSaving(false);
  }, [activeProgram]);

  /* ---------------------------------------------------------------- */
  /* Load field officers lazily                                        */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!activeProgram) {
      setFieldOfficers([]);
      setOfftakeTeam([]);
      fieldOfficersLoadedRef.current = false;
      return;
    }
    if (fieldOfficersLoadedRef.current) return;
    let cancelled = false;
    const load = async () => {
      setFieldOfficersLoading(true);
      try {
        const allUsers = await fetchCollection<FieldOfficerRecord>("users");
        if (cancelled) return;
        const officers = allUsers
          .filter(isMobileUserRecord)
          .map((record) => ({
            id: record.id || getOfficerDisplayName(record),
            name: getOfficerDisplayName(record),
            phone: getOfficerPhone(record),
            counties: parseAssignedCounties(record.county),
            aliases: [record.name, record.userName, record.username, record.displayName, record.email, record.id].filter(
              (v): v is string => typeof v === "string" && v.trim().length > 0,
            ),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const team = allUsers
          .filter(isOfftakeUserRecord)
          .map((record) => ({
            id: record.id || getOfficerDisplayName(record),
            name: getOfficerDisplayName(record),
            phone: getOfficerPhone(record),
            email: typeof record.email === "string" ? record.email.trim() : "",
            counties: parseAssignedCounties(record.county),
            purchaseDate: "",
            subcounty: typeof record.subcounty === "string" ? record.subcounty.trim() : "",
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        if (!cancelled) {
          setFieldOfficers(officers);
          setOfftakeTeam(team);
          fieldOfficersLoadedRef.current = true;
        }
      } catch {
        if (!cancelled) {
          setFieldOfficers([]);
          setOfftakeTeam([]);
          toast({ title: "Error", description: "Failed to load Field Officers.", variant: "destructive" });
        }
      } finally {
        if (!cancelled) setFieldOfficersLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [activeProgram, toast]);

  const mobileOfficerTokenSet = useMemo(() => {
    const tokens = new Set<string>();
    for (const officer of fieldOfficers) {
      for (const value of [officer.name, officer.id, officer.phone, ...(officer.aliases || [])]) {
        const t = normalizeText(value);
        if (t) tokens.add(t);
      }
    }
    return tokens;
  }, [fieldOfficers]);

  /* ---------------------------------------------------------------- */
  /* Incremental pre-computation                                       */
  /* ---------------------------------------------------------------- */

  const precomputedCacheRef = useRef<Map<string, { pc: PrecomputedRecord; fp: string }>>(new Map());
  const precomputed = useMemo(
    () => buildPrecomputedMap(allRecords, precomputedCacheRef.current),
    [allRecords],
  );

  /* ---------------------------------------------------------------- */
  /* Core batch grouping                                              */
  /* ---------------------------------------------------------------- */

  const batchRows = useMemo(() => {
    const batchMap = new Map<string, { pr: PrecomputedRecord; items: NormalizedOrderItem[]; itemIds: Set<string> }>();
    const batchAliasMap = new Map<string, string>();
    const consumedRecordIds = new Set<string>();
    const countyBatchIndex = new Map<string, string[]>();

    /* 1. Register batch parents that belong to the active programme */
    for (const pc of precomputed) {
      if (!pc.isBatch) continue;
      const recProgramme = (pc.record.programme as string | undefined)?.trim().toUpperCase();
      if (recProgramme && recProgramme !== activeProgram) continue;
      const itemIds = new Set(pc.normalizedItems.map((i) => i.id));
      batchMap.set(pc.id, { pr: pc, items: [...pc.normalizedItems], itemIds });
      for (const id of pc.identifiers) {
        if (!batchAliasMap.has(id)) batchAliasMap.set(id, pc.id);
      }
      if (pc.normCounty) {
        let list = countyBatchIndex.get(pc.normCounty);
        if (!list) { list = []; countyBatchIndex.set(pc.normCounty, list); }
        list.push(pc.id);
      }
    }

    /* 2. Fast resolve for submission records */
    for (const pc of precomputed) {
      if (pc.isBatch) continue;
      if (consumedRecordIds.has(pc.id)) continue;

      let batchId: string | null = null;

      if (pc.refId) {
        batchId = batchAliasMap.get(pc.refId) || (batchMap.has(pc.refId) ? pc.refId : null);
      }

      if (!batchId) {
        const rec = pc.record;
        for (const key of BATCH_REFERENCE_KEYS) {
          const val = rec[key];
          if (val == null) continue;
          const norm = normalizeIdValue(val);
          if (!norm) continue;
          batchId = batchAliasMap.get(norm);
          if (batchId) break;
        }
      }

      if (!batchId && (pc.isSubmission || pc.officerTokens.some((t) => mobileOfficerTokenSet.has(t)))) {
        let bestScore = 0;
        const candidateBatchIds = pc.normCounty ? countyBatchIndex.get(pc.normCounty) : null;
        const batchesToScan = candidateBatchIds || Array.from(batchMap.keys());
        for (const bid of batchesToScan) {
          if (bid === pc.id) continue;
          const entry = batchMap.get(bid);
          if (!entry) continue;
          const bp = entry.pr;
          let score = 0;
          if (pc.normProgramme && bp.normProgramme && pc.normProgramme === bp.normProgramme) score += 3;
          if (pc.normCounty && bp.normCounty && pc.normCounty === bp.normCounty) score += 2;
          if (pc.normLocation && bp.normLocation && pc.normLocation === bp.normLocation) score += 4;
          if (pc.dateMs && bp.dateMs) {
            const dayDiff = Math.abs(pc.dateMs - bp.dateMs) / 86400000;
            if (dayDiff <= 1) score += 4;
            else if (dayDiff <= 7) score += 3;
            else if (dayDiff <= 30) score += 1;
          }
          if (pc.goatsTotal > 0 && bp.goatsTotal > 0 && pc.goatsTotal === bp.goatsTotal) score += 2;
          if (normalizeStatus(bp.record.status) !== "completed") score += 1;
          if (score > bestScore) { bestScore = score; batchId = bid; }
        }
        if (bestScore < 6) batchId = null;
      }

      if (!batchId || batchId === pc.id) continue;

      const parent = batchMap.get(batchId);
      if (!parent) continue;
      const subItems = getSubmissionItems(pc.record);
      if (subItems.length === 0) continue;
      const filtered = subItems.filter((item) => !parent.itemIds.has(item.id));
      if (filtered.length === 0) continue;
      for (const item of filtered) parent.itemIds.add(item.id);
      parent.items.push(...filtered);
      consumedRecordIds.add(pc.id);
    }

    /* 3. Build output rows */
    const result: BatchOrderRow[] = [];
    for (const [, entry] of batchMap.entries()) {
      if (consumedRecordIds.has(entry.pr.id)) continue;
      const rec = entry.pr.record;
      const items = entry.items;
      const purchaseEntries = getPurchaseHistoryEntries(rec);
      const itemsTotal = items.reduce((s, i) => s + i.goats, 0);
      const totalGoats = getBatchTotalGoats(rec, itemsTotal);
      const goatsBought = clamp(
        purchaseEntries.reduce((sum, purchaseEntry) => sum + purchaseEntry.goats, 0) || Number(rec.goatsBought || 0),
        0,
        Math.max(totalGoats, 0),
      );
      const remainingGoats = Math.max(totalGoats - goatsBought, 0);
      const createdAt = rec.createdAt || rec.timestamp || "";
      const completedAt = rec.completedAt || "";
      const batchDate = resolveOrderDate(rec, items[0]?.date || "");
      const storedStatus = normalizeStatus(rec.status);
      const isReadyForCompletion = totalGoats > 0 && remainingGoats <= 0 && storedStatus !== "completed";
      const status = storedStatus === "completed"
        ? "completed"
        : goatsBought > 0 || items.length > 0 ? "in-progress" : "pending";
      const county = rec.county || "N/A";
      const subcounty = rec.subcounty || "N/A";
      const location = rec.location || items[0]?.location || items[0]?.village || "N/A";
      const programme = rec.programme || activeProgram || "N/A";
      const username = rec.username || rec.createdBy || items[0]?.officer || "N/A";
      const targetGoats = Number(rec.targetGoats || 0) || totalGoats;
      const orderCode = normalizeIdValue(rec.orderId) || normalizeIdValue(rec.batchId) || normalizeIdValue(rec.id) || "N/A";
      result.push({
        batchId: rec.id, orderCode, batchDate, createdAt, completedAt, targetGoats, totalGoats, recordedGoats: itemsTotal,
        goatsBought, remainingGoats, status,
        county, subcounty, location, programme, username,
        sortTimestamp: parseDate(batchDate)?.getTime() || 0, isReadyForCompletion, items, purchaseEntries,
        searchableText: `${county} ${subcounty} ${location} ${username} ${status} ${programme} ${rec.id} ${orderCode} ${totalGoats}`.toLowerCase(),
      });
    }
    result.sort((a, b) => b.sortTimestamp - a.sortTimestamp);
    return result;
  }, [precomputed, activeProgram, mobileOfficerTokenSet]);

  /* ---------------------------------------------------------------- */
  /* Dialog memoized data                                             */
  /* ---------------------------------------------------------------- */

  const ordersDialogRow = useMemo(
    () => batchRows.find((r) => r.batchId === ordersDialogBatchId) || null,
    [batchRows, ordersDialogBatchId]
  );

  const ordersDialogRecord = useMemo(
    () => allRecords.find((record) => record.id === ordersDialogBatchId) || null,
    [allRecords, ordersDialogBatchId]
  );

  const ordersDialogIsEditing = ordersDialogMode === "edit" && userCanEditOrders;

  const ordersDialogItems = useMemo(
    () => ordersDialogRow?.items.filter((item) => item.goats > 0 || item.date) || [],
    [ordersDialogRow]
  );

  const ordersDialogPurchaseLedgerRows = useMemo(() => {
    if (!ordersDialogRow) return [] as Array<{ key: string; dateLabel: string; goats: number; balance: number; recordedBy: string }>;

    const target = ordersDialogRow.targetGoats > 0 ? ordersDialogRow.targetGoats : ordersDialogRow.totalGoats;
    const chronologicalEntries = [...ordersDialogRow.purchaseEntries].sort((left, right) => {
      const leftDate = parseDate(left.date)?.getTime() || parseDate(left.createdAt)?.getTime() || 0;
      const rightDate = parseDate(right.date)?.getTime() || parseDate(right.createdAt)?.getTime() || 0;
      return leftDate - rightDate;
    });

    let runningPurchased = 0;
    return chronologicalEntries.map((purchaseEntry) => {
      runningPurchased += purchaseEntry.goats;
      return {
        key: purchaseEntry.id,
        dateLabel: formatDate(purchaseEntry.date || purchaseEntry.createdAt),
        goats: purchaseEntry.goats,
        balance: target - runningPurchased,
        recordedBy: purchaseEntry.recordedBy || "Recorded purchase",
      };
    });
  }, [ordersDialogRow]);

  const ordersDialogAssignedOfftakeTeam = useMemo(
    () => resolveAssignedOfftakeTeam(ordersDialogRecord, offtakeTeam),
    [offtakeTeam, ordersDialogRecord]
  );

  const offtakeTeamDialogRow = useMemo(
    () => batchRows.find((r) => r.batchId === offtakeTeamDialogBatchId) || null,
    [batchRows, offtakeTeamDialogBatchId]
  );

  const offtakeTeamDialogRecord = useMemo(
    () => allRecords.find((record) => record.id === offtakeTeamDialogBatchId) || null,
    [allRecords, offtakeTeamDialogBatchId]
  );

  const offtakeTeamDialogAssignedMembers = useMemo(
    () => resolveAssignedOfftakeTeam(offtakeTeamDialogRecord, offtakeTeam),
    [offtakeTeam, offtakeTeamDialogRecord]
  );

  const offtakeTeamDialogSystemMembers = useMemo(() => {
    const members = new Map<string, OfftakeTeamMember>();
    getAvailableOfftakeTeamMembers(offtakeTeamDialogRow, offtakeTeam).forEach((member) => members.set(member.id, member));
    offtakeTeamDialogAssignedMembers.forEach((member) => members.set(member.id, member));
    return Array.from(members.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [offtakeTeam, offtakeTeamDialogAssignedMembers, offtakeTeamDialogRow]);

  const offtakeTeamSystemNameMatch = useMemo(() => {
    const target = normalizeText(offtakeTeamFormName);
    if (!target) return null;
    return offtakeTeam.find((member) => normalizeText(member.name) === target) || null;
  }, [offtakeTeam, offtakeTeamFormName]);

  /* ---------------------------------------------------------------- */
  /* Dialog effects                                                    */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (ordersDialogBatchId && !ordersDialogRow) {
      setOrdersDialogBatchId(null);
      setOrdersDialogMode("view");
      setEditingOrderKey(null);
      setOrderGoatsDraft("");
      setOrderDateDraft("");
    }
  }, [ordersDialogBatchId, ordersDialogRow]);

  /* Initialize edit-mode drafts including the purchasing date */
  useEffect(() => {
    if (!ordersDialogRow) return;
    if (ordersDialogMode === "edit") {
      setDialogGoatsBoughtDraft("");
      setDialogPurchaseDateDraft(getTodayInputDate());
      return;
    }
    setDialogGoatsBoughtDraft("");
    setDialogPurchaseDateDraft("");
  }, [ordersDialogMode, ordersDialogRow]);

  useEffect(() => {
    if (offtakeTeamDialogBatchId && !offtakeTeamDialogRow) {
      setOfftakeTeamDialogBatchId(null);
      setOfftakeTeamDraftMembers([]);
      setOfftakeTeamFormName("");
      setOfftakeTeamFormPurchaseDate("");
      setOfftakeTeamSaving(false);
    }
  }, [offtakeTeamDialogBatchId, offtakeTeamDialogRow]);

  useEffect(() => {
    if (!offtakeTeamDialogBatchId || !offtakeTeamDialogRecord) {
      setOfftakeTeamDraftMembers([]);
      setOfftakeTeamFormName("");
      setOfftakeTeamFormPurchaseDate("");
      setOfftakeTeamSaving(false);
      return;
    }
    setOfftakeTeamDraftMembers(resolveAssignedOfftakeTeam(offtakeTeamDialogRecord, offtakeTeam));
    setOfftakeTeamFormName("");
    setOfftakeTeamFormPurchaseDate(
      toInputDate(resolveLatestPurchaseDate(offtakeTeamDialogRecord, getTodayInputDate()))
    );
    setOfftakeTeamSaving(false);
  }, [offtakeTeam, offtakeTeamDialogBatchId, offtakeTeamDialogRecord, offtakeTeamDialogRow]);

  /* ---------------------------------------------------------------- */
  /* Filtering & pagination                                            */
  /* ---------------------------------------------------------------- */

  const filterStartDateMs = useMemo(
    () => filters.startDate ? new Date(filters.startDate).setHours(0, 0, 0, 0) : null,
    [filters.startDate],
  );
  const filterEndDateMs = useMemo(
    () => filters.endDate ? new Date(filters.endDate).setHours(23, 59, 59, 999) : null,
    [filters.endDate],
  );

  const filteredBatchRows = useMemo(() => {
    const searchTerm = deferredSearch.toLowerCase().trim();
    const statusFilter = filters.status;
    const hasDateFilter = filterStartDateMs != null || filterEndDateMs != null;
    const needsSearch = searchTerm.length > 0;
    const needsDate = hasDateFilter;
    const rows = batchRows.filter((row) => {
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      if (!needsSearch && !needsDate) return true;
      if (needsDate) {
        const rowMs = row.sortTimestamp;
        if (!rowMs) return false;
        if (filterStartDateMs != null && rowMs < filterStartDateMs) return false;
        if (filterEndDateMs != null && rowMs > filterEndDateMs) return false;
      }
      if (!needsSearch) return true;
      return row.searchableText.includes(searchTerm);
    });
    return rows;
  }, [batchRows, filters.status, filterStartDateMs, filterEndDateMs, deferredSearch]);

  const totalTargetGoats = useMemo(
    () => filteredBatchRows.reduce((sum, row) => sum + (row.targetGoats || row.totalGoats), 0),
    [filteredBatchRows]
  );

  const totalGoatsPurchased = useMemo(
    () => filteredBatchRows.reduce((sum, row) => sum + row.goatsBought, 0),
    [filteredBatchRows]
  );

  const purchasePercentage = useMemo(() => {
    if (totalTargetGoats === 0) return 0;
    return Math.round((totalGoatsPurchased / totalTargetGoats) * 100);
  }, [totalGoatsPurchased, totalTargetGoats]);

  const totalOrdersInBatches = useMemo(
    () => filteredBatchRows.reduce((sum, row) => sum + row.items.length, 0),
    [filteredBatchRows]
  );

  const countiesMap = useMemo(() => {
    const map = new Map<string, number>();
    filteredBatchRows.forEach((row) => {
      const county = row.county || "Unknown";
      map.set(county, (map.get(county) || 0) + row.totalGoats);
    });
    return new Map([...map.entries()].sort((a, b) => b[1] - a[1]));
  }, [filteredBatchRows]);

  const uniqueCounties = countiesMap.size;

  useEffect(() => {
    setPagination((prev) => {
      const totalPages = Math.max(1, Math.ceil(filteredBatchRows.length / prev.limit));
      const page = Math.min(prev.page, totalPages);
      return { ...prev, page, totalPages, hasNext: page < totalPages, hasPrev: page > 1 };
    });
  }, [filteredBatchRows.length]);

  const pageRows = useMemo(() => {
    const start = (pagination.page - 1) * pagination.limit;
    return filteredBatchRows.slice(start, start + pagination.limit);
  }, [filteredBatchRows, pagination.page, pagination.limit]);

  const availableStatuses = useMemo(() => {
    const set = new Set<string>();
    batchRows.forEach((r) => set.add(r.status));
    return Array.from(set).sort();
  }, [batchRows]);

  /* ---------------------------------------------------------------- */
  /* Create order helpers                                              */
  /* ---------------------------------------------------------------- */

  const countyOptions = useMemo(() => {
    const countyMap = new Map<string, string>();
    fieldOfficers.forEach((officer) => {
      officer.counties.forEach((county) => {
        const token = normalizeText(county);
        if (token && !countyMap.has(token)) countyMap.set(token, county);
      });
    });
    return Array.from(countyMap.values()).sort((a, b) => a.localeCompare(b));
  }, [fieldOfficers]);

  const countyFieldOfficers = useMemo(() => {
    const selectedCountyTokens = new Set(newOrder.counties.map((county) => normalizeText(county)).filter(Boolean));
    if (selectedCountyTokens.size === 0) return [];
    return fieldOfficers.filter((officer) =>
      officer.counties.some((county) => selectedCountyTokens.has(normalizeText(county)))
    );
  }, [fieldOfficers, newOrder.counties]);

  const canChooseOrderProgramme = availablePrograms.length > 1;
  const resolvedOrderProgramme = newOrder.programme || activeProgram || availablePrograms[0] || "";

  const selectedOfficerNames = useMemo(
    () => fieldOfficers.filter((o) => selectedFieldOfficerIds.includes(o.id)).map((o) => o.name),
    [fieldOfficers, selectedFieldOfficerIds]
  );

  const selectedOfficersSummary = useMemo(() => {
    if (newOrder.counties.length === 0) return "Select counties first";
    if (countyFieldOfficers.length === 0) return "No field officers assigned";
    return selectedOfficerNames.length === 0 ? "Select field officers" : `${selectedOfficerNames.length} selected`;
  }, [countyFieldOfficers.length, newOrder.counties.length, selectedOfficerNames.length]);

  const selectedOfficersPreview = useMemo(() => {
    const countyLabel = formatSelectedCounties(newOrder.counties);
    if (newOrder.counties.length === 0) return "Choose counties to load their assigned field officers.";
    if (countyFieldOfficers.length === 0) return `No field officers are assigned to ${countyLabel}.`;
    if (selectedOfficerNames.length === 0) {
      return `${countyFieldOfficers.length} field officer${countyFieldOfficers.length === 1 ? "" : "s"} available in ${countyLabel}.`;
    }
    const preview = selectedOfficerNames.slice(0, 3).join(", ");
    return selectedOfficerNames.length <= 3 ? preview : `${preview} +${selectedOfficerNames.length - 3} more`;
  }, [countyFieldOfficers.length, newOrder.counties, selectedOfficerNames]);

  const generatedSmsPreview = useMemo(() => {
    const programmeLabel = resolvedOrderProgramme || "Selected programme";
    const countyLabel = formatSelectedCounties(newOrder.counties) || "selected counties";
    const targetGoats = Number(newOrder.goats) || 0;
    const goatsLabel = targetGoats > 0
      ? targetGoats.toLocaleString()
      : "0";
    const dateLabel = newOrder.date ? formatDate(newOrder.date) : "selected date";

    return `Dear Field Officer, a ${programmeLabel} order has been created for ${countyLabel} on ${dateLabel}. Target goats: ${goatsLabel}. Order reference will be attached automatically.`;
  }, [newOrder.counties, newOrder.date, newOrder.goats, resolvedOrderProgramme]);

  useEffect(() => {
    const allowedOfficerIds = new Set(countyFieldOfficers.map((officer) => officer.id));
    setSelectedFieldOfficerIds((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.filter((id) => allowedOfficerIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [countyFieldOfficers]);

  /* ---------------------------------------------------------------- */
  /* Filter & search handlers                                          */
  /* ---------------------------------------------------------------- */

  const handleSearchChange = useCallback((value: string) => {
    setFilters((prev) => ({ ...prev, search: value }));
    setPagination((prev) => ({ ...prev, page: 1 }));
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      startTransition(() => setDebouncedSearch(value));
    }, 200);
  }, []);

  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  const handleFilterChange = useCallback((key: keyof Filters, value: string) => {
    setPagination((prev) => ({ ...prev, page: 1 }));
    if (key === "search") {
      handleSearchChange(value);
    } else {
      setFilters((prev) => ({ ...prev, [key]: value }));
    }
  }, [handleSearchChange]);

  const clearFilters = useCallback(() => {
    setFilters({ search: "", startDate: "", endDate: "", status: "all" });
    setPagination((prev) => ({ ...prev, page: 1 }));
    startTransition(() => setDebouncedSearch(""));
  }, []);

 
  /* ---------------------------------------------------------------- */
  /* Dialog open/close callbacks                                       */
  /* ---------------------------------------------------------------- */

  const openOrdersDialog = useCallback((batchId: string, mode: OrdersDialogMode) => {
    setOrdersDialogMode(mode);
    setOrdersDialogBatchId(batchId);
  }, []);

  const openOrdersViewDialog = useCallback((batchId: string) => {
    openOrdersDialog(batchId, "view");
  }, [openOrdersDialog]);

  const openOrdersEditDialog = useCallback((batchId: string) => {
    if (!ensureOrderEditAccess()) return;
    openOrdersDialog(batchId, "edit");
  }, [ensureOrderEditAccess, openOrdersDialog]);

  const openOrdersOfftakeTeamDialog = useCallback((batchId: string) => {
    setOfftakeTeamDialogBatchId(batchId);
  }, []);

  const clearOrderCsvImport = useCallback(() => {
    setOrderCsvFile(null);
    setOrderCsvPreviewItems([]);
    setOrderCsvSkippedRows(0);
    if (orderCsvInputRef.current) orderCsvInputRef.current.value = "";
  }, []);

  const closeOrdersDialog = useCallback(() => {
    setOrdersDialogBatchId(null);
    setOrdersDialogMode("view");
    setEditingOrderKey(null);
    setOrderGoatsDraft("");
    setOrderDateDraft("");
    setOrderOfficerDraft("");
    setOrderLocationDraft("");
    setOrderSubcountyDraft("");
    setDialogGoatsBoughtDraft("");
    setDialogPurchaseDateDraft("");
    clearOrderCsvImport();
  }, [clearOrderCsvImport]);

  const closeOfftakeTeamDialog = useCallback(() => {
    setOfftakeTeamDialogBatchId(null);
    setOfftakeTeamDraftMembers([]);
    setOfftakeTeamFormName("");
    setOfftakeTeamFormPurchaseDate("");
    setOfftakeTeamSaving(false);
  }, []);

  /* ---------------------------------------------------------------- */
  /* Offtake team management                                           */
  /* ---------------------------------------------------------------- */

  const addOfftakeTeamMember = useCallback(() => {
    if (!ensureOrderEditAccess()) return;
    const trimmedName = offtakeTeamFormName.trim();
    if (!trimmedName) {
      toast({ title: "Team member name required", description: "Enter the offtake team member name.", variant: "destructive" });
      return;
    }

    const normalizedName = normalizeText(trimmedName);
    const existingSystemMember = offtakeTeam.find((member) => normalizeText(member.name) === normalizedName) || null;
    const duplicateExists = offtakeTeamDraftMembers.some((member) =>
      member.id === existingSystemMember?.id || normalizeText(member.name) === normalizedName,
    );

    if (duplicateExists) {
      toast({ title: "Already added", description: "This offtake team member is already on the list." });
      return;
    }

    setOfftakeTeamDraftMembers((prev) => {
      const nextMember = existingSystemMember || createManualOfftakeTeamMember(trimmedName, "", prev.map((member) => member.id));
      return [...prev, nextMember].sort((a, b) => a.name.localeCompare(b.name));
    });
    setOfftakeTeamFormName("");
  }, [ensureOrderEditAccess, offtakeTeam, offtakeTeamDraftMembers, offtakeTeamFormName, toast]);

  const removeOfftakeTeamMember = useCallback((memberId: string) => {
    if (!ensureOrderEditAccess()) return;
    setOfftakeTeamDraftMembers((prev) => prev.filter((member) => member.id !== memberId));
  }, [ensureOrderEditAccess]);

  const saveOfftakeTeamAssignments = useCallback(async () => {
    if (!offtakeTeamDialogRecord) return;
    if (!ensureOrderEditAccess()) return;

    setOfftakeTeamSaving(true);
    try {
      const selectedMembers = [...offtakeTeamDraftMembers].sort((a, b) => a.name.localeCompare(b.name));
      const selectedIds = selectedMembers.map((member) => member.id);

      await update(ref(db, `orders/${offtakeTeamDialogRecord.id}`), {
        offtakeTeamIds: selectedIds,
        offtakeTeamMembers: selectedMembers,
      });

      toast({
        title: "Offtake team updated",
        description: selectedIds.length === 0
          ? "The order has no assigned offtake team members now."
          : `${selectedIds.length} team member${selectedIds.length === 1 ? "" : "s"} assigned to this order.`,
      });
      closeOfftakeTeamDialog();
    } catch {
      toast({ title: "Error", description: "Failed to update the offtake team.", variant: "destructive" });
    } finally {
      setOfftakeTeamSaving(false);
    }
  }, [
    closeOfftakeTeamDialog,
    ensureOrderEditAccess,
    offtakeTeamDraftMembers,
    offtakeTeamDialogRecord,
    toast,
  ]);

  /* ---------------------------------------------------------------- */
  /* Order CRUD operations                                             */
  /* ---------------------------------------------------------------- */

  const resetNewOrderForm = useCallback((programme: string) => {
    setNewOrder(getDefaultOrderForm(programme));
    setSelectedFieldOfficerIds([]);
  }, []);

  const openCreateDialog = useCallback(() => {
    if (!ensureOrderCreateAccess()) return;
    if (!activeProgram) {
      toast({ title: "Select programme", description: "Please select a programme before creating an order.", variant: "destructive" });
      return;
    }
    resetNewOrderForm(activeProgram);
    setIsCreateDialogOpen(true);
  }, [activeProgram, userCanCreateOrders, ensureOrderCreateAccess]);

  const closeCreateDialog = useCallback(() => { setIsCreateDialogOpen(false); }, []);

  const toggleFieldOfficerSelection = useCallback((officerId: string) => {
    setSelectedFieldOfficerIds((prev) =>
      prev.includes(officerId) ? prev.filter((id) => id !== officerId) : [...prev, officerId]
    );
  }, []);

  const toggleCountySelection = useCallback(async (county: string) => {
    const nextCounties = newOrder.counties.includes(county)
      ? newOrder.counties.filter((selectedCounty) => selectedCounty !== county)
      : [...newOrder.counties, county];
    setNewOrder((prev) => ({ ...prev, counties: nextCounties }));
    setSelectedFieldOfficerIds([]);
    const code = nextCounties.length > 0 ? await generateOrderCode(nextCounties[0], resolvedOrderProgramme) : "";
    setNewOrder((prev) => ({ ...prev, orderCode: code }));
  }, [newOrder.counties, resolvedOrderProgramme]);

  const updateBatchOrders = async (row: BatchOrderRow, nextItems: NormalizedOrderItem[], nextGoatsBought?: number) => {
    const sanitizedItems = nextItems
      .filter((item) => Number(item.goats || 0) > 0 || Boolean(String(item.date || "").trim()))
      .map((item, index) => {
        const orderLocation = item.location || item.village || row.location || "";
        const orderOfficer = typeof item.officer === "string" && item.officer !== "N/A" ? item.officer.trim() : "";
        const rawItem = { ...(item.raw ?? {}) };
        delete rawItem.word;
        return {
          ...rawItem,
          id: item.id || `${row.batchId}-${index + 1}`,
          goats: Math.max(0, Number(item.goats || 0)),
          date: item.date || row.batchDate || "",
          location: orderLocation,
          village: item.village || orderLocation,
          subcounty: item.subcounty || row.subcounty || "",
          ...(orderOfficer ? { fieldOfficerName: orderOfficer, officer: orderOfficer } : {}),
        };
      });
    const itemsTotal = sanitizedItems.reduce((sum, i) => sum + i.goats, 0);
    const targetGoats = row.targetGoats > 0 ? row.targetGoats : row.totalGoats;
    const existingPurchasedGoats = row.purchaseEntries.reduce((sum, purchaseEntry) => sum + purchaseEntry.goats, 0) || Number(row.goatsBought || 0);
    const goatsBought = clamp(
      typeof nextGoatsBought === "number" ? nextGoatsBought : existingPurchasedGoats,
      0, Math.max(targetGoats, 0)
    );
    const remainingGoats = Math.max(targetGoats - goatsBought, 0);
    const storedStatus = normalizeStatus(row.status);
    const nextStatus = storedStatus === "completed" ? "completed" : goatsBought > 0 || itemsTotal > 0 ? "in-progress" : "pending";
    const nextCompletedAt = storedStatus === "completed" ? row.completedAt || new Date().toISOString() : "";
    await update(ref(db, `orders/${row.batchId}`), {
      mobileAppdata: sanitizedItems, totalGoats: itemsTotal, goatsBought, remainingGoats, status: nextStatus, completedAt: nextCompletedAt,
    });
  };

  const persistPurchaseHistory = useCallback(async (
    row: BatchOrderRow,
    nextPurchaseEntries: NormalizedPurchaseHistoryEntry[],
  ) => {
    const target = row.targetGoats || row.totalGoats;
    const sanitizedPurchaseEntries = sortPurchaseHistoryEntries(
      nextPurchaseEntries
        .filter((purchaseEntry) => purchaseEntry.goats > 0 && Boolean(String(purchaseEntry.date || "").trim()))
        .map((purchaseEntry, index) => ({
          id: purchaseEntry.id || `${row.batchId}-purchase-${index + 1}`,
          date: purchaseEntry.date,
          goats: Math.max(0, Number(purchaseEntry.goats || 0)),
          createdAt: purchaseEntry.createdAt || new Date().toISOString(),
          recordedBy: purchaseEntry.recordedBy || userName || "Unknown",
        })),
    );
    const goatsBought = clamp(
      sanitizedPurchaseEntries.reduce((sum, purchaseEntry) => sum + purchaseEntry.goats, 0),
      0,
      Math.max(target, 0),
    );
    const remainingGoats = Math.max(target - goatsBought, 0);
    const storedStatus = normalizeStatus(row.status);
    const nextStatus = storedStatus === "completed" ? "completed" : goatsBought > 0 || row.items.length > 0 ? "in-progress" : "pending";
    const nextCompletedAt = storedStatus === "completed" ? row.completedAt || new Date().toISOString() : "";
    const latestPurchaseDate =
      sanitizedPurchaseEntries[0]?.date ||
      ordersDialogRecord?.date ||
      row.createdAt ||
      "";

    await update(ref(db, `orders/${row.batchId}`), {
      purchaseHistory: sanitizedPurchaseEntries,
      goatsBought,
      remainingGoats,
      status: nextStatus,
      completedAt: nextCompletedAt,
      purchaseDate: latestPurchaseDate,
    });
  }, [ordersDialogRecord?.date, userName]);

  /** Save a new dated partial purchase without closing the parent order until the target is met */
  const saveDialogGoatsBought = async () => {
    if (!ordersDialogRow) return;
    if (!ensureOrderEditAccess()) return;
    const nextValue = Number(dialogGoatsBoughtDraft);
    if (!Number.isFinite(nextValue) || nextValue <= 0) {
      toast({ title: "Invalid value", description: "Goats purchased must be greater than 0.", variant: "destructive" });
      return;
    }
    const nextPurchaseDate = dialogPurchaseDateDraft || getTodayInputDate();
    if (!nextPurchaseDate) {
      toast({ title: "Date required", description: "Purchasing date is required.", variant: "destructive" });
      return;
    }

    try {
      await persistPurchaseHistory(ordersDialogRow, [
        ...ordersDialogRow.purchaseEntries,
        {
          id: `${ordersDialogRow.batchId}-purchase-${Date.now()}`,
          date: nextPurchaseDate,
          goats: nextValue,
          createdAt: new Date().toISOString(),
          recordedBy: userName || "Unknown",
        },
      ]);
      setDialogGoatsBoughtDraft("");
      setDialogPurchaseDateDraft(getTodayInputDate());
      toast({ title: "Purchase recorded", description: "Partial purchase saved and the order remains open until the target is fully met." });
    } catch {
      toast({ title: "Error", description: "Failed to update.", variant: "destructive" });
    }
  };

  const deletePurchaseEntry = useCallback(async (purchaseEntryId: string) => {
    if (!ordersDialogRow) return;
    if (!ensureOrderEditAccess()) return;
    const purchaseEntry = ordersDialogRow.purchaseEntries.find((entry) => entry.id === purchaseEntryId);
    if (!purchaseEntry) return;
    if (!window.confirm(`Delete the ${purchaseEntry.goats.toLocaleString()} goat purchase recorded on ${formatDate(purchaseEntry.date)}?`)) {
      return;
    }

    try {
      await persistPurchaseHistory(
        ordersDialogRow,
        ordersDialogRow.purchaseEntries.filter((entry) => entry.id !== purchaseEntryId),
      );
      toast({ title: "Purchase removed", description: "The purchase history and remaining goats were recalculated." });
    } catch {
      toast({ title: "Error", description: "Failed to remove the purchase entry.", variant: "destructive" });
    }
  }, [ensureOrderEditAccess, ordersDialogRow, persistPurchaseHistory, toast]);

  const markOrderComplete = async (row: BatchOrderRow) => {
    if (!ensureOrderEditAccess()) return;
    if (!window.confirm("Mark this order as complete?")) return;
    try {
      await update(ref(db, `orders/${row.batchId}`), {
        status: "completed",
        completedAt: row.completedAt || new Date().toISOString(),
        goatsBought: Math.max(row.targetGoats, row.totalGoats, row.goatsBought, row.recordedGoats),
        remainingGoats: 0,
      });
      toast({ title: "Completed", description: "Order marked as complete." });
    } catch {
      toast({ title: "Error", description: "Failed to mark complete.", variant: "destructive" });
    }
  };

  /* ---------------------------------------------------------------- */
  /* Inline order-item editing in submissions table                    */
  /* ---------------------------------------------------------------- */

  const startOrderEdit = (row: BatchOrderRow, item: NormalizedOrderItem, index: number) => {
    if (!ensureOrderEditAccess()) return;
    setEditingOrderKey(`${row.batchId}:${index}`);
    setOrderGoatsDraft(String(item.goats || 0));
    setOrderDateDraft(toInputDate(item.date));
    setOrderOfficerDraft(item.officer === "N/A" ? "" : item.officer || "");
    setOrderLocationDraft(item.location === "N/A" ? "" : item.location || "");
    setOrderSubcountyDraft(item.subcounty === "N/A" ? "" : item.subcounty || "");
  };

  const cancelOrderEdit = () => {
    setEditingOrderKey(null);
    setOrderGoatsDraft("");
    setOrderDateDraft("");
    setOrderOfficerDraft("");
    setOrderLocationDraft("");
    setOrderSubcountyDraft("");
  };

  const saveOrderEdit = async (row: BatchOrderRow, index: number) => {
    if (!ensureOrderEditAccess()) return;
    const nextGoats = Number(orderGoatsDraft);
    if (!Number.isFinite(nextGoats) || nextGoats < 0) {
      toast({ title: "Invalid value", description: "Goats must be 0 or greater.", variant: "destructive" });
      return;
    }
    if (!orderDateDraft) { toast({ title: "Date required", variant: "destructive" }); return; }
    const nextItems = row.items.map((item, i) =>
      i === index
        ? {
            ...item,
            goats: nextGoats,
            date: orderDateDraft,
            officer: orderOfficerDraft.trim() || item.officer,
            location: orderLocationDraft.trim() || item.location,
            subcounty: orderSubcountyDraft.trim() || item.subcounty,
          }
        : item
    );
    try {
      await updateBatchOrders(row, nextItems);
      toast({ title: "Updated", description: "Order item updated." });
      cancelOrderEdit();
    } catch {
      toast({ title: "Error", description: "Failed to update.", variant: "destructive" });
    }
  };

  const deleteOrderItem = async (row: BatchOrderRow, index: number) => {
    if (!ensureOrderEditAccess()) return;
    if (!window.confirm("Delete this order item?")) return;
    try {
      await updateBatchOrders(row, row.items.filter((_, i) => i !== index));
      toast({ title: "Deleted", description: "Order item deleted." });
    } catch {
      toast({ title: "Error", description: "Failed to delete.", variant: "destructive" });
    }
  };

  const deleteBatch = async (row: BatchOrderRow) => {
    if (!ensureBatchDeleteAccess()) return;
    if (!window.confirm("Delete this batch and all its orders?")) return;
    try {
      await remove(ref(db, `orders/${row.batchId}`));
      if (ordersDialogBatchId === row.batchId) closeOrdersDialog();
      toast({ title: "Deleted", description: "Batch deleted." });
    } catch {
      toast({ title: "Error", description: "Failed to delete.", variant: "destructive" });
    }
  };

  /* ---------------------------------------------------------------- */
  /* CSV / Excel import                                                */
  /* ---------------------------------------------------------------- */

  const handleOrderFileSelect = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] || null;
      if (!file) {
        clearOrderCsvImport();
        return;
      }
      if (!ordersDialogRow) {
        clearOrderCsvImport();
        toast({ title: "Select order", description: "Open an order before uploading data.", variant: "destructive" });
        return;
      }

      const isExcel = file.name.toLowerCase().endsWith(".xlsx") || file.name.toLowerCase().endsWith(".xls");
      const isCsv = file.name.toLowerCase().endsWith(".csv");

      if (!isExcel && !isCsv) {
        clearOrderCsvImport();
        toast({ title: "Invalid file", description: "Please select a CSV or Excel file (.csv, .xlsx, .xls).", variant: "destructive" });
        return;
      }

      setOrderCsvUploading(true);
      try {
        let parsed: ParsedOrderCsvResult;

        if (isExcel) {
          const data = await file.arrayBuffer();
          const workbook = XLSX.read(new Uint8Array(data), { type: "array" });
          const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
          const csvText = XLSX.utils.sheet_to_csv(firstSheet);
          parsed = parseOrderCsvText(csvText, ordersDialogRow);
        } else {
          const text = await file.text();
          parsed = parseOrderCsvText(text, ordersDialogRow);
        }

        setOrderCsvFile(file);
        setOrderCsvPreviewItems(parsed.items);
        setOrderCsvSkippedRows(parsed.skippedRows);
        const fileType = isExcel ? "Excel" : "CSV";
        toast({
          title: `${fileType} ready`,
          description: `${parsed.items.length} submission${parsed.items.length === 1 ? "" : "s"} parsed${parsed.skippedRows > 0 ? `, ${parsed.skippedRows} row${parsed.skippedRows === 1 ? "" : "s"} skipped` : ""}.`,
        });
      } catch (error) {
        clearOrderCsvImport();
        toast({
          title: "Import failed",
          description: error instanceof Error ? error.message : "The file could not be parsed.",
          variant: "destructive",
        });
      } finally {
        setOrderCsvUploading(false);
      }
    },
    [clearOrderCsvImport, ordersDialogRow, toast]
  );

  const importOrderFileData = useCallback(async () => {
    if (!ordersDialogRow) return;
    if (!ensureOrderEditAccess()) return;
    if (orderCsvPreviewItems.length === 0) {
      toast({ title: "No data ready", description: "Choose a file first.", variant: "destructive" });
      return;
    }

    setOrderCsvUploading(true);
    try {
      const existingIds = new Set(
        ordersDialogRow.items.map((item) => normalizeIdValue(item.id)).filter((value) => value.length > 0)
      );
      const existingSignatures = new Set(
        ordersDialogRow.items
          .filter((item) => Number(item.goats || 0) > 0 || Boolean(String(item.date || "").trim()))
          .map(getImportedSubmissionSignature)
      );

      const mergedItems = [...ordersDialogRow.items];
      let importedCount = 0;
      let duplicateCount = 0;

      for (const item of orderCsvPreviewItems) {
        const itemId = normalizeIdValue(item.id);
        const signature = getImportedSubmissionSignature(item);

        if ((itemId && existingIds.has(itemId)) || existingSignatures.has(signature)) {
          duplicateCount++;
          continue;
        }

        if (itemId) existingIds.add(itemId);
        existingSignatures.add(signature);
        mergedItems.push(item);
        importedCount++;
      }

      if (importedCount === 0) {
        toast({
          title: "Nothing imported",
          description: duplicateCount > 0 ? "All parsed rows already exist in this batch." : "No new submissions were found in the file.",
        });
        return;
      }

      await updateBatchOrders(ordersDialogRow, mergedItems);
      toast({
        title: "Data imported",
        description: `${importedCount} submission${importedCount === 1 ? "" : "s"} added${duplicateCount > 0 ? `, ${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"} skipped` : ""}.`,
      });
      clearOrderCsvImport();
    } catch {
      toast({ title: "Error", description: "Failed to import data.", variant: "destructive" });
    } finally {
      setOrderCsvUploading(false);
    }
  }, [clearOrderCsvImport, ensureOrderEditAccess, orderCsvPreviewItems, ordersDialogRow, toast]);

  /* ---------------------------------------------------------------- */
  /* Create new order                                                  */
  /* ---------------------------------------------------------------- */

  const handleCreateOrder = async () => {
    if (!ensureOrderCreateAccess()) return;
    const selectedProgramme = resolvedOrderProgramme.trim();
    if (!selectedProgramme) { toast({ title: "Select programme", variant: "destructive" }); return; }
    const selectedCounties = newOrder.counties.map((county) => county.trim()).filter(Boolean);
    const trimmedCounty = formatSelectedCounties(selectedCounties);
    const goatsValue = Number(newOrder.goats);
    const trimmedOrderCode = newOrder.orderCode.trim();

    if (!newOrder.date) { toast({ title: "Date required", variant: "destructive" }); return; }
    if (selectedCounties.length === 0) { toast({ title: "County required", variant: "destructive" }); return; }
    if (!Number.isFinite(goatsValue) || goatsValue <= 0) { toast({ title: "Invalid goats", description: "Enter the total number of goats to be collected.", variant: "destructive" }); return; }

    const selectedOfficers = countyFieldOfficers.filter((o) => selectedFieldOfficerIds.includes(o.id));
    const recipients = Array.from(new Set(selectedOfficers.map((o) => o.phone).filter(Boolean)));
    if (recipients.length === 0) { toast({ title: "No recipients", variant: "destructive" }); return; }

    setCreatingOrder(true);
    try {
      const now = new Date().toISOString();
      const orderRef = push(ref(db, "orders"));
      const orderRecordId = orderRef.key || null;
      if (!orderRecordId) throw new Error("Failed to generate order record ID.");
      const batchOrderCode = trimmedOrderCode || orderRecordId;

      await set(orderRef, {
        id: orderRecordId,
        orderId: batchOrderCode,
        programme: selectedProgramme,
        purchaseDate: "",
        date: newOrder.date,
        county: trimmedCounty,
        counties: selectedCounties,
        username: userName || "Unknown",
        status: "pending",
        createdAt: now,
        mobileAppdata: [],
        offtakeTeamIds: [],
        offtakeTeamMembers: [],
        purchaseHistory: [],
        targetGoats: goatsValue,
        totalGoats: 0,
        goatsBought: 0,
        remainingGoats: goatsValue,
      });
      const messageWithGoats = `${generatedSmsPreview} Ref: ${batchOrderCode}.`;
      const smsRef = push(ref(db, "smsOutbox"));
      await set(smsRef, {
        status: "pending",
        programme: selectedProgramme,
        createdAt: Date.now(),
        createdBy: userName || "unknown",
        message: messageWithGoats,
        recipients,
        recipientCount: recipients.length,
        orderId: batchOrderCode,
        batchId: orderRecordId,
        targetOrderId: orderRecordId,
        totalGoats: goatsValue,
      });
      if (selectedProgramme !== activeProgram) setActiveProgram(selectedProgramme);
      toast({ title: "Order created", description: `SMS queued for ${recipients.length} officers. Target: ${goatsValue.toLocaleString()} goats.` });
      closeCreateDialog();
    } catch {
      toast({ title: "Error", description: "Failed to create order.", variant: "destructive" });
    } finally {
      setCreatingOrder(false);
    }
  };

  /* ================================================================== */
  /* RENDER                                                             */
  /* ================================================================== */

  const activeQuickRange = useMemo((): "month" | "year" | "all" | null => {
    if (!filters.startDate && !filters.endDate) return "all";
    const monthDates = getCurrentMonthDates();
    const yearDates = getCurrentYearDates();
    if (filters.startDate === monthDates.startDate && filters.endDate === monthDates.endDate) return "month";
    if (filters.startDate === yearDates.startDate && filters.endDate === yearDates.endDate) return "year";
    return null;
  }, [filters.startDate, filters.endDate]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-blue-600 p-2.5 text-white shadow-md shadow-blue-200">
            <ShoppingCart className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Orders</h1>
            <p className="text-sm text-slate-600">Grouped order batches with totals and per-order breakdown.</p>
          </div>
        </div>
        {userCanCreateOrders && (
          <Button
            onClick={openCreateDialog}
            disabled={!activeProgram}
            className="w-fit gap-2 bg-blue-600 text-white shadow-md shadow-blue-200 hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            New Order
          </Button>
        )}
      </div>

      {/* Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card className="border-slate-200 border-l-4 border-l-[#0B1F5F] shadow-sm">
          <CardContent className="flex items-center gap-4 p-5">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-50 border border-blue-100">
              <ShoppingCart className="h-6 w-6 text-blue-600" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wider text-slate-600">Total Orders</p>
              <p className="text-2xl font-bold text-slate-900">{filteredBatchRows.length}</p>
              <p className="text-xs text-slate-500">{totalOrdersInBatches.toLocaleString()} submissions in batches</p>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 border-l-4 border-l-orange-500 shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-emerald-50 border border-emerald-100">
                <TrendingUp className="h-6 w-6 text-emerald-600" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wider text-slate-600">Goats Purchased</p>
                <p className="text-2xl font-bold text-slate-900">{totalGoatsPurchased.toLocaleString()}</p>
              </div>
            </div>
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-600">Target: {totalTargetGoats.toLocaleString()}</span>
                <span className={`font-semibold ${purchasePercentage >= 100 ? "text-emerald-600" : purchasePercentage >= 50 ? "text-amber-600" : "text-red-500"}`}>
                  {purchasePercentage}%
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 border border-slate-200">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${purchasePercentage >= 100 ? "bg-emerald-500" : purchasePercentage >= 50 ? "bg-amber-400" : "bg-red-400"}`}
                  style={{ width: `${Math.min(purchasePercentage, 100)}%` }}
                />
              </div>
              <p className="text-[11px] text-slate-500">
                {totalTargetGoats - totalGoatsPurchased > 0
                  ? `${(totalTargetGoats - totalGoatsPurchased).toLocaleString()} goats remaining`
                  : "Target fully achieved"}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 border-l-4 border-l-[#7B1E3A] shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-violet-50 border border-violet-100">
                <MapPin className="h-6 w-6 text-violet-600" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wider text-slate-600">Counties Covered</p>
                <p className="text-2xl font-bold text-slate-900">{uniqueCounties}</p>
              </div>
            </div>
            <div className="mt-3 max-h-[88px] space-y-1 overflow-y-auto pr-1">
              {uniqueCounties === 0 ? (
                <p className="text-xs text-slate-500">No counties yet</p>
              ) : (
                Array.from(countiesMap.entries()).map(([county, goats]) => (
                  <div key={county} className="flex items-center justify-between">
                    <span className="text-xs text-slate-700 truncate mr-2">{county}</span>
                    <span className="text-[11px] font-medium text-slate-500 tabular-nums shrink-0">
                      {formatCompactNumber(goats)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card className="border-slate-200 shadow-sm">
        <CardContent className="space-y-4 pt-5">
          <ScrollableFilterBar
            ariaLabel="Order filters"
            contentClassName="sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_auto_auto_auto_auto_auto]"
          >
            <div className="w-[260px] shrink-0 space-y-1.5 sm:w-auto">
              <Label className="text-xs font-medium text-slate-600">Search</Label>
              <Input
                placeholder="County, order code, user, status..."
                value={filters.search}
                onChange={(e) => handleFilterChange("search", e.target.value)}
                className="border-slate-200 bg-white focus:border-blue-400 focus:ring-blue-100"
              />
            </div>
            <div className="w-[156px] shrink-0 space-y-1.5 sm:w-auto">
              <Label className="text-xs font-medium text-slate-600">From</Label>
              <Input
                type="date"
                value={filters.startDate}
                onChange={(e) => handleFilterChange("startDate", e.target.value)}
                className="border-slate-200 bg-white focus:border-blue-400 focus:ring-blue-100"
              />
            </div>
            <div className="w-[156px] shrink-0 space-y-1.5 sm:w-auto">
              <Label className="text-xs font-medium text-slate-600">To</Label>
              <Input
                type="date"
                value={filters.endDate}
                onChange={(e) => handleFilterChange("endDate", e.target.value)}
                className="border-slate-200 bg-white focus:border-blue-400 focus:ring-blue-100"
              />
            </div>
            <div className="w-[148px] shrink-0 space-y-1.5 sm:w-auto">
              <Label className="text-xs font-medium text-slate-600">Status</Label>
              <Select value={filters.status} onValueChange={(v) => handleFilterChange("status", v)}>
                <SelectTrigger className="border-slate-200 bg-white focus:border-blue-400 focus:ring-blue-100 w-[140px]">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All status</SelectItem>
                  {availableStatuses.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {userIsAdmin && (
              <div className="w-[138px] shrink-0 space-y-1.5 sm:w-auto">
                <Label className="text-xs font-medium text-slate-600">Programme</Label>
                <Select value={activeProgram} onValueChange={setActiveProgram} disabled={availablePrograms.length === 0}>
                  <SelectTrigger className="border-slate-200 bg-white focus:border-blue-400 focus:ring-blue-100 w-[130px]">
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {availablePrograms.map((p) => (
                      <SelectItem key={p} value={p}>{p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <Button variant="outline" onClick={clearFilters} className="mt-6 border-slate-200 hover:bg-slate-50 shrink-0 sm:mt-0">
              Clear
            </Button>
          </ScrollableFilterBar>
        </CardContent>
      </Card>

      {/* Table */}
      <Card className="shadow-lg border-0 bg-white">
        <CardContent className="p-0">
          {loading ? (
            <div className="text-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" />
              <p className="text-muted-foreground mt-2 text-sm">Loading orders...</p>
            </div>
          ) : pageRows.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              {activeProgram
                ? filters.startDate || filters.endDate
                  ? "No orders match the selected date range. Try \"All Time\" to see all orders."
                  : "No orders found for current filters."
                : "You do not have access to any programme data."}
            </div>
          ) : (
            <>
              <div className="w-full overflow-x-auto rounded-md">
                <table className="w-full border-collapse border border-gray-300 text-sm text-left whitespace-nowrap">
                  <thead>
                    <tr className="bg-blue-500 text-White text-xs">
                      <th className="py-3 px-3 font-semibold text-white ">Order Date</th>
                      <th className="py-3 px-3 font-semibold text-white ">County</th>
                      <th className="py-3 px-3 font-semibold text-white ">Ordered By</th>
                      <th className="py-3 px-3 font-semibold text-white ">Target Goats</th>
                      <th className="py-3 px-3 font-semibold text-white ">Recorded Goats</th>
                      <th className="py-3 px-3 font-semibold text-white ">Purchased</th>
                      <th className="py-3 px-3 font-semibold text-white ">Status</th>
                      <th className="py-3 px-3 font-semibold text-white ">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((row) => (
                      <OrderTableRow
                        key={row.batchId}
                        row={row}
                        userCanEditOrders={userCanEditOrders}
                        userIsAdmin={userIsAdmin}
                        onView={openOrdersViewDialog}
                        onEdit={openOrdersEditDialog}
                        onOpenTeam={openOrdersOfftakeTeamDialog}
                        onMarkComplete={markOrderComplete}
                        onDelete={deleteBatch}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-col sm:flex-row items-center justify-between p-4 border-t bg-gray-50 gap-4">
                <div className="text-sm text-muted-foreground">
                  {filteredBatchRows.length} total records · Page {pagination.page} of {pagination.totalPages}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!pagination.hasPrev}
                    onClick={() => setPagination((prev) => ({ ...prev, page: prev.page - 1 }))}
                    className="border-gray-300 hover:bg-gray-100"
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!pagination.hasNext}
                    onClick={() => setPagination((prev) => ({ ...prev, page: prev.page + 1 }))}
                    className="border-gray-300 hover:bg-gray-100"
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Create Order Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={(open) => { if (!open) closeCreateDialog(); }}>
        <DialogContent className="sm:max-w-lg bg-white rounded-2xl border-slate-200 shadow-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-slate-900">Create Order</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {canChooseOrderProgramme && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-slate-600">Programme</Label>
                <Select
                  value={resolvedOrderProgramme}
                  onValueChange={(value) => setNewOrder((prev) => ({ ...prev, programme: value }))}
                >
                  <SelectTrigger className="border-slate-200 bg-white text-sm focus:border-blue-400">
                    <SelectValue placeholder="Select programme" />
                  </SelectTrigger>
                  <SelectContent>
                    {availablePrograms.map((programme) => (
                      <SelectItem key={programme} value={programme}>
                        {programme}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-slate-600">Order Date *</Label>
                <Input type="date" value={newOrder.date} onChange={(e) => setNewOrder((p) => ({ ...p, date: e.target.value }))} className="border-slate-200 bg-white text-sm focus:border-blue-400" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-slate-600">Target Goats *</Label>
                <Input type="number" min={1} value={newOrder.goats} onChange={(e) => setNewOrder((p) => ({ ...p, goats: e.target.value }))} placeholder="Total goats to collect" className="border-slate-200 bg-white text-sm focus:border-blue-400" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-slate-600">Counties *</Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={fieldOfficersLoading || countyOptions.length === 0}
                    className="w-full justify-between border-slate-200 bg-white text-sm font-normal"
                  >
                    <span className="truncate">
                      {fieldOfficersLoading
                        ? "Loading counties..."
                        : countyOptions.length === 0
                          ? "No assigned counties"
                          : newOrder.counties.length === 0
                            ? "Select counties"
                            : `${newOrder.counties.length} selected`}
                    </span>
                    <ChevronDown className="h-4 w-4 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="max-h-56 w-[--radix-dropdown-menu-trigger-width] overflow-y-auto" align="start">
                  {countyOptions.map((county) => (
                    <DropdownMenuCheckboxItem
                      key={county}
                      checked={newOrder.counties.includes(county)}
                      onCheckedChange={() => toggleCountySelection(county)}
                      onSelect={(event) => event.preventDefault()}
                    >
                      {county}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              {!fieldOfficersLoading && countyOptions.length === 0 && (
                <p className="text-[11px] text-slate-500">No counties found on Field Officers in site management.</p>
              )}
              {newOrder.counties.length > 0 && (
                <p className="text-[11px] text-slate-500">{formatSelectedCounties(newOrder.counties)}</p>
              )}
            </div>

            {/* Field Officers */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-slate-600">Field Officers *</Label>
              {fieldOfficersLoading ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">Loading...</div>
              ) : newOrder.counties.length === 0 ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">Select counties to load field officers.</div>
              ) : countyFieldOfficers.length === 0 ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">No field officers assigned to these counties.</div>
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" className="w-full justify-between border-slate-200 bg-white text-sm">
                      <span>{selectedOfficersSummary}</span>
                      <ChevronDown className="h-4 w-4 opacity-50" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="max-h-56 w-[--radix-dropdown-menu-trigger-width] overflow-y-auto" align="start">
                    {countyFieldOfficers.map((officer) => (
                      <DropdownMenuCheckboxItem
                        key={officer.id}
                        disabled={!officer.phone}
                        checked={selectedFieldOfficerIds.includes(officer.id)}
                        onCheckedChange={() => toggleFieldOfficerSelection(officer.id)}
                        onSelect={(e) => e.preventDefault()}
                      >
                        {officer.name}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {selectedOfficersPreview && <p className="text-[11px] text-slate-500">{selectedOfficersPreview}</p>}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
            <Button variant="outline" onClick={closeCreateDialog} disabled={creatingOrder} className="border-slate-200 text-sm">Cancel</Button>
            <Button onClick={handleCreateOrder} disabled={creatingOrder} className="bg-blue-600 text-white hover:bg-blue-700 text-sm shadow-sm">
              {creatingOrder ? "Creating..." : "Create Order"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Order Details Dialog */}
      <Dialog open={Boolean(ordersDialogBatchId && ordersDialogRow)} onOpenChange={(open) => { if (!open) closeOrdersDialog(); }}>
        <DialogContent className="sm:max-w-2xl bg-white rounded-2xl border-slate-200 shadow-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader className="border-b border-slate-100 pb-3">
            <DialogTitle className="text-slate-900">{ordersDialogIsEditing ? "Edit Order" : "Order Details"}</DialogTitle>
            {ordersDialogRow?.orderCode ? (
              <p className="text-sm font-medium text-slate-500">{ordersDialogRow.orderCode}</p>
            ) : null}
          </DialogHeader>
          {ordersDialogRow ? (
            <div className="space-y-4 px-6 pb-6 pt-4">
                {/* Summary Grid */}
                <div className="grid grid-cols-4 gap-2.5">
                {([
                  { label: "Order Date", value: formatDate(ordersDialogRow.batchDate)},
                  { label: "Order Code", value: ordersDialogRow.orderCode || "N/A" },
                  { label: "County", value: ordersDialogRow.county },
                  { label: "Status", badge: ordersDialogRow.status },
                ].filter(Boolean) as OrderSummaryItem[]).map((item) => (
                  <div key={item.label} className="rounded-lg border border-slate-150 bg-slate-50/60 p-3">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{item.label}</p>
                    {item.badge ? (
                      <Badge variant="outline" className={`mt-1 ${getStatusBadgeClass(item.badge)}`}>{item.badge}</Badge>
                    ) : (
                      <p className="mt-0.5 text-sm font-semibold text-slate-800">{item.value || "N/A"}</p>
                    )}
                    {item.sub && <p className="mt-0.5 text-[10px] text-slate-500 font-mono">{item.sub}</p>}
                  </div>
                ))}
                </div>

              {/* Status Banner */}
              {ordersDialogRow.status === "completed" ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
                  Target achieved. This order is closed.
                </div>
              ) : (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                  <p className="text-xs leading-relaxed">
                    {ordersDialogRow.remainingGoats.toLocaleString()} goats remaining.
                  </p>
                </div>
              )}

              <div className="rounded-lg border border-slate-200 overflow-hidden">
                <div className="border-b border-slate-100 bg-slate-50 px-3 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-600">Purchasing History</p>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="h-7 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Date</TableHead>
                      <TableHead className="h-7 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Purchased By</TableHead>
                      <TableHead className="h-7 px-3 py-1 text-right text-[10px] font-semibold uppercase tracking-wider text-slate-500">Goats Bought</TableHead>
                      <TableHead className="h-7 px-3 py-1 text-right text-[10px] font-semibold uppercase tracking-wider text-slate-500">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ordersDialogPurchaseLedgerRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="px-3 py-2 text-center text-[10px] text-slate-500">
                          No purchasing history recorded yet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      ordersDialogPurchaseLedgerRows.map((purchaseRow) => (
                        <TableRow key={purchaseRow.key}>
                          <TableCell className="px-3 py-1.5 text-[10px] text-slate-700">{purchaseRow.dateLabel}</TableCell>
                          <TableCell className="px-3 py-1.5 text-[10px] text-slate-700">{formatRecordName(purchaseRow.recordedBy)}</TableCell>
                          <TableCell className="px-3 py-1.5 text-right text-[10px] font-medium tabular-nums text-slate-800">
                            {purchaseRow.goats.toLocaleString()}
                          </TableCell>
                          <TableCell className="px-3 py-1.5 text-right text-[10px] font-medium tabular-nums text-slate-800">
                            {purchaseRow.balance.toLocaleString()}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>

              {/* Edit section: Purchasing Date + Goats Purchased */}
              {ordersDialogIsEditing && (
                <div className="rounded-lg border border-blue-100 bg-blue-50/40 p-4">
                  <div className="flex items-center justify-between mb-3">
                    
                    <Button size="sm" className="h-8 bg-blue-600 text-white hover:bg-blue-700 text-xs" onClick={saveDialogGoatsBought}>
                      <Save className="mr-1.5 h-3.5 w-3.5" />
                      Add Purchase
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium text-slate-600">Purchasing Date</Label>
                      <Input
                        type="date"
                        value={dialogPurchaseDateDraft}
                        onChange={(e) => setDialogPurchaseDateDraft(e.target.value)}
                        className="h-9 text-sm border-slate-200"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium text-slate-600">Goats Purchased This Round</Label>
                      <Input
                        type="number"
                        min={1}
                        value={dialogGoatsBoughtDraft}
                        onChange={(e) => setDialogGoatsBoughtDraft(e.target.value)}
                        className="h-9 text-sm border-slate-200"
                      />
                    </div>
                  </div>
                  <p className="mt-3 text-[11px] text-slate-500">
                    Remaining after the current total: {ordersDialogRow.remainingGoats.toLocaleString()} goats.
                  </p>
                </div>
              )}

              {/* Upload Mobile App Data - Edit Mode Only */}
              {ordersDialogIsEditing && (
                <div className="rounded-lg border border-slate-200 overflow-hidden">
                  <div className="border-b border-slate-100 bg-slate-50 px-4 py-2.5">
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">Upload Mobile App Data</p>
                    <p className="text-[11px] text-slate-500">Upload the CSV or Excel file exported from the mobile app for this batch.</p>
                  </div>
                  <div className="space-y-4 bg-white p-4">
                    <input
                      ref={orderCsvInputRef}
                      type="file"
                      accept=".csv,.xlsx,.xls"
                      onChange={handleOrderFileSelect}
                      className="hidden"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        className="h-9 bg-blue-600 text-white hover:bg-blue-700 text-xs"
                        onClick={() => orderCsvInputRef.current?.click()}
                        disabled={orderCsvUploading}
                      >
                        {orderCsvUploading ? (
                          <>
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            Processing...
                          </>
                        ) : (
                          <>
                            <Upload className="mr-1.5 h-3.5 w-3.5" />
                            Choose CSV/Excel
                          </>
                        )}
                      </Button>
                      {orderCsvFile ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-9 border-slate-200 text-xs"
                          onClick={clearOrderCsvImport}
                          disabled={orderCsvUploading}
                        >
                          Clear File
                        </Button>
                      ) : null}
                    </div>

                    {orderCsvFile ? (
                      <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-slate-800">{orderCsvFile.name}</p>
                            <p className="mt-1 text-[11px] text-slate-500">
                              {orderCsvPreviewItems.length} parsed row{orderCsvPreviewItems.length === 1 ? "" : "s"}
                              {orderCsvSkippedRows > 0 ? `, ${orderCsvSkippedRows} skipped` : ""}
                            </p>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            className="h-8 bg-emerald-600 text-white hover:bg-emerald-700 text-xs"
                            onClick={importOrderFileData}
                            disabled={orderCsvUploading || orderCsvPreviewItems.length === 0}
                          >
                            {orderCsvUploading ? (
                              <>
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                Importing...
                              </>
                            ) : (
                              <>
                                <Upload className="mr-1.5 h-3.5 w-3.5" />
                                Import Rows
                              </>
                            )}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              )}

              {/* Submissions Table */}
              <div className="rounded-lg border border-slate-200 overflow-hidden">
                <div className="border-b border-slate-100 bg-slate-50 px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-slate-600">
                  Field Officer Submissions ({ordersDialogItems.length})
                </div>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-b border-slate-100 bg-slate-50/50 hover:bg-slate-50/50">
                        <TableHead className="h-8 px-4 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Date</TableHead>
                        <TableHead className="h-8 px-4 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Field Officer</TableHead>
                        <TableHead className="h-8 px-4 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Location</TableHead>
                        <TableHead className="h-8 px-4 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Subcounty</TableHead>
                        <TableHead className="h-8 px-4 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">Goats</TableHead>
                        {ordersDialogIsEditing && (
                          <TableHead className="h-8 px-3 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">Actions</TableHead>
                        )}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {ordersDialogItems.map((item) => {
                        const index = ordersDialogRow.items.indexOf(item);
                        const orderKey = `${ordersDialogRow.batchId}:${index}`;
                        const isEditing = ordersDialogIsEditing && editingOrderKey === orderKey;
                        return (
                          <TableRow key={orderKey} className="border-b border-slate-50 hover:bg-blue-50/30">
                            <TableCell className="px-4 py-2">
                              {isEditing ? (
                                <Input type="date" value={orderDateDraft} onChange={(e) => setOrderDateDraft(e.target.value)} className="h-7 max-w-36 text-xs border-slate-200" />
                              ) : (
                                <span className="text-xs text-slate-700">{formatDate(item.date)}</span>
                              )}
                            </TableCell>
                            <TableCell className="px-4 py-2">
                              {isEditing ? (
                                <Input value={orderOfficerDraft} onChange={(e) => setOrderOfficerDraft(e.target.value)} className="h-7 text-xs border-slate-200" placeholder="Officer" />
                              ) : (
                                <span className="text-xs text-slate-700 max-w-[120px] truncate block">{formatRecordName(item.officer)}</span>
                              )}
                            </TableCell>
                            <TableCell className="px-4 py-2">
                              {isEditing ? (
                                <Input value={orderLocationDraft} onChange={(e) => setOrderLocationDraft(e.target.value)} className="h-7 text-xs border-slate-200" placeholder="Location" />
                              ) : (
                                <span className="text-xs text-slate-700">{item.location}</span>
                              )}
                            </TableCell>
                            <TableCell className="px-4 py-2">
                              {isEditing ? (
                                <Input value={orderSubcountyDraft} onChange={(e) => setOrderSubcountyDraft(e.target.value)} className="h-7 text-xs border-slate-200" placeholder="Subcounty" />
                              ) : (
                                <span className="text-xs text-slate-700 max-w-[100px] truncate block">{item.subcounty || "N/A"}</span>
                              )}
                            </TableCell>
                            <TableCell className="px-4 py-2 text-right">
                              {isEditing ? (
                                <Input type="number" min={0} value={orderGoatsDraft} onChange={(e) => setOrderGoatsDraft(e.target.value)} className="ml-auto h-7 max-w-24 text-right text-xs border-slate-200" />
                              ) : (
                                <span className="text-xs font-semibold tabular-nums text-slate-800">{item.goats.toLocaleString()}</span>
                              )}
                            </TableCell>
                            {ordersDialogIsEditing && (
                              <TableCell className="px-4 py-2 text-right">
                                {isEditing ? (
                                  <div className="flex justify-end gap-1">
                                    <Button size="sm" variant="outline" className="h-7 text-[11px] border-slate-200" onClick={() => saveOrderEdit(ordersDialogRow, index)}>
                                      <Save className="mr-1 h-3 w-3" />Save
                                    </Button>
                                    <Button size="sm" variant="outline" className="h-7 text-[11px] border-slate-200" onClick={cancelOrderEdit}>
                                      <X className="mr-1 h-3 w-3" />Cancel
                                    </Button>
                                  </div>
                                ) : (
                                  <div className="flex justify-end gap-0.5">
                                    <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-amber-600 hover:bg-amber-50" onClick={() => startOrderEdit(ordersDialogRow, item, index)} title="Edit">
                                      <Pencil className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-red-600 hover:bg-red-50" onClick={() => deleteOrderItem(ordersDialogRow, index)} title="Delete">
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                  </div>
                                )}
                              </TableCell>
                            )}
                          </TableRow>
                        );
                      })}
                      {ordersDialogItems.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={ordersDialogIsEditing ? 6 : 5} className="py-6 text-center text-xs text-slate-500">
                            No submissions attached yet.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Offtake Team Dialog */}
      <Dialog open={Boolean(offtakeTeamDialogBatchId && offtakeTeamDialogRow)} onOpenChange={(open) => { if (!open) closeOfftakeTeamDialog(); }}>
        <DialogContent className="sm:max-w-xl bg-white rounded-2xl border-slate-200 shadow-xl max-h-[90vh] overflow-hidden">
          <DialogHeader className="border-b border-slate-100 pb-3">
            <DialogTitle className="text-slate-900">Add Offtake Team</DialogTitle>
          </DialogHeader>

          {offtakeTeamDialogRow ? (
            <div className="space-y-4 py-4">
              <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">
                  {offtakeTeamDialogRow.county}
                </p>
                <p className="mt-1 text-sm font-medium text-slate-800">
                  Order date {formatDate(offtakeTeamDialogRow.batchDate)}
                </p>
              </div>

              <div className="rounded-lg border border-slate-200 overflow-hidden">
                <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-4 py-2.5">
                </div>

                <div className="space-y-4 bg-white p-4">
                  {userCanEditOrders ? (
                    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                      <div className="space-y-1.5">
                        <Label htmlFor="offtakeTeamName" className="text-xs font-medium text-slate-600">Team Member Name</Label>
                        <Input
                          id="offtakeTeamName"
                          list="offtake-team-name-options"
                          value={offtakeTeamFormName}
                          onChange={(e) => setOfftakeTeamFormName(e.target.value)}
                          disabled={offtakeTeamSaving}
                          placeholder="Enter team member name"
                          className="border-slate-200 bg-white text-sm focus:border-blue-400"
                        />
                        <datalist id="offtake-team-name-options">
                          {offtakeTeamDialogSystemMembers.map((member) => (
                            <option key={member.id} value={member.name} />
                          ))}
                        </datalist>
                      </div>
                      <Button
                        type="button"
                        onClick={addOfftakeTeamMember}
                        disabled={offtakeTeamSaving || !offtakeTeamFormName.trim()}
                        className="bg-blue-600 text-white hover:bg-blue-700 text-sm shadow-sm"
                      >
                        <Plus className="mr-1.5 h-4 w-4" />
                        Add Member
                      </Button>
                    </div>
                  ) : null}

                  {offtakeTeamSystemNameMatch && (
                    <div className="rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2 text-xs text-slate-600">
                      <p className="font-medium text-slate-700">{offtakeTeamSystemNameMatch.name}</p>
                      <p>This name already exists in the system and will use the saved staff record.</p>
                    </div>
                  )}

                  <div className="rounded-lg border border-slate-200 overflow-hidden">
                    <div className="border-b border-slate-100 bg-slate-50 px-4 py-2.5">
                      <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">Added Team Members</p>
                    </div>
                    <div className="max-h-[320px] divide-y divide-slate-100 overflow-y-auto bg-white">
                      {offtakeTeamDraftMembers.length === 0 ? (
                        <div className="px-4 py-6 text-sm text-slate-500">No offtake team members added yet.</div>
                      ) : (
                        offtakeTeamDraftMembers.map((member) => (
                          <div key={member.id} className="flex items-start justify-between gap-3 px-4 py-3">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-slate-800">{member.name}</p>
                              {member.counties.length > 0 && (
                                <p className="mt-0.5 text-[11px] text-slate-500">
                                  {member.counties.join(", ")}
                                </p>
                              )}
                              {(member.phone || member.email) && (
                                <p className="mt-1 text-[11px] text-slate-500">
                                  {member.phone && member.email
                                    ? `${member.phone} - ${member.email}`
                                    : member.phone || member.email}
                                </p>
                              )}
                            </div>
                            {userCanEditOrders && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-8 shrink-0 border-slate-200 text-xs"
                                disabled={offtakeTeamSaving}
                                onClick={() => removeOfftakeTeamMember(member.id)}
                              >
                                <X className="mr-1 h-3.5 w-3.5" />
                                Remove
                              </Button>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
                <Button variant="outline" onClick={closeOfftakeTeamDialog} disabled={offtakeTeamSaving} className="border-slate-200 text-sm">
                  {userCanEditOrders ? "Cancel" : "Close"}
                </Button>
                {userCanEditOrders && (
                  <Button onClick={saveOfftakeTeamAssignments} disabled={offtakeTeamSaving} className="bg-blue-600 text-white hover:bg-blue-700 text-sm shadow-sm">
                    {offtakeTeamSaving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
                    Save Team
                  </Button>
                )}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default OrdersPage;


