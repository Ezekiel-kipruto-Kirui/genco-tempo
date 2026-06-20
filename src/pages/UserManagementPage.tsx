import { useState, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { createUserWithEmailAndPassword, deleteUser } from "firebase/auth";
import { db, secondaryAuth, invalidateCollectionCache, ref, set, update, remove, push, serverTimestamp } from "@/lib/firebase";
import { fetchCollection } from "@/lib/firebase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Download, Users, User, Edit, Trash2, Mail, Shield, Calendar, Eye, Phone, Plus, AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cacheKey, readCachedValue, removeCachedValue, writeCachedValue } from "@/lib/data-cache";
import {
  isFinance,
  isAdmin,
  isHummanResourceManager,
  isOfftakeOfficer,
  isProjectManager,
  normalizeRole,
  resolvePermissionPrincipal,
} from "@/contexts/authhelper";

// --- Types ---
interface AccessControl {
  // The custom user attribute typed by admin as-is.
  customAttribute?: string;
  // Legacy data support from previous structure.
  customAttributes?: Record<string, string>;
}

interface UserRecord {
  id: string;
  name?: string;
  email?: string;
  phoneNumber?: string;
  phone?: string;
  county?: string;
  subcounty?: string;
  role?: string;
  createdAt?: any;
  lastLogin?: any;
  status?: string;
  updatedAt?: any;
  uid?: string;
  allowedProgrammes?: { [key: string]: boolean };
  accessControl?: AccessControl;
}

interface Filters {
  search: string;
  role: string;
  status: string;
  programme: string;
  startDate: string;
  endDate: string;
}

interface Stats {
  totalUsers: number;
  activeUsers: number;
  adminUsers: number;
  fieldOfficerUsers: number;
  hrUsers: number;
  projectManagerUsers: number;
  financeUsers: number;
  offtakeOfficerUsers: number;
}

interface Pagination {
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

interface EditForm {
  name: string;
  email: string;
  phoneNumber: string;
  county: string;
  subcounty: string;
  role: string;
  status: string;
  customAttribute: string;
  allowedProgrammes: { [key: string]: boolean };
}

interface AddUserForm {
  name: string;
  email: string;
  phoneNumber: string;
  county: string;
  subcounty: string;
  role: string;
  password: string;
  confirmPassword: string;
  customAttribute: string;
  allowedProgrammes: { [key: string]: boolean };
}

type KenyaAreasResponse = Record<string, Record<string, string[]>>;

// --- Constants ---
const PAGE_LIMIT = 15;
const EXPORT_HEADERS = [
  "Name",
  "Email",
  "Phone Number",
  "Role",
  "Status",
  "Created At",
  "Last Login",
  "Updated At",
];

// Available programmes assignable to users
const AVAILABLE_PROGRAMMES = [
  "KPMD", 
  "RANGE",
  "KPMD 2",
];
const USER_ROLE_OPTIONS = [
  "Field Officer",
  "Chief Executive Officer",
  "Chief Operations Officer",
  "Project Officer",
  "Human Resource Manager",
  "M&E Officer",
  "Finance",
  "Offtake Officer",
  "Executive Assistant",
  "Staff",
] as const;
const ROLE_OPTIONS = [
  { value: "admin", label: "Admin" },
  ...USER_ROLE_OPTIONS.map((role) => ({ value: role, label: role })),
] as const;
const LEGACY_ROLE_ATTRIBUTE_MAP: Record<string, string> = {
  "mobile": "Field Officer",
  "mobile user": "Field Officer",
  "field officer": "Field Officer",
  "fieldofficer": "Field Officer",
  "chief-admin": "",
  "chief admin": "",
  "humman resource manager": "Human Resource Manager",
  "human resource manager": "Human Resource Manager",
  "humman resource manger": "Human Resource Manager",
  "human resource manger": "Human Resource Manager",
  "project manager": "Project Officer",
  "project officer": "Project Officer",
  "m&e officer": "M&E Officer",
  "mne officer": "M&E Officer",
  "me officer": "M&E Officer",
  "monitoring and evaluation officer": "M&E Officer",
  "monitoring & evaluation officer": "M&E Officer",
  "finance": "Finance",
  "offtake officer": "Offtake Officer",
  "executive assistant": "Executive Assistant",
  "executive assitant": "Executive Assistant",
  "staff": "Staff",
  "ceo": "Chief Executive Officer",
  "chief executive officer": "Chief Executive Officer",
  "chief operations manager": "Chief Operations Officer",
  "chief operational manager": "Chief Operations Officer",
  "chief operational officer": "Chief Operations Officer",
  "chief operatons manger": "Chief Operations Officer",
};

const USER_MANAGEMENT_CACHE_KEY = cacheKey("admin-page", "users");
const KENYA_AREAS_API_KEY = "keyPub1569gsvndc123kg9sjhg";
const KENYA_AREAS_API_URL = "https://kenyaareadata.vercel.app/api/areas";
const KENYA_AREAS_CACHE_KEY = cacheKey("lookups", "kenya-areas");
const KENYA_AREAS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// --- Helper Functions ---
const buildAccessControl = (customAttribute: string): AccessControl =>
  customAttribute ? { customAttribute } : {};

const normalizeAreaValue = (value: string | null | undefined): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const isKenyaAreasResponse = (value: unknown): value is KenyaAreasResponse => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  return Object.values(value as Record<string, unknown>).every((countyValue) => {
    if (!countyValue || typeof countyValue !== "object" || Array.isArray(countyValue)) return false;
    return Object.values(countyValue as Record<string, unknown>).every((subcountyValue) =>
      Array.isArray(subcountyValue) && subcountyValue.every((ward) => typeof ward === "string")
    );
  });
};

const sortAreaOptions = (options: string[]): string[] =>
  [...options].sort((left, right) => left.localeCompare(right));

const withCurrentAreaOption = (options: string[], currentValue: string): string[] => {
  const trimmedCurrentValue = currentValue.trim();
  if (!trimmedCurrentValue) return sortAreaOptions(options);
  return sortAreaOptions(
    options.some((option) => normalizeAreaValue(option) === normalizeAreaValue(trimmedCurrentValue))
      ? options
      : [...options, trimmedCurrentValue],
  );
};

const resolveAreaSelectionValue = (
  options: string[],
  currentValue: string,
): string | undefined => {
  const trimmedCurrentValue = currentValue.trim();
  if (!trimmedCurrentValue) return undefined;
  return options.find((option) => normalizeAreaValue(option) === normalizeAreaValue(trimmedCurrentValue)) || trimmedCurrentValue;
};

const getMatchingCountyName = (
  areas: KenyaAreasResponse,
  county: string,
): string => {
  const target = normalizeAreaValue(county);
  if (!target) return "";
  return Object.keys(areas).find((countyName) => normalizeAreaValue(countyName) === target) || "";
};

const getCountyOptions = (areas: KenyaAreasResponse): string[] =>
  sortAreaOptions(Object.keys(areas));

const getSubcountyOptions = (
  areas: KenyaAreasResponse,
  county: string,
): string[] => {
  const matchingCountyName = getMatchingCountyName(areas, county);
  if (!matchingCountyName) return [];
  return sortAreaOptions(Object.keys(areas[matchingCountyName] || {}));
};

const getCustomAttributeText = (accessControl?: AccessControl): string => {
  if (!accessControl) return "";
  if (typeof accessControl.customAttribute === "string") return accessControl.customAttribute;

  // Backward compatibility for records saved using the old key-value map.
  if (accessControl.customAttributes && typeof accessControl.customAttributes === "object") {
    return Object.keys(accessControl.customAttributes).join(", ");
  }

  return "";
};

const normalizeSelectableRole = (role: string) =>
  USER_ROLE_OPTIONS.includes(role as typeof USER_ROLE_OPTIONS[number]) ? role : "";

const formatRoleLabel = (role: string): string => {
  const normalized = normalizeRole(role);
  if (normalized === "admin") return "Admin";
  if (normalized === "field officer") return "Field Officer";
  return role
    .split("-")
    .join(" ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};

const normalizeSystemRole = (role: string | null | undefined): string => {
  const normalized = normalizeRole(role);
  if (normalized === "admin") return "admin";
  const selectedRole = ROLE_OPTIONS.find((option) => normalizeRole(option.value) === normalized);
  return selectedRole?.value || "user";
};

const isFieldOfficerSelection = (role: string | null | undefined): boolean =>
  normalizeRole(role) === "field officer";

const getAttributeFromLegacyRole = (
  role: string | null | undefined,
): string => {
  const normalized = normalizeRole(role);
  return LEGACY_ROLE_ATTRIBUTE_MAP[normalized] || "";
};

const getEffectiveLegacyRole = (record: UserRecord): string => {
  const fromAccessControl = normalizeSelectableRole(
    getCustomAttributeText(record.accessControl),
  );
  if (fromAccessControl) return fromAccessControl;
  return getAttributeFromLegacyRole(record.role);
};

const getEffectiveRole = (record: UserRecord): string => {
  const normalizedRole = normalizeSystemRole(record.role);
  if (normalizedRole !== "user") return normalizedRole;
  return getEffectiveLegacyRole(record) || "user";
};

const getDisplayRole = (record: UserRecord): string =>
  formatRoleLabel(getEffectiveRole(record));

const getRoleSelectionFromRecord = (record: UserRecord): string =>
  getEffectiveRole(record) === "user" ? "User" : getEffectiveRole(record);

const getRecordPermissionPrincipal = (record: UserRecord): string =>
  resolvePermissionPrincipal(getEffectiveRole(record), getEffectiveLegacyRole(record));

const parseDate = (date: any): Date | null => {
  if (!date) return null;  
  try {
    if (date?.toDate && typeof date.toDate === 'function') return date.toDate();
    else if (date && typeof date === 'object' && (date.seconds || date._seconds)) return new Date((date.seconds || date._seconds) * 1000);
    else if (typeof date === 'string') {
      const parsed = new Date(date);
      return isNaN(parsed.getTime()) ? null : parsed;
    }
    else if (typeof date === 'number') return new Date(date);
  } catch (error) {
    console.error('Error parsing date:', error);
  }
  return null;
};

const sortUsersByLatest = (records: UserRecord[]): UserRecord[] =>
  [...records].sort((a, b) => {
    const dateA = parseDate(a.createdAt) || new Date(0);
    const dateB = parseDate(b.createdAt) || new Date(0);
    return dateB.getTime() - dateA.getTime();
  });

const getCurrentMonthDates = () => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const formatLocalDate = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  
  return {
    startDate: formatLocalDate(startOfMonth),
    endDate: formatLocalDate(endOfMonth)
  };
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
    minute: '2-digit'
  }) : 'N/A';
};

const useDebounce = (value: string, delay: number) => {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
};

// --- Extracted Sub-Components (Optimization) ---

interface StatsCardProps {
  title: string;
  value: string | number;
  icon: any;
  description?: string;
  children?: React.ReactNode;
}

const StatsCard = ({ title, value, icon: Icon, description, children }: StatsCardProps) => (
  <Card className="bg-white text-slate-900 shadow-md border-0 rounded-xl relative overflow-hidden hover:shadow-lg transition-shadow duration-200">
    <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-gradient-to-b from-blue-500 to-blue-600"></div>
    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 pt-5 pl-7">
      <CardTitle className="text-xs font-semibold text-slate-600 uppercase tracking-wide">{title}</CardTitle>
    </CardHeader>
    <CardContent className="pl-7 pb-5 flex flex-row items-center">
      <div className="mr-3 rounded-lg bg-blue-50 p-2">
        <Icon className="h-7 w-7 text-blue-600" />
      </div>
      <div>
        <div className="text-3xl font-bold text-slate-900">{value}</div>
        {children}
        {description && (
          <p className="text-xs text-slate-500 mt-1.5">
            {description}
          </p>
        )}
      </div>
    </CardContent>
  </Card>
);

interface FilterSectionProps {
  searchValue: string;
  filters: Omit<Filters, 'search'>;
  uniqueRoles: string[];
  uniqueStatuses: string[];
  onSearch: (value: string) => void;
  onFilterChange: (key: keyof Omit<Filters, 'search'>, value: string) => void;
}

const FilterSection = ({ searchValue, filters, uniqueRoles, uniqueStatuses, onSearch, onFilterChange }: FilterSectionProps) => (
  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
    <div className="space-y-1.5">
      <Label htmlFor="search" className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Search</Label>
      <Input
        id="search"
        placeholder="Search by name..."
        value={searchValue}
        onChange={(e) => onSearch(e.target.value)}
        className="border-gray-200 focus:border-blue-500 focus:ring-blue-500 bg-white text-sm h-9"
      />
    </div>

    <div className="space-y-1.5">
      <Label htmlFor="role" className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Role</Label>
      <Select value={filters.role} onValueChange={(value) => onFilterChange("role", value)}>
        <SelectTrigger className="border-gray-200 focus:border-blue-500 focus:ring-blue-500 bg-white text-sm h-9">
          <SelectValue placeholder="Select role" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Roles</SelectItem>
          {uniqueRoles.map(role => (
            <SelectItem key={role} value={role}>
              {formatRoleLabel(role)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>

    <div className="space-y-1.5">
      <Label htmlFor="status" className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Status</Label>
      <Select value={filters.status} onValueChange={(value) => onFilterChange("status", value)}>
        <SelectTrigger className="border-gray-200 focus:border-blue-500 focus:ring-blue-500 bg-white text-sm h-9">
          <SelectValue placeholder="Select status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Status</SelectItem>
          {uniqueStatuses.map(status => (
            <SelectItem key={status} value={status}>
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>

    <div className="space-y-1.5">
      <Label htmlFor="programme" className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Programme</Label>
      <Select value={filters.programme} onValueChange={(value) => onFilterChange("programme", value)}>
        <SelectTrigger className="border-gray-200 focus:border-blue-500 focus:ring-blue-500 bg-white text-sm h-9">
          <SelectValue placeholder="All Programmes" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Programmes</SelectItem>
          {AVAILABLE_PROGRAMMES.map(prog => (
            <SelectItem key={prog} value={prog}>
              {prog}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>

    <div className="space-y-1.5">
      <Label htmlFor="startDate" className="text-xs font-semibold text-gray-600 uppercase tracking-wide">From Date</Label>
      <Input
        id="startDate"
        type="date"
        value={filters.startDate}
        onChange={(e) => onFilterChange("startDate", e.target.value)}
        className="border-gray-200 focus:border-blue-500 focus:ring-blue-500 bg-white text-sm h-9"
      />
    </div>

    <div className="space-y-1.5">
      <Label htmlFor="endDate" className="text-xs font-semibold text-gray-600 uppercase tracking-wide">To Date</Label>
      <Input
        id="endDate"
        type="date"
        value={filters.endDate}
        onChange={(e) => onFilterChange("endDate", e.target.value)}
        className="border-gray-200 focus:border-blue-500 focus:ring-blue-500 bg-white text-sm h-9"
      />
    </div>
  </div>
);

interface TableRowProps {
  record: UserRecord;
  selectedRecords: string[];
  onSelectRecord: (id: string) => void;
  onView: (record: UserRecord) => void;
  onEdit: (record: UserRecord) => void;
  onDeleteClick: (record: UserRecord) => void;
  userIsAdmin: boolean;
}

const TableRow = ({ record, selectedRecords, onSelectRecord, onView, onEdit, onDeleteClick, userIsAdmin }: TableRowProps) => {
  const effectiveRole = getEffectiveRole(record);
  const displayRole = getDisplayRole(record);

  return (
    <tr className="border-b border-gray-100 hover:bg-blue-50/60 transition-all duration-200 group text-sm">
      <td className="py-3 px-4 ml-2">
        <Checkbox
          checked={selectedRecords.includes(record.id)}
          onCheckedChange={() => onSelectRecord(record.id)}
          className="data-[state=checked]:bg-blue-600"
        />
      </td>
      <td className="py-3 px-4 text-sm font-medium text-gray-900">{record.name || "N/A"}</td>
      <td className="py-3 px-4 text-sm">
        <Badge
          variant="secondary"
          className={
            effectiveRole === "admin" ? "bg-blue-100 text-blue-800" :
            displayRole === "Field Officer" ? "bg-green-100 text-green-800" :
            "bg-gray-100 text-gray-800"
          }
        >
          {displayRole}
        </Badge>
      </td>
      <td className="py-3 px-4 text-sm">
        <Badge
          variant={record.status === "active" ? "default" : "secondary"}
          className={record.status === "active" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}
        >
          {record.status ? record.status.charAt(0).toUpperCase() + record.status.slice(1) : "N/A"}
        </Badge>
      </td>
      <td className="py-3 px-4 text-sm text-gray-600">{formatDate(record.createdAt)}</td>
      <td className="py-3 px-4 text-sm">
        <div className="flex gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onView(record)}
            className="h-7 w-7 p-0 hover:bg-blue-50 hover:text-blue-600"
            title="View details"
          >
            <Eye className="h-3.5 w-3.5" />
          </Button>
          {userIsAdmin && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onEdit(record)}
                className="h-7 w-7 p-0 hover:bg-orange-50 hover:text-orange-600"
                title="Edit user"
              >
                <Edit className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onDeleteClick(record)}
                className="h-7 w-7 p-0 hover:bg-red-50 hover:text-red-600"
                title="Delete user"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
};

// --- Main Component ---

const UserManagementPage = () => {
  const { userRole, userAttribute } = useAuth();
  const { toast } = useToast();
  const userIsAdmin = isAdmin(userRole);
  const requireAdmin = useCallback(() => {
    if (userIsAdmin) return true;
    toast({
      title: "Access denied",
      description: "Only admin can create, edit, or delete records on this page.",
      variant: "destructive",
    });
    return false;
  }, [userIsAdmin, toast]);
  
  // State
  const [allRecords, setAllRecords] = useState<UserRecord[]>([]);
  const [filteredRecords, setFilteredRecords] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [exportLoading, setExportLoading] = useState(false);
  const [selectedRecords, setSelectedRecords] = useState<string[]>([]);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isBulkDeleteDialogOpen, setIsBulkDeleteDialogOpen] = useState(false);
  const [viewingRecord, setViewingRecord] = useState<UserRecord | null>(null);
  const [editingRecord, setEditingRecord] = useState<UserRecord | null>(null);
  const [recordToDelete, setRecordToDelete] = useState<UserRecord | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [addLoading, setAddLoading] = useState(false);
  const [kenyaAreas, setKenyaAreas] = useState<KenyaAreasResponse>({});
  const [kenyaAreasLoading, setKenyaAreasLoading] = useState(false);
  const [kenyaAreasError, setKenyaAreasError] = useState<string>("");
  
  const currentMonth = useMemo(getCurrentMonthDates, []);

  // Separate search state with debouncing
  const [searchValue, setSearchValue] = useState("");
  const debouncedSearch = useDebounce(searchValue, 300);

  const [filters, setFilters] = useState<Omit<Filters, 'search'>>({
    role: "all",
    status: "all",
    programme: "all",
    startDate: currentMonth.startDate,
    endDate: currentMonth.endDate,
  });

  const [stats, setStats] = useState<Stats>({
    totalUsers: 0,
    activeUsers: 0,
    adminUsers: 0,
    fieldOfficerUsers: 0,
    hrUsers: 0,
    projectManagerUsers: 0,
    financeUsers: 0,
    offtakeOfficerUsers: 0,
  });

  const [pagination, setPagination] = useState<Pagination>({
    page:1,
    limit: PAGE_LIMIT,
    totalPages:1,
    hasNext: false,
    hasPrev: false
  });

  const initialProgrammes = AVAILABLE_PROGRAMMES.reduce((acc, prog) => ({ ...acc, [prog]: false }), {});

  const [editForm, setEditForm] = useState<EditForm>({
    name: "",
    email: "",
    phoneNumber: "",
    county: "",
    subcounty: "",
    role: "",
    status: "active",
    customAttribute: "",
    allowedProgrammes: initialProgrammes
  });

  const [addForm, setAddForm] = useState<AddUserForm>({
    name: "",
    email: "",
    phoneNumber: "",
    county: "",
    subcounty: "",
    role: "",
    password: "",
    confirmPassword: "",
    customAttribute: "",
    allowedProgrammes: initialProgrammes
  });
  const addFormIsFieldOfficer = isFieldOfficerSelection(addForm.role);
  const editFormIsFieldOfficer = isFieldOfficerSelection(editForm.role);

  const fetchKenyaAreas = useCallback(async () => {
    const cachedAreas = readCachedValue<KenyaAreasResponse>(
      KENYA_AREAS_CACHE_KEY,
      KENYA_AREAS_CACHE_TTL_MS,
    );

    if (cachedAreas && isKenyaAreasResponse(cachedAreas)) {
      setKenyaAreas(cachedAreas);
      setKenyaAreasError("");
      return;
    }

    try {
      setKenyaAreasLoading(true);
      const response = await fetch(`${KENYA_AREAS_API_URL}?apiKey=${KENYA_AREAS_API_KEY}`);
      if (!response.ok) {
        throw new Error(`Failed to load Kenya areas (${response.status})`);
      }

      const payload: unknown = await response.json();
      if (!isKenyaAreasResponse(payload)) {
        throw new Error("Unexpected Kenya areas response format.");
      }

      setKenyaAreas(payload);
      setKenyaAreasError("");
      writeCachedValue(KENYA_AREAS_CACHE_KEY, payload);
    } catch (error) {
      console.error("Error loading Kenya areas:", error);
      setKenyaAreasError("Failed to load counties and sub counties.");
    } finally {
      setKenyaAreasLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchKenyaAreas();
  }, [fetchKenyaAreas]);

  const addCountyOptions = useMemo(
    () => withCurrentAreaOption(getCountyOptions(kenyaAreas), addForm.county),
    [addForm.county, kenyaAreas],
  );

  const editCountyOptions = useMemo(
    () => withCurrentAreaOption(getCountyOptions(kenyaAreas), editForm.county),
    [editForm.county, kenyaAreas],
  );

  const addSubcountyOptions = useMemo(
    () => withCurrentAreaOption(getSubcountyOptions(kenyaAreas, addForm.county), addForm.subcounty),
    [addForm.county, addForm.subcounty, kenyaAreas],
  );

  const editSubcountyOptions = useMemo(
    () => withCurrentAreaOption(getSubcountyOptions(kenyaAreas, editForm.county), editForm.subcounty),
    [editForm.county, editForm.subcounty, kenyaAreas],
  );

  const addSelectedCountyValue = useMemo(
    () => resolveAreaSelectionValue(addCountyOptions, addForm.county),
    [addCountyOptions, addForm.county],
  );

  const editSelectedCountyValue = useMemo(
    () => resolveAreaSelectionValue(editCountyOptions, editForm.county),
    [editCountyOptions, editForm.county],
  );

  const addSelectedSubcountyValue = useMemo(
    () => resolveAreaSelectionValue(addSubcountyOptions, addForm.subcounty),
    [addForm.subcounty, addSubcountyOptions],
  );

  const editSelectedSubcountyValue = useMemo(
    () => resolveAreaSelectionValue(editSubcountyOptions, editForm.subcounty),
    [editForm.subcounty, editSubcountyOptions],
  );

  const handleRoleFormChange = (value: string, isEdit: boolean) => {
    const setter = isEdit ? setEditForm : setAddForm;
    setter((prev) => ({
      ...prev,
      role: value,
      county: isFieldOfficerSelection(value) ? prev.county : "",
      subcounty: isFieldOfficerSelection(value) ? prev.subcounty : "",
    }));
  };

  const handleLocationFieldChange = useCallback((
    field: "county" | "subcounty",
    value: string,
    isEdit: boolean,
  ) => {
    const setter = isEdit ? setEditForm : setAddForm;
    setter((prev) => ({
      ...prev,
      county: field === "county" ? value : prev.county,
      subcounty: field === "county" ? "" : value,
    }));
  }, []);

  // Data fetching
  const fetchAllData = useCallback(async () => {
    try {
      const cachedUsers = readCachedValue<UserRecord[]>(USER_MANAGEMENT_CACHE_KEY);
      if (cachedUsers) {
        setAllRecords(sortUsersByLatest(cachedUsers));
        setLoading(false);
      } else {
        setLoading(true);
      }
      
      // Only fetch Users
      const recordsData: UserRecord[] = (await fetchCollection("users")) as UserRecord[];

      const sortedRecordsData = sortUsersByLatest(recordsData);

      setAllRecords(sortedRecordsData);
      if (sortedRecordsData.length > 0) {
        writeCachedValue(USER_MANAGEMENT_CACHE_KEY, sortedRecordsData);
      } else {
        removeCachedValue(USER_MANAGEMENT_CACHE_KEY);
      }
      
    } catch (error) {
      console.error("Error fetching data:", error);
      toast({
        title: "Error",
        description: "Failed to load users from database",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  // Main filtering logic
  const filterAndProcessData = useCallback((records: UserRecord[], searchTerm: string, filterParams: Omit<Filters, 'search'>) => {
    const filtered = records.filter(record => {
      const displayRole = getDisplayRole(record);

      if (filterParams.role !== "all" && displayRole !== filterParams.role) {
        return false;
      }

      if (filterParams.status !== "all" && record.status?.toLowerCase() !== filterParams.status.toLowerCase()) {
        return false;
      }

      // Programme Filter
      if (filterParams.programme !== "all") {
        const hasAccess = record.allowedProgrammes && record.allowedProgrammes[filterParams.programme] === true;
        if (!hasAccess) return false;
      }

      if (filterParams.startDate || filterParams.endDate) {
        const recordDate = parseDate(record.createdAt);
        if (recordDate) {
          const recordDateOnly = new Date(recordDate);
          recordDateOnly.setHours(0, 0, 0, 0);

          const startDate = filterParams.startDate ? new Date(filterParams.startDate) : null;
          const endDate = filterParams.endDate ? new Date(filterParams.endDate) : null;
          if (startDate) startDate.setHours(0, 0, 0, 0);
          if (endDate) endDate.setHours(23, 59, 59, 999);

          if (startDate && recordDateOnly < startDate) return false;
          if (endDate && recordDateOnly > endDate) return false;
        }
      }

      if (searchTerm) {
        const searchTermLower = searchTerm.toLowerCase();
        const searchMatch = [
          record.name,
          record.email,
          record.phoneNumber,
          record.phone,
          displayRole,
        ].some(field => field?.toLowerCase().includes(searchTermLower));
        if (!searchMatch) return false;
      }

      return true;
    });

    const sortedFiltered = sortUsersByLatest(filtered);

    const activeUsers = sortedFiltered.filter(r => r.status?.toLowerCase() === 'active').length;
    const adminUsers = sortedFiltered.filter((r) => getEffectiveRole(r) === "admin").length;
    const fieldOfficerUsers = sortedFiltered.filter((r) => getDisplayRole(r) === "Field Officer").length;
    const hrUsers = sortedFiltered.filter((r) => isHummanResourceManager(getRecordPermissionPrincipal(r))).length;
    const projectManagerUsers = sortedFiltered.filter((r) => isProjectManager(getRecordPermissionPrincipal(r))).length;
    const financeUsers = sortedFiltered.filter((r) => isFinance(getRecordPermissionPrincipal(r))).length;
    const offtakeOfficerUsers = sortedFiltered.filter((r) => isOfftakeOfficer(getRecordPermissionPrincipal(r))).length;

    const calculatedStats = {
      totalUsers: sortedFiltered.length,
      activeUsers,
      adminUsers,
      fieldOfficerUsers,
      hrUsers,
      projectManagerUsers,
      financeUsers,
      offtakeOfficerUsers,
    };

    const totalPages = Math.ceil(sortedFiltered.length / PAGE_LIMIT);

    return {
      filteredRecords: sortedFiltered,
      stats: calculatedStats,
      totalPages
    };
  }, []);

  useEffect(() => {
    if (allRecords.length === 0) return;

    const result = filterAndProcessData(allRecords, debouncedSearch, filters);
    
    setFilteredRecords(result.filteredRecords);
    setStats(result.stats);
    
    setPagination(prev => ({
      ...prev,
      totalPages: result.totalPages,
      hasNext: prev.page < result.totalPages,
      hasPrev: prev.page > 1
    }));
  }, [allRecords, debouncedSearch, filters, filterAndProcessData]);

  useEffect(() => {
    fetchAllData();
  }, [fetchAllData]);

  const handleSearch = useCallback((value: string) => {
    setSearchValue(value);
    setPagination(prev => ({ ...prev, page: 1 }));
  }, []);

  const handleFilterChange = useCallback((key: keyof Omit<Filters, 'search'>, value: string) => {
    setFilters(prev => ({
      ...prev,
      [key]: value
    }));
    setPagination(prev => ({ ...prev, page: 1 }));
  }, []);

  const handleExport = useCallback(async () => {
    try {
      setExportLoading(true);
      
      if (filteredRecords.length === 0) {
        toast({
          title: "No Data to Export",
          description: "There are no users matching your current filters",
          variant: "destructive",
        });
        return;
      }

      const csvData = filteredRecords.map(record => [
        record.name || "N/A",
        record.email || "N/A",
        record.phoneNumber || record.phone || "N/A",
        getDisplayRole(record),
        record.status || "N/A",
        formatDate(record.createdAt),
        formatDate(record.lastLogin),
        formatDate(record.updatedAt)
      ]);

      const csvContent = [EXPORT_HEADERS, ...csvData]
        .map(row => row.map(field => `"${field}"`).join(','))
        .join('\n');

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      
      let filename = `users-management`;
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
        description: `Exported ${filteredRecords.length} users with applied filters`,
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
  }, [filteredRecords, filters.startDate, filters.endDate, toast]);

  const handlePageChange = useCallback((newPage: number) => {
    setPagination(prev => ({ ...prev, page: newPage }));
  }, []);

  const getCurrentPageRecords = useCallback(() => {
    const startIndex = (pagination.page - 1) * pagination.limit;
    const endIndex = startIndex + pagination.limit;
    return filteredRecords.slice(startIndex, endIndex);
  }, [filteredRecords, pagination.page, pagination.limit]);

  const handleSelectRecord = useCallback((recordId: string) => {
    setSelectedRecords(prev =>
      prev.includes(recordId)
        ? prev.filter(id => id !== recordId)
        : [...prev, recordId]
    );
  }, []);

  const handleSelectAll = useCallback(() => {
    const currentPageIds = getCurrentPageRecords().map(r => r.id);
    setSelectedRecords(prev =>
      prev.length === currentPageIds.length ? [] : currentPageIds
    );
  }, [getCurrentPageRecords]);

  const openEditDialog = useCallback((record: UserRecord) => {
    if (!userIsAdmin) return;
    setEditingRecord(record);
    
    const existingProgs = record.allowedProgrammes || {};
    const mergedProgs = AVAILABLE_PROGRAMMES.reduce((acc, prog) => ({
      ...acc,
      [prog]: !!existingProgs[prog]
    }), {});

    setEditForm({
      name: record.name || "",
      email: record.email || "",
      phoneNumber: record.phoneNumber || record.phone || "",
      county: record.county || "",
      subcounty: record.subcounty || "",
      role: getRoleSelectionFromRecord(record),
      status: record.status || "active",
      customAttribute: "",
      allowedProgrammes: mergedProgs
    });
    setIsEditDialogOpen(true);
  }, [userIsAdmin]);

  const openViewDialog = useCallback((record: UserRecord) => {
    setViewingRecord(record);
    setIsViewDialogOpen(true);
  }, []);

  const openAddDialog = useCallback(() => {
    if (!userIsAdmin) return;
    setAddForm({
      name: "",
      email: "",
      phoneNumber: "",
      county: "",
      subcounty: "",
      role: "",
      password: "",
      confirmPassword: "",
      customAttribute: "",
      allowedProgrammes: initialProgrammes
    });
    setIsAddDialogOpen(true);
  }, [initialProgrammes, userIsAdmin]);

  const openDeleteDialog = useCallback((record: UserRecord) => {
    if (!userIsAdmin) return;
    setRecordToDelete(record);
    setIsDeleteDialogOpen(true);
  }, [userIsAdmin]);

  const openBulkDeleteDialog = useCallback(() => {
    if (!userIsAdmin) return;
    if (selectedRecords.length === 0) return;
    setIsBulkDeleteDialogOpen(true);
  }, [selectedRecords, userIsAdmin]);

  const handleEditSubmit = useCallback(async () => {
    if (!requireAdmin()) return;
    if (!editingRecord) return;

    try {
      const normalizedRole = normalizeSystemRole(editForm.role);
      const isFieldOfficer = isFieldOfficerSelection(editForm.role);
      if (isFieldOfficer && (!editForm.county.trim() || !editForm.subcounty.trim())) {
        toast({
          title: "Missing location",
          description: "County and subcounty are required for Field Officers.",
          variant: "destructive",
        });
        return;
      }

      await update(ref(db, `users/${editingRecord.id}`), {
        name: editForm.name,
        email: editForm.email,
        phoneNumber: editForm.phoneNumber.trim(),
        county: isFieldOfficer ? editForm.county.trim() : "",
        subcounty: isFieldOfficer ? editForm.subcounty.trim() : "",
        role: normalizedRole,
        status: editForm.status,
        accessControl: buildAccessControl(""),
        allowedProgrammes: editForm.allowedProgrammes,
        updatedAt: serverTimestamp()
      });

      toast({
        title: "Success",
        description: "User updated successfully",
      });

      removeCachedValue(USER_MANAGEMENT_CACHE_KEY);
      invalidateCollectionCache("users");
      setIsEditDialogOpen(false);
      setEditingRecord(null);
      fetchAllData();
    } catch (error) {
      console.error("Error updating user:", error);
      toast({
        title: "Error",
        description: "Failed to update user",
        variant: "destructive",
      });
    }
  }, [editingRecord, editForm, fetchAllData, toast, requireAdmin]);

  const handleAddUser = useCallback(async () => {
    if (!requireAdmin()) return;
    if (!addForm.name || !addForm.email || !addForm.password) {
      toast({ title: "Error", description: "Please fill in all required fields", variant: "destructive" });
      return;
    }

    if (!addForm.role) {
      toast({ title: "Error", description: "Please select a role", variant: "destructive" });
      return;
    }

    if (addForm.password !== addForm.confirmPassword) {
      toast({ title: "Error", description: "Passwords do not match", variant: "destructive" });
      return;
    }

    try {
      setAddLoading(true);
      const normalizedRole = normalizeSystemRole(addForm.role);
      const isFieldOfficer = isFieldOfficerSelection(addForm.role);
      if (isFieldOfficer && (!addForm.county.trim() || !addForm.subcounty.trim())) {
        toast({
          title: "Missing location",
          description: "County and subcounty are required for Field Officers.",
          variant: "destructive",
        });
        return;
      }

      const userCredential = await createUserWithEmailAndPassword(
        secondaryAuth,
        addForm.email,
        addForm.password
      );

      const newUser = userCredential.user;

      await set(ref(db, `users/${newUser.uid}`), {
        uid: newUser.uid, 
        name: addForm.name,
        email: addForm.email,
        phoneNumber: addForm.phoneNumber.trim(),
        county: isFieldOfficer ? addForm.county.trim() : "",
        subcounty: isFieldOfficer ? addForm.subcounty.trim() : "",
        role: normalizedRole,
        status: "active",
        accessControl: buildAccessControl(""),
        allowedProgrammes: addForm.allowedProgrammes,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      toast({ title: "Success", description: "User created successfully!" });

      setIsAddDialogOpen(false);
      setAddForm({
        name: "",
        email: "",
        phoneNumber: "",
        county: "",
        subcounty: "",
        role: "",
        password: "",
        confirmPassword: "",
        customAttribute: "",
        allowedProgrammes: initialProgrammes
      });

      removeCachedValue(USER_MANAGEMENT_CACHE_KEY);
      invalidateCollectionCache("users");
      fetchAllData();

    } catch (error: any) {
      console.error("CREATE USER ERROR:", error);
      let msg = "Failed to create user";

      if (error.code === "auth/email-already-in-use") msg = "Email already in use";
      if (error.code === "auth/invalid-email") msg = "Invalid email";
      if (error.code === "auth/weak-password") msg = "Weak password";

      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setAddLoading(false);
    }
  }, [addForm, toast, fetchAllData, initialProgrammes, requireAdmin]);

  const handleDeleteSingle = useCallback(async () => {
    if (!requireAdmin()) return;
    if (!recordToDelete) return;

    try {
      setDeleteLoading(true);

      if (recordToDelete.uid) {
        try {
          console.warn("User has Auth account. Consider implementing backend deletion for Auth users.");
        } catch (authError) {
          console.error("Error deleting user from Auth:", authError);
        }
      }

      await remove(ref(db, `users/${recordToDelete.id}`));

      toast({
        title: "Success",
        description: "User deleted successfully",
      });

      removeCachedValue(USER_MANAGEMENT_CACHE_KEY);
      invalidateCollectionCache("users");
      setIsDeleteDialogOpen(false);
      setRecordToDelete(null);
      setSelectedRecords(prev => prev.filter(id => id !== recordToDelete.id));
      fetchAllData();
    } catch (error) {
      console.error("Error deleting user:", error);
      toast({
        title: "Error",
        description: "Failed to delete user",
        variant: "destructive",
      });
    } finally {
      setDeleteLoading(false);
    }
  }, [recordToDelete, fetchAllData, toast, requireAdmin]);

  const handleDeleteSelected = useCallback(async () => {
    if (!requireAdmin()) return;
    if (selectedRecords.length === 0) return;

    try {
      setDeleteLoading(true);
      
      await Promise.all(selectedRecords.map(recordId => 
        remove(ref(db, `users/${recordId}`))
      ));

      toast({
        title: "Success",
        description: `Deleted ${selectedRecords.length} users successfully`,
      });

      removeCachedValue(USER_MANAGEMENT_CACHE_KEY);
      invalidateCollectionCache("users");
      setIsBulkDeleteDialogOpen(false);
      setSelectedRecords([]);
      fetchAllData();
    } catch (error) {
      console.error("Error deleting users:", error);
      toast({
        title: "Error",
        description: "Failed to delete users",
        variant: "destructive",
      });
    } finally {
      setDeleteLoading(false);
    }
  }, [selectedRecords, fetchAllData, toast, requireAdmin]);

  const uniqueRoles = useMemo(
    () => ROLE_OPTIONS.map((option) => option.value),
    []
  );

  const uniqueStatuses = useMemo(() => 
    ["active", "inactive"],
    []
  );

  const currentPageRecords = useMemo(getCurrentPageRecords, [getCurrentPageRecords]);

  const clearAllFilters = useCallback(() => {
    setSearchValue("");
    setFilters({
      role: "all",
      status: "all",
      programme: "all",
      startDate: "",
      endDate: "",
    });
    setPagination(prev => ({ ...prev, page: 1 }));
  }, []);

  const resetToCurrentMonth = useCallback(() => {
    setFilters(prev => ({ ...prev, ...currentMonth }));
    setPagination(prev => ({ ...prev, page: 1 }));
  }, [currentMonth]);

  const toggleProgramme = (prog: string, isEdit: boolean) => {
    const setter = isEdit ? setEditForm : setAddForm;
    setter(prev => ({
      ...prev,
      allowedProgrammes: {
        ...prev.allowedProgrammes,
        [prog]: !prev.allowedProgrammes[prog]
      }
    }));
  };

  return (
    <div className="space-y-6 bg-slate-50/50 min-h-screen p-4 md:p-6 lg:p-8">
      {/* Header */}
      <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4 bg-white rounded-xl shadow-sm p-5 border border-gray-100">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 mb-1">
            User Management
          </h1>
          <p className="text-sm text-slate-500">Manage system users, roles, and permissions</p>
        </div>

        <div className="flex flex-wrap gap-2 w-full xl:w-auto">
          <Button variant="outline" size="sm" onClick={clearAllFilters} className="text-sm border-gray-200 hover:bg-gray-50 hover:text-gray-900">
            Clear Filters
          </Button>
          <Button variant="outline" size="sm" onClick={resetToCurrentMonth} className="text-sm border-gray-200 hover:bg-gray-50 hover:text-gray-900">
            This Month
          </Button>
          {userIsAdmin && (
            <>
              <Button onClick={openAddDialog} className="bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white shadow-sm text-sm">
                <Plus className="h-4 w-4 mr-2" />
                Add User
              </Button>
              {selectedRecords.length > 0 && (
                <Button onClick={openBulkDeleteDialog} variant="destructive" className="text-sm">
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete ({selectedRecords.length})
                </Button>
              )}
            </>
           )}
          <Button onClick={handleExport} disabled={exportLoading || filteredRecords.length === 0} className="bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-700 hover:to-emerald-800 text-white shadow-sm text-sm">
            <Download className="h-4 w-4 mr-2" />
            {exportLoading ? "Exporting..." : `Export (${filteredRecords.length})`}
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard title="Total Users" value={stats.totalUsers} icon={Users}>
          <div className="flex gap-3 text-xs">
            <span className="text-green-600 font-medium">● Active: {stats.activeUsers}</span>
            <span className="text-red-500 font-medium">● Inactive: {stats.totalUsers - stats.activeUsers}</span>
          </div>
        </StatsCard>

        <StatsCard title="Admin Users" value={stats.adminUsers} icon={Shield} description="Administrative users" />
        <StatsCard title="Field Officers" value={stats.fieldOfficerUsers} icon={User} description="Field data users" />
        <StatsCard title="Role Assignments" value={stats.hrUsers + stats.projectManagerUsers + stats.financeUsers + stats.offtakeOfficerUsers} icon={Users} description="Assigned operational roles" />

      </div>

      {/* Filters */}
      <Card className="shadow-md border-0 bg-white rounded-xl">
        <CardHeader className="border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
          <CardTitle className="text-base font-semibold text-slate-700">Filters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-6">
          <FilterSection
            searchValue={searchValue}
            filters={filters}
            uniqueRoles={uniqueRoles}
            uniqueStatuses={uniqueStatuses}
            onSearch={handleSearch}
            onFilterChange={handleFilterChange}
          />
        </CardContent>
      </Card>

      {/* Table */}
      <Card className="shadow-md border-0 bg-white rounded-xl overflow-hidden">
        <CardContent className="p-0">
          {loading ? (
            <div className="text-center py-16">
              <div className="animate-spin rounded-full h-10 w-10 border-4 border-blue-200 border-t-blue-600 mx-auto"></div>
              <p className="text-slate-500 mt-4 font-medium">Loading users...</p>
            </div>
          ) : currentPageRecords.length === 0 ? (
            <div className="text-center py-16">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-slate-100 mb-4">
                <Users className="h-8 w-8 text-slate-400" />
              </div>
              <p className="text-slate-600 font-medium">
                {allRecords.length === 0 ? "No users found" : "No users matching your filters"}
              </p>
              <p className="text-slate-400 text-sm mt-1">Try adjusting your search or filter criteria</p>
            </div>
          ) : (
            <>
              <div className="w-full overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="bg-gradient-to-r from-blue-600 to-blue-700 text-white">
                      <th className="py-3.5 px-4 ml-2">
                        <Checkbox
                          checked={selectedRecords.length === currentPageRecords.length && currentPageRecords.length > 0}
                          onCheckedChange={handleSelectAll}
                          className="data-[state=checked]:bg-white/20 data-[state=checked]:border-white"
                        />
                      </th>
                      <th className="text-left py-3.5 px-4 font-semibold text-white/95">Name</th>
                      <th className="text-left py-3.5 px-4 font-semibold text-white/95">Role</th>
                      <th className="text-left py-3.5 px-4 font-semibold text-white/95">Status</th>
                      <th className="text-left py-3.5 px-4 font-semibold text-white/95">Created</th>
                      <th className="text-left py-3.5 px-4 font-semibold text-white/95">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {currentPageRecords.map((record) => (
                      <TableRow
                        key={record.id}
                        record={record}
                        selectedRecords={selectedRecords}
                        onSelectRecord={handleSelectRecord}
                        onView={openViewDialog}
                        onEdit={openEditDialog}
                        onDeleteClick={openDeleteDialog}
                        userIsAdmin={userIsAdmin}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between p-5 border-t border-gray-100 bg-gradient-to-r from-slate-50 to-white">
                <div className="text-sm text-slate-600 font-medium">
                  Showing <span className="text-blue-600 font-semibold">{currentPageRecords.length}</span> of{" "}
                  <span className="text-blue-600 font-semibold">{filteredRecords.length}</span> users
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!pagination.hasPrev}
                    onClick={() => handlePageChange(pagination.page - 1)}
                    className="border-gray-200 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200"
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" />
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!pagination.hasNext}
                    onClick={() => handlePageChange(pagination.page + 1)}
                    className="border-gray-200 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200"
                  >
                    Next
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* View User Dialog */}
      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent className="sm:max-w-[32rem] bg-white rounded-2xl shadow-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 text-lg font-semibold text-slate-900">
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-50">
                <Eye className="h-4 w-4 text-blue-600" />
              </div>
              User Details
            </DialogTitle>
            <DialogDescription className="text-sm text-slate-500">
              View complete information for this user
            </DialogDescription>
          </DialogHeader>
          {viewingRecord && (
            <div className="space-y-5 py-3 max-h-[65vh] overflow-y-auto pr-1">
              {/* User Header */}
              <div className="flex items-center gap-4 pb-4 border-b border-gray-100">
                <div className="flex items-center justify-center w-14 h-14 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 text-white text-xl font-bold shadow-sm">
                  {viewingRecord.name?.charAt(0)?.toUpperCase() || 'U'}
                </div>
                <div>
                  <h4 className="font-semibold text-slate-900 text-base">{viewingRecord.name || 'Unknown User'}</h4>
                  <p className="text-sm text-slate-500">{viewingRecord.email || 'No email'}</p>
                </div>
              </div>

              {/* Personal Information */}
              <div className="bg-gradient-to-br from-slate-50 to-slate-100/50 rounded-xl p-4 border border-slate-200">
                <h5 className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-3 flex items-center gap-2">
                  <User className="h-3.5 w-3.5" /> Personal Information
                </h5>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Phone Number</Label>
                    <p className="text-slate-900 font-medium mt-1">{viewingRecord.phoneNumber || viewingRecord.phone || 'N/A'}</p>
                  </div>
                  <div>
                    <Label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Role</Label>
                    <Badge variant="secondary" className={
                      getEffectiveRole(viewingRecord) === 'admin' ? 'bg-blue-100 text-blue-800' :
                      getDisplayRole(viewingRecord) === 'Field Officer' ? 'bg-green-100 text-green-800' :
                      'bg-gray-100 text-gray-800'
                    }>
                      {getDisplayRole(viewingRecord)}
                    </Badge>
                  </div>
                  <div>
                    <Label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Status</Label>
                    <Badge variant={viewingRecord.status === 'active' ? 'default' : 'secondary'} className={viewingRecord.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}>
                      {viewingRecord.status ? viewingRecord.status.charAt(0).toUpperCase() + viewingRecord.status.slice(1) : 'N/A'}
                    </Badge>
                  </div>
                </div>
              </div>

              {/* Allowed Programmes */}
              <div className="bg-gradient-to-br from-slate-50 to-slate-100/50 rounded-xl p-4 border border-slate-200">
                <h5 className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-3 flex items-center gap-2">
                  <Shield className="h-3.5 w-3.5" /> Allowed Programmes
                </h5>
                <div className="flex flex-wrap gap-2">
                  {Object.keys(viewingRecord.allowedProgrammes || {}).length > 0 ? (
                    Object.entries(viewingRecord.allowedProgrammes || {})
                      .filter(([_, allowed]) => allowed)
                      .map(([prog, _]) => (
                        <Badge key={prog} variant="outline" className="bg-white border-blue-200 text-blue-700 font-medium">
                          {prog}
                        </Badge>
                      ))
                  ) : (
                    <span className="text-sm text-slate-500 italic">No specific programmes assigned</span>
                  )}
                </div>
              </div>
              {/* Coverage Area */}
              {(viewingRecord.county || viewingRecord.subcounty) && (
                <div className="bg-gradient-to-br from-slate-50 to-slate-100/50 rounded-xl p-4 border border-slate-200">
                  <h5 className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-3">Coverage Area</h5>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <Label className="text-xs font-medium text-slate-500 uppercase tracking-wide">County</Label>
                      <p className="text-slate-900 font-medium mt-1">{viewingRecord.county || "N/A"}</p>
                    </div>
                    <div>
                      <Label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Sub County</Label>
                      <p className="text-slate-900 font-medium mt-1">{viewingRecord.subcounty || "N/A"}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Account Information */}
              <div className="bg-gradient-to-br from-slate-50 to-slate-100/50 rounded-xl p-4 border border-slate-200">
                <h5 className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-3 flex items-center gap-2">
                  <Calendar className="h-3.5 w-3.5" /> Account Information
                </h5>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Created At</Label>
                    <p className="text-slate-900 font-medium mt-1">{formatDateTime(viewingRecord.createdAt)}</p>
                  </div>
                  <div>
                    <Label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Last Login</Label>
                    <p className="text-slate-900 font-medium mt-1">{formatDateTime(viewingRecord.lastLogin)}</p>
                  </div>
                </div>
              </div>
            </div>
          )}
          <DialogFooter className="border-t border-gray-100 pt-4">
            <Button onClick={() => setIsViewDialogOpen(false)} className="bg-gradient-to-r from-slate-600 to-slate-700 hover:from-slate-700 hover:to-slate-800 text-white shadow-sm">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add User Dialog */}
      {userIsAdmin &&  
      (
        <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
          <DialogContent className="sm:max-w-2xl bg-white rounded-2xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-slate-900">
                <Plus className="h-5 w-5 text-green-600" />
                Add New User
              </DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4 max-h-[70vh] overflow-y-auto">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="add-name" className="text-sm font-medium text-slate-700">Name *</Label>
                  <Input id="add-name" value={addForm.name} onChange={(e) => setAddForm(prev => ({ ...prev, name: e.target.value }))} className="bg-white border-slate-300" placeholder="Enter full name" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="add-email" className="text-sm font-medium text-slate-700">Email *</Label>
                  <Input id="add-email" type="email" value={addForm.email} onChange={(e) => setAddForm(prev => ({ ...prev, email: e.target.value }))} className="bg-white border-slate-300" placeholder="Enter email address" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="add-phone" className="text-sm font-medium text-slate-700">Phone Number</Label>
                  <Input id="add-phone" type="tel" value={addForm.phoneNumber} onChange={(e) => setAddForm(prev => ({ ...prev, phoneNumber: e.target.value }))} className="bg-white border-slate-300" placeholder="e.g. 07XXXXXXXX or +2547XXXXXXXX" />
                </div>
              </div>              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="add-role" className="text-sm font-medium text-slate-700">Role *</Label>
                  <Select value={addForm.role} onValueChange={(value) => handleRoleFormChange(value, false)}>
                    <SelectTrigger className="bg-white border-slate-300"><SelectValue placeholder="Select role" /></SelectTrigger>
                    <SelectContent>
                      {ROLE_OPTIONS.map((roleOption) => (
                        <SelectItem key={roleOption.value} value={roleOption.value}>
                          {roleOption.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {addFormIsFieldOfficer && (
                <div className="space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="add-county" className="text-sm font-medium text-slate-700">County *</Label>
                      <Select
                        value={addSelectedCountyValue}
                        onValueChange={(value) => handleLocationFieldChange("county", value, false)}
                        disabled={kenyaAreasLoading || addCountyOptions.length === 0}
                      >
                        <SelectTrigger id="add-county" className="bg-white border-slate-300">
                          <SelectValue
                            placeholder={
                              kenyaAreasLoading
                                ? "Loading counties..."
                                : addCountyOptions.length === 0
                                  ? "No counties available"
                                  : "Select county"
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {addCountyOptions.map((county) => (
                            <SelectItem key={county} value={county}>
                              {county}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="add-subcounty" className="text-sm font-medium text-slate-700">Sub County *</Label>
                      <Select
                        value={addSelectedSubcountyValue}
                        onValueChange={(value) => handleLocationFieldChange("subcounty", value, false)}
                        disabled={kenyaAreasLoading || !addForm.county || addSubcountyOptions.length === 0}
                      >
                        <SelectTrigger id="add-subcounty" className="bg-white border-slate-300">
                          <SelectValue
                            placeholder={
                              kenyaAreasLoading
                                ? "Loading sub counties..."
                                : !addForm.county
                                  ? "Select county first"
                                  : addSubcountyOptions.length === 0
                                    ? "No sub counties available"
                                    : "Select sub county"
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {addSubcountyOptions.map((subcounty) => (
                            <SelectItem key={subcounty} value={subcounty}>
                              {subcounty}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {kenyaAreasError ? (
                    <p className="text-xs text-red-600">{kenyaAreasError}</p>
                  ) : null}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="add-password" className="text-sm font-medium text-slate-700">Password *</Label>
                  <Input id="add-password" type="password" value={addForm.password} onChange={(e) => setAddForm(prev => ({ ...prev, password: e.target.value }))} className="bg-white border-slate-300" placeholder="Enter password" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="add-confirm-password" className="text-sm font-medium text-slate-700">Confirm Password *</Label>
                  <Input id="add-confirm-password" type="password" value={addForm.confirmPassword} onChange={(e) => setAddForm(prev => ({ ...prev, confirmPassword: e.target.value }))} className="bg-white border-slate-300" placeholder="Confirm password" />
                </div>
              </div>

              <div className="space-y-3 border-t pt-4">
                <Label className="text-sm font-bold text-slate-700">Allowed Programmes (Data Access)</Label>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {AVAILABLE_PROGRAMMES.map((prog) => (
                    <div key={prog} className="flex items-center space-x-2 border p-2 rounded-md hover:bg-slate-50">
                      <Checkbox
                        id={`add-prog-${prog}`}
                        checked={!!addForm.allowedProgrammes[prog]}
                        onCheckedChange={() => toggleProgramme(prog, false)}
                      />
                      <label
                        htmlFor={`add-prog-${prog}`}
                        className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                      >
                        {prog}
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsAddDialogOpen(false)} className="border-slate-300">Cancel</Button>
              <Button onClick={handleAddUser} disabled={addLoading} className="bg-gradient-to-r from-green-500 to-blue-600 hover:from-green-600 hover:to-blue-700 text-white">
                {addLoading ? "Creating..." : "Create User"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
       )} 

      {/* Edit Dialog */}
      {userIsAdmin && (
        <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
          <DialogContent className="sm:max-w-2xl bg-white rounded-2xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-slate-900">
                <Edit className="h-5 w-5 text-blue-600" />
                Edit User
              </DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4 max-h-[70vh] overflow-y-auto">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-name" className="text-sm font-medium text-slate-700">Name</Label>
                  <Input id="edit-name" value={editForm.name} onChange={(e) => setEditForm(prev => ({ ...prev, name: e.target.value }))} className="bg-white border-slate-300" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-email" className="text-sm font-medium text-slate-700">Email</Label>
                  <Input id="edit-email" value={editForm.email} onChange={(e) => setEditForm(prev => ({ ...prev, email: e.target.value }))} className="bg-white border-slate-300" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-phone" className="text-sm font-medium text-slate-700">Phone Number</Label>
                  <Input id="edit-phone" type="tel" value={editForm.phoneNumber} onChange={(e) => setEditForm(prev => ({ ...prev, phoneNumber: e.target.value }))} className="bg-white border-slate-300" />
                </div>
              </div>              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-role" className="text-sm font-medium text-slate-700">Role</Label>
                  <Select value={editForm.role} onValueChange={(value) => handleRoleFormChange(value, true)}>
                    <SelectTrigger className="bg-white border-slate-300"><SelectValue placeholder="Select role" /></SelectTrigger>
                    <SelectContent>
                      {ROLE_OPTIONS.map((roleOption) => (
                        <SelectItem key={roleOption.value} value={roleOption.value}>
                          {roleOption.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-status" className="text-sm font-medium text-slate-700">Status</Label>
                  <Select value={editForm.status} onValueChange={(value) => setEditForm(prev => ({ ...prev, status: value }))}>
                    <SelectTrigger className="bg-white border-slate-300"><SelectValue placeholder="Select status" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="inactive">Inactive</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {editFormIsFieldOfficer && (
                <div className="space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="edit-county" className="text-sm font-medium text-slate-700">County *</Label>
                      <Select
                        value={editSelectedCountyValue}
                        onValueChange={(value) => handleLocationFieldChange("county", value, true)}
                        disabled={kenyaAreasLoading || editCountyOptions.length === 0}
                      >
                        <SelectTrigger id="edit-county" className="bg-white border-slate-300">
                          <SelectValue
                            placeholder={
                              kenyaAreasLoading
                                ? "Loading counties..."
                                : editCountyOptions.length === 0
                                  ? "No counties available"
                                  : "Select county"
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {editCountyOptions.map((county) => (
                            <SelectItem key={county} value={county}>
                              {county}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-subcounty" className="text-sm font-medium text-slate-700">Sub County *</Label>
                      <Select
                        value={editSelectedSubcountyValue}
                        onValueChange={(value) => handleLocationFieldChange("subcounty", value, true)}
                        disabled={kenyaAreasLoading || !editForm.county || editSubcountyOptions.length === 0}
                      >
                        <SelectTrigger id="edit-subcounty" className="bg-white border-slate-300">
                          <SelectValue
                            placeholder={
                              kenyaAreasLoading
                                ? "Loading sub counties..."
                                : !editForm.county
                                  ? "Select county first"
                                  : editSubcountyOptions.length === 0
                                    ? "No sub counties available"
                                    : "Select sub county"
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {editSubcountyOptions.map((subcounty) => (
                            <SelectItem key={subcounty} value={subcounty}>
                              {subcounty}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {kenyaAreasError ? (
                    <p className="text-xs text-red-600">{kenyaAreasError}</p>
                  ) : null}
                </div>
              )}

              <div className="space-y-3 border-t pt-4">
                <Label className="text-sm font-bold text-slate-700">Allowed Programmes (Data Access)</Label>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {AVAILABLE_PROGRAMMES.map((prog) => (
                    <div key={prog} className="flex items-center space-x-2 border p-2 rounded-md hover:bg-slate-50">
                      <Checkbox
                        id={`edit-prog-${prog}`}
                        checked={!!editForm.allowedProgrammes[prog]}
                        onCheckedChange={() => toggleProgramme(prog, true)}
                      />
                      <label
                        htmlFor={`edit-prog-${prog}`}
                        className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                      >
                        {prog}
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsEditDialogOpen(false)} className="border-slate-300">Cancel</Button>
              <Button onClick={handleEditSubmit} className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white">
                Save Changes
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Single Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent className="bg-white">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="h-5 w-5" />
              Delete User
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete user <strong>"{recordToDelete?.name}"</strong>? 
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteSingle} disabled={deleteLoading} className="bg-red-600 hover:bg-red-700 text-white">
              {deleteLoading ? "Deleting..." : "Delete User"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Delete Confirmation Dialog */}
      <AlertDialog open={isBulkDeleteDialogOpen} onOpenChange={setIsBulkDeleteDialogOpen}>
        <AlertDialogContent className="bg-white">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="h-5 w-5" />
              Delete Multiple Users
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{selectedRecords.length} users</strong>? 
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteSelected} disabled={deleteLoading} className="bg-red-600 hover:bg-red-700 text-white">
              {deleteLoading ? "Deleting..." : `Delete ${selectedRecords.length} Users`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default UserManagementPage;


