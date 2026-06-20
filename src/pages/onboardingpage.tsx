import { useState, useEffect, useCallback, useMemo } from "react";
import { db, ref, get, push, update, remove, set, query as dbQuery, orderByChild, equalTo } from "@/lib/firebase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollableFilterBar } from "@/components/ScrollableFilterBar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { 
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription 
} from "@/components/ui/dialog";
import { 
  Tabs, TabsContent, TabsList, TabsTrigger 
} from "@/components/ui/tabs";
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { 
  Download, Users, Edit, Trash2, GraduationCap, Eye, MapPin, Upload, Plus, 
  Calendar, X, UserPlus, User, Phone, Map as MapIcon, FileText, MessageSquare, BookOpen, 
  Heart, Zap, Target, Leaf, Shield, CheckCircle, Clock, ChevronLeft, ChevronRight 
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useSharedProgrammeSelection } from "@/hooks/use-shared-programme-selection";
import * as XLSX from 'xlsx';
import { canViewAllProgrammes, isAdmin } from "@/contexts/authhelper";
import { cacheKey, readCachedValue, removeCachedValue, writeCachedValue } from "@/lib/data-cache";
import {
  normalizeProgramme,
  resolveAccessibleProgrammes,
  type ProgrammeOption,
} from "@/lib/programme-access";

// --- Constants ---
const COLLECTION_NAME = "Onboarding";
const CARDS_PER_PAGE = 3;

// --- Interfaces ---
interface FarmerData {
  name: string;
  idNo: string;
  phoneNo: string;
  subcounty: string;
  location: string; // Replaced region with location
  gender: string;
  county: string;
}

interface StaffData {
  name: string;
  role: string;
}

interface OnboardingData {
  id?: string;
  date: Date;
  topic: string;
  comment: string;
  staff: StaffData[];
  farmers: FarmerData[];
  programme: ProgrammeOption; 
  createdAt?: Date;
  status: 'pending' | 'completed';
}

interface Filters {
  startDate: string;
  endDate: string;
}

interface Stats {
  totalFarmers: number;
  totalOnboarding: number;
  uniqueSubcounties: number;
  completedSessions: number;
  pendingSessions: number;
  maleFarmers: number;
  femaleFarmers: number;
  uniqueCounties: number;
}

const normalizeOnboardingRecord = (record: Partial<OnboardingData>): OnboardingData => ({
  id: record.id || "",
  date: record.date ? new Date(record.date) : new Date(),
  topic: record.topic || "",
  comment: record.comment || "",
  staff: Array.isArray(record.staff) ? record.staff : [],
  farmers: Array.isArray(record.farmers) ? record.farmers : [],
  programme: normalizeProgramme(record.programme) || "KPMD",
  createdAt: record.createdAt ? new Date(record.createdAt) : undefined,
  status: record.status === "completed" ? "completed" : "pending",
});

const getOnboardingTimestamp = (record: Partial<OnboardingData> | null | undefined): number => {
  if (!record) return 0;
  const dateValue = record.date ? new Date(record.date).getTime() : 0;
  if (Number.isFinite(dateValue) && dateValue > 0) return dateValue;
  const createdAtValue = record.createdAt ? new Date(record.createdAt).getTime() : 0;
  return Number.isFinite(createdAtValue) ? createdAtValue : 0;
};

const sortOnboardingByLatest = (records: OnboardingData[]): OnboardingData[] =>
  [...records].sort((a, b) => getOnboardingTimestamp(b) - getOnboardingTimestamp(a));

// --- Utility Functions ---

const getTopicIcon = (topic: string) => {
  const topicLower = topic.toLowerCase();
  
  if (topicLower.includes('health') || topicLower.includes('medical') || topicLower.includes('vaccin')) {
    return <Heart className="h-5 w-5 text-red-500" />;
  } else if (topicLower.includes('breed') || topicLower.includes('genetic') || topicLower.includes('reproduction')) {
    return <Leaf className="h-5 w-5 text-green-500" />;
  } else if (topicLower.includes('feed') || topicLower.includes('nutrition') || topicLower.includes('diet')) {
    return <Zap className="h-5 w-5 text-yellow-500" />;
  } else if (topicLower.includes('market') || topicLower.includes('business') || topicLower.includes('economic')) {
    return <Target className="h-5 w-5 text-blue-500" />;
  } else if (topicLower.includes('safety') || topicLower.includes('security') || topicLower.includes('protection')) {
    return <Shield className="h-5 w-5 text-purple-500" />;
  } else {
    return <BookOpen className="h-5 w-5 text-gray-500" />;
  }
};

const getStatusBadge = (status: 'pending' | 'completed') => {
  if (status === 'completed') {
    return (
      <Badge className="bg-green-100 text-green-800 hover:bg-green-100">
        <CheckCircle className="h-3 w-3 mr-1" />
        Completed
      </Badge>
    );
  } else {
    return (
      <Badge variant="outline" className="text-yellow-600 border-yellow-300">
        <Clock className="h-3 w-3 mr-1" />
        Pending
      </Badge>
    );
  }
};

// --- Components ---

interface StatsCardProps {
  title: string;
  value: number;
  icon: any;
  description?: any; 
}

const StatsCard = ({ title, value, icon: Icon, description }: StatsCardProps) => (
  <Card className="bg-white text-slate-900 shadow-lg border border-gray-200 relative overflow-hidden">
    <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-blue-500 to-purple-600"></div>
    
    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 pt-4 pl-6">
      <CardTitle className="text-sm font-medium text-gray-400">{title}</CardTitle>
    </CardHeader>
    <CardContent className="pl-6 pb-4 flex flex-row">
      <div className="mr-2 rounded-full">
        <Icon className="h-8 w-8 text-blue-600" />
      </div>
      <div className="flex-1">
        <div className="text-2xl font-bold text-green-500 mb-1">{value}</div>
        {description && (
          <div className="text-xs bg-orange-50 px-2 py-1 rounded-md border border-slate-100">
            {description}
          </div>
        )}
      </div>
    </CardContent>
  </Card>
);

interface OnboardingCardProps {
  record: OnboardingData;
  isSelected: boolean;
  userIsAdmin: boolean;
  onSelectRecord: (id: string) => void;
  onView: (record: OnboardingData) => void;
  onEdit: (record: OnboardingData) => void;
  onDeleteClick: (record: OnboardingData) => void;
}

const OnboardingCard = ({ 
  record, 
  isSelected, 
  userIsAdmin, 
  onSelectRecord, 
  onView, 
  onEdit, 
  onDeleteClick 
}: OnboardingCardProps) => {
  const uniqueLocations = useMemo(() => {
    const locations = record.farmers.map(farmer => farmer.location).filter(Boolean);
    return [...new Set(locations)];
  }, [record.farmers]);

  const uniqueCounties = useMemo(() => {
     const counties = record.farmers.map(farmer => farmer.county).filter(Boolean);
     return [...new Set(counties)];
  }, [record.farmers]);

  const genderStats = useMemo(() => {
    const maleCount = record.farmers.filter(f => f.gender?.toLowerCase() === 'male').length;
    const femaleCount = record.farmers.filter(f => f.gender?.toLowerCase() === 'female').length;
    return { maleCount, femaleCount };
  }, [record.farmers]);

  return (
    <Card className={`bg-white shadow-lg border border-gray-200 hover:shadow-xl transition-all duration-300 ${
      isSelected ? 'ring-2 ring-blue-500 border-blue-500' : ''
    }`}>
      <CardHeader className="pb-3">
        <div className="flex justify-between items-start">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              {getTopicIcon(record.topic)}
              <CardTitle className="text-md font-bold text-gray-800">{record.topic}</CardTitle>
            </div>
            <div className="flex items-center justify-between mt-2">
            
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Calendar className="h-4 w-4" />
                <span>{record.date.toLocaleDateString()}</span>
              </div>
              {getStatusBadge(record.status)}
            </div>
          </div>
          {userIsAdmin && (
            <div className="flex items-center">
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => record.id && onSelectRecord(record.id)}
                className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              />
            </div>
          )}
        </div>
      </CardHeader>
      
      <CardContent className="space-y-4">
        {record.comment && (
          <div className="pt-2 border-t">
            <div className="flex items-start gap-2 text-sm text-gray-700 bg-gray-50 p-3 rounded-lg border">
              <MessageSquare className="h-4 w-4 text-blue-500 mt-0.5 flex-shrink-0" />
              <div>
                <span className="font-medium text-gray-600">Comments:</span>
                <p className="mt-1 text-gray-800">{record.comment}</p>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 pt-2 border-t">
          <div className="flex justify-between m-2 p-1">
            <div className="flex items-center gap-2 text-sm font-medium text-blue-700">
              <User className="h-4 w-4" />
              <span>Trainers</span>
            </div>
            <div className="text-md text-blue-800">{record.staff.length}</div>
          </div>
          <div className="flex justify-between m-2 p-1">
            <div className="flex items-center gap-2 text-sm font-medium text-green-700">
              <Users className="h-4 w-4" />
              <span>Farmers</span>
            </div>
            <div className="text-md text-green-800">{record.farmers.length}</div>
          </div>
        </div>

        <div className="pt-2 border-t space-y-2">
           <div className="flex justify-between m-2 p-1">
            <div className="flex items-center gap-1 text-xs text-gray-600">
              <MapPin className="h-3 w-3" />
              <span>County</span>
            </div>
            <div className="text-sm font-semibold text-blue-600">
              {uniqueCounties.length > 0 ? (
                 <span>{uniqueCounties[0]}{uniqueCounties.length > 1 ? ` (+${uniqueCounties.length - 1})` : ''}</span>
              ) : <span className="text-gray-400">N/A</span>}
            </div>
          </div>
          <div className="flex justify-between m-2 p-1">
            <div className="flex items-center gap-1 text-xs text-gray-600">
              <MapPin className="h-3 w-3" />
              <span>Location</span>
            </div>
            <div className="text-sm font-semibold text-green-600">
              {uniqueLocations.length > 0 ? (
                <div className="flex flex-wrap gap-1 justify-end">
                  {uniqueLocations.slice(0, 2).map((loc, i) => (
                    <Badge key={i} variant="secondary" className="text-xs">{loc}</Badge>
                  ))}
                  {uniqueLocations.length > 2 && (
                    <Badge variant="outline" className="text-xs">+{uniqueLocations.length - 2} more</Badge>
                  )}
                </div>
              ) : (
                <span className="text-gray-400">No locations</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex gap-2 pt-3 border-t">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 h-8 text-xs hover:bg-blue-50 hover:text-blue-600 border-blue-200"
            onClick={() => onView(record)}
          >
            <Eye className="h-3 w-3 mr-1" />
            View Details
          </Button>
          {userIsAdmin && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0 hover:bg-green-50 hover:text-green-600 border-green-200"
                onClick={() => onEdit(record)}
              >
                <Edit className="h-3 w-3 text-green-500" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0 hover:bg-red-50 hover:text-red-600 border-red-200"
                onClick={() => onDeleteClick(record)}
              >
                <Trash2 className="h-3 w-3 text-red-500" />
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

// --- Main Page Component ---

const OnboardingPage = () => {
  const { user, userRole, userAttribute, allowedProgrammes } = useAuth();
  const { toast } = useToast();

  // --- Programme State (Mimicking CapacityBuildingPage) ---
  const [allOnboarding, setAllOnboarding] = useState<OnboardingData[]>([]);
  const [filteredOnboarding, setFilteredOnboarding] = useState<OnboardingData[]>([]);
  const [displayedOnboarding, setDisplayedOnboarding] = useState<OnboardingData[]>([]);

  const [onboardingForm, setOnboardingForm] = useState({
    id: "",
    topic: "",
    comment: "",
    date: "",
    status: 'pending' as 'pending' | 'completed',
    programme: "" as ProgrammeOption | "",
  });
  const [staff, setStaff] = useState<StaffData[]>([{ name: "", role: "" }]);
  const [farmers, setFarmers] = useState<FarmerData[]>([
    { name: "", idNo: "", phoneNo: "", subcounty: "", location: "", gender: "", county: "" } 
  ]);
  
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isBulkDeleteDialogOpen, setIsBulkDeleteDialogOpen] = useState(false);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  
  const [selectedRecord, setSelectedRecord] = useState<OnboardingData | null>(null);
  const [selectedRecords, setSelectedRecords] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);

  const userIsAdmin = useMemo(() => isAdmin(userRole), [userRole]);
  const userCanViewAllProgrammeData = useMemo(
    () => canViewAllProgrammes(userRole, userAttribute, allowedProgrammes),
    [allowedProgrammes, userRole, userAttribute]
  );
  const accessibleProgrammes = useMemo(
    () => resolveAccessibleProgrammes(userCanViewAllProgrammeData, allowedProgrammes),
    [allowedProgrammes, userCanViewAllProgrammeData]
  );
  const [activeProgram, setActiveProgram] = useSharedProgrammeSelection(accessibleProgrammes);
  const onboardingCacheKey = useMemo(
    () => cacheKey("admin-page", "onboarding", user?.uid || "anonymous", activeProgram || "none"),
    [activeProgram, user?.uid]
  );
  const availablePrograms = accessibleProgrammes;
  const resolveAssignableProgramme = useCallback(
    (programme?: string): ProgrammeOption | "" => {
      const normalizedProgramme = normalizeProgramme(programme);
      if (normalizedProgramme && availablePrograms.includes(normalizedProgramme)) {
        return normalizedProgramme;
      }

      return (availablePrograms[0] as ProgrammeOption | undefined) || "";
    },
    [availablePrograms],
  );
  const requireAdmin = () => {
    if (userIsAdmin) return true;
    toast({
      title: "Access denied",
      description: "Only Admin can create, edit, or delete records on this page.",
      variant: "destructive",
    });
    return false;
  };

  const [filters, setFilters] = useState<Filters>({
    startDate: "",
    endDate: "",
  });

  const [stats, setStats] = useState<Stats>({
    totalFarmers: 0,
    totalOnboarding: 0,
    uniqueSubcounties: 0,
    completedSessions: 0,
    pendingSessions: 0,
    maleFarmers: 0,
    femaleFarmers: 0,
    uniqueCounties: 0
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

  const currentMonth = useMemo(getCurrentMonthDates, []);

  useEffect(() => {
    setOnboardingForm((prev) => {
      const programme = resolveAssignableProgramme(prev.programme || activeProgram);
      return programme === prev.programme ? prev : { ...prev, programme };
    });
  }, [activeProgram, resolveAssignableProgramme]);

  const readExcelFile = (file: File): Promise<any[]> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target?.result as ArrayBuffer);
          const workbook = XLSX.read(data, { type: 'array' });
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          const jsonData = XLSX.utils.sheet_to_json(worksheet);
          resolve(jsonData);
        } catch (error) {
          reject(error);
        }
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  };

  const fetchOnboardingData = async () => {
    try {
      if (!activeProgram) {
        setAllOnboarding([]);
        setFilteredOnboarding([]);
        setDisplayedOnboarding([]);
        setLoading(false);
        return;
      }

      const cachedOnboarding = readCachedValue<OnboardingData[]>(onboardingCacheKey);
      if (cachedOnboarding) {
        const normalizedCachedOnboarding = cachedOnboarding.map(normalizeOnboardingRecord);
        setAllOnboarding(sortOnboardingByLatest(normalizedCachedOnboarding));
        setLoading(false);
      } else {
        setLoading(true);
      }
      const dbRef = ref(db, COLLECTION_NAME);
      const [programmeSnapshot, legacyProgrammeSnapshot] = await Promise.all([
        get(dbQuery(dbRef, orderByChild("programme"), equalTo(activeProgram))),
        get(dbQuery(dbRef, orderByChild("Programme"), equalTo(activeProgram))),
      ]);
      
      const dataById = new Map<string, OnboardingData>();
      
      const appendSnapshotRecords = (snapshot: typeof programmeSnapshot) => {
        if (!snapshot.exists()) return;

        snapshot.forEach((childSnapshot) => {
          const docData = childSnapshot.val();
          const record = {
            id: childSnapshot.key,
            date: docData.date ? new Date(docData.date) : new Date(),
            topic: docData.topic || "",
            comment: docData.comment || "",
            staff: docData.staff || [],
            farmers: docData.farmers || [],
            programme: normalizeProgramme(docData.programme || docData.Programme || activeProgram) || "KPMD",
            createdAt: docData.createdAt ? new Date(docData.createdAt) : new Date(),
            status: docData.status || 'pending'
          };

          if (childSnapshot.key && (userCanViewAllProgrammeData || availablePrograms.includes(record.programme))) {
            dataById.set(childSnapshot.key, record);
          }
        });
      };

      appendSnapshotRecords(programmeSnapshot);
      appendSnapshotRecords(legacyProgrammeSnapshot);
      
      const data = Array.from(dataById.values());
      const sortedData = sortOnboardingByLatest(data);
      setAllOnboarding(sortedData);
      writeCachedValue(onboardingCacheKey, sortedData);
      // FilteredOnboarding will be updated by the programme filter effect
      setSelectedRecords([]);
      if (data.length === 0) {
        removeCachedValue(onboardingCacheKey);
      }
    } catch (error) {
      console.error("Error fetching onboarding data:", error);
      toast({
        title: "Error",
        description: "Failed to fetch onboarding data",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!userRole) {
      setAllOnboarding([]);
      setFilteredOnboarding([]);
      setDisplayedOnboarding([]);
      setLoading(false);
      return;
    }

    if (!userCanViewAllProgrammeData && availablePrograms.length === 0) {
      setAllOnboarding([]);
      setFilteredOnboarding([]);
      setDisplayedOnboarding([]);
      setLoading(false);
      return;
    }

    fetchOnboardingData();
  }, [userRole, userCanViewAllProgrammeData, availablePrograms, activeProgram]); // Re-fetch when access scope is resolved

  // --- Filtering Logic including Programme Switcher ---
  const filterAndProcessData = useCallback((data: OnboardingData[], filterParams: Filters, program: string) => {
    const filtered = data.filter(record => {
      // 1. Filter by Active Programme
      if (program && record.programme !== program) return false;

      // 2. Filter by Date
      if (filterParams.startDate || filterParams.endDate) {
        const recordDate = new Date(record.date);
        recordDate.setHours(0, 0, 0, 0);

        const startDate = filterParams.startDate ? new Date(filterParams.startDate) : null;
        const endDate = filterParams.endDate ? new Date(filterParams.endDate) : null;
        if (startDate) startDate.setHours(0, 0, 0, 0);
        if (endDate) endDate.setHours(23, 59, 59, 999);

        if (startDate && recordDate < startDate) return false;
        if (endDate && recordDate > endDate) return false;
      }
      return true;
    });

    const allFarmers = filtered.flatMap(record => record.farmers);
    const uniqueFarmers = new Set(allFarmers.map(f => f.idNo || f.name));
    const uniqueSubcounties = new Set(allFarmers.map(f => f.subcounty).filter(Boolean));
    const uniqueCounties = new Set(allFarmers.map(f => f.county).filter(Boolean));
    const completedSessions = filtered.filter(r => r.status === 'completed').length;
    const pendingSessions = filtered.filter(r => r.status === 'pending').length;
    
    const maleFarmers = allFarmers.filter(f => f.gender?.toLowerCase() === 'male').length;
    const femaleFarmers = allFarmers.filter(f => f.gender?.toLowerCase() === 'female').length;

    const sortedFiltered = sortOnboardingByLatest(filtered);

    return {
      filteredOnboarding: sortedFiltered,
      stats: {
        totalFarmers: uniqueFarmers.size,
        totalOnboarding: sortedFiltered.length,
        uniqueSubcounties: uniqueSubcounties.size,
        uniqueCounties: uniqueCounties.size,
        completedSessions,
        pendingSessions,
        maleFarmers,
        femaleFarmers
      }
    };
  }, []);

  useEffect(() => {
    if (allOnboarding.length === 0) return;
    const result = filterAndProcessData(allOnboarding, filters, activeProgram);
    setFilteredOnboarding(result.filteredOnboarding);
    setStats(result.stats);
    setCurrentPage(1);
  }, [allOnboarding, filters, activeProgram, filterAndProcessData]);

  useEffect(() => {
    const startIndex = (currentPage - 1) * CARDS_PER_PAGE;
    const endIndex = startIndex + CARDS_PER_PAGE;
    setDisplayedOnboarding(filteredOnboarding.slice(startIndex, endIndex));
  }, [filteredOnboarding, currentPage]);

  const totalPages = Math.ceil(filteredOnboarding.length / CARDS_PER_PAGE);
  const hasNextPage = currentPage < totalPages;
  const hasPrevPage = currentPage > 1;

  const handleProgramChange = (program: string) => {
    setActiveProgram(program);
    setFilters(prev => ({ ...prev, ...currentMonth })); // Reset date filters like reference
    setSelectedRecords([]);
  };

  const handleSelectRecord = (recordId: string) => {
    setSelectedRecords(prev => 
      prev.includes(recordId) ? prev.filter(id => id !== recordId) : [...prev, recordId]
    );
  };

  const handleSelectAllOnPage = () => {
    const pageRecordIds = displayedOnboarding
      .filter(r => r.id)
      .map(r => r.id!) as string[];
    
    if (selectedRecords.length === pageRecordIds.length) {
      setSelectedRecords([]);
    } else {
      setSelectedRecords(pageRecordIds);
    }
  };

  const handleViewDetails = (record: OnboardingData) => {
    setSelectedRecord(record);
    setIsViewDialogOpen(true);
  };

  const handleBulkDelete = async () => {
    if (!requireAdmin()) return;
    if (selectedRecords.length === 0) return;
    try {
      setLoading(true);
      const deletePromises = selectedRecords.map(id => remove(ref(db, `${COLLECTION_NAME}/${id}`)));
      
      await Promise.all(deletePromises);
      removeCachedValue(onboardingCacheKey);
      
      toast({ title: "Success", description: `Successfully deleted ${selectedRecords.length} records` });
      setIsBulkDeleteDialogOpen(false);
      setSelectedRecords([]);
      fetchOnboardingData();
    } catch (error) {
      console.error("Error deleting records:", error);
      toast({ title: "Error", description: "Failed to delete records", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleAddOnboarding = async () => {
    if (!requireAdmin()) return;
    try {
      const selectedProgramme = resolveAssignableProgramme(onboardingForm.programme);
      if (!onboardingForm.topic || !onboardingForm.date || !selectedProgramme) {
        toast({ title: "Validation Error", description: "Please fill required fields including an assigned programme", variant: "destructive" });
        return;
      }

      const validStaff = staff.filter(s => s.name.trim() !== "");
      const validFarmers = farmers.filter(f => f.name.trim() !== "");

      if (validStaff.length === 0 || validFarmers.length === 0) {
        toast({ title: "Validation Error", description: "Add at least one staff and one farmer", variant: "destructive" });
        return;
      }

      setLoading(true);
      
      const data = {
        ...onboardingForm,
        programme: selectedProgramme,
        date: new Date(onboardingForm.date).toISOString(),
        staff: validStaff,
        farmers: validFarmers,
        createdAt: new Date().toISOString()
      };

      if (onboardingForm.id) {
        await update(ref(db, `${COLLECTION_NAME}/${onboardingForm.id}`), {
            ...data,
            updatedAt: new Date().toISOString()
        });
        toast({ title: "Success", description: "Record updated successfully" });
      } else {
        await push(ref(db, COLLECTION_NAME), data);
        toast({ title: "Success", description: "Record added successfully" });
      }

      removeCachedValue(onboardingCacheKey);
      resetForm();
      setIsDialogOpen(false);
      fetchOnboardingData();
    } catch (error) {
      console.error("Error saving record:", error);
      toast({ title: "Error", description: "Failed to save record", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    // Default to active program when opening new form
    const defaultProg = resolveAssignableProgramme(activeProgram);
    
    setOnboardingForm({ id: "", topic: "", comment: "", date: "", status: 'pending', programme: defaultProg });
    setStaff([{ name: "", role: "" }]);
    setFarmers([{ name: "", idNo: "", phoneNo: "", subcounty: "", location: "", gender: "", county: "" }]);
  };

  const handleDeleteConfirm = async () => {
    if (!requireAdmin()) return;
    if (!selectedRecord?.id) return;
    try {
      setLoading(true);
      await remove(ref(db, `${COLLECTION_NAME}/${selectedRecord.id}`));
      removeCachedValue(onboardingCacheKey);
      toast({ title: "Success", description: "Record deleted successfully" });
      setIsDeleteDialogOpen(false);
      setSelectedRecord(null);
      fetchOnboardingData();
    } catch (error) {
      console.error("Error deleting:", error);
      toast({ title: "Error", description: "Failed to delete record", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleExcelUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setLoading(true);
      const data = await readExcelFile(file);
      const validatedFarmers = validateExcelData(data);
      if (validatedFarmers.length === 0) {
        toast({ title: "No valid data", description: "Incorrect Excel format", variant: "destructive" });
        return;
      }
      setFarmers(prev => [...prev.filter(f => f.name.trim() !== ""), ...validatedFarmers]);
      toast({ title: "Success", description: `Loaded ${validatedFarmers.length} farmers` });
      setIsUploadDialogOpen(false);
      event.target.value = ""; // Reset input
    } catch (error) {
      console.error("Error uploading Excel:", error);
      toast({ title: "Upload Failed", description: "Failed to process file", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const validateExcelData = (data: any[]): FarmerData[] => {
    return data.filter(item => item.name).map(item => ({
      name: item.name || "",
      gender: item.gender || item.Gender || "",
      idNo: item.idNo || item.idNumber || item.farmeridNo || "",
      phoneNo: item.phoneNo || item.phoneNumber || item.farmerphoneNo || "",
      subcounty: item.subcounty || "",
      location: item.location || item.Location || item.farmerLocation || "",
      county: item.county || item.County || ""
    }));
  };

  const downloadTemplate = () => {
    const templateData = [{
      name: "Farmer Name",
      gender: "Gender (Male/Female)",
      idNo: "ID Number",
      phoneNo: "Phone Number",
      county: "County",
      subcounty: "Subcounty",
      location: "Location"
    }];
    const ws = XLSX.utils.json_to_sheet(templateData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Farmers Template");
    XLSX.writeFile(wb, "farmers_template.xlsx");
  };

  const handleExport = async () => {
    try {
      setExportLoading(true);
      if (filteredOnboarding.length === 0) {
        toast({ title: "No Data", description: "No records to export", variant: "destructive" });
        return;
      }

      const exportData = filteredOnboarding.flatMap(record => 
        record.farmers.map(farmer => ({
          Programme: record.programme,
          Date: record.date.toLocaleDateString(),
          Topic: record.topic,
          Comment: record.comment || 'N/A',
          Status: record.status,
          'Staff Members': record.staff.map(s => `${s.name} (${s.role})`).join(', '),
          'Farmer Name': farmer.name,
          'Farmer Gender': farmer.gender || 'N/A',
          'Farmer ID': farmer.idNo,
          'Phone Number': farmer.phoneNo,
          County: farmer.county || 'N/A',
          Subcounty: farmer.subcounty || 'N/A',
          Location: farmer.location || 'N/A',
          'Created Date': record.createdAt?.toLocaleDateString() || 'N/A'
        }))
      );

      const ws = XLSX.utils.json_to_sheet(exportData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Onboarding Data");
      XLSX.writeFile(wb, `onboarding_data_${activeProgram}_${new Date().toISOString().split('T')[0]}.xlsx`);
      toast({ title: "Export Successful", description: `Exported ${exportData.length} records` });
    } catch (error) {
      console.error("Export error:", error);
      toast({ title: "Export Failed", description: "Failed to export data", variant: "destructive" });
    } finally {
      setExportLoading(false);
    }
  };

  const clearAllFilters = () => setFilters({ startDate: "", endDate: "" });
  const resetToCurrentMonth = () => setFilters(prev => ({ ...prev, ...currentMonth }));

  // Calculate percentages for display
  const totalGendered = stats.maleFarmers + stats.femaleFarmers;
  const malePercent = totalGendered > 0 ? Math.round((stats.maleFarmers / totalGendered) * 100) : 0;
  const femalePercent = totalGendered > 0 ? Math.round((stats.femaleFarmers / totalGendered) * 100) : 0;

  return (
    <div className="w-full p-4 sm:p-6 space-y-6">
      {/* --- Header with Programme Switcher --- */}
      <div className="grid grid-cols-1 justify-between items-start md:items-center gap-1">
        <div className="flex flex-row gap-1 items-center">
          
          <h2 className="text-xs ">Additional Training</h2>
             <p className="bg-blue-50 text-[10px] text-blue-700 border-blue-200 font-bold w-fit">
                {activeProgram || "No Access"} PROJECT
             </p>
         
        </div>

        <div className="flex flex-col md:flex-row lg:flex-row">
          <div className="flex flex-row justify-between p-1 gap-8">
          {userIsAdmin && selectedRecords.length > 0 && (
            <Button variant="destructive" onClick={() => setIsBulkDeleteDialogOpen(true)}>
              <Trash2 className="w-4 h-4 mr-2" /> Delete Selected ({selectedRecords.length})
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={clearAllFilters}>Clear Filters</Button>
          <Button variant="outline" size="sm" onClick={resetToCurrentMonth}>This Month</Button>
           {/* Programme Selector - Visible to Admin or if user has multiple programmes */}
          {userIsAdmin && (
             <div className="flex justify-end">
                <Select value={activeProgram} onValueChange={handleProgramChange}>
                    <SelectTrigger className="w-full sm:w-[200px] border-gray-300 focus:border-blue-500 bg-white">
                        <SelectValue placeholder="Select Programme" />
                    </SelectTrigger>
                    <SelectContent>
                        {availablePrograms.map(p => (
                            <SelectItem key={p} value={p}>{p}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
             </div>
          )}
          </div>
<div className="flex flex-row justify-between p-1 gap-8">
          {userIsAdmin && (
             <Button onClick={handleExport} disabled={exportLoading || filteredOnboarding.length === 0}>
              <Download className="w-4 h-4 mr-2" />
              {exportLoading ? "Exporting..." : `Export (${filteredOnboarding.flatMap(r => r.farmers).length})`}
            </Button>
          )}
          
         
          {userIsAdmin && (
            <Button onClick={() => { resetForm(); setIsDialogOpen(true); }}>
              <Plus className="w-4 h-4 mr-2" /> Add Training
            </Button>
          )}
          </div>
       </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatsCard 
          title="TOTAL FARMERS" 
          value={totalGendered} 
          icon={Users} 
          description={
           <div className="flex items-center gap-1 whitespace-nowrap text-xs">
              <User className="h-3 w-3" />
              <span>Male {stats.maleFarmers} ({malePercent}%)</span>
              <span>|</span>
              <span>Female {stats.femaleFarmers} ({femalePercent}%)</span>
            </div>
          } 
        />
        <StatsCard title="TRAINING SESSIONS" value={stats.totalOnboarding} icon={GraduationCap} description={`${stats.completedSessions} completed, ${stats.pendingSessions} pending`} />
        {/* <StatsCard title="SUBCOUNTIES COVERED" value={stats.uniqueSubcounties} icon={MapPin} description="Unique subcounties reached" /> */}
        <StatsCard title="COUNTIES COVERED" value={stats.uniqueCounties} icon={MapIcon} description="Unique counties reached" />
      </div>

      {/* Date Filters Card */}
      <Card className="shadow-lg border-0 bg-white">
        <CardContent className="space-y-4 pt-6">
          <ScrollableFilterBar ariaLabel="Onboarding filters" contentClassName="sm:grid-cols-2 lg:grid-cols-3">
            <div className="w-[156px] shrink-0 space-y-2 sm:w-auto">
              <Label htmlFor="startDate" className="font-semibold text-gray-700">From Date</Label>
              <Input id="startDate" type="date" value={filters.startDate} onChange={(e) => setFilters(prev => ({ ...prev, startDate: e.target.value }))} className="border-gray-300 focus:border-blue-500 focus:ring-blue-500 bg-white" />
            </div>
            <div className="w-[156px] shrink-0 space-y-2 sm:w-auto">
              <Label htmlFor="endDate" className="font-semibold text-gray-700">To Date</Label>
              <Input id="endDate" type="date" value={filters.endDate} onChange={(e) => setFilters(prev => ({ ...prev, endDate: e.target.value }))} className="border-gray-300 focus:border-blue-500 focus:ring-blue-500 bg-white" />
            </div>
            <div className="w-[120px] shrink-0 space-y-2 sm:w-auto sm:flex sm:items-end">
              <div className="flex gap-2 w-full">
                {/* Placeholder for potential future filters */}
              </div>
            </div>
          </ScrollableFilterBar>
        </CardContent>
      </Card>

      {/* Main Content Card */}
      <Card className="shadow-lg border-0 bg-white">
        <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-4">
            <CardTitle>Additional Training Records</CardTitle>
            {userIsAdmin && displayedOnboarding.length > 0 && (
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={selectedRecords.length === displayedOnboarding.filter(r => r.id).length} onChange={handleSelectAllOnPage} className="h-4 w-4 text-blue-600 border-gray-300 rounded" />
                <Label className="text-sm text-gray-600">Select all on page</Label>
              </div>
            )}
          </div>
          {filteredOnboarding.length > CARDS_PER_PAGE && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setCurrentPage(p => p - 1)} disabled={!hasPrevPage} className="h-8 w-8 p-0"><ChevronLeft className="h-4 w-4" /></Button>
              <span className="text-sm text-gray-600">Page {currentPage} of {totalPages}</span>
              <Button variant="outline" size="sm" onClick={() => setCurrentPage(p => p + 1)} disabled={!hasNextPage} className="h-8 w-8 p-0"><ChevronRight className="h-4 w-4" /></Button>
            </div>
          )}
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div></div>
          ) : displayedOnboarding.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
                {activeProgram ? "No records found." : "You do not have access to any programme data."}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {displayedOnboarding.map((record) => (
                <OnboardingCard 
                  key={record.id} 
                  record={record} 
                  isSelected={!!record.id && selectedRecords.includes(record.id)}
                  userIsAdmin={userIsAdmin}
                  onSelectRecord={handleSelectRecord}
                  onView={handleViewDetails} 
                  onEdit={() => { 
                      if (!userIsAdmin) return;
                      const localDate = `${record.date.getFullYear()}-${String(record.date.getMonth() + 1).padStart(2, "0")}-${String(record.date.getDate()).padStart(2, "0")}`;
                      setOnboardingForm({
                        id: record.id || "",
                        topic: record.topic,
                        comment: record.comment || "",
                        date: localDate,
                        status: record.status,
                        programme: resolveAssignableProgramme(record.programme)
                      });
                      setStaff(record.staff.length > 0 ? record.staff : [{ name: "", role: "" }]);
                      setFarmers(record.farmers.length > 0 ? record.farmers : [{ name: "", idNo: "", phoneNo: "", subcounty: "", location: "", gender: "", county: "" }]);
                      setIsDialogOpen(true);
                  }}
                  onDeleteClick={() => {
                    if (!userIsAdmin) return;
                    setSelectedRecord(record);
                    setIsDeleteDialogOpen(true);
                  }}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialogs */}
      {userIsAdmin && (
        <>
          {/* Add/Edit Dialog */}
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
              <DialogHeader><DialogTitle>{onboardingForm.id ? "Edit" : "Add New"} Training</DialogTitle></DialogHeader>
              
              <Tabs defaultValue="details" className="flex-1 flex flex-col overflow-hidden">
                <TabsList className="grid w-full grid-cols-3">
                  <TabsTrigger value="details">Details</TabsTrigger>
                  <TabsTrigger value="trainers">Trainers ({staff.filter(s => s.name.trim() !== "").length})</TabsTrigger>
                  <TabsTrigger value="farmers">Farmers ({farmers.filter(f => f.name.trim() !== "").length})</TabsTrigger>
                </TabsList>
                
                <div className="flex-1 overflow-y-auto mt-4 pr-2">
                  {/* Tab 1: General Details */}
                  <TabsContent value="details" className="space-y-4">
                    <div className="grid grid-cols-1 gap-4">
                      <div className="space-y-2">
                        <Label>PROJECT *</Label>
                        <Select 
                          value={onboardingForm.programme} 
                          onValueChange={(val) => setOnboardingForm(p => ({ ...p, programme: resolveAssignableProgramme(val) }))}
                          disabled={!!onboardingForm.id || availablePrograms.length === 0} // Lock programme on edit usually
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select Programme" />
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
                      <div className="space-y-2"><Label>Topic *</Label><Input value={onboardingForm.topic} onChange={e => setOnboardingForm(p => ({ ...p, topic: e.target.value }))} placeholder="Enter topic" /></div>
                      <div className="space-y-2"><Label>Comment/Notes</Label><textarea value={onboardingForm.comment} onChange={e => setOnboardingForm(p => ({ ...p, comment: e.target.value }))} rows={3} className="w-full px-3 py-2 border rounded-md" /></div>
                      <div className="space-y-2"><Label>Date *</Label><Input type="date" value={onboardingForm.date} onChange={e => setOnboardingForm(p => ({ ...p, date: e.target.value }))} /></div>
                      <div className="space-y-2">
                        <Label>Status</Label>
                        <div className="flex gap-2">
                          <Button type="button" variant={onboardingForm.status === 'pending' ? 'default' : 'outline'} onClick={() => setOnboardingForm(p => ({ ...p, status: 'pending' }))} className="flex-1"><Clock className="h-4 w-4 mr-2" /> Pending</Button>
                          <Button type="button" variant={onboardingForm.status === 'completed' ? 'default' : 'outline'} onClick={() => setOnboardingForm(p => ({ ...p, status: 'completed' }))} className="flex-1"><CheckCircle className="h-4 w-4 mr-2" /> Completed</Button>
                        </div>
                      </div>
                    </div>
                  </TabsContent>

                  {/* Tab 2: Staff/Trainers */}
                  <TabsContent value="trainers" className="space-y-4">
                    <div className="flex justify-between items-center">
                      <h4 className="text-sm font-medium text-muted-foreground">Manage Trainers</h4>
                      <Button type="button" variant="outline" size="sm" onClick={() => setStaff(p => [...p, { name: "", role: "" }])}><UserPlus className="w-4 h-4 mr-1" /> Add Trainer</Button>
                    </div>
                    <div className="space-y-3">
                      {staff.map((s, i) => (
                        <div key={i} className="grid grid-cols-12 gap-3 items-end p-3 border rounded bg-white">
                          <div className="col-span-5"><Input placeholder="Trainer Name *" value={s.name} onChange={e => { const newStaff = [...staff]; newStaff[i].name = e.target.value; setStaff(newStaff); }} /></div>
                          <div className="col-span-5"><Input placeholder="Role *" value={s.role} onChange={e => { const newStaff = [...staff]; newStaff[i].role = e.target.value; setStaff(newStaff); }} /></div>
                          <div className="col-span-2 flex justify-end">{staff.length > 1 && <Button variant="outline" size="sm" className="h-10 w-10 p-0 text-red-500" onClick={() => setStaff(p => p.filter((_, idx) => idx !== i))}><X className="h-4 w-4" /></Button>}</div>
                        </div>
                      ))}
                    </div>
                  </TabsContent>

                  {/* Tab 3: Farmers */}
                  <TabsContent value="farmers" className="space-y-4">
                    <div className="flex justify-between items-center">
                      <h4 className="text-sm font-medium text-muted-foreground">Manage Farmers</h4>
                      <div className="flex gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={() => setIsUploadDialogOpen(true)}><Upload className="w-4 h-4 mr-1" /> Upload Excel</Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => setFarmers(p => [...p, { name: "", idNo: "", phoneNo: "", county: "", subcounty: "", location: "", gender: "" }])}><UserPlus className="w-4 h-4 mr-1" /> Add Farmer</Button>
                      </div>
                    </div>
                    <div className="space-y-3">
                      {farmers.map((f, i) => (
                        <div key={i} className="grid grid-cols-1 md:grid-cols-7 gap-2 items-end p-3 border rounded bg-white">
                          {/* Order: Name, Gender, ID, Phone, County, Subcounty, Location */}
                          <Input placeholder="Name *" value={f.name} onChange={e => { const newF = [...farmers]; newF[i].name = e.target.value; setFarmers(newF); }} />
                          <select value={f.gender} onChange={e => { const newF = [...farmers]; newF[i].gender = e.target.value; setFarmers(newF); }} className="w-full px-3 py-2 border rounded-md bg-white"><option value="">Select</option><option value="Male">Male</option><option value="Female">Female</option></select>
                          <Input placeholder="ID Number" value={f.idNo} onChange={e => { const newF = [...farmers]; newF[i].idNo = e.target.value; setFarmers(newF); }} />
                          <Input placeholder="Phone" value={f.phoneNo} onChange={e => { const newF = [...farmers]; newF[i].phoneNo = e.target.value; setFarmers(newF); }} />
                          
                          {/* County */}
                          <Input placeholder="County" value={f.county} onChange={e => { const newF = [...farmers]; newF[i].county = e.target.value; setFarmers(newF); }} />
                          
                          {/* Subcounty */}
                          <Input placeholder="Subcounty" value={f.subcounty} onChange={e => { const newF = [...farmers]; newF[i].subcounty = e.target.value; setFarmers(newF); }} />
                          
                          {/* Location with delete button container */}
                          <div className="flex gap-2">
                             <Input placeholder="Location" value={f.location} onChange={e => { const newF = [...farmers]; newF[i].location = e.target.value; setFarmers(newF); }} />
                             {farmers.length > 1 && <Button variant="outline" size="sm" className="h-10 w-10 p-0 text-red-500" onClick={() => setFarmers(p => p.filter((_, idx) => idx !== i))}><X className="h-4 w-4" /></Button>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </TabsContent>
                </div>
              </Tabs>

              <DialogFooter className="mt-4">
                <Button variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleAddOnboarding} disabled={loading}>{loading ? "Saving..." : (onboardingForm.id ? "Update" : "Add")} Onboarding</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
            <DialogContent>
              <DialogHeader><DialogTitle>Confirm Deletion</DialogTitle><DialogDescription>Are you sure you want to delete {selectedRecord?.topic}? This cannot be undone.</DialogDescription></DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsDeleteDialogOpen(false)}>Cancel</Button>
                <Button variant="destructive" onClick={handleDeleteConfirm} disabled={loading}>Delete</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={isBulkDeleteDialogOpen} onOpenChange={setIsBulkDeleteDialogOpen}>
            <DialogContent>
              <DialogHeader><DialogTitle>Confirm Bulk Deletion</DialogTitle><DialogDescription>Delete {selectedRecords.length} selected records? This cannot be undone.</DialogDescription></DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsBulkDeleteDialogOpen(false)}>Cancel</Button>
                <Button variant="destructive" onClick={handleBulkDelete} disabled={loading}>Delete</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={isUploadDialogOpen} onOpenChange={setIsUploadDialogOpen}>
            <DialogContent>
              <DialogHeader><DialogTitle>Upload Farmers Excel</DialogTitle></DialogHeader>
              <div className="space-y-4">
                <Button onClick={downloadTemplate} variant="outline"><Download className="w-4 h-4 mr-2" /> Download Template</Button>
                <Input type="file" accept=".xlsx,.xls,.csv" onChange={handleExcelUpload} disabled={loading} />
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}

      {/* View Dialog - Available for all users */}
      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Additional Training Details</DialogTitle>
            <DialogDescription>Full details for the selected training session.</DialogDescription>
          </DialogHeader>
          
          {selectedRecord ? (
            <div className="flex-1 overflow-y-auto space-y-6">
              {/* Summary Section */}
              <div className="p-4 bg-gray-50 rounded-lg border space-y-2">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <span className="text-xs text-muted-foreground block">Date</span>
                    <span className="font-medium">{selectedRecord.date.toLocaleDateString()}</span>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground block">Topic</span>
                    <span className="font-medium">{selectedRecord.topic}</span>
                  </div>
                   <div>
                    <span className="text-xs text-muted-foreground block">PROJECT</span>
                    <span className="font-medium">{selectedRecord.programme}</span>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground block">Status</span>
                    {getStatusBadge(selectedRecord.status)}
                  </div>
                  <div className="md:col-span-4">
                     <span className="text-xs text-muted-foreground block">Comment</span>
                     <span className="font-medium text-sm">{selectedRecord.comment || 'N/A'}</span>
                  </div>
                </div>
              </div>

              {/* Trainers Section */}
              <div>
                <h4 className="font-semibold mb-3 flex items-center gap-2">
                  <GraduationCap className="h-4 w-4" />
                  Trainers ({selectedRecord.staff.length})
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {selectedRecord.staff.map((s, i) => (
                    <div key={i} className="flex justify-between items-center p-3 border rounded bg-white shadow-sm">
                      <span className="font-medium">{s.name}</span>
                      <Badge variant="secondary">{s.role}</Badge>
                    </div>
                  ))}
                </div>
              </div>

              {/* Farmers Section */}
              <div>
                <h4 className="font-semibold mb-3 flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  Farmers ({selectedRecord.farmers.length})
                </h4>
                <div className="border rounded overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-sm">
                      <thead>
                        <tr className="bg-gray-100 text-gray-600">
                          <th className="text-left py-2 px-3 font-medium border">Name</th>
                          <th className="text-left py-2 px-3 font-medium border">Gender</th>
                          <th className="text-left py-2 px-3 font-medium border">ID No</th>
                          <th className="text-left py-2 px-3 font-medium border">Phone</th>
                          <th className="text-left py-2 px-3 font-medium border">County</th>
                          <th className="text-left py-2 px-3 font-medium border">Subcounty</th>
                          <th className="text-left py-2 px-3 font-medium border">Location</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedRecord.farmers.map((f, i) => (
                          <tr key={i} className="hover:bg-gray-50 border-b last:border-0">
                            <td className="py-2 px-3 border text-gray-700">{f.name}</td>
                            <td className="py-2 px-3 border text-gray-700"><Badge variant={f.gender === 'Male' ? 'default' : 'secondary'} className={f.gender === 'Male' ? 'bg-blue-100 text-blue-800' : 'bg-pink-100 text-pink-800'}>{f.gender || 'N/A'}</Badge></td>
                            <td className="py-2 px-3 border text-gray-700"><code className="bg-gray-100 px-2 py-1 rounded text-xs">{f.idNo || 'N/A'}</code></td>
                            <td className="py-2 px-3 border text-gray-700">{f.phoneNo || 'N/A'}</td>
                            <td className="py-2 px-3 border text-gray-700"><Badge variant="outline" className="bg-purple-50 text-purple-700">{f.county || 'N/A'}</Badge></td>
                            <td className="py-2 px-3 border text-gray-700"><Badge variant="secondary">{f.subcounty || 'N/A'}</Badge></td>
                            <td className="py-2 px-3 border text-gray-700"><Badge variant="secondary">{f.location || 'N/A'}</Badge></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-10 text-muted-foreground">No record selected</div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsViewDialogOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default OnboardingPage;



