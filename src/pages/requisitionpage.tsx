import { useState, useEffect, useCallback, useMemo, useRef, ChangeEvent, memo } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { getAuth } from "firebase/auth"; 
import { db, ref, set, update, remove, push, onValue, subscribeCollectionByProgrammes } from "@/lib/firebase";
import { Button } from "@/components/ui/button";
import ProgrammeSelector from "@/components/programme-selector";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"; 
import { Download, Eye, Calendar, Edit, Trash2, Car, Wallet, CheckCircle, XCircle, MapPin, Printer, Plus, Minus, Save, FileImage, ExternalLink, MoreHorizontal, History, Clock, ChevronDown, FileText, Phone } from "lucide-react"; 
import { useSharedProgrammeSelection } from "@/hooks/use-shared-programme-selection";
import { useToast } from "@/hooks/use-toast";
import { canViewAllProgrammes, isAdmin, isFieldOfficer, isFinance, isHummanResourceManager, isMonitoringAndEvaluationOfficer, isProjectManager, resolvePermissionPrincipal } from "@/contexts/authhelper";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import { millify } from "millify";
import { cacheKey, readCachedValue, removeCachedValue, writeCachedValue } from "@/lib/data-cache";
import {
  canAccessProgrammeRecord,
  normalizeProgramme,
  resolveAccessibleProgrammes,
} from "@/lib/programme-access";

// --- Types ---
interface PerdiemItem {
  date?: string | number; 
  name: string;
  price: number;
}

interface HistoryEntry {
  id?: string; 
  action: string;
  actor: string;
  actorAttribute?: string;
  timestamp: number;
  details?: string;
}

interface RequisitionData {
  id: string;
  type: 'fuel and Service' | 'perdiem' | 'airtime';
  status: 'pending' | 'approved' | 'rejected' | 'complete';
  username: string;
  Programme?: string;
  role?: string;
  userRole?: string;
  requesterRole?: string;
  submittedByRole?: string;
  createdByRole?: string;
  customAttribute?: string;
  userAttribute?: string;
  requesterAttribute?: string;
  submittedByAttribute?: string;
  createdByAttribute?: string;
  accessControl?: {
    customAttribute?: string;
    customAttributes?: Record<string, unknown>;
  };
  source?: string;
  sourcePage?: string;
  platform?: string;
  submittedFrom?: string;
  name?: string;
  userName?: string;
  email?: string;
  submittedAt: string | number;
  county?: string;
  subcounty?: string;
  programme?: string;
  phone?: string;
  phoneNumber?: string;
  approvedBy?: string;
  approvedByAttribute?: string;
  approvedAt?: string | number;
  authorizedBy?: string;
  authorizedByAttribute?: string;
  authorizedAt?: string | number;
  transactionCompletedBy?: string;
  transactionCompletedAt?: string | number;
  completedBy?: string;
  completedAt?: string | number;
  rejectedBy?: string;
  rejectedAt?: string | number;
  rejectionReason?: string;
  rejectionSmsText?: string;
  createdAt?: number | string;
  totalAmount?: number;
  transactedAmount?: number;
  history?: HistoryEntry[];
  
  // Fuel & Service Fields
  lastReading?: number;
  currentReading?: number;
  distanceTraveled?: number;
  fuelAmount?: number;
  fuelPurpose?: string;
  
  // Perdiem Fields
  fromLocation?: string; 
  toLocation?: string; 
  tripFrom?: string;   
  tripTo?: string;     
  tripPurpose?: string; 
  numberOfDays?: number;
  items?: PerdiemItem[]; 
  total?: number;
  location?: string; 

  // Airtime Fields
  airtimeAmount?: number;
  airtimePurpose?: string;
  
  // Mobile App Upload Fields
  fileUploaded?: boolean;
  fileUploadedAt?: string | number;
  requisitionUrl?: string;
}

interface Filters {
  search: string;
  startDate: string;
  endDate: string;
  type: string;
  status: string;
}

interface Stats {
  totalRequests: number;
  pendingRequests: number;
  approvedRequests: number;
  authorizedRequests: number;
  rejectedRequests: number;
  completeRequests: number;
  totalAmount: number;
}

interface Pagination {
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

// --- Constants ---
const PAGE_LIMIT = 10;

const createDefaultFilters = (): Filters => ({
  search: "",
  startDate: "",
  endDate: "",
  type: "all",
  status: "all",
});

// --- Helper Functions ---
const getNormalizedStatus = (status: unknown): string =>
  typeof status === "string" ? status.trim().toLowerCase() : "";

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

const formatDateTime = (date: any): string => {
  const parsedDate = parseDate(date);
  return parsedDate ? parsedDate.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }) : 'N/A';
};

const toInputDate = (date: any): string => {
  const d = parseDate(date);
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const getOfficerName = (record: RequisitionData | null | undefined): string => {
  if (!record) return "Unknown";
  return record.name || record.userName || record.username || record.email || "Unknown";
};

const getRequisitionTimestamp = (
  record: Partial<RequisitionData> | null | undefined
): number => {
  if (!record) return 0;
  const dateCandidates = [
    record.submittedAt,
    record.createdAt,
    record.approvedAt,
    record.authorizedAt,
    record.transactionCompletedAt,
    record.completedAt,
    record.rejectedAt,
  ];

  for (const candidate of dateCandidates) {
    const parsed = parseDate(candidate);
    if (parsed) return parsed.getTime();
  }

  return 0;
};

const sortRequisitionsByLatest = (records: RequisitionData[]): RequisitionData[] =>
  [...records].sort((a, b) => getRequisitionTimestamp(b) - getRequisitionTimestamp(a));

const getCurrentMonthDates = () => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(),1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const formatDate = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return {
    startDate: formatDate(startOfMonth),
    endDate: formatDate(endOfMonth),
  };
};

const getRequisitionImages = (urlString: string | undefined): string[] => {
  if (!urlString) return [];
  return urlString.split('|').map(url => url.trim()).filter(url => url.length > 0);
};

const getRequestedAmount = (record: RequisitionData | null | undefined): number => {
  if (!record) return 0;
  if (record.type === "fuel and Service") return Number(record.fuelAmount || 0);
  if (record.type === "airtime") return Number(record.airtimeAmount || 0);
  return Number(record.total || 0);
};

const getRequisitionPurpose = (record: RequisitionData | null | undefined): string => {
  if (!record) return "N/A";
  const purpose =
    record.type === "fuel and Service"
      ? record.fuelPurpose || record.tripPurpose
      : record.type === "airtime"
        ? record.airtimePurpose || record.tripPurpose
        : record.tripPurpose;

  return String(purpose || "").trim() || "N/A";
};

const getTransactedBy = (record: RequisitionData | null | undefined): string =>
  String(record?.transactionCompletedBy || "").trim() || "Pending";

const getTransactedAmount = (record: RequisitionData | null | undefined): number | null => {
  if (!record) return null;
  if (typeof record.transactedAmount === "number") return record.transactedAmount;
  if (record.transactionCompletedBy) return getRequestedAmount(record);
  return null;
};

const getRequisitionRequesterTokens = (record: RequisitionData | null | undefined): string[] => {
  if (!record) return [];

  const customAttributes = record.accessControl?.customAttributes
    ? Object.keys(record.accessControl.customAttributes)
    : [];

  return [
    record.role,
    record.userRole,
    record.requesterRole,
    record.submittedByRole,
    record.createdByRole,
    record.customAttribute,
    record.userAttribute,
    record.requesterAttribute,
    record.submittedByAttribute,
    record.createdByAttribute,
    record.accessControl?.customAttribute,
    record.source,
    record.sourcePage,
    record.platform,
    record.submittedFrom,
    ...customAttributes,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
};

const isFieldOfficerRequisition = (record: RequisitionData | null | undefined): boolean =>
  getRequisitionRequesterTokens(record).some((token) => isFieldOfficer(token));

const isProjectOrMerRequisition = (record: RequisitionData | null | undefined): boolean =>
  getRequisitionRequesterTokens(record).some(
    (token) => isProjectManager(token) || isMonitoringAndEvaluationOfficer(token),
  );

/** True if the requisition is NOT from a Field Officer, Project Manager, or M&E Officer.
 *  These requisitions can be approved+authorized directly by HR in one step. */
const isHrDirectApprovalRequisition = (record: RequisitionData | null | undefined): boolean =>
  record != null &&
  !isFieldOfficerRequisition(record) &&
  !isProjectOrMerRequisition(record);

const isProjectOfficerApprovedRequisition = (record: RequisitionData | null | undefined): boolean => {
  if (!record) return false;
  const status = getNormalizedStatus(record.status);
  if (status !== "approved" && status !== "complete") return false;
  if (!String(record.approvedBy || "").trim()) return false;

  const approvedByAttribute = String(record.approvedByAttribute || "").trim();
  return !approvedByAttribute || isProjectManager(approvedByAttribute) || isMonitoringAndEvaluationOfficer(approvedByAttribute);
};

const canRequisitionReachHr = (record: RequisitionData | null | undefined): boolean =>
  !isProjectOrMerRequisition(record) &&
  (!isFieldOfficerRequisition(record) || isProjectOfficerApprovedRequisition(record));

const requiresHrAuthorization = (record: RequisitionData | null | undefined): boolean =>
  !isProjectOrMerRequisition(record);

const canProceedAfterApproval = (record: RequisitionData | null | undefined): boolean =>
  Boolean(record) &&
  getNormalizedStatus(record?.status) === "approved" &&
  (!requiresHrAuthorization(record) || !!String(record?.authorizedBy || "").trim());

// --- Helper to Log History ---
const logHistory = async (
  recordId: string,
  action: string,
  details: string,
  actorName?: string,
  actorAttribute?: string,
) => {
  const auth = getAuth();
  const currentUser = auth.currentUser;
  if (!currentUser) return;

  const entry: HistoryEntry = {
    action,
    actor: actorName?.trim() || currentUser.displayName || currentUser.email || "Admin",
    actorAttribute: actorAttribute?.trim() || undefined,
    timestamp: Date.now(),
    details
  };

  try {
    await push(ref(db, `requisitions/${recordId}/history`), entry);
  } catch (error) {
    console.error("Failed to log history:", error);
  }
};

const HISTORY_ACTOR_PATTERN = /\bby\s+(.+?)(?:\s+\(([^)]+)\))?(?=(?:\s+after\b)|(?:\.\s)|[.]?$|$)/i;

const extractHistoryActorMeta = (entry: HistoryEntry): { name: string; attribute: string } => {
  const details = typeof entry.details === "string" ? entry.details : "";
  const match = details.match(HISTORY_ACTOR_PATTERN);
  return {
    name: match?.[1]?.trim() || "",
    attribute: match?.[2]?.trim() || "",
  };
};

const getHistoryActorName = (entry: HistoryEntry): string => {
  const actor = typeof entry.actor === "string" ? entry.actor.trim() : "";
  if (actor && !actor.includes("@")) return actor;

  const parsed = extractHistoryActorMeta(entry);
  if (parsed.name) return parsed.name;

  if (actor.includes("@")) {
    const [localPart = ""] = actor.split("@");
    return localPart.trim() || "Unknown User";
  }

  return "Unknown User";
};

const getHistoryActorAttribute = (entry: HistoryEntry): string => {
  if (typeof entry.actorAttribute === "string" && entry.actorAttribute.trim()) {
    return entry.actorAttribute.trim();
  }
  return extractHistoryActorMeta(entry).attribute;
};

const shouldHideHistoryActorMeta = (entry: HistoryEntry): boolean => {
  const details = typeof entry.details === "string" ? entry.details.trim() : "";
  if (!details) return false;

  const actorName = getHistoryActorName(entry);
  const actorAttribute = getHistoryActorAttribute(entry);
  const normalizedDetails = details.toLowerCase();
  const includesActorName = actorName ? normalizedDetails.includes(actorName.toLowerCase()) : false;
  const includesActorAttribute = actorAttribute ? normalizedDetails.includes(actorAttribute.toLowerCase()) : true;

  return includesActorName && includesActorAttribute;
};

// --- Main Component ---

const RequisitionsPage = () => {
  const { user, userRole, userAttribute, userName, allowedProgrammes } = useAuth();
  const { toast } = useToast();
  
  // List State
  const [allRequisitions, setAllRequisitions] = useState<RequisitionData[]>([]);
  const [filteredRequisitions, setFilteredRequisitions] = useState<RequisitionData[]>([]);
  const [loading, setLoading] = useState(true);
  const [exportLoading, setExportLoading] = useState(false);
  const [selectedRecords, setSelectedRecords] = useState<string[]>([]);
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  
  // Dialog States
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [viewingRecord, setViewingRecord] = useState<RequisitionData | null>(null);
  const [hrDecisionAction, setHrDecisionAction] = useState<string>("");
  const [pmDecisionAction, setPmDecisionAction] = useState<string>("");
  const [isRejectDialogOpen, setIsRejectDialogOpen] = useState(false);
  const [rejectionMessageText, setRejectionMessageText] = useState<string>("");
  const [isBulkRejectDialogOpen, setIsBulkRejectDialogOpen] = useState(false);
  const [bulkRejectionMessageText, setBulkRejectionMessageText] = useState<string>("");
  
  const [isImageViewerOpen, setIsImageViewerOpen] = useState(false);
  const [viewingImages, setViewingImages] = useState<string[]>([]);
  const [imageRecord, setImageRecord] = useState<RequisitionData | null>(null);
  const [isImageEditDialogOpen, setIsImageEditDialogOpen] = useState(false);
  const [imageEditIndex, setImageEditIndex] = useState<number | null>(null);
  const [imageEditUrl, setImageEditUrl] = useState("");
  const [imageActionLoading, setImageActionLoading] = useState(false);
  
  // History State
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [historyList, setHistoryList] = useState<HistoryEntry[]>([]);

  // Edit State
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editRecord, setEditRecord] = useState<RequisitionData | null>(null);
  const [editFormData, setEditFormData] = useState<Partial<RequisitionData>>({});
  const [isSaving, setIsSaving] = useState(false);

  // Print State
  const [printDate, setPrintDate] = useState<string>('');

  // Delete State
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [recordToDelete, setRecordToDelete] = useState<RequisitionData | null>(null);
  
  const docRef = useRef<HTMLDivElement>(null);
  const currentMonth = useMemo(getCurrentMonthDates, []);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Filters
  const [filters, setFilters] = useState<Filters>(() => createDefaultFilters());

  const [stats, setStats] = useState<Stats>({
    totalRequests: 0,
    pendingRequests: 0,
    approvedRequests: 0,
    authorizedRequests: 0,
    rejectedRequests: 0,
    completeRequests: 0,
    totalAmount: 0
  });

  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: PAGE_LIMIT,
    totalPages: 1,
    hasNext: false,
    hasPrev: false
  });

  const permissionPrincipal = useMemo(
    () => resolvePermissionPrincipal(userRole, userAttribute),
    [allowedProgrammes, userRole, userAttribute]
  );
  const userIsAdmin = useMemo(() => isAdmin(userRole), [userRole]);
  const userHasProjectManagerRights = useMemo(() => isProjectManager(permissionPrincipal), [permissionPrincipal]);
  const userHasHummanResourceRights = useMemo(
    () => isHummanResourceManager(permissionPrincipal),
    [permissionPrincipal]
  );
  const userHasMerRights = useMemo(
    () => isMonitoringAndEvaluationOfficer(permissionPrincipal),
    [permissionPrincipal]
  );
  const userHasFinanceRights = useMemo(() => isFinance(permissionPrincipal), [permissionPrincipal]);
  const userHasHrLikeViewRights = useMemo(
    () => userHasHummanResourceRights || userHasFinanceRights,
    [userHasHummanResourceRights, userHasFinanceRights]
  );
  const userCanViewAllProgrammes = useMemo(
    () => canViewAllProgrammes(userRole, userAttribute, allowedProgrammes),
    [allowedProgrammes, userRole, userAttribute]
  );
  const canViewAllRequisitionProgrammes = useMemo(
    () => userCanViewAllProgrammes,
    [userCanViewAllProgrammes]
  );
  const accessibleProgrammes = useMemo(
    () => resolveAccessibleProgrammes(canViewAllRequisitionProgrammes, allowedProgrammes),
    [allowedProgrammes, canViewAllRequisitionProgrammes]
  );
  const [activeProgram, setActiveProgram] = useSharedProgrammeSelection(accessibleProgrammes, {
    allowAll: canViewAllRequisitionProgrammes || accessibleProgrammes.length > 1,
    fallbackToAll: canViewAllRequisitionProgrammes || accessibleProgrammes.length > 1,
  });
  const canSelectAllProgrammes = canViewAllRequisitionProgrammes || accessibleProgrammes.length > 1;
  const showProgrammeSelector = accessibleProgrammes.length > 1;
  const canApproveRequisition =
    isAdmin(permissionPrincipal) ||
    userHasProjectManagerRights ||
    userHasMerRights ||
    userHasHummanResourceRights;
  const canAuthorizeRequisition = userHasHummanResourceRights;
  const canCompleteTransaction = userHasFinanceRights;
  const canSendRequisitionSms = useMemo(
    () => userIsAdmin,
    [userIsAdmin]
  );
  const canRejectRequisition = useMemo(
    () => canAuthorizeRequisition || canSendRequisitionSms,
    [canAuthorizeRequisition, canSendRequisitionSms]
  );
  const canRejectPendingRequisition = useMemo(
    () => userHasProjectManagerRights,
    [userHasProjectManagerRights]
  );
  const canMarkRequisitionComplete = useMemo(
    () =>
      userHasFinanceRights ||
      canApproveRequisition ||
      canAuthorizeRequisition ||
      userCanViewAllProgrammes,
    [
      userHasFinanceRights,
      canApproveRequisition,
      canAuthorizeRequisition,
      userCanViewAllProgrammes,
    ]
  );
  const canDeleteRequisition = useMemo(
    () => userIsAdmin,
    [userIsAdmin]
  );
  const canManageImages = useMemo(
    () =>
      canApproveRequisition ||
      canAuthorizeRequisition ||
      canCompleteTransaction ||
      userIsAdmin,
    [canApproveRequisition, canAuthorizeRequisition, canCompleteTransaction, userIsAdmin]
  );
  const approvalActorAttribute = useMemo(() => {
    if (typeof userAttribute === "string" && userAttribute.trim()) return userAttribute.trim();
    if (userHasProjectManagerRights) return permissionPrincipal || "Project Officer";
    if (userHasMerRights) return permissionPrincipal || "M&E Officer";
    return "";
  }, [permissionPrincipal, userAttribute, userHasMerRights, userHasProjectManagerRights]);
  const actorAttribute = useMemo(() => {
    if (typeof userAttribute === "string" && userAttribute.trim()) return userAttribute.trim();
    if (typeof userRole === "string" && userRole.trim()) return userRole.trim();
    return "Unknown";
  }, [userAttribute, userRole]);
  const historyActorName = useMemo(
    () => userName || user?.displayName || user?.email || "Admin",
    [user?.displayName, user?.email, userName]
  );
  const historyActorAttribute = useMemo(() => {
    if (typeof permissionPrincipal === "string" && permissionPrincipal.trim()) {
      return permissionPrincipal.trim();
    }
    return actorAttribute;
  }, [actorAttribute, permissionPrincipal]);
  const requisitionCacheKey = useMemo(
    () => cacheKey("admin-page", "requisitions-v2", permissionPrincipal || "no-access", activeProgram || "all"),
    [permissionPrincipal, activeProgram]
  );

  // --- 2. Data Fetching ---
  useEffect(() => {
    if (!canViewAllRequisitionProgrammes && !activeProgram) {
        setAllRequisitions([]);
        setLoading(false);
        return;
    }
    const cachedRequisitions = readCachedValue<RequisitionData[]>(requisitionCacheKey);
    if (cachedRequisitions) {
      setAllRequisitions(sortRequisitionsByLatest(cachedRequisitions));
      setLoading(false);
    } else {
      setLoading(true);
    }

    const normalizedActiveProgram = normalizeProgramme(activeProgram);
    const handleSnapshotData = (data: Record<string, any> | null | undefined) => {
        if (!data) {
            setAllRequisitions([]);
            removeCachedValue(requisitionCacheKey);
            setLoading(false);
            return;
        }
        const records = Object.keys(data).map((key) => {
            const item = data[key];
            const dateVal = getRequisitionTimestamp(item as Partial<RequisitionData>);
            const normalizedPhone = item.phoneNumber || item.phone || item.phone_number || item.Phone || item.mobile || item.contact || item.telephone || '';
            const type = item.type === "fuel and Service" || item.type === "perdiem" || item.type === "airtime" ? item.type : item.type || "perdiem";
            const username = item.username || item.userName || item.name || item.email || "Unknown";
            const programme = normalizeProgramme(item.programme || item.Programme);
            return {
                id: key,
                ...item,
                type,
                username,
                programme: programme || item.programme || item.Programme || "",
                status: (getNormalizedStatus(item.status) || "pending") as RequisitionData["status"],
                phoneNumber: normalizedPhone,
                tripPurpose: type === "fuel and Service" ? item.fuelPurpose : type === "airtime" ? (item.airtimePurpose || item.tripPurpose) : item.tripPurpose,
                items: Array.isArray(item.items) ? item.items : [], 
                submittedAt: item.submittedAt || item.createdAt || dateVal,
                createdAt: dateVal || 0,
                totalAmount: (type === "fuel and Service" ? item.fuelAmount : type === "airtime" ? item.airtimeAmount : item.total) || 0,
                fileUploaded: item.fileUploaded || false
            };
        });
        const sortedRecords = sortRequisitionsByLatest(records);
        setAllRequisitions(sortedRecords);
        writeCachedValue(requisitionCacheKey, sortedRecords);
        setLoading(false);
    };

    const handleSnapshotError = (error: Error) => {
        console.error("Error fetching requisition data:", error);
        toast({ title: "Error", description: "Failed to load requisition data", variant: "destructive" });
        setLoading(false);
    };

    const unsubscribe =
      canViewAllRequisitionProgrammes && !normalizedActiveProgram
        ? onValue(
            ref(db, "requisitions"),
            (snapshot) => handleSnapshotData(snapshot.exists() ? snapshot.val() : null),
            handleSnapshotError,
          )
        : subscribeCollectionByProgrammes<Record<string, any>>(
            "requisitions",
            normalizedActiveProgram
              ? [normalizedActiveProgram]
              : Array.from(new Set([...accessibleProgrammes, normalizeProgramme("KPMD 2")].filter(Boolean))),
            handleSnapshotData,
            handleSnapshotError,
          );
    return () => { if(typeof unsubscribe === 'function') unsubscribe(); };
  }, [activeProgram, accessibleProgrammes, canViewAllRequisitionProgrammes, toast, requisitionCacheKey]);

  // --- 3. Filtering & Stats Logic ---
  useEffect(() => {
    if (allRequisitions.length === 0) {
      setFilteredRequisitions([]);
      setStats({
        totalRequests: 0,
        pendingRequests: 0,
        approvedRequests: 0,
        authorizedRequests: 0,
        rejectedRequests: 0,
        completeRequests: 0,
        totalAmount: 0,
      });
      return;
    }
    const baseFilteredList = allRequisitions.filter(record => {
      const recordProgramme = record.programme || record.Programme;
      const normalizedRecordProgramme = normalizeProgramme(recordProgramme);
      const normalizedActiveProgram = normalizeProgramme(activeProgram);

      if (!canViewAllRequisitionProgrammes) {
        if (!canAccessProgrammeRecord(recordProgramme, accessibleProgrammes, false)) {
          return false;
        }
        if (normalizedActiveProgram && normalizedRecordProgramme !== normalizedActiveProgram) {
          return false;
        }
      } else if (normalizedActiveProgram && normalizedRecordProgramme !== normalizedActiveProgram) {
        return false;
      }

      if (filters.startDate || filters.endDate) {
        const recordDate = parseDate(record.createdAt);
        if (recordDate) {
          const recordDateOnly = new Date(recordDate);
          recordDateOnly.setHours(0, 0, 0, 0);
          const startDate = filters.startDate ? new Date(filters.startDate) : null;
          const endDate = filters.endDate ? new Date(filters.endDate) : null;
          if (startDate) startDate.setHours(0, 0, 0, 0);
          if (endDate) endDate.setHours(23, 59, 59, 999);
          if (startDate && recordDateOnly < startDate) return false;
          if (endDate && recordDateOnly > endDate) return false;
        } else if (filters.startDate || filters.endDate) return false;
      }

      if (filters.type !== "all" && record.type?.toLowerCase() !== filters.type.toLowerCase()) return false;

      if (filters.search) {
        const term = filters.search.toLowerCase();
        const match = [
          getOfficerName(record), record.county, record.subcounty, record.location
        ].some(field => field?.toLowerCase().includes(term));
        if (!match) return false;
      }
      return true;
    });

    const roleScopedList = baseFilteredList.filter((record) => {
      const normalizedStatus = getNormalizedStatus(record.status);
      if (userHasHummanResourceRights) {
        if (!canRequisitionReachHr(record)) return false;
        return filters.status === "all" || normalizedStatus === filters.status.toLowerCase();
      }
      if (userHasFinanceRights) {
        const isAuthorized = !!String(record.authorizedBy || "").trim() || canProceedAfterApproval(record);
        const isCompleted = normalizedStatus === "complete";
        return isAuthorized || isCompleted;
      }
      return true;
    });

    const tableFilteredList = roleScopedList.filter((record) => {
      if (filters.status !== "all" && record.status?.toLowerCase() !== filters.status.toLowerCase()) return false;
      return true;
    });

    const sortedFilteredList = sortRequisitionsByLatest(tableFilteredList);
    setFilteredRequisitions(sortedFilteredList);

    const statsSourceList = tableFilteredList;

    const totalRequests = statsSourceList.length;
    const pendingRequests = statsSourceList.filter((r) => getNormalizedStatus(r.status) === "pending").length;
    const approvedRequests = statsSourceList.filter((r) => getNormalizedStatus(r.status) === "approved").length;
    const authorizedRequests = statsSourceList.filter((r) => canProceedAfterApproval(r)).length;
    const rejectedRequests = statsSourceList.filter((r) => getNormalizedStatus(r.status) === "rejected").length;
    const completeRequests = statsSourceList.filter((r) => getNormalizedStatus(r.status) === "complete").length;
    const totalAmount = statsSourceList.reduce((sum, r) => sum + (r.totalAmount || 0), 0);
    
    setStats({
      totalRequests,
      pendingRequests,
      approvedRequests,
      authorizedRequests,
      rejectedRequests,
      completeRequests,
      totalAmount,
    });
    
    const totalPages = Math.ceil(sortedFilteredList.length / pagination.limit);
    const currentPage = Math.min(pagination.page, Math.max(1, totalPages));
    setPagination(prev => ({
      ...prev, page: currentPage, totalPages, hasNext: currentPage < totalPages, hasPrev: currentPage > 1
    }));
  }, [
    allRequisitions,
    filters,
    pagination.limit,
    pagination.page,
    userHasHummanResourceRights,
    userHasFinanceRights,
    activeProgram,
    accessibleProgrammes,
    canViewAllRequisitionProgrammes,
  ]);

  useEffect(() => {
    const filteredIds = new Set(filteredRequisitions.map((record) => record.id));
    setSelectedRecords((prev) => prev.filter((id) => filteredIds.has(id)));
  }, [filteredRequisitions]);

  // --- Handlers ---
  const toggleRecordSelection = (recordId: string) => {
    setSelectedRecords((prev) =>
      prev.includes(recordId) ? prev.filter((id) => id !== recordId) : [...prev, recordId]
    );
  };

  const toggleSelectAllCurrentPage = () => {
    const pageIds = getCurrentPageRecords().map((record) => record.id);
    setSelectedRecords((prev) => {
      const allSelected = pageIds.length > 0 && pageIds.every((id) => prev.includes(id));
      if (allSelected) return prev.filter((id) => !pageIds.includes(id));
      return Array.from(new Set([...prev, ...pageIds]));
    });
  };

  const getSelectedRequisitions = (): RequisitionData[] => {
    if (selectedRecords.length === 0) return [];
    const selectedSet = new Set(selectedRecords);
    return allRequisitions.filter((record) => selectedSet.has(record.id));
  };

  const removeRequisitionsFromState = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const deletedIds = new Set(ids);
    setAllRequisitions((prev) => prev.filter((record) => !deletedIds.has(record.id)));
    setFilteredRequisitions((prev) => prev.filter((record) => !deletedIds.has(record.id)));
    setSelectedRecords((prev) => prev.filter((id) => !deletedIds.has(id)));
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setSearchValue(value);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      setFilters(prev => ({ ...prev, search: value }));
      setPagination(prev => ({ ...prev, page: 1 }));
    }, 300);
  }, []);

  const handleFilterChange = useCallback((key: keyof Filters, value: string) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    setPagination(prev => ({ ...prev, page: 1 }));
  }, []);

  const clearFilters = useCallback(() => {
    setSearchValue("");
    setFilters(createDefaultFilters());
    setSelectedRecords([]);
    setPagination(prev => ({ ...prev, page: 1 }));
  }, []);

  const resetToCurrentMonth = useCallback(() => {
    setFilters((prev) => ({
      ...prev,
      startDate: currentMonth.startDate,
      endDate: currentMonth.endDate,
    }));
    setPagination((prev) => ({ ...prev, page: 1 }));
  }, [currentMonth.endDate, currentMonth.startDate]);

  const handlePageChange = useCallback((newPage: number) => {
    setPagination(prev => {
      const totalPages = Math.ceil(filteredRequisitions.length / prev.limit);
      const validatedPage = Math.max(1, Math.min(newPage, totalPages));
      return { ...prev, page: validatedPage, hasNext: validatedPage < totalPages, hasPrev: validatedPage > 1 };
    });
  }, [filteredRequisitions.length]);

  const resetHrDecisionState = useCallback(() => {
    setHrDecisionAction("");
    setPmDecisionAction("");
    setIsRejectDialogOpen(false);
    setRejectionMessageText("");
  }, []);

  const handleViewDialogOpenChange = useCallback((open: boolean) => {
    setIsViewDialogOpen(open);
    if (!open) {
      resetHrDecisionState();
    }
  }, [resetHrDecisionState]);

  const openViewDialog = useCallback(async (record: RequisitionData) => { 
    setViewingRecord(record); 
    resetHrDecisionState();
    
    // Fetch history for this record
    if (userIsAdmin && record.id) {
      const historyRef = ref(db, `requisitions/${record.id}/history`);
      onValue(historyRef, (snapshot) => {
        const data = snapshot.val();
        if (data) {
            const historyArr = Object.keys(data).map(key => ({ id: key, ...data[key] }));
            historyArr.sort((a, b) => b.timestamp - a.timestamp);
            setHistoryList(historyArr);
        } else {
            setHistoryList([]);
        }
      });
    } else {
      setHistoryList([]);
    }
    
    setIsViewDialogOpen(true); 
  }, [resetHrDecisionState, userIsAdmin]);

  const openHistoryOnly = useCallback((record: RequisitionData) => {
    if (!userIsAdmin) return;
    setViewingRecord(record);
    if (record.id) {
      const historyRef = ref(db, `requisitions/${record.id}/history`);
      onValue(historyRef, (snapshot) => {
        const data = snapshot.val();
        if (data) {
            const historyArr = Object.keys(data).map(key => ({ id: key, ...data[key] }));
            historyArr.sort((a, b) => b.timestamp - a.timestamp);
            setHistoryList(historyArr);
        } else {
            setHistoryList([]);
        }
        setIsHistoryOpen(true);
      }, { onlyOnce: true });
    }
  }, [userIsAdmin]);

  const handleOpenImageViewer = (record: RequisitionData, printImmediately = false) => {
    const images = getRequisitionImages(record.requisitionUrl);
    if (images.length === 0) {
      toast({ title: "No Images", description: "No receipts uploaded for this record." });
      return;
    }
    setViewingImages(images);
    setImageRecord(record);
    setIsImageViewerOpen(true);
    if (printImmediately) setTimeout(() => window.print(), 500);
  };

  const updateRequisitionImages = async (
    recordId: string,
    nextImages: string[],
    historyDetails: string
  ) => {
    setImageActionLoading(true);
    try {
      const nextUrl = nextImages.join(" | ");
      await update(ref(db, `requisitions/${recordId}`), {
        requisitionUrl: nextUrl,
        fileUploaded: nextImages.length > 0,
      });
      removeCachedValue(requisitionCacheKey);
      setViewingImages(nextImages);
      setViewingRecord((prev) =>
        prev && prev.id === recordId
          ? { ...prev, requisitionUrl: nextUrl, fileUploaded: nextImages.length > 0 }
          : prev
      );
      setImageRecord((prev) =>
        prev && prev.id === recordId
          ? { ...prev, requisitionUrl: nextUrl, fileUploaded: nextImages.length > 0 }
          : prev
      );
      await logHistory(recordId, "Receipts Updated", historyDetails, historyActorName, historyActorAttribute);
      toast({ title: "Updated", description: "Receipt images updated." });
    } catch (error) {
      console.error("Failed to update receipt images:", error);
      toast({ title: "Error", description: "Failed to update receipt images.", variant: "destructive" });
    } finally {
      setImageActionLoading(false);
    }
  };

  const openImageEditDialog = (index: number) => {
    if (!canManageImages) {
      toast({ title: "Unauthorized", description: "You do not have permission to edit images.", variant: "destructive" });
      return;
    }
    setImageEditIndex(index);
    setImageEditUrl(viewingImages[index] || "");
    setIsImageEditDialogOpen(true);
  };

  const handleSaveImageEdit = async () => {
    if (!imageRecord || imageEditIndex === null) return;
    if (!canManageImages) {
      toast({ title: "Unauthorized", description: "You do not have permission to edit images.", variant: "destructive" });
      return;
    }
    const nextUrl = imageEditUrl.trim();
    if (!nextUrl) {
      toast({ title: "Invalid URL", description: "Enter a valid image URL.", variant: "destructive" });
      return;
    }
    const nextImages = [...viewingImages];
    nextImages[imageEditIndex] = nextUrl;
    await updateRequisitionImages(
      imageRecord.id,
      nextImages,
      `Updated receipt image #${imageEditIndex + 1}`
    );
    setIsImageEditDialogOpen(false);
    setImageEditIndex(null);
    setImageEditUrl("");
  };

  const handleDeleteImage = async (index: number) => {
    if (!imageRecord) return;
    if (!canManageImages) {
      toast({ title: "Unauthorized", description: "You do not have permission to delete images.", variant: "destructive" });
      return;
    }
    const confirmed = window.confirm(`Delete receipt #${index + 1}? This cannot be undone.`);
    if (!confirmed) return;
    const nextImages = viewingImages.filter((_, i) => i !== index);
    await updateRequisitionImages(
      imageRecord.id,
      nextImages,
      `Deleted receipt image #${index + 1}`
    );
  };

  const openEditDialog = useCallback((record: RequisitionData) => {
    if (!userIsAdmin) {
      toast({
        title: "Unauthorized",
        description: "Only Admin can edit requisitions.",
        variant: "destructive",
      });
      return;
    }
    setEditRecord(record);
    setEditFormData({
      ...record,
      items: record.items ? [...record.items] : []
    });
    setIsEditDialogOpen(true);
  }, [toast, userIsAdmin]);

  const handleEditFieldChange = (field: keyof RequisitionData, value: any) => {
    setEditFormData(prev => ({ ...prev, [field]: value }));
  };

  const handlePerdiemItemChange = (index: number, field: 'name' | 'price' | 'date', value: any) => {
    const currentItems = editFormData.items || [];
    const updatedItems = currentItems.map((item, i) => 
      i === index ? { ...item, [field]: value } : item
    );
    setEditFormData(prev => ({ ...prev, items: updatedItems }));
    if (field === 'price') {
      const newTotal = updatedItems.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
      setEditFormData(prev => ({ ...prev, total: newTotal }));
    }
  };

  const addPerdiemItem = () => {
    const currentItems = editFormData.items || [];
    setEditFormData(prev => ({
      ...prev,
      items: [...currentItems, { name: '', price: 0, date: toInputDate(new Date()) }]
    }));
  };

  const removePerdiemItem = (index: number) => {
    const currentItems = editFormData.items || [];
    const updatedItems = currentItems.filter((_, i) => i !== index);
    const newTotal = updatedItems.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
    setEditFormData(prev => ({ ...prev, items: updatedItems, total: newTotal }));
  };

  const saveEdit = async () => {
    if (!userIsAdmin) {
      toast({
        title: "Unauthorized",
        description: "Only Admin can edit requisitions.",
        variant: "destructive",
      });
      return;
    }
    if (!editRecord) return;
    setIsSaving(true);
    try {
      const actorName = userName || user?.displayName || user?.email || "Admin";
      const previousStatus = String(editRecord.status || '').toLowerCase();
      const nextStatus = String(editFormData.status || editRecord.status || '').toLowerCase();
      const statusChanged = previousStatus !== nextStatus;

      const updatePayload: any = {
        county: editFormData.county,
        subcounty: editFormData.subcounty,
        tripPurpose: editFormData.tripPurpose,
        status: editFormData.status,
      };

      if (statusChanged && nextStatus === 'approved') {
        if (!canApproveRequisition) {
          toast({ title: "Unauthorized", description: "Only Project Manager, M&E Officer, Admin and Admin can approve requisitions.", variant: "destructive" });
          return;
        }
        updatePayload.approvedBy = actorName;
        updatePayload.approvedByAttribute = approvalActorAttribute || null;
        updatePayload.approvedAt = Date.now();
      }

      if (statusChanged && nextStatus === 'complete') {
        if (!canMarkRequisitionComplete) {
          toast({ title: "Unauthorized", description: "You do not have permission to mark requisitions complete.", variant: "destructive" });
          return;
        }
        const authorizedBy = String(editFormData.authorizedBy || editRecord.authorizedBy || '').trim();
        if (requiresHrAuthorization(editRecord) && !authorizedBy) {
          toast({ title: "Authorization Required", description: "Requisition can only be completed after Humman Resource Manager authorization.", variant: "destructive" });
          return;
        }
        const transactionCompletedBy = String(
          editFormData.transactionCompletedBy || editRecord.transactionCompletedBy || ''
        ).trim();
        if (!transactionCompletedBy) {
          toast({ title: "Transaction Required", description: "Finance must complete the transaction before requisition can be marked complete.", variant: "destructive" });
          return;
        }
        const receiptImages = getRequisitionImages(
          String(editFormData.requisitionUrl || editRecord.requisitionUrl || "")
        );
        if (receiptImages.length === 0) {
          toast({ title: "Receipts Required", description: "Requisition can only be marked complete after receipt images are uploaded.", variant: "destructive" });
          return;
        }
        updatePayload.completedBy = actorName;
        updatePayload.completedAt = Date.now();
      }

      if (statusChanged && nextStatus === "rejected" && !canRejectRequisition) {
        toast({ title: "Unauthorized", description: "Only HR or Admin can reject requisitions.", variant: "destructive" });
        return;
      }

      if (editRecord.type === 'fuel and Service') {
        updatePayload.lastReading = editFormData.lastReading;
        updatePayload.currentReading = editFormData.currentReading;
        updatePayload.distanceTraveled = editFormData.distanceTraveled;
        updatePayload.fuelAmount = editFormData.fuelAmount;
        updatePayload.fuelPurpose = editFormData.tripPurpose; 
      } else if (editRecord.type === 'airtime') {
        updatePayload.airtimeAmount = editFormData.airtimeAmount;
        updatePayload.airtimePurpose = editFormData.tripPurpose;
      } else {
        updatePayload.fromLocation = editFormData.fromLocation;
        updatePayload.toLocation = editFormData.toLocation;
        updatePayload.tripFrom = editFormData.tripFrom;
        updatePayload.tripTo = editFormData.tripTo;
        updatePayload.numberOfDays = editFormData.numberOfDays;
        updatePayload.items = editFormData.items;
        updatePayload.total = editFormData.total;
        updatePayload.location = editFormData.location;
      }
      await update(ref(db, `requisitions/${editRecord.id}`), updatePayload);
      removeCachedValue(requisitionCacheKey);

      if (statusChanged && nextStatus === 'approved') {
        await logHistory(editRecord.id, "Approved", `Approved by ${actorName}`, actorName, approvalActorAttribute || historyActorAttribute);
      } else if (statusChanged && nextStatus === 'complete') {
        await logHistory(editRecord.id, "Completed", `Marked complete by ${actorName}`, actorName, historyActorAttribute);
      } else if (statusChanged && nextStatus === 'rejected') {
        await logHistory(editRecord.id, "Rejected", `Rejected by ${actorName}`, actorName, historyActorAttribute);
      } else {
        await logHistory(editRecord.id, "Edited", "Requisition details updated.", actorName, historyActorAttribute);
      }

      toast({ title: "Success", description: "Requisition updated successfully." });
      setIsEditDialogOpen(false);
    } catch (error) {
      console.error(error);
      toast({ title: "Error", description: "Failed to update requisition.", variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  const confirmDelete = (record: RequisitionData) => {
    if (!canDeleteRequisition) {
      toast({
        title: "Unauthorized",
        description: "Only Admin can delete requisitions.",
        variant: "destructive",
      });
      return;
    }
    setRecordToDelete(record);
    setIsDeleteConfirmOpen(true);
  };

  const executeDelete = async () => {
    if (!canDeleteRequisition) {
      toast({
        title: "Unauthorized",
        description: "Only Admin can delete requisitions.",
        variant: "destructive",
      });
      return;
    }
    if (!recordToDelete) return;
    setDeleteLoading(true);
    try {
      await remove(ref(db, `requisitions/${recordToDelete.id}`));
      removeCachedValue(requisitionCacheKey);
      removeRequisitionsFromState([recordToDelete.id]);
      toast({ title: "Deleted", description: "Requisition deleted successfully" });
      setIsDeleteConfirmOpen(false);
      setRecordToDelete(null);
    } catch (error) {
      toast({ title: "Error", description: "Failed to delete", variant: "destructive" });
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleApprove = async () => {
    if (!viewingRecord) return;
    if (!canApproveRequisition) {
      toast({ title: "Unauthorized", description: "Only Project Manager, M&E Officer, Admin and Admin can approve requisitions.", variant: "destructive" });
      return;
    }
    if (isFieldOfficerRequisition(viewingRecord) && !userHasProjectManagerRights && !userHasMerRights && !userIsAdmin) {
      toast({ title: "Project Officer Required", description: "Field Officer requisitions must be approved by Project Officer before HR receives them.", variant: "destructive" });
      return;
    }
    if (isProjectOrMerRequisition(viewingRecord) && !userHasProjectManagerRights && !userHasMerRights && !userIsAdmin) {
      toast({ title: "Project/M&E Approval Required", description: "Project Officer and M&E requisitions must be approved by Project Officer or M&E Officer.", variant: "destructive" });
      return;
    }
    try {
        const approverName = userName || user?.displayName || user?.email || "Admin";
        await update(ref(db, `requisitions/${viewingRecord.id}`), {
            status: 'approved',
            approvedBy: approverName,
            approvedByAttribute: approvalActorAttribute || null,
            approvedAt: Date.now()
        });
        removeCachedValue(requisitionCacheKey);
        
        const approvalDetails = approvalActorAttribute ?
          `Approved by ${approverName} (${approvalActorAttribute})` :
          `Approved by ${approverName}`;
        await logHistory(viewingRecord.id, "Approved", approvalDetails, approverName, approvalActorAttribute || historyActorAttribute);
        
        toast({ title: "Approved", description: "Requisition approved successfully" });
        handleViewDialogOpenChange(false); 
    } catch (error) {
        toast({ title: "Error", description: "Failed to approve", variant: "destructive" });
    }
  };

  const handlePmDecisionChange = async (decision: string) => {
    setPmDecisionAction(decision);
    if (!viewingRecord) return;

    if (decision === "approve") {
      await handleApprove();
      setPmDecisionAction("");
      return;
    }

    if (decision === "reject") {
      if (!canRejectPendingRequisition) {
        toast({ title: "Unauthorized", description: "Only Project Manager can reject pending requisitions.", variant: "destructive" });
        setPmDecisionAction("");
        return;
      }
      if (String(viewingRecord.status || "").toLowerCase() !== "pending") {
        toast({ title: "Invalid Status", description: "Only pending requisitions can be rejected at this stage.", variant: "destructive" });
        setPmDecisionAction("");
        return;
      }
      setRejectionMessageText("");
      setIsRejectDialogOpen(true);
    }
  };

  // --- HR Authorization Handler ---
  const handleAuthorize = async (): Promise<boolean> => {
    if (!viewingRecord) return false;
    if (!canAuthorizeRequisition) {
      toast({ title: "Unauthorized", description: "Only Humman Resource Manager can authorize requisitions.", variant: "destructive" });
      return false;
    }
    if (viewingRecord.status !== 'approved') {
      toast({ title: "Invalid Status", description: "Only approved requisitions can be authorized.", variant: "destructive" });
      return false;
    }
    if (!canRequisitionReachHr(viewingRecord)) {
      toast({ title: "Project Officer Approval Required", description: "Field Officer requisitions can only be authorized after Project Officer approval.", variant: "destructive" });
      return false;
    }
    try {
        const actorName = userName || user?.displayName || user?.email || "Admin";
        
        // Only updates authorizedBy and authorizedAt, keeps status as 'approved'
        await update(ref(db, `requisitions/${viewingRecord.id}`), {
            authorizedBy: actorName,
            authorizedByAttribute: actorAttribute,
            authorizedAt: Date.now()
        });
        removeCachedValue(requisitionCacheKey);

        await logHistory(viewingRecord.id, "Authorized", `Authorized by ${actorName} (${actorAttribute})`, actorName, actorAttribute);

        toast({ title: "Authorized", description: "Requisition authorized successfully." });
        
        // Update local state
        setViewingRecord(prev => prev ? { 
            ...prev, 
            authorizedBy: actorName, 
            authorizedByAttribute: actorAttribute,
            authorizedAt: Date.now() 
        } : null);
        return true;
    } catch (error) {
        toast({ title: "Error", description: "Failed to authorize", variant: "destructive" });
        return false;
    }
  };

  const handleHrDecisionChange = async (decision: string) => {
    setHrDecisionAction(decision);
    if (!viewingRecord) return;

    if (decision === "authorize") {
      const succeeded = await handleAuthorize();
      if (succeeded) setHrDecisionAction("");
      return;
    }

    // HR direct approve + authorize for non-FO/PM/M&E pending requisitions
    if (decision === "approve-authorize") {
      if (!isHrDirectApprovalRequisition(viewingRecord)) {
        toast({ title: "Not Allowed", description: "Only non-FO/PM/M&E requisitions can be directly approved by HR.", variant: "destructive" });
        setHrDecisionAction("");
        return;
      }
      try {
        const actorName = userName || user?.displayName || user?.email || "Admin";
        await update(ref(db, `requisitions/${viewingRecord.id}`), {
          status: "approved",
          approvedBy: actorName,
          approvedByAttribute: actorAttribute,
          approvedAt: Date.now(),
          authorizedBy: actorName,
          authorizedByAttribute: actorAttribute,
          authorizedAt: Date.now(),
        });
        removeCachedValue(requisitionCacheKey);
        await logHistory(viewingRecord.id, "Approved & Authorized", `Approved and authorized by ${actorName} (${actorAttribute})`, actorName, actorAttribute);
        toast({ title: "Approved & Authorized", description: "Requisition approved and authorized successfully." });
        setViewingRecord(prev => prev ? {
          ...prev,
          status: "approved",
          approvedBy: actorName,
          approvedByAttribute: actorAttribute,
          approvedAt: Date.now(),
          authorizedBy: actorName,
          authorizedByAttribute: actorAttribute,
          authorizedAt: Date.now(),
        } : null);
        setHrDecisionAction("");
      } catch (error) {
        toast({ title: "Error", description: "Failed to approve and authorize requisition.", variant: "destructive" });
      }
      return;
    }

    if (decision === "reject") {
      if (!canRejectRequisition) {
        toast({ title: "Unauthorized", description: "Only HR or Admin can reject requisitions.", variant: "destructive" });
        setHrDecisionAction("");
        return;
      }
      setRejectionMessageText("");
      setIsRejectDialogOpen(true);
    }
  };

  const handleRejectRequisition = async () => {
    if (!viewingRecord) return;
    const status = String(viewingRecord.status || "").toLowerCase();
    if (status !== "pending" && status !== "approved") {
      toast({ title: "Invalid Status", description: "Only pending or approved requisitions can be rejected.", variant: "destructive" });
      return;
    }
    if (status === "pending" && !canRejectPendingRequisition) {
      toast({ title: "Unauthorized", description: "Only Project Manager can reject pending requisitions.", variant: "destructive" });
      return;
    }
    if (status === "approved" && !canRejectRequisition) {
      toast({ title: "Unauthorized", description: "Only HR or Admin can reject approved requisitions.", variant: "destructive" });
      return;
    }
    if (status === "approved" && canAuthorizeRequisition && !canRequisitionReachHr(viewingRecord)) {
      toast({ title: "Project Officer Approval Required", description: "Field Officer requisitions can only be rejected by HR after Project Officer approval.", variant: "destructive" });
      return;
    }

    const rejectionMessage = rejectionMessageText.trim();
    if (!rejectionMessage) {
      toast({ title: "Message Required", description: "Enter an SMS message.", variant: "destructive" });
      return;
    }

    try {
      const actorName = userName || user?.displayName || user?.email || "Admin";
      const rejectedAt = Date.now();
      await update(ref(db, `requisitions/${viewingRecord.id}`), {
        status: "rejected",
        rejectedBy: actorName,
        rejectedAt,
        rejectionReason: rejectionMessage,
        rejectionSmsText: rejectionMessage,
      });
      removeCachedValue(requisitionCacheKey);
      await logHistory(viewingRecord.id, "Rejected", `Rejected by ${actorName}. SMS sent to requester.`, actorName, historyActorAttribute);

      toast({ title: "Rejected", description: "Requisition rejected and requester will be notified by SMS." });
      setViewingRecord((prev) =>
        prev ?
          {
            ...prev,
            status: "rejected",
            rejectedBy: actorName,
            rejectedAt,
            rejectionReason: rejectionMessage,
            rejectionSmsText: rejectionMessage,
          } :
          null
      );
      setIsRejectDialogOpen(false);
      setHrDecisionAction("");
      setPmDecisionAction("");
      setRejectionMessageText("");
    } catch (error) {
      toast({ title: "Error", description: "Failed to reject requisition.", variant: "destructive" });
    }
  };

  // --- Transaction Completion Handler (Finance) ---
  const handleCompleteTransaction = async () => {
    if (!viewingRecord) return;
    if (!canCompleteTransaction) {
      toast({ title: "Unauthorized", description: "Only Finance can complete transactions.", variant: "destructive" });
      return;
    }
    if (viewingRecord.status !== 'approved') {
      toast({ title: "Invalid Status", description: "Only approved requisitions can be marked complete.", variant: "destructive" });
      return;
    }
    if (!canProceedAfterApproval(viewingRecord)) {
      toast({ title: "Authorization Required", description: "Requisition can only be completed after Humman Resource Manager authorization.", variant: "destructive" });
      return;
    }
    if (viewingRecord.transactionCompletedBy) {
      toast({ title: "Already Completed", description: "Transaction has already been completed by Finance." });
      return;
    }
    try {
        const actorName = userName || user?.displayName || user?.email || "Admin";
        
        const updatePayload: any = {
            transactionCompletedBy: actorName,
            transactionCompletedAt: Date.now(),
        };

        await update(ref(db, `requisitions/${viewingRecord.id}`), updatePayload);
        removeCachedValue(requisitionCacheKey);

        await logHistory(viewingRecord.id, "Transaction Completed", `Finance completed transaction by ${actorName}`, actorName, historyActorAttribute);

        toast({ title: "Transaction Completed", description: "Finance transaction completed successfully." });
        
        setViewingRecord(prev => prev ? {
          ...prev,
          transactionCompletedBy: actorName,
          transactionCompletedAt: updatePayload.transactionCompletedAt,
        } : null);
        setIsHistoryOpen(false);
    } catch (error) {
        toast({ title: "Error", description: "Failed to complete transaction", variant: "destructive" });
    }
  };

  // --- Mark Requisition Complete Handler (Non-Finance) ---
  const handleMarkComplete = async () => {
    if (!viewingRecord) return;
    if (!canMarkRequisitionComplete) {
      toast({ title: "Unauthorized", description: "You do not have permission to mark requisitions complete.", variant: "destructive" });
      return;
    }
    if (viewingRecord.status !== 'approved') {
      toast({ title: "Invalid Status", description: "Only approved requisitions can be marked complete.", variant: "destructive" });
      return;
    }
    if (!canProceedAfterApproval(viewingRecord)) {
      toast({ title: "Authorization Required", description: "Requisition can only be completed after Humman Resource Manager authorization.", variant: "destructive" });
      return;
    }
    if (!viewingRecord.transactionCompletedBy) {
      toast({ title: "Transaction Required", description: "Finance must complete the transaction before marking requisition complete.", variant: "destructive" });
      return;
    }
    const receiptImages = getRequisitionImages(viewingRecord.requisitionUrl);
    if (receiptImages.length === 0) {
      toast({ title: "Receipts Required", description: "Requisition can only be marked complete after receipt images are uploaded.", variant: "destructive" });
      return;
    }
    try {
        const actorName = userName || user?.displayName || user?.email || "Admin";
        const updatePayload: any = {
            status: 'complete',
            completedBy: actorName,
            completedAt: Date.now(),
        };

        await update(ref(db, `requisitions/${viewingRecord.id}`), updatePayload);
        removeCachedValue(requisitionCacheKey);

        await logHistory(viewingRecord.id, "Completed", `Marked complete by ${actorName} after receipt submission.`, actorName, historyActorAttribute);

        toast({ title: "Completed", description: "Requisition marked as complete." });
        
        setViewingRecord(prev => prev ? {
          ...prev,
          status: 'complete',
          completedBy: actorName,
          completedAt: updatePayload.completedAt,
        } : null);
        setIsHistoryOpen(false);
    } catch (error) {
        toast({ title: "Error", description: "Failed to mark complete", variant: "destructive" });
    }
  };

  // --- Bulk Actions ---
  const handleBulkApprove = async () => {
    if (!canApproveRequisition) {
      toast({ title: "Unauthorized", description: "You do not have permission to approve requisitions.", variant: "destructive" });
      return;
    }

    const selected = getSelectedRequisitions();
    const eligible = selected.filter((record) => (
      record.status === "pending" &&
      !record.approvedBy &&
      (!isFieldOfficerRequisition(record) || userHasProjectManagerRights || userHasMerRights || userIsAdmin) &&
      (!isProjectOrMerRequisition(record) || userHasProjectManagerRights || userHasMerRights || userIsAdmin)
    ));
    const skipped = selected.length - eligible.length;

    if (eligible.length === 0) {
      toast({ title: "No Eligible Records", description: "Select pending requisitions that are not yet approved." });
      return;
    }

    const actorName = userName || user?.displayName || user?.email || "Admin";
    setIsBulkProcessing(true);
    try {
      const results = await Promise.all(
        eligible.map(async (record) => {
          try {
            await update(ref(db, `requisitions/${record.id}`), {
              status: "approved",
              approvedBy: actorName,
              approvedByAttribute: approvalActorAttribute || null,
              approvedAt: Date.now(),
            });
            const approvalDetails = approvalActorAttribute ?
              `Approved by ${actorName} (${approvalActorAttribute})` :
              `Approved by ${actorName}`;
            await logHistory(record.id, "Approved", approvalDetails, actorName, approvalActorAttribute || historyActorAttribute);
            return true;
          } catch (error) {
            console.error("Bulk approve failed for record:", record.id, error);
            return false;
          }
        })
      );
      const successCount = results.filter(Boolean).length;
      if (successCount > 0) removeCachedValue(requisitionCacheKey);
      setSelectedRecords([]);
      toast({
        title: "Bulk Approve Complete",
        description: `${successCount} approved${skipped ? `, ${skipped} skipped` : ""}.`,
      });
    } finally {
      setIsBulkProcessing(false);
    }
  };

  const handleBulkAuthorize = async () => {
    if (!canAuthorizeRequisition) {
      toast({ title: "Unauthorized", description: "Only Humman Resource Manager can authorize requisitions.", variant: "destructive" });
      return;
    }

    const selected = getSelectedRequisitions();
    const eligible = selected.filter((record) => (
      record.status === "approved" &&
      !record.authorizedBy &&
      canRequisitionReachHr(record)
    ));
    const skipped = selected.length - eligible.length;

    if (eligible.length === 0) {
      toast({ title: "No Eligible Records", description: "Select approved requisitions that are not yet authorized." });
      return;
    }

    const actorName = userName || user?.displayName || user?.email || "Admin";
    setIsBulkProcessing(true);
    try {
      const results = await Promise.all(
        eligible.map(async (record) => {
          try {
            await update(ref(db, `requisitions/${record.id}`), {
              authorizedBy: actorName,
              authorizedByAttribute: actorAttribute,
              authorizedAt: Date.now(),
            });
            await logHistory(record.id, "Authorized", `Authorized by ${actorName} (${actorAttribute})`, actorName, actorAttribute);
            return true;
          } catch (error) {
            console.error("Bulk authorize failed for record:", record.id, error);
            return false;
          }
        })
      );
      const successCount = results.filter(Boolean).length;
      if (successCount > 0) removeCachedValue(requisitionCacheKey);
      setSelectedRecords([]);
      toast({
        title: "Bulk Authorize Complete",
        description: `${successCount} authorized${skipped ? `, ${skipped} skipped` : ""}.`,
      });
    } finally {
      setIsBulkProcessing(false);
    }
  };

  const handleBulkReject = async () => {
    if (!canRejectRequisition) {
      toast({ title: "Unauthorized", description: "Only HR or Admin can reject requisitions.", variant: "destructive" });
      return;
    }

    const rejectionMessage = bulkRejectionMessageText.trim();
    if (!rejectionMessage) {
      toast({ title: "Message Required", description: "Enter an SMS message.", variant: "destructive" });
      return;
    }

    const selected = getSelectedRequisitions();
    const eligible = selected.filter((record) => record.status === "approved" && canRequisitionReachHr(record));
    const skipped = selected.length - eligible.length;

    if (eligible.length === 0) {
      toast({ title: "No Eligible Records", description: "Only approved requisitions can be rejected." });
      return;
    }

    const actorName = userName || user?.displayName || user?.email || "Admin";
    const rejectedAt = Date.now();
    setIsBulkProcessing(true);
    try {
      const results = await Promise.all(
        eligible.map(async (record) => {
          try {
            await update(ref(db, `requisitions/${record.id}`), {
              status: "rejected",
              rejectedBy: actorName,
              rejectedAt,
              rejectionReason: rejectionMessage,
              rejectionSmsText: rejectionMessage,
            });
            await logHistory(record.id, "Rejected", `Rejected by ${actorName}. SMS sent to requester.`, actorName, historyActorAttribute);
            return true;
          } catch (error) {
            console.error("Bulk reject failed for record:", record.id, error);
            return false;
          }
        })
      );
      const successCount = results.filter(Boolean).length;
      if (successCount > 0) removeCachedValue(requisitionCacheKey);
      setSelectedRecords([]);
      setIsBulkRejectDialogOpen(false);
      setBulkRejectionMessageText("");
      toast({
        title: "Bulk Reject Complete",
        description: `${successCount} rejected${skipped ? `, ${skipped} skipped` : ""}.`,
      });
    } finally {
      setIsBulkProcessing(false);
    }
  };

  const handleBulkCompleteTransaction = async () => {
    if (!canCompleteTransaction) {
      toast({ title: "Unauthorized", description: "Only Finance can complete transactions.", variant: "destructive" });
      return;
    }

    const selected = getSelectedRequisitions();
    const eligible = selected.filter(
      (record) => canProceedAfterApproval(record) && !record.transactionCompletedBy
    );
    const skipped = selected.length - eligible.length;

    if (eligible.length === 0) {
      toast({ title: "No Eligible Records", description: "Select authorized approved requisitions pending transaction completion." });
      return;
    }

    const actorName = userName || user?.displayName || user?.email || "Admin";
    setIsBulkProcessing(true);
    try {
      const results = await Promise.all(
        eligible.map(async (record) => {
          try {
            const transactionCompletedAt = Date.now();
            await update(ref(db, `requisitions/${record.id}`), {
              transactionCompletedBy: actorName,
              transactionCompletedAt,
            });
            await logHistory(record.id, "Transaction Completed", `Finance completed transaction by ${actorName}`, actorName, historyActorAttribute);
            return true;
          } catch (error) {
            console.error("Bulk transaction completion failed for record:", record.id, error);
            return false;
          }
        })
      );
      const successCount = results.filter(Boolean).length;
      if (successCount > 0) removeCachedValue(requisitionCacheKey);
      setSelectedRecords([]);
      toast({
        title: "Bulk Transaction Complete",
        description: `${successCount} transactions completed${skipped ? `, ${skipped} skipped` : ""}.`,
      });
    } finally {
      setIsBulkProcessing(false);
    }
  };

  const handleCompleteAllTransactions = async () => {
    if (!canCompleteTransaction) {
      toast({ title: "Unauthorized", description: "Only Finance can complete transactions.", variant: "destructive" });
      return;
    }

    const scopeRecords = filteredRequisitions;
    const eligible = scopeRecords.filter(
      (record) => canProceedAfterApproval(record) && !record.transactionCompletedBy
    );
    const skipped = scopeRecords.length - eligible.length;

    if (eligible.length === 0) {
      toast({ title: "No Eligible Records", description: "No authorized approved requisitions are pending transaction completion." });
      return;
    }

    const actorName = userName || user?.displayName || user?.email || "Admin";
    setIsBulkProcessing(true);
    try {
      const results = await Promise.all(
        eligible.map(async (record) => {
          try {
            const transactionCompletedAt = Date.now();
            await update(ref(db, `requisitions/${record.id}`), {
              transactionCompletedBy: actorName,
              transactionCompletedAt,
            });
            await logHistory(record.id, "Transaction Completed", `Finance completed transaction by ${actorName}`, actorName, historyActorAttribute);
            return true;
          } catch (error) {
            console.error("Complete-all transaction failed for record:", record.id, error);
            return false;
          }
        })
      );
      const successCount = results.filter(Boolean).length;
      if (successCount > 0) removeCachedValue(requisitionCacheKey);
      setSelectedRecords([]);
      toast({
        title: "All Transactions Complete",
        description: `${successCount} transactions completed${skipped ? `, ${skipped} skipped` : ""}.`,
      });
    } finally {
      setIsBulkProcessing(false);
    }
  };

  const handleBulkMarkComplete = async () => {
    if (!canMarkRequisitionComplete) {
      toast({ title: "Unauthorized", description: "You do not have permission to mark requisitions complete.", variant: "destructive" });
      return;
    }

    const selected = getSelectedRequisitions();
    const eligible = selected.filter((record) => (
      canProceedAfterApproval(record) &&
      !!record.transactionCompletedBy &&
      getRequisitionImages(record.requisitionUrl).length > 0
    ));
    const skipped = selected.length - eligible.length;

    if (eligible.length === 0) {
      toast({ title: "No Eligible Records", description: "Select requisitions with authorization, completed transaction and uploaded receipts." });
      return;
    }

    const actorName = userName || user?.displayName || user?.email || "Admin";
    setIsBulkProcessing(true);
    try {
      const results = await Promise.all(
        eligible.map(async (record) => {
          try {
            const completedAt = Date.now();
            await update(ref(db, `requisitions/${record.id}`), {
              status: "complete",
              completedBy: actorName,
              completedAt,
            });
            await logHistory(record.id, "Completed", `Marked complete by ${actorName} after receipt submission.`, actorName, historyActorAttribute);
            return true;
          } catch (error) {
            console.error("Bulk mark complete failed for record:", record.id, error);
            return false;
          }
        })
      );
      const successCount = results.filter(Boolean).length;
      if (successCount > 0) removeCachedValue(requisitionCacheKey);
      setSelectedRecords([]);
      toast({
        title: "Bulk Completion Done",
        description: `${successCount} requisitions marked complete${skipped ? `, ${skipped} skipped` : ""}.`,
      });
    } finally {
      setIsBulkProcessing(false);
    }
  };

  const handleMarkAllComplete = async () => {
    if (!canMarkRequisitionComplete) {
      toast({ title: "Unauthorized", description: "You do not have permission to mark requisitions complete.", variant: "destructive" });
      return;
    }

    const scopeRecords = filteredRequisitions;
    const eligible = scopeRecords.filter((record) => (
      canProceedAfterApproval(record) &&
      !!record.transactionCompletedBy &&
      getRequisitionImages(record.requisitionUrl).length > 0
    ));
    const skipped = scopeRecords.length - eligible.length;

    if (eligible.length === 0) {
      toast({ title: "No Eligible Records", description: "No requisitions meet completion requirements in the current list." });
      return;
    }

    const actorName = userName || user?.displayName || user?.email || "Admin";
    setIsBulkProcessing(true);
    try {
      const results = await Promise.all(
        eligible.map(async (record) => {
          try {
            const completedAt = Date.now();
            await update(ref(db, `requisitions/${record.id}`), {
              status: "complete",
              completedBy: actorName,
              completedAt,
            });
            await logHistory(record.id, "Completed", `Marked complete by ${actorName} after receipt submission.`, actorName, historyActorAttribute);
            return true;
          } catch (error) {
            console.error("Mark-all complete failed for record:", record.id, error);
            return false;
          }
        })
      );
      const successCount = results.filter(Boolean).length;
      if (successCount > 0) removeCachedValue(requisitionCacheKey);
      setSelectedRecords([]);
      toast({
        title: "All Requisitions Marked",
        description: `${successCount} requisitions marked complete${skipped ? `, ${skipped} skipped` : ""}.`,
      });
    } finally {
      setIsBulkProcessing(false);
    }
  };

  const handleBulkDelete = async () => {
    if (!canDeleteRequisition) {
      toast({ title: "Unauthorized", description: "You do not have permission to delete requisitions.", variant: "destructive" });
      return;
    }

    const selected = getSelectedRequisitions();
    if (selected.length === 0) {
      toast({ title: "No Selection", description: "Select requisitions to delete." });
      return;
    }

    const confirmed = window.confirm(`Delete ${selected.length} selected requisitions? This action cannot be undone.`);
    if (!confirmed) return;

    setIsBulkProcessing(true);
    try {
      const results = await Promise.all(
        selected.map(async (record) => {
          try {
            await remove(ref(db, `requisitions/${record.id}`));
            return true;
          } catch (error) {
            console.error("Bulk delete failed for record:", record.id, error);
            return false;
          }
        })
      );
      const successCount = results.filter(Boolean).length;
      if (successCount > 0) {
        removeCachedValue(requisitionCacheKey);
        const deletedIds = selected.filter((_, index) => results[index]).map((record) => record.id);
        removeRequisitionsFromState(deletedIds);
      } else {
        setSelectedRecords([]);
      }
      toast({
        title: "Bulk Delete Complete",
        description: `${successCount} requisitions deleted.`,
      });
    } finally {
      setIsBulkProcessing(false);
    }
  };

  const handlePrint = () => {
    setPrintDate(new Date().toLocaleString());
    // Allow the state to update before triggering print
    setTimeout(() => {
        window.print();
    }, 300);
  };

  const handleDownload = useCallback(async () => {
    if (!docRef.current || !viewingRecord) return;
    const element = docRef.current;
    const parent = element.parentElement as HTMLElement; 
    const grandParent = parent?.parentElement as HTMLElement; 
    
    toast({ title: "Generating PDF", description: "Please wait..." });
    
    const originalParentOverflow = parent?.style.overflow;
    const originalParentHeight = parent?.style.height;
    const originalGrandParentMaxHeight = grandParent?.style.maxHeight;
    const originalGrandParentHeight = grandParent?.style.height;

    try {
      if (parent) {
        parent.style.overflow = 'visible';
        parent.style.height = 'auto';
      }
      if (grandParent) {
        grandParent.style.maxHeight = 'none';
        grandParent.style.height = 'auto';
        grandParent.style.overflow = 'visible';
      }

      await new Promise(resolve => setTimeout(resolve, 100));

      const canvas = await html2canvas(element, { 
        scale: 2, 
        useCORS: true, 
        backgroundColor: '#ffffff',
        windowWidth: element.scrollWidth, 
      });
      
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const imgProps = pdf.getImageProperties(imgData);
      const imgHeight = (imgProps.height * pdfWidth) / imgProps.width;
      pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, imgHeight);
      pdf.save(`Requisition_${viewingRecord.id}_${viewingRecord.type}.pdf`);
      toast({ title: "Success", description: "Document downloaded." });
    } catch (error) {
      console.error("PDF Gen Error:", error);
      toast({ title: "Error", description: "Failed to generate PDF", variant: "destructive" });
    } finally {
      if (parent) {
        parent.style.overflow = originalParentOverflow || '';
        parent.style.height = originalParentHeight || '';
      }
      if (grandParent) {
        grandParent.style.maxHeight = originalGrandParentMaxHeight || '';
        grandParent.style.height = originalGrandParentHeight || '';
      }
    }
  }, [viewingRecord, toast]);

  const getCurrentPageRecords = useCallback(() => {
    const startIndex = (pagination.page - 1) * pagination.limit;
    const endIndex = startIndex + pagination.limit;
    return filteredRequisitions.slice(startIndex, endIndex);
  }, [filteredRequisitions, pagination.page, pagination.limit]);

  const currentPageRecords = getCurrentPageRecords();
  const allCurrentPageSelected =
    currentPageRecords.length > 0 &&
    currentPageRecords.every((record) => selectedRecords.includes(record.id));

  const StatsCard = memo(({ title, value, icon: Icon, color = "blue", description }: any) => (
    <Card className="bg-white text-slate-900 shadow-lg border border-gray-200 relative overflow-hidden">
      <div className={`absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-${color}-600 to-purple-800`}></div>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 pt-4 pl-6">
        <CardTitle className="text-sm font-medium text-gray-400">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pl-6 pb-4 flex flex-col">
        {(value !== undefined && value !== null && value !== "") && (
          <div className="flex items-center gap-3 mb-1">
              <div className="rounded-full bg-gray-50 p-2">
                  <Icon className={`h-5 w-5 text-${color}-600`} />
              </div>
              <div className="text-xl font-bold text-gray-800">{value}</div>
          </div>
        )}
        {description && <p className="text-xs mt-2 bg-gray-50 px-2 py-1 rounded-md border border-slate-100">{description}</p>}
      </CardContent>
    </Card>
  ));

  // --- Render ---
  return (
    <>
   <style>
{`
@media print {

    /* Paper setup */
    @page { 
        size: A4 portrait; 
        margin: 10mm; 
    }

    /* Reset root */
    html, body {
        width: 100% !important;
        height: auto !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: visible !important;
        background: white !important;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
    }

    /* Hide everything except print wrapper */
    body > *:not(.print-content-wrapper) {
        display: none !important;
    }

    /* Main wrapper */
    .print-content-wrapper {
        position: static !important;
        width: 100% !important;
        max-width: 100% !important;
        margin: 0 !important;
        padding: 0 !important;
        background: white !important;
        display: block !important;
        height: auto !important;
        min-height: auto !important;
        max-height: none !important;
        overflow: visible !important;
        border: none !important;
        box-shadow: none !important;
        transform: none !important;
    }

    /* Remove dialog UI elements */
    .print-content-wrapper button,
    .print-content-wrapper .fixed,
    .print-content-wrapper .no-print {
        display: none !important;
    }

    /* Remove scroll containers */
    .print-content-wrapper .overflow-y-auto,
    .print-content-wrapper .overflow-auto {
        overflow: visible !important;
        max-height: none !important;
        height: auto !important;
    }

    /* Main printable content */
    .printable-area {
        width: 100% !important;
        max-width: 100% !important;
        height: auto !important;
        min-height: auto !important;
        max-height: none !important;
        overflow: visible !important;
        padding: 0 !important;
        margin: 0 !important;
        border: none !important;
        box-shadow: none !important;
    }

    /* Tables */
    table {
        width: 100% !important;
        border-collapse: collapse !important;
    }

    /* Fix grid layouts breaking */
    .grid {
        display: block !important;
    }

    .grid > div {
        page-break-inside: avoid !important;
        break-inside: avoid !important;
        margin-bottom: 20px !important;
    }

    /* Fix Tailwind aspect ratio issue */
    .aspect-\\[4\\/3\\] {
        aspect-ratio: auto !important;
        height: auto !important;
    }

    /* Images */
    .print-content-wrapper img {
        max-width: 100% !important;
        width: 100% !important;
        height: auto !important;
        display: block !important;
        page-break-inside: avoid !important;
        break-inside: avoid !important;
        margin-bottom: 15px !important;
    }

}
`}
</style>


    <div className="space-y-6 px-2 sm:px-4 md:px-0 items-center">
      {/* Header Section */}
       {(!userRole || !userHasHrLikeViewRights) && ( <div className="flex flex-col gap-4 text-sm">
             <div className="flex flex-col xl:flex-row xl:justify-between xl:items-end gap-4 w-full">
       <div className="w-full xl:w-auto flex flex-wrap items-center gap-3">
          <h2 className="text-md font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
            Requisitions
          </h2>
        </div>
         
         <div className="flex flex-col xl:flex-row gap-4 w-full xl:w-auto">
          {showProgrammeSelector && (
            <div className="w-full sm:w-[220px]">
              <ProgrammeSelector
                value={activeProgram}
                onValueChange={setActiveProgram}
                programmes={accessibleProgrammes}
                includeAll={canSelectAllProgrammes}
                placeholder="All Programmes"
                triggerClassName="h-9 w-full border-gray-300 bg-white px-6 text-sm font-medium text-gray-700 shadow-sm focus:border-blue-500 xl:w-auto"
              />
            </div>
          )}
          
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full xl:w-auto relative z-50">
              
                <div className="">
                    <Label className="sr-only">Start Date</Label>
                    <Input type="date" value={filters.startDate} onChange={(e) => handleFilterChange("startDate", e.target.value)} className="border-gray-300 focus:border-blue-500 bg-white h-9 w-full" />
                </div>
                <div className="">
                    <Label className="sr-only">End Date</Label>
                    <Input type="date" value={filters.endDate} onChange={(e) => handleFilterChange("endDate", e.target.value)} className="border-gray-300 focus:border-blue-500 bg-white h-9 w-full" />
                </div>
            </div>
            
            <div className="flex flex-col sm:flex-row gap-2 w-full xl:w-auto">
                <Button variant="outline" size="sm" onClick={clearFilters} className="h-9 px-6 w-full xl:w-auto">
                    Clear Filters
                </Button>
                <Button variant="outline" size="sm" onClick={resetToCurrentMonth} className="h-9 px-6 w-full xl:w-auto">
                    This Month
                </Button>
            </div>
          
        <div className="flex flex-wrap gap-2 w-full xl:w-auto mt-2 xl:mt-0 justify-end">
           {userHasFinanceRights && (
            <div className="flex justify-between items-center text-sm">
              <div className="font-semibold text-gray-700 rounded-md bg-gray-100 px-2 py-1 border border-gray-300">
                <span className="font-normal">
                  {`${userName || user?.email || "System"} - ${permissionPrincipal || userRole || "user"}`}
                </span>
              </div>
            </div>
           )}
           { !userHasHrLikeViewRights && userRole !== 'admin' && (
             <Button onClick={() => {}} disabled={exportLoading} className="bg-gradient-to-r from-blue-800 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white shadow-md text-xs h-9 px-6 w-full xl:w-auto">
                <Download className="h-4 w-4 mr-2" /> Export ({filteredRequisitions.length})
              </Button>
           )}
        </div>
        </div>
      </div>

              
            </div> )}
      {userHasHrLikeViewRights && ( <div className="flex flex-col gap-4 text-sm">
    
      <div className="flex flex-col xl:flex-row xl:justify-between xl:items-end gap-4 w-full">
        
         <div className="w-full xl:w-auto flex flex-wrap items-center gap-3">
            <h2 className="text-md font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
            Requisitions
          </h2>
            
          
        </div>
         
         <div className="flex flex-col xl:flex-row gap-4 w-full xl:w-auto">
          {showProgrammeSelector && (
            <div className="w-full sm:w-[220px]">
              <ProgrammeSelector
                value={activeProgram}
                onValueChange={setActiveProgram}
                programmes={accessibleProgrammes}
                includeAll={canSelectAllProgrammes}
                placeholder="All Programmes"
                triggerClassName="h-9 w-full border-gray-300 bg-white px-6 text-sm font-medium text-gray-700 shadow-sm focus:border-blue-500 xl:w-auto"
              />
            </div>
          )}
          
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full xl:w-auto relative z-50">
              
                <div className="">
                    <Label className="sr-only">Start Date</Label>
                    <Input type="date" value={filters.startDate} onChange={(e) => handleFilterChange("startDate", e.target.value)} className="border-gray-300 focus:border-blue-500 bg-white h-9 w-full" />
                </div>
                <div className="">
                    <Label className="sr-only">End Date</Label>
                    <Input type="date" value={filters.endDate} onChange={(e) => handleFilterChange("endDate", e.target.value)} className="border-gray-300 focus:border-blue-500 bg-white h-9 w-full" />
                </div>
            </div>
            
            <div className="flex flex-col sm:flex-row gap-2 w-full xl:w-auto">
                <Button variant="outline" size="sm" onClick={clearFilters} className="h-9 px-6 w-full xl:w-auto">
                    Clear Filters
                </Button>
                <Button variant="outline" size="sm" onClick={resetToCurrentMonth} className="h-9 px-6 w-full xl:w-auto">
                    This Month
                </Button>
            </div>
          
        <div className="flex flex-wrap gap-2 w-full xl:w-auto mt-2 xl:mt-0 justify-end">
           { !userHasHrLikeViewRights && (
             <Button onClick={() => {}} disabled={exportLoading} className="bg-gradient-to-r from-blue-800 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white shadow-md text-xs h-9 px-6 w-full xl:w-auto">
                <Download className="h-4 w-4 mr-2" /> Export ({filteredRequisitions.length})
              </Button>
           )}
        </div>
        </div>
      </div>
            </div> )}
     

      {/* Stats Section */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <StatsCard
          title="TOTAL REQUISITIONS"
          value={stats.totalRequests.toLocaleString()}
          icon={FileText}
          color="blue"
          description={`Pending Requisitions: ${stats.pendingRequests.toLocaleString()} | Approved Requisitions: ${stats.approvedRequests.toLocaleString()}`}
        />
        <StatsCard
          title="AUTHORIZED REQUISITIONS"
          value={stats.authorizedRequests.toLocaleString()}
          icon={Calendar}
          color="orange"
          description={`Rejected Requisitions: ${stats.rejectedRequests.toLocaleString()}`}
        />
        <StatsCard title="TOTAL AMOUNT" value={`KES ${millify(stats.totalAmount)}`} icon={Wallet} color="green" />
      </div>

      {/* Filter Section */}
      <Card className="shadow-lg border-0 bg-white">
        <CardContent className="space-y-6 pt-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            <div className="space-y-2">
                <Label className="font-semibold text-gray-700 text-xs uppercase">Type</Label>
                <Select value={filters.type} onValueChange={(value) => handleFilterChange("type", value)}>
                    <SelectTrigger className="border-gray-300 focus:border-blue-500 bg-white h-9"><SelectValue placeholder="All Types" /></SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All Types</SelectItem>
                        <SelectItem value="fuel and Service">Fuel & Service</SelectItem>
                        <SelectItem value="perdiem">Perdiem</SelectItem>
                        <SelectItem value="airtime">Airtime</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            <div className="space-y-2">
                <Label className="font-semibold text-gray-700 text-xs uppercase">Status</Label>
                <Select value={filters.status} onValueChange={(value) => handleFilterChange("status", value)}>
                    <SelectTrigger className="border-gray-300 focus:border-blue-500 bg-white h-9"><SelectValue placeholder="All Statuses" /></SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All Statuses</SelectItem>
                        <SelectItem value="pending">Pending</SelectItem>
                        <SelectItem value="approved">Approved</SelectItem>
                        <SelectItem value="rejected">Rejected</SelectItem>
                        <SelectItem value="complete">Complete</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            <div className="space-y-2 lg:col-span-2">
                <Label className="font-semibold text-gray-700 text-xs uppercase">Search User</Label>
                <Input placeholder="Name, County, Location..." value={searchValue} onChange={(e) => handleSearchChange(e.target.value)} className="border-gray-300 focus:border-blue-500 bg-white h-9" />
            </div>
          </div>
        </CardContent>
      </Card>

      {selectedRecords.length > 0 && (
        <Card className="shadow-lg border border-blue-100 bg-blue-50/40">
          <CardContent className="pt-4 pb-4 space-y-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="text-sm font-medium text-blue-900">
                {selectedRecords.length} requisition{selectedRecords.length === 1 ? "" : "s"} selected
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {canApproveRequisition && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleBulkApprove}
                    disabled={isBulkProcessing}
                    className="bg-green-600 hover:bg-green-700"
                  >
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Approve Selected
                  </Button>
                )}

                {canAuthorizeRequisition && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={isBulkProcessing}
                        className="border-indigo-300 text-indigo-700 hover:bg-indigo-50"
                      >
                        HR Actions
                        <ChevronDown className="h-4 w-4 ml-2" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={handleBulkAuthorize}>
                        <CheckCircle className="h-4 w-4 mr-2 text-green-600" />
                        Authorize Selected
                      </DropdownMenuItem>
                      {canRejectRequisition && (
                        <DropdownMenuItem
                          onClick={() => setIsBulkRejectDialogOpen(true)}
                          className="text-red-600 focus:text-red-700 focus:bg-red-50"
                        >
                          <XCircle className="h-4 w-4 mr-2" />
                          Reject Selected
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}

                {canRejectRequisition && !canAuthorizeRequisition && (
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={() => setIsBulkRejectDialogOpen(true)}
                    disabled={isBulkProcessing}
                  >
                    <XCircle className="h-4 w-4 mr-2" />
                    Reject Selected
                  </Button>
                )}

                {canCompleteTransaction && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleBulkCompleteTransaction}
                    disabled={isBulkProcessing}
                    className="bg-blue-700 hover:bg-blue-800"
                  >
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Complete Transaction
                  </Button>
                )}

                {canMarkRequisitionComplete && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleBulkMarkComplete}
                    disabled={isBulkProcessing}
                    className="bg-emerald-700 hover:bg-emerald-800"
                  >
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Mark Complete
                  </Button>
                )}

                {canDeleteRequisition && (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={handleBulkDelete}
                    disabled={isBulkProcessing}
                  >
                    Delete Selected
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Data Table Section */}
      <Card className="shadow-lg border-0 bg-white">
        <CardContent className="p-0">
          {loading ? (
            <div className="text-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div><p className="text-muted-foreground mt-2">Loading requisitions...</p></div>
          ) : currentPageRecords.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">No records found matching your criteria</div>
          ) : (
            <>
              <div className="w-full overflow-x-auto rounded-md">
                <table className="w-full border-collapse border border-gray-300 text-sm text-left whitespace-nowrap">
                  <thead>
                    <tr className="bg-blue-50 text-xs">
                      <th className="py-3 px-3 font-semibold text-gray-700">
                        <Checkbox checked={allCurrentPageSelected} onCheckedChange={toggleSelectAllCurrentPage} />
                      </th>
                      <th className="py-3 px-3 font-semibold text-gray-700">Date</th>
                      <th className="py-3 px-3 font-semibold text-gray-700">Type</th>
                      <th className="py-3 px-3 font-semibold text-gray-700">Field Officer</th>
                      <th className="py-3 px-3 font-semibold text-gray-700">Purpose</th>
                      <th className="py-3 px-3 font-semibold text-gray-700">Amount</th>
                      <th className="py-3 px-3 font-semibold text-gray-700">Transacted By</th>
                      <th className="py-3 px-3 font-semibold text-gray-700">Status</th>
                      <th className="py-3 px-3 font-semibold text-gray-700 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentPageRecords.map((record) => (
                      <tr key={record.id} className="border-b hover:bg-blue-50 transition-colors group">
                        <td className="py-2 px-3">
                          <Checkbox
                            checked={selectedRecords.includes(record.id)}
                            onCheckedChange={() => toggleRecordSelection(record.id)}
                          />
                        </td>
                        <td className="py-2 px-3 text-xs text-gray-500">{formatDate(record.submittedAt)}</td>
                        <td className="py-2 px-3 text-xs font-medium">
                            {record.type === 'fuel and Service' ? (
                                <span className="flex items-center gap-1"><Car className="h-3 w-3"/> Fuel</span>
                            ) : record.type === 'airtime' ? (
                                <span className="flex items-center gap-1"><Phone className="h-3 w-3"/> Airtime</span>
                            ) : (
                                <span className="flex items-center gap-1"><Wallet className="h-3 w-3"/> Perdiem</span>
                            )}
                        </td>
                        <td className="py-2 px-3 text-xs">{getOfficerName(record)}</td>
                        <td className="py-2 px-3 text-xs truncate max-w-[150px]">
                            {getRequisitionPurpose(record)}
                        </td>
                        <td className="py-2 px-3 text-xs font-semibold text-green-700">
                            KES {record.type === 'fuel and Service' ? record.fuelAmount?.toLocaleString() : record.type === 'airtime' ? record.airtimeAmount?.toLocaleString() : record.total?.toLocaleString()}
                        </td>
                        <td className="py-2 px-3 text-xs">{getTransactedBy(record)}</td>
                        <td className="py-2 px-3">
                             <div className="flex flex-col gap-1">
                               {(() => {
                                 const isAuthorized =
                                   record.status === "approved" &&
                                   !!String(record.authorizedBy || "").trim();
                                 return (
                                <Badge 
                                   variant={
                                     isAuthorized ||
                                     record.status === "approved" ||
                                     record.status === "complete" ?
                                       "default" :
                                       record.status === "rejected" ?
                                         "destructive" :
                                         "outline"
                                   }
                                   className={
                                     isAuthorized ?
                                       "bg-indigo-100 text-indigo-800 hover:bg-indigo-100" :
                                       record.status === "approved" ?
                                         "bg-green-100 text-green-800 hover:bg-green-100" :
                                         record.status === "complete" ?
                                           "bg-blue-100 text-blue-800 hover:bg-blue-100" :
                                           ""
                                   }
                                >
                                   {isAuthorized ? "authorized" : record.status}
                                </Badge>
                                 );
                               })()}
                                {record.status === "rejected" && (
                                  <span className="text-[10px] text-red-700 font-medium">Rejected</span>
                                )}
                               {record.status === "approved" && !!record.transactionCompletedBy && (
                                 <span className="text-[10px] text-blue-700 font-medium">Transaction complete</span>
                               )}
                               {getRequisitionImages(record.requisitionUrl).length > 0 && (
                                 <span className="text-[10px] text-emerald-700 font-medium">Images uploaded</span>
                               )}
                             </div>
                        </td>
                        <td className="py-2 px-3 text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="sm" className="  border-b border-gray-500 h-8 w-8 bodder p-2 mr-2 text-gray-500 hover:text-gray-900">
                                    <span className="sr-only">Open menu</span>
                                    <ChevronDown className="h-4 w-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => openViewDialog(record)}>
                                    <Eye className="mr-2 h-4 w-4 text-blue-600" /> <span className="text-gray-700">View Details</span>
                                </DropdownMenuItem>
                                
                                {userIsAdmin && (
                                  <DropdownMenuItem onClick={() => openHistoryOnly(record)}>
                                      <Clock className="mr-2 h-4 w-4 text-purple-600" /> <span className="text-gray-700">View History</span>
                                  </DropdownMenuItem>
                                )}
                                
                                <DropdownMenuItem onClick={() => handleOpenImageViewer(record)}>
                                    <FileImage className="mr-2 h-4 w-4 text-indigo-600" /> <span className="text-gray-700">View Images</span>
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleOpenImageViewer(record, true)}>
                                    <Printer className="mr-2 h-4 w-4 text-indigo-700" /> <span className="text-gray-700">Print Images</span>
                                </DropdownMenuItem>

                                {userIsAdmin && <DropdownMenuSeparator />}

                                {userIsAdmin && (
                                    <DropdownMenuItem onClick={() => openEditDialog(record)}>
                                        <Edit className="mr-2 h-4 w-4 text-gray-600" /> <span className="text-gray-700">Edit</span>
                                    </DropdownMenuItem>
                                )}
                                
                                {canDeleteRequisition && (
                                    <DropdownMenuItem onClick={() => confirmDelete(record)} className="text-red-600 focus:text-red-700 focus:bg-red-50">
                                        <Trash2 className="mr-2 h-4 w-4" /> Delete
                                    </DropdownMenuItem>
                                )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-col sm:flex-row items-center justify-between p-4 border-t bg-gray-50 gap-4">
                <div className="text-sm text-muted-foreground">{filteredRequisitions.length} total records Page {pagination.page} of {pagination.totalPages}</div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={!pagination.hasPrev} onClick={() => handlePageChange(pagination.page - 1)}>Previous</Button>
                  <Button variant="outline" size="sm" disabled={!pagination.hasNext} onClick={() => handlePageChange(pagination.page + 1)}>Next</Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* --- VIEW DIALOG --- */}
      <Dialog open={isViewDialogOpen} onOpenChange={handleViewDialogOpenChange}>
        <DialogContent className="print-content-wrapper font-times sm:max-w-5xl bg-gray-200 rounded-none w-[95vw] sm:w-full max-h-[95vh] flex flex-col">
          <div className="overflow-y-auto flex-1">
            {viewingRecord && (
              <div ref={docRef} className="gridgrid-cols-1 bg-white shadow-lg w-full md:p-12 min-h-[800px] relative flex flex-col printable-area">
                <div className="pb-10 flex-1 ml-10 mr-10">
                  <div className="flex flex-col items-center justify-center">
                      <div className="w-[260px] m-0 p-0 mb-4">
                        <img src="/img/logo.png" alt="Logo" className="w-full" />
                      </div>
                      <h1 className="font-times text-2xl font-bold uppercase tracking-tight leading-tight mb-2">
                        {viewingRecord.type === "fuel and Service"
                          ? "Fuel & Service"
                          : viewingRecord.type === "airtime"
                          ? "Airtime"
                          : "Perdiem"}{" "}
                        Requisition Form
                      </h1>
                  </div>
                  
                 

                  <div className="mt-5 flex flex-col gap-2 mb-2 text-sm">
                    <div className="flex flex-row gap-2"><span className="text-gray-700 text-[17px]">Date of Request:</span><span className="font-medium flex-1 text-[17px]">{formatDate(viewingRecord.submittedAt)}</span></div>
                    <div className="flex flex-row gap-2"><span className="text-gray-700 text-[17px]">Programme:</span><span className="font-medium flex-1 text-[17px]">{viewingRecord.programme || 'N/A'}</span></div>
                    <div className="flex flex-row gap-2"><span className="text-gray-700 text-[17px]">County:</span><span className="font-medium flex-1 text-[17px]">{viewingRecord.county}</span></div>
                    <div className="flex flex-row gap-2"><span className="text-gray-700 text-[17px]">Sub County:</span><span className="font-medium flex-1 text-[17px]">{viewingRecord.subcounty}</span></div>
                    <div className="flex flex-row gap-2"><span className="text-gray-700 text-[17px]">Requested By:</span><span className="font-medium flex-1 text-[17px]">{getOfficerName(viewingRecord)}</span></div>
                    <div className="flex flex-row gap-2"><span className="text-gray-700 text-[17px]">Phone: </span><span className="font-medium  flex-1 text-[17px]">{viewingRecord.phoneNumber || viewingRecord.phone || 'N/A'}</span></div>
                    <div className="flex flex-row gap-2"><span className="text-gray-700 text-[17px]">Purpose : </span><span className="font-medium  flex-1 text-[17px]">{getRequisitionPurpose(viewingRecord)}</span></div>
                    <div className="flex flex-row gap-2"><span className="text-gray-700 text-[17px]">Transacted By : </span><span className="font-medium  flex-1 text-[17px]">{getTransactedBy(viewingRecord)}</span></div>
                  </div>

                  {viewingRecord.type === 'fuel and Service' ? (
                    <div className="space-y-2 font-times">
                      <div className="grid grid-cols-1 gap-4">
                        <div className="flex flex-row items-center gap-2"><span className="text-gray-800 text-[17px] ">Last Speedometer Reading : </span><span className="text-gray-800">{viewingRecord.lastReading} Km</span></div>
                        <div className="flex flex-row items-center gap-2"><span className="text-gray-800 text-[17px] ">Current Speedometer Reading :</span><span className="text-gray-800">{viewingRecord.currentReading} km</span></div>
                        <div className="flex flex-row items-center gap-2"><span className="text-gray-800 text-[17px] ">Distance Traveled : </span><span className="text-gray-800">{viewingRecord.distanceTraveled} Km</span></div>
                        <div className="flex flex-row items-center gap-2"><span className="text-gray-800 text-[17px] ">Amount Requested : </span><span className="text-gray-800">KES {viewingRecord.fuelAmount?.toLocaleString()}</span></div>
                        <div className="flex flex-row items-center gap-2">
                          <span className="text-gray-800 text-[17px] ">Transacted Amount : </span>
                          <span className="text-gray-800">
                            {getTransactedAmount(viewingRecord) !== null
                              ? `KES ${getTransactedAmount(viewingRecord)?.toLocaleString()}`
                              : "Pending"}
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : viewingRecord.type === 'airtime' ? (
                    <div className="space-y-2 font-times">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

                        <div className="flex flex-row items-center gap-2"><span className="text-gray-800 text-[17px]">Amount Requested : </span><span className="text-gray-800">KES {viewingRecord.airtimeAmount?.toLocaleString()}</span></div>
                        <div className="flex flex-row items-center gap-2">
                          <span className="text-gray-800 text-[17px]">Transacted Amount : </span>
                          <span className="text-gray-800">
                            {getTransactedAmount(viewingRecord) !== null
                              ? `KES ${getTransactedAmount(viewingRecord)?.toLocaleString()}`
                              : "Pending"}
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-6">
                      <div className="items-center"><u><h3 className="font-times text-center font-bold text-gray-800 uppercase text-lg">TRAVEL REQUEST REIMBURSEMENT SHEET</h3></u></div>
                      <div className="grid grid-cols-1 md:grid-cols-2">
                        <div className="flex flex-row items-center"><span className="text-gray-800 text-[17px] "> From : </span><span className="font-medium">{viewingRecord.fromLocation || 'N/A'}</span></div>
                        <div className="flex flex-row items-center"><span className="text-gray-800 text-[17px] "> To : </span><span className="font-medium">{viewingRecord.toLocation || 'N/A'}</span></div>
                        <div className="flex flex-row items-center"><span className="text-gray-800 text-[17px] "> Trip Starts On : </span><span className="font-medium">{formatDate(viewingRecord.tripFrom)}</span></div>
                        <div className="flex flex-row items-center"><span className="text-gray-800 text-[17px] ">Trip End on : </span><span className="font-medium">{formatDate(viewingRecord.tripTo)}</span></div>
                        <div className="flex flex-row items-center"><span className="text-gray-800 text-[17px] ">Number of Days : </span><span className="font-medium">{viewingRecord.numberOfDays} Days</span></div>
                        <div className="flex flex-row items-center"><span className="text-gray-800 text-[17px]  flex items-center gap-2">Location :</span><span className="font-medium">{viewingRecord.location || 'N/A'}</span></div>
                      </div>
                      <div className="mt-4 flex flex-col items-center justify-center">
                        <span className="text-gray-800 text-xl uppercase font-bold block mb-2 ">Cost Breakdown</span>
                        <div className="w-full text-sm border-collapse border border-gray-400">
                          <table className="w-full border-collapse border border-gray-300">
                            <thead><tr className="bg-gray-100"><td className="p-2 border border-gray-500 text-left text-[17px] font-semibold text-gray-700">Date</td><td className="p-2 border border-gray-500 text-left text-[17px] font-semibold text-gray-700">Item/Description</td><td className="p-2 border border-gray-500 text-right text-[17px] font-semibold text-gray-700">Amount (KES)</td></tr></thead>
                            <tbody className="divide-y divide-gray-300">
                              {viewingRecord.items && viewingRecord.items.length > 0 ? viewingRecord.items.map((item, idx) => (
                                <tr key={idx} className=""><td className="p-2 text-[17px] border-r border-gray-500 w-32">{formatDate(item.date)}</td><td className="p-2 text-[17px] border-r border-gray-500 flex-1">{item.name}</td><td className="p-2 text-[17px] text-right w-32">{item.price.toLocaleString()}</td></tr>
                              )) : <div className="p-4 text-center text-gray-500 italic">No items found.</div>}
                              <tr className=""><td className="p-2 text-[17px] ">Total Amount</td><td></td><td className="p-2 text-[17px] text-right border-l border-gray-800 text-gray-700">{viewingRecord.total?.toLocaleString()}</td></tr>
                              <tr className="">
                                <td className="p-2 text-[17px] ">Transacted Amount</td>
                                <td></td>
                                <td className="p-2 text-[17px] text-right border-l border-gray-800 text-gray-700">
                                  {getTransactedAmount(viewingRecord) !== null
                                    ? getTransactedAmount(viewingRecord)?.toLocaleString()
                                    : "Pending"}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="mt-8">
                    <div className="grid grid-cols-1 top-5 gap-8">
                      <div className="flex flex-col">
                        <div className="flex flex-row justify-between">
                          <div className="flex flex-col gap-2 items-center justify-start"></div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 mt-4 gap-8">
                        <div className="flex flex-row">
                          <span className="text-[17px] text-gray-700">Approved By : </span>
                          <div className="flex-1 flex relative h-6">
                            {viewingRecord.approvedBy ? (
                              <span className="text-[17px] ml-2">
                                {viewingRecord.approvedBy}
                                {viewingRecord.approvedByAttribute ? ` (${viewingRecord.approvedByAttribute})` : ""}
                              </span>
                            ) : (
                              <span className="text-xs italic text-gray-300">Pending Approval</span>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-row"><span className="text-[17px]">Date : </span><div className="flex justify-between text-2xs text-gray-900 ml-2"><span>{viewingRecord.approvedAt ? formatDateTime(viewingRecord.approvedAt) : 'Date'}</span></div></div>
                        
                       
                          <div className="flex flex-row">
                             <span className="text-[17px] text-gray-800 ">Authorized By :</span>
                          <div className="flex-1 h-6 ml-2">
                            {viewingRecord.authorizedBy ? (
                              <span className="text-[17px]">
                                {viewingRecord.authorizedBy}
                                {viewingRecord.authorizedByAttribute ? ` (${viewingRecord.authorizedByAttribute})` : ""}
                              </span>
                            ) : ""}
                          </div>

                          </div>
                          <div className="flex-1 flex flex-row justify-between mt-2">
                          <span className="text-[17px]">Date : </span>
                          <div className="flex-1 h-6  ml-2">
                            {viewingRecord.authorizedAt ? formatDateTime(viewingRecord.authorizedAt) : ""}
                          </div>
                        </div>

                          <div>
                            <div className="flex-1 flex flex-col justify-between mt-2">
                          <span className="text-[17px]">Signature : </span>
                          
                        </div>
                          </div>
                          <div><div className="flex-1 flex flex-col justify-between mt-2">
                          <span className="text-[17px]">Official Stamp : </span>
                         
                        </div></div>
                          
                         
                       
                        
                      </div>
                    </div>
                  </div>
                </div>
                
                {/* PRINT FOOTER - Always at bottom of printable area */}
                <div className="shrink-0 mt-8 pt-6 text-center">
                    <p className="text-sm font-semibold text-gray-800 mb-2">Printed on {printDate || new Date().toLocaleString()}</p>
                    <p className="text-xs italic text-gray-600 mb-1">This document is marked complete once transaction receipt is received.</p>
                    
                </div>
              </div>
            )}
          </div>

          {/* Dialog Actions (Non-Printable) */}
          <div className="bg-gray-200 p-4 flex flex-col-reverse sm:flex-row justify-between items-center gap-4 border-t border-gray-300 z-10 shrink-0 no-print">
            <div className="flex gap-2 w-full sm:w-auto">
              <Button variant="outline" onClick={handlePrint} className="flex-1 sm:flex-none"><Printer className="h-4 w-4 mr-2" /> Print</Button>
              <Button variant="outline" onClick={handleDownload} className="flex-1 sm:flex-none"><Download className="h-4 w-4 mr-2" /> Download</Button>
            </div>
            <div className="flex gap-2 w-full sm:w-auto justify-end">
              {userHasProjectManagerRights &&
                viewingRecord?.status === "pending" &&
                !viewingRecord?.approvedBy && (
                  <div className="w-full sm:w-[260px]">
                    <Select value={pmDecisionAction} onValueChange={handlePmDecisionChange}>
                      <SelectTrigger className="h-10 border-emerald-300 bg-emerald-50 text-emerald-900 focus:ring-emerald-500">
                        <SelectValue placeholder="PM action: approve or reject" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="approve">Approve requisition</SelectItem>
                        <SelectItem value="reject">Reject requisition</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}

              {!userHasProjectManagerRights && canApproveRequisition && !viewingRecord?.approvedBy && (
                <Button onClick={handleApprove} className="bg-green-600 hover:bg-green-700 flex-1 sm:flex-none">
                  <CheckCircle className="h-4 w-4 mr-2" /> Approve Requisition
                </Button>
              )}
              
              
              {canAuthorizeRequisition && viewingRecord?.status === 'approved' && !viewingRecord.authorizedBy && canRequisitionReachHr(viewingRecord) && (
                <div className="w-full sm:w-[250px]">
                  <Select value={hrDecisionAction} onValueChange={handleHrDecisionChange}>
                    <SelectTrigger className="h-10 border-indigo-300 bg-indigo-50 text-indigo-900 focus:ring-indigo-500">
                      <SelectValue placeholder="HR action: authorize or reject" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="authorize">Authorize requisition</SelectItem>
                      {canRejectRequisition && (
                        <SelectItem value="reject">Reject requisition</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* HR direct approve+authorize for non-FO/PM/M&E pending requisitions */}
              {canAuthorizeRequisition && viewingRecord?.status === 'pending' && isHrDirectApprovalRequisition(viewingRecord) && (
                <div className="w-full sm:w-[280px]">
                  <Select value={hrDecisionAction} onValueChange={handleHrDecisionChange}>
                    <SelectTrigger className="h-10 border-violet-300 bg-violet-50 text-violet-900 focus:ring-violet-500">
                      <SelectValue placeholder="HR: Approve & Authorize or Reject" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="approve-authorize">Approve & Authorize</SelectItem>
                      {canRejectRequisition && (
                        <SelectItem value="reject">Reject requisition</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {canRejectRequisition && !canAuthorizeRequisition && viewingRecord?.status === 'approved' && (
                <Button
                  onClick={() => {
                    setRejectionMessageText("");
                    setIsRejectDialogOpen(true);
                  }}
                  variant="destructive"
                  className="flex-1 sm:flex-none"
                >
                  <XCircle className="h-4 w-4 mr-2" /> Reject Requisition
                </Button>
              )}

        
              {canCompleteTransaction && canProceedAfterApproval(viewingRecord) && !viewingRecord.transactionCompletedBy && (
                <Button onClick={handleCompleteTransaction} className="bg-blue-800 hover:bg-blue-900 flex-1 sm:flex-none">
                  <CheckCircle className="h-4 w-4 mr-2" /> Complete Transaction
                </Button>
              )}
              {canMarkRequisitionComplete &&
                canProceedAfterApproval(viewingRecord) &&
                !!viewingRecord.transactionCompletedBy &&
                getRequisitionImages(viewingRecord?.requisitionUrl).length > 0 && (
                  <Button onClick={handleMarkComplete} className="bg-green-700 hover:bg-green-800 flex-1 sm:flex-none">
                    <CheckCircle className="h-4 w-4 mr-2" /> Mark Requisition Complete
                  </Button>
              )}

              <Button variant="outline" onClick={() => handleViewDialogOpenChange(false)} className="flex-1 sm:flex-none">Close</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isRejectDialogOpen}
        onOpenChange={(open) => {
          setIsRejectDialogOpen(open);
          if (!open) {
            setHrDecisionAction("");
            setPmDecisionAction("");
            setRejectionMessageText("");
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Reject Requisition</DialogTitle>
          <DialogDescription>
            Enter the SMS message to send to the requester. Only HR or Chief
            Admin can reject approved requisitions. Project Manager can reject pending requisitions.
          </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rejection-message-text">SMS Message</Label>
            <Textarea
              id="rejection-message-text"
              value={rejectionMessageText}
              onChange={(event) => setRejectionMessageText(event.target.value)}
              placeholder="Type SMS message for rejected requisition..."
              rows={5}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsRejectDialogOpen(false);
                setHrDecisionAction("");
                setPmDecisionAction("");
                setRejectionMessageText("");
              }}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRejectRequisition}>
              Reject Requisition
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isBulkRejectDialogOpen}
        onOpenChange={(open) => {
          setIsBulkRejectDialogOpen(open);
          if (!open) {
            setBulkRejectionMessageText("");
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Reject Selected Requisitions</DialogTitle>
            <DialogDescription>
              Enter one SMS message to apply to all selected approved
              requisitions. Only HR or Admin can perform this action.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="bulk-rejection-message-text">SMS Message</Label>
            <Textarea
              id="bulk-rejection-message-text"
              value={bulkRejectionMessageText}
              onChange={(event) => setBulkRejectionMessageText(event.target.value)}
              placeholder="Type SMS message for selected rejected requisitions..."
              rows={5}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsBulkRejectDialogOpen(false);
                setBulkRejectionMessageText("");
              }}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleBulkReject} disabled={isBulkProcessing}>
              Reject Selected
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --- HISTORY DIALOG --- */}
      {userIsAdmin && <Dialog open={isHistoryOpen} onOpenChange={setIsHistoryOpen}>
        <DialogContent className="sm:max-w-lg">
            <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                    <Clock className="h-5 w-5" />
                    Document History
                </DialogTitle>
            </DialogHeader>
            <div className="max-h-[400px] overflow-y-auto">
                {historyList.length === 0 ? (
                    <p className="text-sm text-gray-500 italic text-center py-4">No history recorded for this document.</p>
                ) : (
                    <div className="space-y-4">
                        {historyList.map((entry) => (
                            <div key={entry.id} className="flex gap-4 text-sm">
                                <div className="flex flex-col items-center">
                                    <div className="w-2 h-2 rounded-full bg-blue-600 mt-1.5"></div>
                                    <div className="w-0.5 h-full bg-gray-200 mt-1"></div>
                                </div>
                                <div className="pb-4 flex-1">
                                    {(() => {
                                      const hideActorMeta = shouldHideHistoryActorMeta(entry);
                                      return (
                                        <>
                                    <div className="flex justify-between items-start">
                                        <span className="font-semibold text-gray-800">{entry.action}</span>
                                        <span className="text-xs text-gray-500 whitespace-nowrap">
                                            {formatDateTime(entry.timestamp)}
                                        </span>
                                    </div>
                                    {!hideActorMeta && <p className="text-gray-600 text-xs mt-1">{getHistoryActorName(entry)}</p>}
                                    {!hideActorMeta && getHistoryActorAttribute(entry) && (
                                      <p className="text-gray-500 text-[11px] mt-0.5">{getHistoryActorAttribute(entry)}</p>
                                    )}
                                    {entry.details && <p className="text-gray-500 text-xs mt-0.5 italic">{entry.details}</p>}
                                        </>
                                      );
                                    })()}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
            <DialogFooter>
                <Button variant="outline" onClick={() => setIsHistoryOpen(false)}>Close</Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>}

      {/* --- IMAGE VIEWER DIALOG --- */}
      <Dialog
        open={isImageViewerOpen}
        onOpenChange={(open) => {
          setIsImageViewerOpen(open);
          if (!open) {
            setViewingImages([]);
            setImageRecord(null);
          }
        }}
      >
        <DialogContent className="print-content-wrapper sm:max-w-4xl max-h-[90vh] flex flex-col bg-gray-50">
            <DialogHeader>
                <DialogTitle className="flex items-center gap-2 no-print">
                    <FileImage className="h-5 w-5" />
                    Uploaded Receipts
                </DialogTitle>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto p-4">
                {viewingImages.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                        {viewingImages.map((url, idx) => (
                            <div key={idx} className="group relative border border-gray-200 rounded-lg shadow-sm bg-white overflow-hidden hover:shadow-md transition-shadow">
                                <div className="aspect-[4/3] w-full bg-gray-100 flex items-center justify-center">
                                    <img 
                                    src={url} 
                                    alt={`Receipt ${idx + 1}`} 
                                    className="w-full h-full object-cover"
                                    loading="lazy"
                                    />
                                </div>
                                <div className="p-3 border-t border-gray-100 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                                    <span className="text-sm font-medium text-gray-700">Receipt #{idx + 1}</span>
                                    <div className="flex items-center gap-2">
                                        <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 text-xs flex items-center gap-1 no-print">
                                            Open Original <ExternalLink className="h-3 w-3"/>
                                        </a>
                                        {canManageImages && (
                                          <>
                                            <Button
                                              type="button"
                                              variant="ghost"
                                              size="icon"
                                              className="h-7 w-7 text-gray-600 hover:text-gray-800 no-print"
                                              onClick={() => openImageEditDialog(idx)}
                                              disabled={imageActionLoading}
                                            >
                                              <Edit className="h-4 w-4" />
                                            </Button>
                                            <Button
                                              type="button"
                                              variant="ghost"
                                              size="icon"
                                              className="h-7 w-7 text-red-600 hover:text-red-700 no-print"
                                              onClick={() => handleDeleteImage(idx)}
                                              disabled={imageActionLoading}
                                            >
                                              <Trash2 className="h-4 w-4" />
                                            </Button>
                                          </>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="text-center py-10 text-gray-500">No images to display.</div>
                )}
            </div>
            <DialogFooter className="bg-white border-t p-4 no-print">
                <Button variant="outline" onClick={() => setIsImageViewerOpen(false)}>Close</Button>
                <Button onClick={() => window.print()} variant="default">
                    <Printer className="h-4 w-4 mr-2" /> Print Images
                </Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isImageEditDialogOpen}
        onOpenChange={(open) => {
          setIsImageEditDialogOpen(open);
          if (!open) {
            setImageEditIndex(null);
            setImageEditUrl("");
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Receipt Image</DialogTitle>
            <DialogDescription>Update the image URL for the selected receipt.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="receipt-image-url">Image URL</Label>
            <Input
              id="receipt-image-url"
              value={imageEditUrl}
              onChange={(event) => setImageEditUrl(event.target.value)}
              placeholder="https://..."
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsImageEditDialogOpen(false)}
              disabled={imageActionLoading}
            >
              Cancel
            </Button>
            <Button onClick={handleSaveImageEdit} disabled={imageActionLoading}>
              {imageActionLoading ? "Saving..." : "Save Image"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --- EDIT DIALOG --- */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Edit Requisition</DialogTitle>
          </DialogHeader>
          <div className="overflow-y-auto flex-1 pr-2">
            {editRecord && (
              <div className="grid gap-6 py-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2"><Label>Type</Label><Input value={editRecord.type} disabled className="bg-gray-100" /></div>
                  <div className="space-y-2"><Label>Status</Label>
                    <Select value={editFormData.status} onValueChange={(val) => handleEditFieldChange('status', val)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pending">Pending</SelectItem>
                        <SelectItem value="approved">Approved</SelectItem>
                        {canRejectRequisition && <SelectItem value="rejected">Rejected</SelectItem>}
                        {canMarkRequisitionComplete && <SelectItem value="complete">Complete</SelectItem>}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2"><Label>County</Label><Input value={editFormData.county || ''} onChange={(e) => handleEditFieldChange('county', e.target.value)} /></div>
                  <div className="space-y-2"><Label>Sub County</Label><Input value={editFormData.subcounty || ''} onChange={(e) => handleEditFieldChange('subcounty', e.target.value)} /></div>
                </div>
                {editRecord.type === 'fuel and Service' ? (
                  <div className="space-y-4 border p-4 rounded-lg bg-gray-50">
                    <h3 className="font-semibold text-sm uppercase text-gray-700">Fuel & Service Details</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2"><Label>Purpose</Label><Input value={editFormData.tripPurpose || ''} onChange={(e) => handleEditFieldChange('tripPurpose', e.target.value)} /></div>
                      <div className="space-y-2"><Label>Amount (KES)</Label><Input type="number" value={editFormData.fuelAmount || ''} onChange={(e) => handleEditFieldChange('fuelAmount', Number(e.target.value))} /></div>
                      <div className="space-y-2"><Label>Last Reading (km)</Label><Input type="number" value={editFormData.lastReading || ''} onChange={(e) => handleEditFieldChange('lastReading', Number(e.target.value))} /></div>
                      <div className="space-y-2"><Label>Current Reading (km)</Label><Input type="number" value={editFormData.currentReading || ''} onChange={(e) => handleEditFieldChange('currentReading', Number(e.target.value))} /></div>
                      <div className="space-y-2"><Label>Distance (km)</Label><Input type="number" value={editFormData.distanceTraveled || ''} onChange={(e) => handleEditFieldChange('distanceTraveled', Number(e.target.value))} /></div>
                    </div>
                  </div>
                ) : editRecord.type === 'airtime' ? (
                  <div className="space-y-4 border p-4 rounded-lg bg-gray-50">
                    <h3 className="font-semibold text-sm uppercase text-gray-700">Airtime Details</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2"><Label>Purpose</Label><Input value={editFormData.tripPurpose || ''} onChange={(e) => handleEditFieldChange('tripPurpose', e.target.value)} /></div>
                      <div className="space-y-2"><Label>Amount (KES)</Label><Input type="number" value={editFormData.airtimeAmount || ''} onChange={(e) => handleEditFieldChange('airtimeAmount', Number(e.target.value))} /></div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4 border p-4 rounded-lg bg-gray-50">
                    <h3 className="font-semibold text-sm uppercase text-gray-700">Perdiem Details</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2"><Label>Purpose</Label><Input value={editFormData.tripPurpose || ''} onChange={(e) => handleEditFieldChange('tripPurpose', e.target.value)} /></div>
                      <div className="space-y-2"><Label>From Location</Label><Input value={editFormData.fromLocation || ''} onChange={(e) => handleEditFieldChange('fromLocation', e.target.value)} /></div>
                      <div className="space-y-2"><Label>To Location</Label><Input value={editFormData.toLocation || ''} onChange={(e) => handleEditFieldChange('toLocation', e.target.value)} /></div>
                      <div className="space-y-2"><Label>Trip Start Date</Label><Input type="date" value={toInputDate(editFormData.tripFrom)} onChange={(e) => handleEditFieldChange('tripFrom', e.target.value)} /></div>
                      <div className="space-y-2"><Label>Trip End Date</Label><Input type="date" value={toInputDate(editFormData.tripTo)} onChange={(e) => handleEditFieldChange('tripTo', e.target.value)} /></div>
                      <div className="space-y-2"><Label>Days</Label><Input type="number" value={editFormData.numberOfDays || ''} onChange={(e) => handleEditFieldChange('numberOfDays', Number(e.target.value))} /></div>
                      <div className="space-y-2"><Label>Total (KES)</Label><Input type="number" value={editFormData.total || ''} onChange={(e) => handleEditFieldChange('total', Number(e.target.value))} /></div>
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between items-center">
                        <Label className="text-sm font-bold">Items</Label>
                        <Button size="sm" variant="outline" onClick={addPerdiemItem}><Plus className="h-4 w-4 mr-1"/> Add Item</Button>
                      </div>
                      <div className="space-y-2">
                        {editFormData.items && editFormData.items.map((item, idx) => (
                          <div key={idx} className="flex gap-2 items-center">
                            <Input type="date" className="flex-1" value={toInputDate(item.date)} onChange={(e) => handlePerdiemItemChange(idx, 'date', e.target.value)} />
                            <Input placeholder="Item Name" className="flex-[2]" value={item.name} onChange={(e) => handlePerdiemItemChange(idx, 'name', e.target.value)} />
                            <Input type="number" placeholder="Price" className="w-24" value={item.price} onChange={(e) => handlePerdiemItemChange(idx, 'price', Number(e.target.value))} />
                            <Button size="icon" variant="ghost" className="text-red-500 hover:text-red-600" onClick={() => removePerdiemItem(idx)}><Minus className="h-4 w-4"/></Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>Cancel</Button>
            <Button onClick={saveEdit} disabled={isSaving}><Save className="h-4 w-4 mr-2" /> {isSaving ? "Saving..." : "Save Changes"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --- DELETE DIALOG --- */}
      <Dialog open={isDeleteConfirmOpen} onOpenChange={setIsDeleteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Are you sure?</DialogTitle>
            <DialogDescription className="text-base">
              You are about to delete <strong>{recordToDelete?.type}</strong> requisition submitted by <strong>{getOfficerName(recordToDelete)}</strong>.
              <br/><br/>
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDeleteConfirmOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={executeDelete} disabled={deleteLoading}>
              {deleteLoading ? "Deleting..." : "Yes, Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
    </>
  );
};

export default RequisitionsPage;
