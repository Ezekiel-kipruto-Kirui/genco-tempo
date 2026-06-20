import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { getAuth } from "firebase/auth";
import { db, ref, set, update, remove, push, fetchCollectionByProgrammes, subscribeCollectionByProgramme } from "@/lib/firebase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollableFilterBar } from "@/components/ScrollableFilterBar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Download, Users, MapPin, Eye, Calendar, Scale, Phone, CreditCard, Edit, Trash2, Weight, Upload, Loader2 } from "lucide-react";
import { useSharedProgrammeSelection } from "@/hooks/use-shared-programme-selection";
import { toast, useToast } from "@/hooks/use-toast";
import { canViewAllProgrammes, isAdmin } from "@/contexts/authhelper";
import { cacheKey, readCachedValue, removeCachedValue, writeCachedValue } from "@/lib/data-cache";
import { matchesActiveProgramme, PROGRAMME_OPTIONS, resolveAccessibleProgrammes, resolveActiveProgramme } from "@/lib/programme-access";

// Types
interface OfftakeData {
  id: string;
  date: Date | string;
  farmerName: string;
  gender: string;
  idNumber: string;
  liveWeight: number[];
  carcassWeight: number[];
  location: string;
  noSheepGoats: number;
  phoneNumber: string;
  pricePerGoatAndSheep: number[];
  region: string;
  programme: string;
  subcounty: string;
  username: string;
  offtakeUserId: string;
  totalprice: number;
  createdAt: number;
}

interface Filters {
  search: string;
  startDate: string;
  endDate: string;
  region: string;
  gender: string;
}

interface Stats {
  totalRegions: number;
  totalAnimals: number;
  totalRevenue: number;
  averageLiveWeight: number;
  averageCarcassWeight: number;
  averageRevenue: number;
  totalFarmers: number;
  totalMaleFarmers: number;
  totalFemaleFarmers: number;
  avgPricePerCarcassKg: number;
}

interface Pagination {
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

interface EditForm {
  date: string;
  farmerName: string;
  gender: string;
  idNumber: string;
  phoneNumber: string;
  region: string;
  location: string;
}

interface WeightEditForm {
  liveWeights: number[];
  carcassWeights: number[];
  prices: number[];
}

// Constants
const PAGE_LIMIT = 15;

// --- HELPER: Clean Number for Currency/Weight ---
const cleanNumber = (val: string): number => {
  if (!val) return 0;
  const cleaned = String(val).replace(/[^0-9.-]/g, '');
  return parseFloat(cleaned) || 0;
};

interface FilterSectionProps {
  localSearchInput: string;
  filters: Filters;
  uniqueRegions: string[];
  uniqueGenders: string[];
  onSearchChange: (value: string) => void;
  onFilterChange: (key: keyof Filters, value: string) => void;
}

const FilterSection = memo(({
  localSearchInput,
  filters,
  uniqueRegions,
  uniqueGenders,
  onSearchChange,
  onFilterChange
}: FilterSectionProps) => (
  <ScrollableFilterBar
    ariaLabel="Livestock offtake filters"
    contentClassName="sm:grid-cols-2 lg:grid-cols-5"
  >
    <div className="w-[240px] shrink-0 space-y-2 sm:w-auto">
      <Label htmlFor="search" className="font-semibold text-gray-700">Search</Label>
      <Input
        id="search"
        placeholder="Search farmers..."
        value={localSearchInput}
        onChange={(e) => onSearchChange(e.target.value)}
        className="border-gray-300 focus:border-blue-500 bg-white"
      />
    </div>

    <div className="w-[190px] shrink-0 space-y-2 sm:w-auto">
      <Label htmlFor="region" className="font-semibold text-gray-700">Counties</Label>
      <Select value={filters.region} onValueChange={(value) => onFilterChange("region", value)}>
        <SelectTrigger className="border-gray-300 focus:border-blue-500 bg-white">
          <SelectValue placeholder="Select region" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">County</SelectItem>
          {uniqueRegions.slice(0, 20).map(region => (
            <SelectItem key={region} value={region}>{region}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>

    <div className="w-[190px] shrink-0 space-y-2 sm:w-auto">
      <Label htmlFor="gender" className="font-semibold text-gray-700">Gender</Label>
      <Select value={filters.gender} onValueChange={(value) => onFilterChange("gender", value)}>
        <SelectTrigger className="border-gray-300 focus:border-blue-500 bg-white">
          <SelectValue placeholder="Select gender" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Genders</SelectItem>
          {uniqueGenders.slice(0, 20).map(gender => (
            <SelectItem key={gender} value={gender}>{gender}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>

    <div className="w-[156px] shrink-0 space-y-2 sm:w-auto">
      <Label htmlFor="startDate" className="font-semibold text-gray-700">From Date</Label>
      <Input
        id="startDate"
        type="date"
        value={filters.startDate}
        onChange={(e) => onFilterChange("startDate", e.target.value)}
        className="border-gray-300 focus:border-blue-500 bg-white"
      />
    </div>

    <div className="w-[156px] shrink-0 space-y-2 sm:w-auto">
      <Label htmlFor="endDate" className="font-semibold text-gray-700">To Date</Label>
      <Input
        id="endDate"
        type="date"
        value={filters.endDate}
        onChange={(e) => onFilterChange("endDate", e.target.value)}
        className="border-gray-300 focus:border-blue-500 bg-white"
      />
    </div>
  </ScrollableFilterBar>
));


// Helper functions
const parseDate = (date: any): Date | null => {
  if (!date) return null;
  
  try {
    if (date instanceof Date) {
      return date;
    } else if (typeof date === 'string') {
      const parsed = new Date(date);
      return isNaN(parsed.getTime()) ? null : parsed;
    } else if (typeof date === 'number') {
      return new Date(date);
    }
  } catch (error) {
    console.error('Error parsing date:', error, date);
  }
  
  return null;
};

const formatDate = (date: any): string => {
  const parsedDate = parseDate(date);
  return parsedDate ? parsedDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }) : 'N/A';
};

const getOfftakeTimestamp = (record: Partial<OfftakeData> | null | undefined): number => {
  if (!record) return 0;
  const parsed = parseDate(record.date) || parseDate(record.createdAt);
  return parsed ? parsed.getTime() : 0;
};

const sortOfftakeByLatest = (records: OfftakeData[]): OfftakeData[] =>
  [...records].sort((a, b) => getOfftakeTimestamp(b) - getOfftakeTimestamp(a));

const formatDateToLocal = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatDateForInput = (date: any): string => {
  const parsedDate = parseDate(date);
  return parsedDate ? formatDateToLocal(parsedDate) : '';
};

const formatCurrency = (amount: number): string => {
  return new Intl.NumberFormat('en-KE', {
    style: 'currency',
    currency: 'KES',
  }).format(amount || 0);
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

const calculateAverage = (data: number[]): number => {
  if (!data || data.length === 0) return 0;
  const sum = data.reduce((acc, val) => acc + (Number(val) || 0), 0);
  return sum / data.length;
};

const calculateTotal = (data: number[]): number => {
  if (!data || data.length === 0) return 0;
  return data.reduce((acc, val) => acc + (Number(val) || 0), 0);
};

const isMissingFarmerId = (value: unknown): boolean => {
  const normalized = String(value ?? "").trim().toLowerCase();
  return (
    !normalized ||
    normalized === "0" ||
    normalized === "0.0" ||
    normalized === "n/a" ||
    normalized === "na" ||
    normalized === "/a" ||
    normalized === "a" ||
    normalized === "null" ||
    normalized === "undefined"
  );
};

const sanitizeGeneratedIdSegment = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);

const generateFarmerId = (
  seed: string,
  record?: Partial<Pick<OfftakeData, "farmerName" | "phoneNumber" | "location">> & {
    name?: string;
    phone?: string;
  },
): string => {
  const nameSegment = sanitizeGeneratedIdSegment(record?.farmerName || record?.name || "FARMER") || "FARMER";
  const phoneSegment = sanitizeGeneratedIdSegment(record?.phoneNumber || record?.phone || "");
  const locationSegment = sanitizeGeneratedIdSegment(record?.location || "");
  const seedValue = `${seed}|${nameSegment}|${phoneSegment}|${locationSegment}`;
  let hash = 0;

  for (let index = 0; index < seedValue.length; index += 1) {
    hash = (hash * 31 + seedValue.charCodeAt(index)) >>> 0;
  }

  const suffix = hash.toString(36).toUpperCase().padStart(6, "0").slice(-6);
  return `GEN-${nameSegment.slice(0, 4)}-${suffix}`;
};

const resolveFarmerId = (
  value: unknown,
  seed: string,
  record?: Partial<Pick<OfftakeData, "farmerName" | "phoneNumber" | "location">> & {
    name?: string;
    phone?: string;
  },
): string => (isMissingFarmerId(value) ? generateFarmerId(seed, record) : String(value).trim());

const getFarmerPhoneFromRecord = (record: Record<string, unknown>): string => {
  const candidates = [
    record.phone,
    record.phoneNumber,
    record.mobile,
    record.telephone,
    record.contact,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return "";
};

// Kept for aggregation export, but removed from main stats calculation
const getFarmerGroupingKey = (record: OfftakeData): string => {
  const normalizedId = String(record.idNumber || '').trim().toLowerCase();
  return normalizedId ? `id:${normalizedId}` : `record:${record.id}`;
};

const LivestockOfftakePage = () => {
  const { userRole, userAttribute, allowedProgrammes } = useAuth();
  const { toast } = useToast();
  const auth = getAuth();
  
  // State
  const [allOfftake, setAllOfftake] = useState<OfftakeData[]>([]);
  const [filteredOfftake, setFilteredOfftake] = useState<OfftakeData[]>([]);
  
  // Local Search State (Optimization: Prevents full re-renders on every keystroke)
  const [localSearchInput, setLocalSearchInput] = useState("");
  
  const [loading, setLoading] = useState(true);
  const [exportLoading, setExportLoading] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadPreview, setUploadPreview] = useState<any[]>([]);
  
  // Upload Progress State
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });

  const [selectedRecords, setSelectedRecords] = useState<string[]>([]);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isWeightEditDialogOpen, setIsWeightEditDialogOpen] = useState(false);
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [isBulkSmsDialogOpen, setIsBulkSmsDialogOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isSingleDeleteDialogOpen, setIsSingleDeleteDialogOpen] = useState(false);
  const [viewingRecord, setViewingRecord] = useState<OfftakeData | null>(null);
  const [editingRecord, setEditingRecord] = useState<OfftakeData | null>(null);
  const [recordToDelete, setRecordToDelete] = useState<OfftakeData | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [bulkSmsMessage, setBulkSmsMessage] = useState("");
  const [bulkSmsSending, setBulkSmsSending] = useState(false);
  const [uploadFile, setUploadFile] = useState<File[] | null>(null);
  
  const currentMonth = useMemo(getCurrentMonthDates, []);

  const [filters, setFilters] = useState<Filters>({
    search: "",
    startDate: currentMonth.startDate,
    endDate: currentMonth.endDate,
    region: "all",
    gender: "all"
  });

  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [stats, setStats] = useState<Stats>({
    totalRegions: 0,
    totalAnimals: 0,
    totalRevenue: 0,
    averageLiveWeight: 0,
    averageCarcassWeight: 0,
    averageRevenue: 0,
    totalFarmers: 0,
    totalMaleFarmers: 0,
    totalFemaleFarmers: 0,
    avgPricePerCarcassKg: 0
  });

  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: PAGE_LIMIT,
    totalPages: 1,
    hasNext: false,
    hasPrev: false
  });

  const [editForm, setEditForm] = useState<EditForm>({
    date: "",
    farmerName: "",
    gender: "",
    idNumber: "",
    phoneNumber: "",
    region: "",
    location: ""
  });

  const [weightEditForm, setWeightEditForm] = useState<WeightEditForm>({
    liveWeights: [],
    carcassWeights: [],
    prices: []
  });

  const userIsAdmin = useMemo(() => isAdmin(userRole), [userRole]);
  const userCanViewAllProgrammeData = useMemo(
    () => canViewAllProgrammes(userRole, userAttribute, allowedProgrammes),
    [allowedProgrammes, userRole, userAttribute]
  );
  const accessibleProgrammes = useMemo(
    () => resolveAccessibleProgrammes(userAttribute, allowedProgrammes),
    [allowedProgrammes, userAttribute]
  );
  const [activeProgram, setActiveProgram] = useSharedProgrammeSelection(accessibleProgrammes);
  const requireAdmin = () => {
    if (userIsAdmin) return true;
    toast({
      title: "Access denied",
      description: "Only Admin can create, edit, or delete records on this page.",
      variant: "destructive",
    });
    return false;
  };
  const offtakeCacheKey = useMemo(
    () => cacheKey("admin-page", "livestock-offtake", activeProgram),
    [activeProgram]
  );

  // --- OPTIMIZATION: Debounce Search Input ---
  useEffect(() => {
    const delay = setTimeout(() => {
      setFilters(prev => ({ ...prev, search: localSearchInput }));
      setPagination(prev => ({ ...prev, page: 1 }));
    }, 500); // 500ms debounce

    return () => clearTimeout(delay);
  }, [localSearchInput]);


  // --- HELPER: Parse CSV Line (Handles quotes) ---
  const parseCSVLine = (text: string): string[] => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current);
    return result;
  };

  // =========================================================================
  // UPDATED CSV PARSER - Handles row-spanning format:
  //   - Header row: Date, Farmer Name, Gender, ID Number, Programme,
  //     Region (County), Subcounty, Location, Phone Number, Total Animals,
  //     Live Weight (kg), Carcass Weight (kg), Price per Animal (KES), Total Price (KES)
  //   - Continuation rows: only Live Weight, Carcass Weight, Price per Animal
  //   - Blank rows separate farmer sessions
  //   - GRAND TOTALS row at the end (auto-skipped)
  // =========================================================================
  const parseCSVFile = (file: File): Promise<any[]> => new Promise((resolve) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      const text = e.target?.result as string;
      const rows = text.split('\n').filter(r => r.trim() !== '');

      if (rows.length < 2) {
        toast({
          title: "Error",
          description: "CSV file is empty or invalid.",
          variant: "destructive"
        });
        resolve([]);
        return;
      }

      // ===============================
      // 1. PARSE & NORMALIZE HEADERS
      // ===============================
      const rawHeaders = parseCSVLine(rows[0]);

      const headers = rawHeaders.map(h => ({
        original: h.trim(),
        clean: h
          .trim()
          .toLowerCase()
          .replace(/\(.*?\)/g, '')   // remove (kg), (KES)
          .replace(/[^a-z0-9 ]/g, '') // remove symbols
          .replace(/\s+/g, ' ')
      }));

      const findIndex = (keys: string[]) =>
        headers.findIndex(h => keys.some(k => h.clean.includes(k)));

      // ===============================
      // 2. TRANSACTION COLUMNS
      // ===============================
      const idxDate = findIndex(['date']);
      const idxName = findIndex(['farmer name', 'name']);
      const idxGender = findIndex(['gender']);
      const idxId = findIndex(['id number', 'idnumber', 'id']);
      const idxPhone = findIndex(['phone number', 'phone']);
      const idxCounty = findIndex(['county', 'region']);
      const idxSub = findIndex(['subcounty', 'sub county']);
      const idxLoc = findIndex(['location', 'village']);
      const idxProg = findIndex(['programme']);
      const idxUser = findIndex(['username', 'user']);
      const idxUserId = findIndex(['user id', 'offtake user id']);

      // ===============================
      // 3. ANIMAL DATA COLUMNS
      // ===============================
      // Prefer specific "price per animal" over generic "price" to avoid
      // accidentally matching the "Total Price (KES)" column.
      const idxPricePerAnimal = findIndex(['price per animal', 'price per goat', 'price per sheep']);
      const idxPrice = idxPricePerAnimal !== -1
        ? idxPricePerAnimal
        : findIndex(['price']);

      const idxLive = headers.findIndex(h => h.clean.startsWith('live weight'));
      const idxCarcass = headers.findIndex(h => h.clean.startsWith('carcass weight'));

      // Detect multi-column numbered format (e.g. "1 Live Weight", "2 Carcass Weight")
      const animalColumnMap = new Map<number, { live?: number; carcass?: number; price?: number; number?: number }>();

      headers.forEach((h, i) => {
        const match = h.clean.match(/(\d+)/);
        if (!match) return;
        const num = parseInt(match[1], 10);
        if (Number.isNaN(num)) return;

        const isLive = h.clean.includes('live weight');
        const isCarcass = h.clean.includes('carcass weight') || h.clean.includes('carcass');
        const isPrice = h.clean.includes('price');
        const isGoatNo = h.clean.includes('goat') && (h.clean.includes('number') || h.clean.includes('no'));

        if (!isLive && !isCarcass && !isPrice && !isGoatNo) return;

        const existing = animalColumnMap.get(num) || {};
        if (isLive) existing.live = i;
        if (isCarcass) existing.carcass = i;
        if (isPrice) existing.price = i;
        if (isGoatNo) existing.number = i;
        animalColumnMap.set(num, existing);
      });

      const animalColumnIndices = Array.from(animalColumnMap.keys()).sort((a, b) => a - b);
      const hasMultiAnimalColumns = animalColumnIndices.length > 0;

      const transactionsMap = new Map<string, any>();
      let lastTransactionKey: string | null = null;

      // --- Helper: Build goats from a multi-column (numbered) row ---
      const buildGoatsFromMultiColumnRow = (cols: string[]) => {
        const goats: { live: string; carcass: string; price: string }[] = [];

        for (const idx of animalColumnIndices) {
          const col = animalColumnMap.get(idx);
          const liveVal = col?.live !== undefined ? cols[col.live] : '';
          const carcassVal = col?.carcass !== undefined ? cols[col.carcass] : '';
          const priceVal = col?.price !== undefined ? cols[col.price] : (idxPrice !== -1 ? cols[idxPrice] : '');

          if (![liveVal, carcassVal, priceVal].some(v => v && v.trim() !== '')) continue;

          goats.push({
            live: liveVal ? cleanNumber(liveVal).toFixed(1) : '',
            carcass: carcassVal ? cleanNumber(carcassVal).toFixed(2) : '',
            price: priceVal ? cleanNumber(priceVal).toFixed(2) : ''
          });
        }

        return goats;
      };

      // --- Helper: Build goats from a single-row (row-spanning) format ---
      const buildGoatsFromSingleRow = (cols: string[]) => {
        const goats: { live: string; carcass: string; price: string }[] = [];

        const liveVal = idxLive !== -1 ? cols[idxLive] : '';
        const carcassVal = idxCarcass !== -1 ? cols[idxCarcass] : '';
        const priceVal = idxPrice !== -1 ? cols[idxPrice] : '';

        if (![liveVal, carcassVal, priceVal].some(v => v && v.trim() !== '')) return goats;

        goats.push({
          live: liveVal ? cleanNumber(liveVal).toFixed(1) : '',
          carcass: carcassVal ? cleanNumber(carcassVal).toFixed(2) : '',
          price: priceVal ? cleanNumber(priceVal).toFixed(2) : ''
        });

        return goats;
      };

      // --- Helper: Create a new transaction from a header row ---
      const createTransaction = (cols: string[], id: string, rawDate: string, uniqueKey: string) => {
        const loc = (cols[idxLoc] || cols[idxCounty] || 'UNK').trim();
        const prefix = loc.substring(0, 3).toUpperCase();
        const generatedUserId = `${prefix}${Math.floor(1000 + Math.random() * 9000)}`;

        let formattedDate = rawDate;
        const parsedDate = parseDate(rawDate);
        if (parsedDate) {
          formattedDate = parsedDate
            .toLocaleDateString('en-GB', {
              day: '2-digit',
              month: 'short',
              year: 'numeric'
            })
            .replace(/ /g, ' ');
        }

        let rawPhone = (cols[idxPhone] || '').trim();
        // Treat "0" as missing phone number
        if (rawPhone === '0' || rawPhone === '0.0') rawPhone = '';

        transactionsMap.set(uniqueKey, {
          date: formattedDate,
          name: (cols[idxName] || '').trim(),
          gender: (cols[idxGender] || '').trim(),
          idNumber: resolveFarmerId(id, uniqueKey, {
            name: (cols[idxName] || '').trim(),
            phone: rawPhone,
            location: loc,
          }),
          phone: rawPhone,
          county: (cols[idxCounty] || '').trim(),
          subcounty: (cols[idxSub] || '').trim(),
          location: loc,
          programme: (cols[idxProg] || activeProgram).trim(),
          username:
            (cols[idxUser] || '').trim() ||
            auth.currentUser?.displayName ||
            auth.currentUser?.email ||
            'admin',
          createdAt: Date.now(),
          offtakeUserId: idxUserId !== -1 ? (cols[idxUserId] || '').trim() : generatedUserId,
          goats: []
        });
      };

      // ===============================
      // 4. PROCESS ROWS
      // ===============================
      for (let i = 1; i < rows.length; i++) {
        const cols = parseCSVLine(rows[i]);
        if (!cols || cols.every(c => !c.trim())) continue;

        // --- Skip summary / total rows (e.g. "GRAND TOTALS (185 Sessions)") ---
        const firstColVal = (cols[0] || '').trim().toUpperCase();
        if (firstColVal.startsWith('GRAND TOTAL') || firstColVal === 'TOTAL') continue;

        const rawId = idxId !== -1 ? cols[idxId]?.trim() : '';
        const rawDate = cols[idxDate]?.trim() || '';
        const hasFarmerDetails = [idxName, idxPhone, idxCounty, idxSub, idxLoc, idxProg]
          .some((idx) => idx !== -1 && Boolean(cols[idx]?.trim()));

        // A "header row" has both ID and Date populated.
        // Continuation rows have only animal-weight columns filled.
        const isHeaderRow = !!(rawDate && (!isMissingFarmerId(rawId) || hasFarmerDetails));

        // Build unique key: header rows get id_date, continuation rows inherit
        // the last-seen transaction key so their animal data is appended there.
        const generatedSeed = `${rawDate}_${cols[idxName] || ''}_${cols[idxPhone] || ''}_${i}`;
        const id = resolveFarmerId(rawId, generatedSeed, {
          name: (cols[idxName] || '').trim(),
          phone: (cols[idxPhone] || '').trim(),
          location: (cols[idxLoc] || cols[idxCounty] || '').trim(),
        });
        const uniqueKey = isHeaderRow ? `${id}_${rawDate}` : (lastTransactionKey || '');

        if (!uniqueKey) continue;

        // --- Create transaction once per header row ---
        if (isHeaderRow && !transactionsMap.has(uniqueKey)) {
          createTransaction(cols, id, rawDate, uniqueKey);
        }

        const transaction = transactionsMap.get(uniqueKey);
        if (!transaction) continue;

        lastTransactionKey = uniqueKey;

        // --- Extract animal data from this row ---
        const goats = hasMultiAnimalColumns
          ? buildGoatsFromMultiColumnRow(cols)
          : buildGoatsFromSingleRow(cols);

        if (goats.length === 0) continue;

        goats.forEach(goat => transaction.goats.push(goat));
      }

      // ===============================
      // 5. FINAL RESULT
      // ===============================
      const transactions = Array.from(transactionsMap.values());

      if (transactions.length === 0) {
        toast({
          title: "No Data",
          description: "No valid transactions found.",
          variant: "destructive"
        });
        resolve([]);
      } else {
        toast({
          title: "Parsed Successfully",
          description: `Found ${transactions.length} transactions`
        });
        resolve(transactions);
      }
    };

    reader.readAsText(file);
  });

  // Data fetching
  useEffect(() => {
    if (!activeProgram) {
      setAllOfftake([]);
      setLoading(false);
      return;
    }

    const cachedOfftakes = readCachedValue<OfftakeData[]>(offtakeCacheKey);
    if (cachedOfftakes) {
      setAllOfftake(sortOfftakeByLatest(cachedOfftakes));
      setLoading(false);
    } else {
      setLoading(true);
    }
    
    const unsubscribe = subscribeCollectionByProgramme<Record<string, any>>("offtakes", activeProgram, (data) => {
      
      if (!data || Object.keys(data).length === 0) {
        setAllOfftake([]);
        removeCachedValue(offtakeCacheKey);
        setLoading(false);
        return;
      }

      const missingIdUpdates: Record<string, string> = {};
      const offtakeList = Object.keys(data).map((key) => {
        const item = data[key];
        
        let dateValue = item.date; 
        if (typeof dateValue === 'number') dateValue = new Date(dateValue);
        else if (typeof dateValue === 'string' && dateValue.includes('-')) {
           const d = new Date(dateValue);
           if (!isNaN(d.getTime())) dateValue = d;
        }

        const liveWeights = (item.goats || []).map((g: any) => parseFloat(g.live) || 0);
        const carcassWeights = (item.goats || []).map((g: any) => parseFloat(g.carcass) || 0);
        const prices = (item.goats || []).map((g: any) => parseFloat(g.price) || 0);

        const resolvedIdNumber = resolveFarmerId(item.idNumber, key, {
          name: item.name || item.farmerName || '',
          phone: item.phone || item.phoneNumber || '',
          location: item.location || item.county || '',
        });

        if (isMissingFarmerId(item.idNumber)) {
          missingIdUpdates[`offtakes/${key}/idNumber`] = resolvedIdNumber;
        }

        return {
          id: key,
          date: dateValue,
          farmerName: item.name || '', 
          gender: item.gender || '',
          idNumber: resolvedIdNumber,
          liveWeight: liveWeights,
          carcassWeight: carcassWeights,
          location: item.location || '',
          noSheepGoats: Number(item.totalGoats || 0),
          phoneNumber: item.phone || '', 
          pricePerGoatAndSheep: prices,
          region: item.county || '', 
          programme: item.programme || activeProgram, 
          subcounty: item.subcounty || '', 
          username: item.username || '',
          offtakeUserId: item.offtakeUserId || '',
          totalprice: Number(item.totalPrice || 0),
          createdAt: item.createdAt || Date.now()
        };
      }).filter((record) => matchesActiveProgramme(record.programme, activeProgram));

      if (Object.keys(missingIdUpdates).length > 0) {
        update(ref(db), missingIdUpdates).catch((error) => {
          console.error("Failed to assign generated farmer IDs:", error);
        });
      }

      const sortedOfftakeList = sortOfftakeByLatest(offtakeList);
      setAllOfftake(sortedOfftakeList);
      writeCachedValue(offtakeCacheKey, sortedOfftakeList);
      setLoading(false);
    }, (error) => {
      console.error("Error fetching livestock offtake data:", error);
      toast({
        title: "Error",
        description: "Failed to load livestock offtake data. You might not have permission for this programme.",
        variant: "destructive",
      });
      setLoading(false);
    });

    return () => {
       if(typeof unsubscribe === 'function') unsubscribe();
    };
  }, [activeProgram, toast, offtakeCacheKey]);

  // Filter application
  useEffect(() => {
    if (allOfftake.length === 0) {
      setFilteredOfftake([]);
      setStats({
        totalRegions: 0,
        totalAnimals: 0,
        totalRevenue: 0,
        averageLiveWeight: 0,
        averageCarcassWeight: 0,
        averageRevenue: 0,
        totalFarmers: 0,
        totalMaleFarmers: 0,
        totalFemaleFarmers: 0,
        avgPricePerCarcassKg: 0
      });
      return;
    }

    const filtered = allOfftake.filter(record => {
      if (filters.region !== "all" && record.region?.toLowerCase() !== filters.region.toLowerCase()) {
        return false;
      }

      if (filters.gender !== "all" && record.gender?.toLowerCase() !== filters.gender.toLowerCase()) {
        return false;
      }

      if (filters.startDate || filters.endDate) {
        const recordDate = parseDate(record.date);
        if (recordDate) {
          const recordDateOnly = new Date(recordDate);
          recordDateOnly.setHours(0, 0, 0, 0);

          const startDate = filters.startDate ? new Date(filters.startDate) : null;
          const endDate = filters.endDate ? new Date(filters.endDate) : null;
          
          if (startDate) startDate.setHours(0, 0, 0, 0);
          if (endDate) endDate.setHours(23, 59, 59, 999);

          if (startDate && recordDateOnly < startDate) return false;
          if (endDate && recordDateOnly > endDate) return false;
        } else if (filters.startDate || filters.endDate) {
          return false;
        }
      }

      if (filters.search) {
        const searchTerm = filters.search.toLowerCase();
        const searchMatch = [
          record.farmerName, 
          record.location, 
          record.region,
          record.subcounty, 
          record.idNumber,
          record.phoneNumber,
          record.offtakeUserId
        ].some(field => field?.toLowerCase().includes(searchTerm));
        if (!searchMatch) return false;
      }

      return true;
    });

    const sortedFiltered = sortOfftakeByLatest(filtered);
    setFilteredOfftake(sortedFiltered);
    
    const totalAnimals = sortedFiltered.reduce((sum, record) => sum + (record.noSheepGoats || 0), 0);
    const totalRevenue = sortedFiltered.reduce((sum, record) => sum + (record.totalprice || 0), 0);
    
    const uniqueRegions = new Set(sortedFiltered.map(f => f.region).filter(Boolean));

    // ==========================================
    // UPDATED LOGIC: COUNT ALL RECORDS (TRANSACTIONS)
    // ==========================================
    
    // Total Records (Transactions) - Counting every entry, including repeats
    const totalRecords = sortedFiltered.length;

    let totalMaleFarmers = 0;
    let totalFemaleFarmers = 0;
    
    // Count gender across all records
    sortedFiltered.forEach(record => {
      if (record.gender?.toLowerCase() === 'male') totalMaleFarmers++;
      else if (record.gender?.toLowerCase() === 'female') totalFemaleFarmers++;
    });

    const totalLiveWeight = sortedFiltered.reduce((sum, record) => sum + calculateTotal(record.liveWeight), 0);
    const totalCarcassWeight = sortedFiltered.reduce((sum, record) => sum + calculateTotal(record.carcassWeight || []), 0);
    
    const averageLiveWeight = totalAnimals > 0 ? totalLiveWeight / totalAnimals : 0;
    const averageCarcassWeight = totalAnimals > 0 ? totalCarcassWeight / totalAnimals : 0;
    const averageRevenue = totalAnimals > 0 ? totalRevenue / totalAnimals : 0;
    const avgPricePerCarcassKg = totalCarcassWeight > 0 ? totalRevenue / totalCarcassWeight : 0;

    setStats({
      totalRegions: uniqueRegions.size,
      totalAnimals,
      totalRevenue,
      averageLiveWeight,
      averageCarcassWeight,
      averageRevenue,
      totalFarmers: totalRecords, // Now reflects total transaction count
      totalMaleFarmers,
      totalFemaleFarmers,
      avgPricePerCarcassKg
    });

    const totalPages = Math.ceil(sortedFiltered.length / pagination.limit);
    const currentPage = Math.min(pagination.page, Math.max(1, totalPages));
    
    setPagination(prev => ({
      ...prev,
      page: currentPage,
      totalPages,
      hasNext: currentPage < totalPages,
      hasPrev: currentPage > 1
    }));

  }, [allOfftake, filters, pagination.limit]);

  function safeTruncate(value: string | number) {
    let str = String(value);
    str = str.replace(/[^0-9.]/g, "");
    const num = Number(str);
    if (isNaN(num)) return "Invalid Number";
    if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + "B";
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M";
    if (num >= 1_000) return (num / 1_000).toFixed(1) + "K";
    return num.toLocaleString();
  }

  // --- Handlers ---

  const handleProgramChange = (program: string) => {
    setActiveProgram(program);
    setFilters({
      search: "",
      startDate: currentMonth.startDate,
      endDate: currentMonth.endDate,
      region: "all",
      gender: "all"
    });
    setLocalSearchInput(""); // Reset local search input
    setPagination(prev => ({ ...prev, page: 1 }));
    setSelectedRecords([]);
  };

  const handleFilterChange = useCallback((key: keyof Filters, value: string) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    setPagination(prev => ({ ...prev, page: 1 }));
  }, []);

  const handleExport = async () => {
    try {
      setExportLoading(true);
      
      if (filteredOfftake.length === 0) {
        toast({
          title: "No Data to Export",
          description: "There are no records matching your current filters",
          variant: "destructive",
        });
        return;
      }

      const headers = [
        'Date', 'Farmer Name', 'Gender', 'ID Number', 'Programme', 'Region (County)', 
        'Subcounty', 'Location', 'Phone Number', 'Total Animals', 
        'Live Weight (kg)', 'Carcass Weight (kg)', 'Price per Animal (KES)', 'Total Price (KES)'
      ];

      const csvData = [];

      filteredOfftake.forEach(record => {
        const liveWeights = Array.isArray(record.liveWeight) ? record.liveWeight : [record.liveWeight || 0];
        const carcassWeights = Array.isArray(record.carcassWeight) ? record.carcassWeight : [record.carcassWeight || 0];
        const prices = Array.isArray(record.pricePerGoatAndSheep) ? record.pricePerGoatAndSheep : [record.pricePerGoatAndSheep || 0];

        const numAnimals = Math.max(liveWeights.length, carcassWeights.length, prices.length, record.noSheepGoats || 1);

        for (let i = 0; i < numAnimals; i++) {
          const liveWeight = liveWeights[i] !== undefined ? Number(liveWeights[i]) : null;
          const carcassWeight = carcassWeights[i] !== undefined ? Number(carcassWeights[i]) : null;
          const price = prices[i] !== undefined ? Number(prices[i]) : null;

          const row = [
            i === 0 ? formatDate(record.date) : '',
            i === 0 ? (record.farmerName || 'N/A') : '',
            i === 0 ? (record.gender || 'N/A') : '',
            i === 0 ? (record.idNumber || 'N/A') : '',
            i === 0 ? (record.programme || 'N/A') : '',
            i === 0 ? (record.region || 'N/A') : '',
            i === 0 ? (record.subcounty || 'N/A') : '',
            i === 0 ? (record.location || 'N/A') : '',
            i === 0 ? (record.phoneNumber || 'N/A') : '',
            i === 0 ? (record.noSheepGoats || 0).toString() : '',
            liveWeight !== null && liveWeight > 0 ? liveWeight.toFixed(1) : '',
            carcassWeight !== null && carcassWeight > 0 ? carcassWeight.toFixed(2) : '',
            price !== null && price > 0 ? price.toFixed(2) : '',
            i === 0 ? (record.totalprice || 0).toFixed(2) : ''
          ];
          csvData.push(row);
        }

        csvData.push(Array(headers.length).fill(''));
      });

      const totalAnimals = filteredOfftake.reduce((sum, record) => sum + (record.noSheepGoats || 0), 0);
      const totalRevenue = filteredOfftake.reduce((sum, record) => sum + (record.totalprice || 0), 0);
      const grandTotalRow = [
        `GRAND TOTALS (${filteredOfftake.length} Sessions)`, '', '', '', '', '', '', '', '', 
        totalAnimals.toString(), '', '', '', totalRevenue.toFixed(2)
      ];

      const csvContent = [headers, ...csvData, grandTotalRow]
        .map(row => row.map(field => `"${field}"`).join(','))
        .join('\n');

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      
      const programLabel = userIsAdmin ? activeProgram : "ASSIGNED_PROGRAMS";
      let filename = `livestock-offtake-${programLabel}`;
      if (filters.startDate || filters.endDate) {
        filename += `_${filters.startDate || 'start'}_to_${filters.endDate || 'end'}`;
      }
      filename += `_${new Date().toISOString().split('T')[0]}.csv`;
      
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      toast({
        title: "Export Successful",
        description: `Exported detailed data for ${filteredOfftake.length} sessions`,
      });

    } catch (error) {
      console.error("Error exporting data:", error);
      toast({
        title: "Export Failed",
        description: "Failed to export data. Please try again.",
        variant: "destructive",
      });
    } finally {
      setExportLoading(false);
    }
  };

  const handleExportAggregatedByFarmer = async () => {
    try {
      setExportLoading(true);

      if (filteredOfftake.length === 0) {
        toast({
          title: "No Data to Export",
          description: "There are no records matching your current filters",
          variant: "destructive",
        });
        return;
      }

      type AggregatedFarmer = {
        idNumber: string;
        farmerName: string;
        gender: string;
        programme: string;
        region: string;
        subcounty: string;
        location: string;
        phoneNumber: string;
        sessions: number;
        totalAnimals: number;
        totalLiveWeight: number;
        totalCarcassWeight: number;
        totalRevenue: number;
      };

      const groupedFarmers = new Map<string, AggregatedFarmer>();

      filteredOfftake.forEach((record) => {
        const groupKey = getFarmerGroupingKey(record);
        const existing = groupedFarmers.get(groupKey);

        const liveWeightSum = calculateTotal(
          Array.isArray(record.liveWeight) ? record.liveWeight : [Number(record.liveWeight) || 0],
        );
        const carcassWeightSum = calculateTotal(
          Array.isArray(record.carcassWeight) ? record.carcassWeight : [Number(record.carcassWeight) || 0],
        );

        if (!existing) {
          groupedFarmers.set(groupKey, {
            idNumber: record.idNumber || 'N/A',
            farmerName: record.farmerName || 'N/A',
            gender: record.gender || 'N/A',
            programme: record.programme || 'N/A',
            region: record.region || 'N/A',
            subcounty: record.subcounty || 'N/A',
            location: record.location || 'N/A',
            phoneNumber: record.phoneNumber || 'N/A',
            sessions: 1,
            totalAnimals: Number(record.noSheepGoats) || 0,
            totalLiveWeight: liveWeightSum,
            totalCarcassWeight: carcassWeightSum,
            totalRevenue: Number(record.totalprice) || 0,
          });
          return;
        }

        existing.sessions += 1;
        existing.totalAnimals += Number(record.noSheepGoats) || 0;
        existing.totalLiveWeight += liveWeightSum;
        existing.totalCarcassWeight += carcassWeightSum;
        existing.totalRevenue += Number(record.totalprice) || 0;

        if (existing.farmerName === 'N/A' && record.farmerName) existing.farmerName = record.farmerName;
        if (existing.gender === 'N/A' && record.gender) existing.gender = record.gender;
        if (existing.phoneNumber === 'N/A' && record.phoneNumber) existing.phoneNumber = record.phoneNumber;
        if (existing.region === 'N/A' && record.region) existing.region = record.region;
        if (existing.subcounty === 'N/A' && record.subcounty) existing.subcounty = record.subcounty;
        if (existing.location === 'N/A' && record.location) existing.location = record.location;
      });

      const aggregatedFarmers = Array.from(groupedFarmers.values());

      const headers = [
        'ID Number',
        'Farmer Name',
        'Gender',
        'Programme',
        'Region (County)',
        'Subcounty',
        'Location',
        'Phone Number',
        'Sessions',
        'Total Animals',
        'Total Live Weight (kg)',
        'Total Carcass Weight (kg)',
        'Total Revenue (KES)',
      ];

      const csvRows = aggregatedFarmers.map((farmer) => [
        farmer.idNumber,
        farmer.farmerName,
        farmer.gender,
        farmer.programme,
        farmer.region,
        farmer.subcounty,
        farmer.location,
        farmer.phoneNumber,
        farmer.sessions.toString(),
        farmer.totalAnimals.toString(),
        farmer.totalLiveWeight.toFixed(1),
        farmer.totalCarcassWeight.toFixed(2),
        farmer.totalRevenue.toFixed(2),
      ]);

      const totals = aggregatedFarmers.reduce((acc, farmer) => {
        acc.sessions += farmer.sessions;
        acc.animals += farmer.totalAnimals;
        acc.liveWeight += farmer.totalLiveWeight;
        acc.carcassWeight += farmer.totalCarcassWeight;
        acc.revenue += farmer.totalRevenue;
        return acc;
      }, { sessions: 0, animals: 0, liveWeight: 0, carcassWeight: 0, revenue: 0 });

      const grandTotalRow = [
        `GRAND TOTALS (${aggregatedFarmers.length} Farmers)`,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        totals.sessions.toString(),
        totals.animals.toString(),
        totals.liveWeight.toFixed(1),
        totals.carcassWeight.toFixed(2),
        totals.revenue.toFixed(2),
      ];

      const csvContent = [headers, ...csvRows, grandTotalRow]
        .map((row) => row.map((field) => `"${field}"`).join(','))
        .join('\n');

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;

      const programLabel = userIsAdmin ? activeProgram : "ASSIGNED_PROGRAMS";
      let filename = `livestock-offtake-aggregated-${programLabel}`;
      if (filters.startDate || filters.endDate) {
        filename += `_${filters.startDate || 'start'}_to_${filters.endDate || 'end'}`;
      }
      filename += `_${new Date().toISOString().split('T')[0]}.csv`;

      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      toast({
        title: "Export Successful",
        description: `Exported aggregated data for ${aggregatedFarmers.length} unique farmers`,
      });
    } catch (error) {
      console.error("Error exporting aggregated data:", error);
      toast({
        title: "Export Failed",
        description: "Failed to export aggregated data. Please try again.",
        variant: "destructive",
      });
    } finally {
      setExportLoading(false);
    }
  };

  const handleExportFarmerOfftakeSummary = async () => {
    try {
      setExportLoading(true);

      if (filteredOfftake.length === 0) {
        toast({
          title: "No Data to Export",
          description: "There are no records matching your current filters",
          variant: "destructive",
        });
        return;
      }

      type FarmerOfftakeSummary = {
        farmerName: string;
        latestDate: string;
        latestDateTimestamp: number;
        totalAnimals: number;
        carcassWeightTotal: number;
        carcassWeightCount: number;
        liveWeightTotal: number;
        liveWeightCount: number;
        priceTotal: number;
        priceCount: number;
      };

      const summaries = new Map<string, FarmerOfftakeSummary>();

      filteredOfftake.forEach((record) => {
        const farmerName = record.farmerName?.trim() || "N/A";
        const key = farmerName.toLowerCase();
        const liveWeights = (Array.isArray(record.liveWeight) ? record.liveWeight : [Number(record.liveWeight) || 0])
          .map(Number)
          .filter((value) => Number.isFinite(value) && value > 0);
        const carcassWeights = (Array.isArray(record.carcassWeight) ? record.carcassWeight : [Number(record.carcassWeight) || 0])
          .map(Number)
          .filter((value) => Number.isFinite(value) && value > 0);
        const prices = (Array.isArray(record.pricePerGoatAndSheep) ? record.pricePerGoatAndSheep : [Number(record.pricePerGoatAndSheep) || 0])
          .map(Number)
          .filter((value) => Number.isFinite(value) && value > 0);
        const totalAnimals = Number(record.noSheepGoats) || 0;
        const totalPrice = Number(record.totalprice) || 0;
        const priceValues = prices.length > 0
          ? prices
          : totalPrice > 0 && totalAnimals > 0
            ? [totalPrice / totalAnimals]
            : [];

        // Compute the timestamp for this record's date for comparison
        const recordDateTimestamp = getOfftakeTimestamp(record);
        const recordDateFormatted = formatDate(record.date);

        const existing = summaries.get(key);

        if (!existing) {
          summaries.set(key, {
            farmerName,
            latestDate: recordDateFormatted,
            latestDateTimestamp: recordDateTimestamp,
            totalAnimals,
            carcassWeightTotal: calculateTotal(carcassWeights),
            carcassWeightCount: carcassWeights.length,
            liveWeightTotal: calculateTotal(liveWeights),
            liveWeightCount: liveWeights.length,
            priceTotal: calculateTotal(priceValues),
            priceCount: priceValues.length,
          });
          return;
        }

        // Keep the most recent date
        if (recordDateTimestamp > existing.latestDateTimestamp) {
          existing.latestDate = recordDateFormatted;
          existing.latestDateTimestamp = recordDateTimestamp;
        }

        existing.totalAnimals += totalAnimals;
        existing.carcassWeightTotal += calculateTotal(carcassWeights);
        existing.carcassWeightCount += carcassWeights.length;
        existing.liveWeightTotal += calculateTotal(liveWeights);
        existing.liveWeightCount += liveWeights.length;
        existing.priceTotal += calculateTotal(priceValues);
        existing.priceCount += priceValues.length;
      });

      const summaryRows = Array.from(summaries.values()).sort((left, right) =>
        left.farmerName.localeCompare(right.farmerName),
      );

      const headers = [
        "Date",
        "Farmer Name",
        "Number of Animals",
        "Average Carcass Weight (kg)",
        "Average Live Weight (kg)",
        "Average Price (KES)",
      ];

      const rows = summaryRows.map((summary) => [
        summary.latestDate,
        summary.farmerName,
        summary.totalAnimals.toString(),
        (summary.carcassWeightCount > 0 ? summary.carcassWeightTotal / summary.carcassWeightCount : 0).toFixed(2),
        (summary.liveWeightCount > 0 ? summary.liveWeightTotal / summary.liveWeightCount : 0).toFixed(1),
        (summary.priceCount > 0 ? summary.priceTotal / summary.priceCount : 0).toFixed(2),
      ]);

      const totals = summaryRows.reduce(
        (acc, summary) => {
          acc.carcassWeight += summary.carcassWeightTotal;
          acc.carcassWeightCount += summary.carcassWeightCount;
          acc.liveWeight += summary.liveWeightTotal;
          acc.liveWeightCount += summary.liveWeightCount;
          acc.animals += summary.totalAnimals;
          acc.price += summary.priceTotal;
          acc.priceCount += summary.priceCount;
          return acc;
        },
        { carcassWeight: 0, carcassWeightCount: 0, liveWeight: 0, liveWeightCount: 0, animals: 0, price: 0, priceCount: 0 },
      );

      const grandTotalRow = [
        "",
        `GRAND TOTALS (${summaryRows.length} Farmers)`,
        totals.animals.toString(),
        (totals.carcassWeightCount > 0 ? totals.carcassWeight / totals.carcassWeightCount : 0).toFixed(2),
        (totals.liveWeightCount > 0 ? totals.liveWeight / totals.liveWeightCount : 0).toFixed(1),
        (totals.priceCount > 0 ? totals.price / totals.priceCount : 0).toFixed(2),
      ];

      const csvContent = [headers, ...rows, grandTotalRow]
        .map((row) => row.map((field) => `"${String(field).replace(/"/g, '""')}"`).join(","))
        .join("\n");

      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;

      const programLabel = userIsAdmin ? activeProgram : "ASSIGNED_PROGRAMS";
      let filename = `livestock-offtake-farmer-summary-${programLabel}`;
      if (filters.startDate || filters.endDate) {
        filename += `_${filters.startDate || "start"}_to_${filters.endDate || "end"}`;
      }
      filename += `_${new Date().toISOString().split("T")[0]}.csv`;

      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      toast({
        title: "Export Successful",
        description: `Exported farmer summary for ${summaryRows.length} farmers`,
      });
    } catch (error) {
      console.error("Error exporting farmer summary:", error);
      toast({
        title: "Export Failed",
        description: "Failed to export farmer summary. Please try again.",
        variant: "destructive",
      });
    } finally {
      setExportLoading(false);
    }
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    setUploadFile(files);
    setUploadProgress({ current: 0, total: 0 });
    setUploadPreview([]);

    const parsedSets = await Promise.all(files.map(parseCSVFile));
    const combined = parsedSets.flat();
    setUploadPreview(combined);
  };

  // --- OPTIMIZED BULK UPLOAD HANDLER (Non-blocking) ---
  const handleUpload = async () => {
    if (!requireAdmin()) return;
    if (uploadPreview.length === 0) {
      toast({ title: "Error", description: "No data to upload", variant: "destructive" });
      return;
    }

    try {
      setUploadLoading(true);
      const totalRecords = uploadPreview.length;
      setUploadProgress({ current: 0, total: totalRecords });

      const BATCH_SIZE = 2000; 
      let processedCount = 0;

      const processBatch = async (startIndex: number) => {
        if (startIndex >= totalRecords) {
          setUploadLoading(false);
          setIsUploadDialogOpen(false);
          setUploadFile(null);
          setUploadPreview([]);
          setUploadProgress({ current: 0, total: 0 });
          toast({
            title: "Upload Successful",
            description: `Uploaded ${totalRecords} transactions to Firebase.`,
          });
          return;
        }

        const endIndex = Math.min(startIndex + BATCH_SIZE, totalRecords);
        const batch = uploadPreview.slice(startIndex, endIndex);
        const updates: Record<string, any> = {};

        batch.forEach(record => {
          const newKey = push(ref(db, 'offtakes')).key;
          if (!newKey) return;

          const totalGoats = record.goats.length;
          const totalPrice = record.goats.reduce((sum: number, g: any) => sum + parseFloat(g.price), 0);
          
          updates[`offtakes/${newKey}`] = {
            county: record.county,
            createdAt: record.createdAt,
            date: record.date,
            gender: record.gender,
            idNumber: record.idNumber,
            location: record.location,
            name: record.name,
            offtakeUserId: record.offtakeUserId,
            phone: record.phone,
            programme: record.programme,
            subcounty: record.subcounty,
            username: record.username,
            totalGoats: totalGoats,
            totalPrice: totalPrice,
            goats: record.goats
          };
        });

        if (Object.keys(updates).length > 0) {
          await update(ref(db), updates);
          removeCachedValue(offtakeCacheKey);
          processedCount += batch.length;
          setUploadProgress({ current: processedCount, total: totalRecords });
        }

        setTimeout(() => processBatch(endIndex), 0);
      };

      processBatch(0);

    } catch (error) {
      console.error("Error uploading:", error);
      setUploadLoading(false);
      toast({
        title: "Upload Failed",
        description: "Check permissions or network connection.",
        variant: "destructive"
      });
    }
  };

  const handlePageChange = useCallback((newPage: number) => {
    setPagination(prev => {
      const totalPages = Math.ceil(filteredOfftake.length / prev.limit);
      const validatedPage = Math.max(1, Math.min(newPage, totalPages));
      
      return {
        ...prev,
        page: validatedPage,
        hasNext: validatedPage < totalPages,
        hasPrev: validatedPage > 1
      };
    });
  }, [filteredOfftake.length]);

  const getCurrentPageRecords = useCallback(() => {
    const startIndex = (pagination.page - 1) * pagination.limit;
    const endIndex = startIndex + pagination.limit;
    return filteredOfftake.slice(startIndex, endIndex);
  }, [filteredOfftake, pagination.page, pagination.limit]);

  const handleSelectRecord = useCallback((recordId: string) => {
    setSelectedRecords(prev =>
      prev.includes(recordId)
        ? prev.filter(id => id !== recordId)
        : [...prev, recordId]
    );
  }, []);

  const handleSelectAll = useCallback(() => {
    const currentPageIds = getCurrentPageRecords().map(f => f.id);
    setSelectedRecords(prev =>
      prev.length === currentPageIds.length ? [] : currentPageIds
    );
  }, [getCurrentPageRecords]);

  const openViewDialog = useCallback((record: OfftakeData) => {
    setViewingRecord(record);
    setIsViewDialogOpen(true);
  }, []);

  const openEditDialog = useCallback((record: OfftakeData) => {
    if (!userIsAdmin) return;
    setEditingRecord(record);
    setEditForm({
      date: formatDateForInput(record.date),
      farmerName: record.farmerName || "",
      gender: record.gender || "",
      idNumber: record.idNumber || "",
      phoneNumber: record.phoneNumber || "",
      region: record.region || "",
      location: record.location || ""
    });
    setIsEditDialogOpen(true);
  }, [userIsAdmin]);

  const openWeightEditDialog = useCallback((record: OfftakeData) => {
    if (!userIsAdmin) return;
    setEditingRecord(record);
    
    const liveWeights = Array.isArray(record.liveWeight) ? record.liveWeight : [record.liveWeight || 0];
    const carcassWeights = Array.isArray(record.carcassWeight) ? record.carcassWeight : [record.carcassWeight || 0];
    const prices = Array.isArray(record.pricePerGoatAndSheep) ? record.pricePerGoatAndSheep : [record.pricePerGoatAndSheep || 0];
    
    const numAnimals = Math.max(liveWeights.length, carcassWeights.length, prices.length, record.noSheepGoats || 1);
    
    const paddedLiveWeights = [...liveWeights];
    const paddedCarcassWeights = [...carcassWeights];
    const paddedPrices = [...prices];
    
    while (paddedLiveWeights.length < numAnimals) paddedLiveWeights.push(0);
    while (paddedCarcassWeights.length < numAnimals) paddedCarcassWeights.push(0);
    while (paddedPrices.length < numAnimals) paddedPrices.push(0);

    setWeightEditForm({
      liveWeights: paddedLiveWeights,
      carcassWeights: paddedCarcassWeights,
      prices: paddedPrices
    });
    
    setIsWeightEditDialogOpen(true);
  }, [userIsAdmin]);

  const handleSingleDelete = async () => {
    if (!requireAdmin()) return;
    if (!recordToDelete) return;
    try {
      setDeleteLoading(true);
      await remove(ref(db, `offtakes/${recordToDelete.id}`));
      removeCachedValue(offtakeCacheKey);

      toast({
        title: "Success",
        description: "Record deleted successfully",
      });

      setIsSingleDeleteDialogOpen(false);
      setRecordToDelete(null);
      setSelectedRecords(prev => prev.filter(id => id !== recordToDelete.id));
      
    } catch (error) {
      console.error("Error deleting record:", error);
      toast({
        title: "Error",
        description: "Failed to delete record",
        variant: "destructive",
      });
    } finally {
      setDeleteLoading(false);
    }
  };

  const openSingleDeleteConfirm = useCallback((record: OfftakeData) => {
    if (!userIsAdmin) return;
    setRecordToDelete(record);
    setIsSingleDeleteDialogOpen(true);
  }, [userIsAdmin]);

  const openBulkDeleteConfirm = () => {
    if (!requireAdmin()) return;
    if (selectedRecords.length === 0) {
      toast({
        title: "No Records Selected",
        description: "Please select records to delete",
        variant: "destructive",
      });
      return;
    }
    setIsDeleteConfirmOpen(true);
  };

  const handleDeleteMultiple = async () => {
    if (!requireAdmin()) return;
    if (selectedRecords.length === 0) return;
    try {
      setDeleteLoading(true);
      const updates: { [key: string]: null } = {};
      selectedRecords.forEach(recordId => {
        updates[`offtakes/${recordId}`] = null;
      });
      await update(ref(db), updates);
      removeCachedValue(offtakeCacheKey);

      toast({ title: "Success", description: `Deleted ${selectedRecords.length} records.` });
      setSelectedRecords([]);
      setIsDeleteConfirmOpen(false);
    } catch (error) {
      toast({ title: "Error", description: "Failed to delete", variant: "destructive" });
    } finally {
      setDeleteLoading(false);
    }
  };

  const openBulkSmsDialog = () => {
    if (selectedRecords.length === 0) {
      toast({
        title: "No Records Selected",
        description: "Select farmers to send bulk SMS.",
        variant: "destructive",
      });
      return;
    }
    setIsBulkSmsDialogOpen(true);
  };

  const handleSendBulkSms = async () => {
    const message = bulkSmsMessage.trim();
    if (!message) {
      toast({
        title: "Message Required",
        description: "Enter the SMS message to send.",
        variant: "destructive",
      });
      return;
    }

    const selectedSet = new Set(selectedRecords);
    const selectedOfftakes = allOfftake.filter((record) => selectedSet.has(record.id));
    const farmerPhonesById = new Map<string, string>();

    try {
      const farmersData = await fetchCollectionByProgrammes<any>("farmers", [activeProgram]);
      for (const farmer of farmersData) {
        const farmerIdNumber = typeof farmer.idNumber === "string" ? farmer.idNumber.trim().toLowerCase() : "";
        const farmerPhone = getFarmerPhoneFromRecord(farmer);
        if (farmerIdNumber && farmerPhone && !farmerPhonesById.has(farmerIdNumber)) {
          farmerPhonesById.set(farmerIdNumber, farmerPhone);
        }
      }
    } catch (error) {
      console.error("Failed to load farmer phone numbers from Realtime Database:", error);
    }

    const recipients = selectedOfftakes
      .map((record) => {
        const directPhone = String(record.phoneNumber || "").trim();
        if (directPhone) return directPhone;

        const idNumberKey = String(record.idNumber || "").trim().toLowerCase();
        if (!idNumberKey) return "";
        return farmerPhonesById.get(idNumberKey) || "";
      })
      .filter((phone) => phone.length > 0);
    const uniqueRecipients = Array.from(new Set(recipients));

    if (uniqueRecipients.length === 0) {
      toast({
        title: "No Phone Numbers",
        description: "No valid phone numbers found in Realtime Database for selected farmers.",
        variant: "destructive",
      });
      return;
    }

    setBulkSmsSending(true);
    try {
      const requestRef = push(ref(db, "smsOutbox"));
      await set(requestRef, {
        status: "pending",
        sourcePage: "livestock-offtake",
        programme: activeProgram,
        createdAt: Date.now(),
        createdBy: auth.currentUser?.email || auth.currentUser?.uid || "unknown",
        message,
        recipients: uniqueRecipients,
        selectedRecordCount: selectedRecords.length,
      });

      toast({
        title: "SMS Queued",
        description: `Bulk SMS queued for ${uniqueRecipients.length} farmers.`,
      });
      setBulkSmsMessage("");
      setIsBulkSmsDialogOpen(false);
    } catch (error) {
      console.error("Failed to queue bulk SMS:", error);
      toast({
        title: "Queue Failed",
        description: "Failed to queue bulk SMS.",
        variant: "destructive",
      });
    } finally {
      setBulkSmsSending(false);
    }
  };

  const handleEditSubmit = async () => {
    if (!requireAdmin()) return;
    if (!editingRecord) return;

    try {
      await update(ref(db, `offtakes/${editingRecord.id}`), {
        date: editForm.date ? new Date(editForm.date).toISOString() : null,
        name: editForm.farmerName,
        gender: editForm.gender,
        idNumber: editForm.idNumber,
        phone: editForm.phoneNumber,
        county: editForm.region,
        location: editForm.location
      });
      removeCachedValue(offtakeCacheKey);

      toast({ title: "Success", description: "Record updated successfully" });
      setIsEditDialogOpen(false);
      setEditingRecord(null);
    } catch (error) {
      console.error("Error updating record:", error);
      toast({ title: "Error", description: "Failed to update", variant: "destructive" });
    }
  };

  const handleWeightEditSubmit = async () => {
    if (!requireAdmin()) return;
    if (!editingRecord) return;

    try {
      const filteredLiveWeights = weightEditForm.liveWeights.filter(w => w > 0);
      const filteredCarcassWeights = weightEditForm.carcassWeights.filter(w => w > 0);
      const filteredPrices = weightEditForm.prices.filter(p => p > 0);

      const newGoatsArray = filteredLiveWeights.map((live, index) => ({
        live: String(live.toFixed(1)),
        carcass: String(filteredCarcassWeights[index]?.toFixed(2) || "0.00"),
        price: String(filteredPrices[index]?.toFixed(2) || "0.00")
      }));

      const newTotalPrice = filteredPrices.reduce((sum, price) => sum + price, 0);

      await update(ref(db, `offtakes/${editingRecord.id}`), {
        goats: newGoatsArray,
        totalGoats: newGoatsArray.length,
        totalPrice: newTotalPrice
      });
      removeCachedValue(offtakeCacheKey);

      toast({ title: "Success", description: "Weights and prices updated" });
      setIsWeightEditDialogOpen(false);
      setEditingRecord(null);
    } catch (error) {
      console.error("Error updating weights:", error);
      toast({ title: "Error", description: "Failed to update weights", variant: "destructive" });
    }
  };

  const uniqueRegions = useMemo(() => {
    const regions = [...new Set(allOfftake.map(f => f.region).filter(Boolean))];
    return regions;
  }, [allOfftake]);

  const uniqueGenders = useMemo(() => {
    const genders = [...new Set(allOfftake.map(f => f.gender).filter(Boolean))];
    return genders;
  }, [allOfftake]);

  const currentPageRecords = useMemo(getCurrentPageRecords, [getCurrentPageRecords]);

  const clearAllFilters = useCallback(() => {
    setFilters({
      search: "",
      startDate: "",
      endDate: "",
      region: "all",
      gender: "all"
    });
    setLocalSearchInput(""); // Reset local input
    setPagination(prev => ({ ...prev, page: 1 }));
  }, []);

  const resetToCurrentMonth = useCallback(() => {
    setFilters(prev => ({
        ...prev,
        startDate: currentMonth.startDate,
        endDate: currentMonth.endDate
    }));
    setPagination(prev => ({ ...prev, page: 1 }));
  }, [currentMonth]);

  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, []);

  const availableProgramsForSelect = useMemo(
    () => resolveAccessibleProgrammes(userAttribute, allowedProgrammes),
    [allowedProgrammes, userAttribute]
  );

  const StatsCard = useMemo(() => ({ title, value, icon: Icon, description, subValue }: any) => (
    <Card className="bg-white text-slate-900 shadow-lg border border-gray-200 relative overflow-hidden">
      <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-blue-500 to-purple-600"></div>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 pt-4 pl-6">
        <CardTitle className="text-sm font-medium text-gray-400">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pl-6 pb-4 flex flex-row">
        <div className="mr-2 rounded-full">
          <Icon className="h-8 w-8 text-blue-600" />
        </div>
        <div>
          <div className="text-xl font-bold text-green-500 mb-2">{value}</div>
          {subValue && <div className="text-sm font-medium text-slate-600 mb-2">{subValue}</div>}
          {description && <p className="text-[10px] mt-2 bg-orange-50 px-2 py-1 rounded-md border border-slate-100">{description}</p>}
        </div>
      </CardContent>
    </Card>
  ), []);

  const handleLocalSearchChange = useCallback((value: string) => {
    setLocalSearchInput(value);
  }, []);


  const TableRow = useMemo(() => ({ record }: { record: OfftakeData }) => {
    const avgLiveWeight = calculateAverage(record.liveWeight);
    const avgPrice = calculateAverage(record.pricePerGoatAndSheep);
    
    return (
      <tr className="border-b hover:bg-blue-50 transition-all duration-200 group text-sm">
        <td className="py-1 px-4">
          <Checkbox
            checked={selectedRecords.includes(record.id)}
            onCheckedChange={() => handleSelectRecord(record.id)}
          />
        </td>
        <td className="py-1 px-6 text-xs">{formatDate(record.date)}</td>
        <td className="py-1 px-6 text-xs">{record.farmerName || 'N/A'}</td>
        <td className="py-1 px-6 text-xs">{record.gender || 'N/A'}</td>
        <td className="py-1 px-6 text-xs">
          <code className="text-sm bg-gray-100 px-2 py-1 rounded text-gray-700">
            {record.idNumber || record.offtakeUserId || 'N/A'}
          </code>
        </td>
        <td className="py-1 px-6 text-xs">{record.region || 'N/A'}</td>
         <td className="py-1 px-6 text-xs">{record.subcounty || 'N/A'}</td>
          <td className="py-1 px-6 text-xs">{record.location || 'N/A'}</td>
        <td className="py-1 px-6 text-xs font-bold">{record.noSheepGoats || 0}</td>
        <td className="py-1 px-6 text-xs font-bold text-green-600">{formatCurrency(record.totalprice || 0)}</td>
        <td className="py-1 px-6 text-xs">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => openViewDialog(record)} className="h-8 w-8 p-0 hover:bg-green-100 hover:text-green-600 border-green-200">
              <Eye className="h-4 w-4 text-green-500" />
            </Button>
            {isAdmin(userRole) && (
              <>
                <Button variant="outline" size="sm" onClick={() => openEditDialog(record)} className="h-8 w-8 p-0 hover:bg-yellow-100 border-white">
                  <Edit className="h-4 w-4 text-orange-500" />
                </Button>
                <Button variant="outline" size="sm" onClick={() => openSingleDeleteConfirm(record)} className="h-8 w-8 p-0 hover:bg-red-100 hover:text-red-600 border-white">
                  <Trash2 className="h-4 w-4 text-red-500" />
                </Button>
              </>
            )}
          </div>
        </td>
      </tr>
    );
  }, [selectedRecords, handleSelectRecord, openViewDialog, openEditDialog, openSingleDeleteConfirm, userRole]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4">
        <div className="flex flex-col gap-1">
            <h2 className="text-md font-bold mb-2 bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
                Livestock Offtake Data
            </h2>
            <div className="flex items-center gap-2">
                <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 font-bold px-3 py-1 w-fit">
                    {userCanViewAllProgrammeData ? `${activeProgram} PROGRAMME` : activeProgram}
                </Badge>
            </div>
        </div>
        
        <div className="flex flex-wrap gap-2 items-center w-full xl:w-auto">
            {availableProgramsForSelect.length > 1 && (
                <div className="mr-4">
                    <Select value={activeProgram} onValueChange={handleProgramChange} disabled={availableProgramsForSelect.length <= 1}>
                        <SelectTrigger className="border-gray-300 focus:border-blue-500 bg-white w-full sm:w-[140px]">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {availableProgramsForSelect.map(p => (
                                <SelectItem key={p} value={p}>{p}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            )}

          {selectedRecords.length > 0 && isAdmin(userRole) && (
            <Button variant="destructive" size="sm" onClick={openBulkDeleteConfirm} disabled={deleteLoading} className="text-xs">
              <Trash2 className="h-4 w-4 mr-2" />
              Delete ({selectedRecords.length})
            </Button>
          )}
          {selectedRecords.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={openBulkSmsDialog}
              className="text-xs border-green-300 text-green-700 hover:bg-green-50"
            >
              <Phone className="h-4 w-4 mr-2" />
              Send SMS ({selectedRecords.length})
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={clearAllFilters} className="text-xs border-gray-300 hover:bg-gray-50">
            Clear Filters
          </Button>
          <Button variant="outline" size="sm" onClick={resetToCurrentMonth} className="text-xs border-gray-300 hover:bg-gray-50">
            This Month
          </Button>
          
          {/* Upload Button */}
          <Button variant="outline" size="sm" onClick={() => setIsUploadDialogOpen(true)} className="text-xs border-gray-300 hover:bg-blue-50 hover:text-blue-600">
            <Upload className="h-4 w-4 mr-2" />
            Upload Data
          </Button>

          {isAdmin(userRole) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button disabled={exportLoading || filteredOfftake.length === 0} className="bg-gradient-to-r from-blue-800 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white shadow-md text-xs">
                  <Download className="h-4 w-4 mr-2" />
                  {exportLoading ? "Exporting..." : `Export (${filteredOfftake.length})`}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuItem onSelect={() => handleExport()} disabled={exportLoading}>
                  <Download className="h-4 w-4 mr-2" />
                  Export Detailed Data
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => handleExportAggregatedByFarmer()} disabled={exportLoading}>
                  <Users className="h-4 w-4 mr-2" />
                  Export Summed by Farmer ID
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => handleExportFarmerOfftakeSummary()} disabled={exportLoading}>
                  <Users className="h-4 w-4 mr-2" />
                  Export Farmer Summary
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatsCard 
          title="TOTAL FARMERS" 
          value={stats.totalFarmers.toLocaleString()} 
          icon={Users} 
          description={`${stats.totalMaleFarmers} Males | ${stats.totalFemaleFarmers} Females`} 
        />
        <StatsCard title="TOTAL ANIMALS" value={stats.totalAnimals.toLocaleString()} icon={Scale} description={`Avg Live: ${stats.averageLiveWeight.toFixed(1)}kg | Avg Carcass: ${stats.averageCarcassWeight.toFixed(1)}kg`} />
        <StatsCard 
          title="TOTAL COST" 
          value={safeTruncate(formatCurrency(stats.totalRevenue))} 
          icon={CreditCard} 
          description={`Avg Price per Goat: ${formatCurrency(stats.averageRevenue)} | Avg per Kg: ${formatCurrency(stats.avgPricePerCarcassKg)}`} 
        />
      </div>

      <Card className="shadow-lg border-0 bg-white">
        <CardContent className="space-y-4 pt-6">
          <FilterSection localSearchInput={localSearchInput} filters={filters} uniqueRegions={uniqueRegions} uniqueGenders={uniqueGenders} onSearchChange={handleLocalSearchChange} onFilterChange={handleFilterChange} />
        </CardContent>
      </Card>

      <Card className="shadow-lg border-0 bg-white">
        <CardContent className="p-0">
          {loading ? (
            <div className="text-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
              <p className="text-muted-foreground mt-2">Loading data...</p>
            </div>
          ) : currentPageRecords.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              {allOfftake.length === 0 ? "No data found in database" : "No records found matching your criteria"}
            </div>
          ) : (
            <>
              <div className="w-full overflow-x-auto rounded-md">
                <table className="w-full border-collapse border border-gray-300 text-sm text-left whitespace-nowrap">
                  <thead className="rounded">
                    <tr className="bg-blue-100 p-1 px-3">
                      <th className="py-2 px-4">
                        <Checkbox checked={selectedRecords.length === currentPageRecords.length && currentPageRecords.length > 0} onCheckedChange={handleSelectAll} />
                      </th>
                      <th className="text-left py-2 px-4 font-medium text-gray-600">Date</th>
                      <th className="text-left py-2 px-4 font-medium text-gray-600">Farmer Name</th>
                      <th className="text-left py-2 px-4 font-medium text-gray-600">Gender</th>
                      <th className="text-left py-2 px-4 font-medium text-gray-600">ID No</th>
                      <th className="text-left py-2 px-4 font-medium text-gray-600">County</th>
                      <th className="text-left py-2 px-4 font-medium text-gray-600">Sub County</th>
                      <th className="text-left py-2 px-4 font-medium text-gray-600">Village</th>
                      <th className="text-left py-2 px-4 font-medium text-gray-600">No.Animals</th>
                      <th className="text-left py-2 px-4 font-medium text-gray-600">Total Price</th>
                      <th className="text-left py-2 px-4 font-medium text-gray-600">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentPageRecords.map((record) => (
                      <TableRow key={record.id} record={record} />
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between p-4 border-t bg-gray-50">
                <div className="text-sm text-muted-foreground">
                  {filteredOfftake.length} total records - Page {pagination.page} of {pagination.totalPages}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={!pagination.hasPrev} onClick={() => handlePageChange(pagination.page - 1)}>Previous</Button>
                  <Button variant="outline" size="sm" disabled={!pagination.hasNext} onClick={() => handlePageChange(pagination.page + 1)}>Next</Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* View Dialog */}
      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent className="sm:max-w-4xl bg-white rounded-2xl max-h-[90vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-slate-900">
              <Eye className="h-5 w-5 text-green-600" />
              Livestock Offtake Details
            </DialogTitle>
          </DialogHeader>
          {viewingRecord && (
            <div className="space-y-6 py-4 overflow-y-auto max-h-[60vh]">
              <div className="bg-slate-50 rounded-xl p-4">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                    <Weight className="h-4 w-4" />
                    Animal Details Table
                  </h3>
                  {isAdmin(userRole) && (
                    <Button variant="outline" size="sm" onClick={() => openWeightEditDialog(viewingRecord)}>
                      <Edit className="h-4 w-4 mr-2" /> Edit Weights
                    </Button>
                  )}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse border border-gray-300 text-sm">
                    <thead>
                      <tr className="bg-blue-100">
                        <th className="border border-gray-300 py-2 px-3 font-medium text-gray-700 text-left">Animal #</th>
                        <th className="border border-gray-300 py-2 px-3 font-medium text-gray-700 text-left">Live Weight (kg)</th>
                        <th className="border border-gray-300 py-2 px-3 font-medium text-gray-700 text-left">Carcass Weight (kg)</th>
                        <th className="border border-gray-300 py-2 px-3 font-medium text-gray-700 text-left">Price (Ksh)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {viewingRecord.liveWeight.map((_, index) => (
                        <tr key={index} className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                          <td className="border border-gray-300 py-2 px-3 font-medium">Animal {index + 1}</td>
                          <td className="border border-gray-300 py-2 px-3">{viewingRecord.liveWeight[index]?.toFixed(1)}</td>
                          <td className="border border-gray-300 py-2 px-3">{viewingRecord.carcassWeight[index]?.toFixed(2) || 'N/A'}</td>
                          <td className="border border-gray-300 py-2 px-3 font-medium text-green-700">{formatCurrency(viewingRecord.pricePerGoatAndSheep[index] || 0)}</td>
                        </tr>
                      ))}
                      <tr className="bg-gray-100 font-semibold">
                        <td className="border border-gray-300 py-2 px-3">Total</td>
                        <td className="border border-gray-300 py-2 px-3">{calculateTotal(viewingRecord.liveWeight).toFixed(1)} kg</td>
                        <td className="border border-gray-300 py-2 px-3">{calculateTotal(viewingRecord.carcassWeight).toFixed(2)} kg</td>
                        <td className="border border-gray-300 py-2 px-3 text-green-700">{formatCurrency(calculateTotal(viewingRecord.pricePerGoatAndSheep))}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="bg-slate-50 rounded-xl p-4">
                <h3 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
                  <Scale className="h-4 w-4" />
                  Transaction Summary
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-white border border-slate-200 rounded-lg p-4 text-center">
                    <Label className="text-sm font-medium text-slate-600 block mb-2">PROJECT</Label>
                    <p className="text-slate-900 font-bold text-xl text-blue-600">{viewingRecord.programme || 'N/A'}</p>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-lg p-4 text-center">
                    <Label className="text-sm font-medium text-slate-600 block mb-2">Total Animals</Label>
                    <p className="text-slate-900 font-medium text-2xl font-bold text-blue-600">{viewingRecord.noSheepGoats}</p>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-lg p-4 text-center">
                    <Label className="text-sm font-medium text-slate-600 block mb-2">Total Value</Label>
                    <p className="text-slate-900 font-medium text-2xl font-bold text-green-600">{formatCurrency(viewingRecord.totalprice)}</p>
                  </div>
                </div>
              </div>

              <div className="bg-slate-50 rounded-xl p-4">
                <h3 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  Farmer Information
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-sm font-medium text-slate-600">Farmer Name</Label>
                    <p className="text-slate-900 font-medium">{viewingRecord.farmerName}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-slate-600">Gender</Label>
                    <Badge className={viewingRecord.gender?.toLowerCase() === 'male' ? 'bg-blue-100 text-blue-800' : 'bg-pink-100 text-pink-800'}>{viewingRecord.gender}</Badge>
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-slate-600">ID Number</Label>
                    <p className="text-slate-900 font-medium font-mono">{viewingRecord.idNumber}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-slate-600">Phone Number</Label>
                    <p className="text-slate-900 font-medium">{viewingRecord.phoneNumber}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-slate-600">County</Label>
                    <p className="text-slate-900 font-medium">{viewingRecord.region}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-slate-600">Subcounty</Label>
                    <p className="text-slate-900 font-medium">{viewingRecord.subcounty}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-slate-600">Location</Label>
                    <p className="text-slate-900 font-medium">{viewingRecord.location}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-slate-600">Date</Label>
                    <p className="text-slate-900 font-medium">{formatDate(viewingRecord.date)}</p>
                  </div>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setIsViewDialogOpen(false)} className="bg-gradient-to-r from-blue-500 to-purple-600 text-white">Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="sm:max-w-md bg-white rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-slate-900">
              <Edit className="h-5 w-5 text-blue-600" />
              Edit Record Data
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-date">Date</Label>
                <Input id="edit-date" type="date" value={editForm.date} onChange={(e) => setEditForm(prev => ({ ...prev, date: e.target.value }))} className="bg-white border-slate-300" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-farmerName">Farmer Name</Label>
                <Input id="edit-farmerName" value={editForm.farmerName} onChange={(e) => setEditForm(prev => ({ ...prev, farmerName: e.target.value }))} className="bg-white border-slate-300" />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-gender">Gender</Label>
                <Select value={editForm.gender} onValueChange={(value) => setEditForm(prev => ({ ...prev, gender: value }))}>
                  <SelectTrigger className="bg-white border-slate-300"><SelectValue placeholder="Select gender" /></SelectTrigger>
                  <SelectContent><SelectItem value="Male">Male</SelectItem><SelectItem value="Female">Female</SelectItem></SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-idNumber">ID Number</Label>
                <Input id="edit-idNumber" value={editForm.idNumber} onChange={(e) => setEditForm(prev => ({ ...prev, idNumber: e.target.value }))} className="bg-white border-slate-300" />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
               <div className="space-y-2">
                <Label htmlFor="edit-phoneNumber">Phone Number</Label>
                <Input id="edit-phoneNumber" value={editForm.phoneNumber} onChange={(e) => setEditForm(prev => ({ ...prev, phoneNumber: e.target.value }))} className="bg-white border-slate-300" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-region">County (Region)</Label>
                <Input id="edit-region" value={editForm.region} onChange={(e) => setEditForm(prev => ({ ...prev, region: e.target.value }))} className="bg-white border-slate-300" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-location">Location</Label>
              <Input id="edit-location" value={editForm.location} onChange={(e) => setEditForm(prev => ({ ...prev, location: e.target.value }))} className="bg-white border-slate-300" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleEditSubmit} className="bg-gradient-to-r from-blue-500 to-purple-600 text-white">Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Weight Edit Dialog */}
      <Dialog open={isWeightEditDialogOpen} onOpenChange={setIsWeightEditDialogOpen}>
        <DialogContent className="sm:max-w-2xl bg-white rounded-2xl max-h-[90vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-slate-900">
              <Weight className="h-5 w-5 text-blue-600" />
              Edit Weights and Prices
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4 overflow-y-auto max-h-[60vh]">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse border border-gray-300 text-sm">
                <thead>
                  <tr className="bg-blue-100">
                    <th className="border border-gray-300 py-2 px-3 font-medium text-gray-700 text-left">Animal #</th>
                    <th className="border border-gray-300 py-2 px-3 font-medium text-gray-700 text-left">Live Weight (kg)</th>
                    <th className="border border-gray-300 py-2 px-3 font-medium text-gray-700 text-left">Carcass Weight (kg)</th>
                    <th className="border border-gray-300 py-2 px-3 font-medium text-gray-700 text-left">Price (Ksh)</th>
                  </tr>
                </thead>
                <tbody>
                  {weightEditForm.liveWeights.map((_, index) => (
                    <tr key={index} className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                      <td className="border border-gray-300 py-2 px-3 font-medium">Animal {index + 1}</td>
                      <td className="border border-gray-300 py-2 px-3">
                        <Input type="number" step="0.1" value={weightEditForm.liveWeights[index] || 0} onChange={(e) => {
                          const newLiveWeights = [...weightEditForm.liveWeights];
                          newLiveWeights[index] = parseFloat(e.target.value) || 0;
                          setWeightEditForm(prev => ({ ...prev, liveWeights: newLiveWeights }));
                        }} className="w-24" />
                      </td>
                      <td className="border border-gray-300 py-2 px-3">
                        <Input type="number" step="0.1" value={weightEditForm.carcassWeights[index] || 0} onChange={(e) => {
                          const newCarcassWeights = [...weightEditForm.carcassWeights];
                          newCarcassWeights[index] = parseFloat(e.target.value) || 0;
                          setWeightEditForm(prev => ({ ...prev, carcassWeights: newCarcassWeights }));
                        }} className="w-24" />
                      </td>
                      <td className="border border-gray-300 py-2 px-3">
                        <Input type="number" step="1" value={weightEditForm.prices[index] || 0} onChange={(e) => {
                          const newPrices = [...weightEditForm.prices];
                          newPrices[index] = parseFloat(e.target.value) || 0;
                          setWeightEditForm(prev => ({ ...prev, prices: newPrices }));
                        }} className="w-32" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsWeightEditDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleWeightEditSubmit} className="bg-gradient-to-r from-blue-500 to-purple-600 text-white">Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Upload Dialog */}
      <Dialog open={isUploadDialogOpen} onOpenChange={setIsUploadDialogOpen}>
        <DialogContent className="sm:max-w-2xl bg-white rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-slate-900">
              <Upload className="h-5 w-5 text-blue-600" />
              Upload CSV Data
            </DialogTitle>
            <DialogDescription>
              Upload a CSV file. Ensure columns include Date, ID Number, Live Weight, Carcass Weight, and Price per Animal.
              Rows will be grouped by ID Number and Date.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid w-full max-w-sm items-center gap-1.5">
              <Label htmlFor="csvUpload">CSV File</Label>
              <Input id="csvUpload" type="file" accept=".csv" multiple ref={fileInputRef} onChange={handleFileSelect} disabled={uploadLoading} />
            </div>
            
            {/* Progress Bar */}
            {uploadLoading && uploadProgress.total > 0 && (
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Uploading...</span>
                  <span>{uploadProgress.current} / {uploadProgress.total}</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2.5">
                  <div 
                    className="bg-blue-600 h-2.5 rounded-full transition-all duration-300" 
                    style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }}
                  ></div>
                </div>
              </div>
            )}
            
            {uploadPreview.length > 0 && !uploadLoading && (
              <div className="max-h-60 overflow-y-auto border rounded-md">
                <table className="w-full text-sm text-left">
                  <thead className="bg-gray-100 sticky top-0">
                    <tr>
                      <th className="p-2">Farmer Name</th>
                      <th className="p-2">Date</th>
                      <th className="p-2">ID</th>
                      <th className="p-2">Goats</th>
                      <th className="p-2">Total (KES)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {uploadPreview.map((record, idx) => {
                       const total = record.goats.reduce((sum: number, g: any) => sum + parseFloat(g.price), 0);
                       return (
                        <tr key={idx} className="border-t">
                          <td className="p-2">{record.name}</td>
                          <td className="p-2">{record.date}</td>
                          <td className="p-2">{record.idNumber}</td>
                          <td className="p-2">{record.goats.length}</td>
                          <td className="p-2">{total.toLocaleString()}</td>
                        </tr>
                       )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
                if(!uploadLoading) setIsUploadDialogOpen(false);
            }} disabled={uploadLoading}>Cancel</Button>
            <Button onClick={handleUpload} disabled={uploadLoading || uploadPreview.length === 0} className="bg-gradient-to-r from-blue-500 to-purple-600 text-white">
              {uploadLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
              {uploadLoading ? `Uploading...` : "Upload Data"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      <Dialog open={isSingleDeleteDialogOpen} onOpenChange={setIsSingleDeleteDialogOpen}>
        <DialogContent className="sm:max-w-md bg-white rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-red-600">Confirm Deletion</DialogTitle>
            <DialogDescription>Are you sure you want to delete this record?</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsSingleDeleteDialogOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleSingleDelete} disabled={deleteLoading}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      <Dialog open={isDeleteConfirmOpen} onOpenChange={setIsDeleteConfirmOpen}>
        <DialogContent className="sm:max-w-md bg-white rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-red-600">Confirm Bulk Deletion</DialogTitle>
            <DialogDescription>Delete {selectedRecords.length} records?</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDeleteConfirmOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDeleteMultiple} disabled={deleteLoading}>Delete All</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isBulkSmsDialogOpen}
        onOpenChange={(open) => {
          if (!bulkSmsSending) setIsBulkSmsDialogOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-lg bg-white rounded-2xl">
          <DialogHeader>
            <DialogTitle>Send Bulk SMS to Farmers</DialogTitle>
            <DialogDescription>
              This message will be sent to selected farmers with valid phone numbers.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="offtake-bulk-sms-message">SMS Message</Label>
            <Textarea
              id="offtake-bulk-sms-message"
              rows={5}
              value={bulkSmsMessage}
              onChange={(event) => setBulkSmsMessage(event.target.value)}
              placeholder="Type SMS message..."
              disabled={bulkSmsSending}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsBulkSmsDialogOpen(false)}
              disabled={bulkSmsSending}
            >
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
export default LivestockOfftakePage;
