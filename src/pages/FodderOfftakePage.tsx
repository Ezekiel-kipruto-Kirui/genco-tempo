import { useState, useEffect, useCallback, useMemo, useRef, ChangeEvent } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { db, ref, update, push, subscribeCollectionByProgramme } from "@/lib/firebase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollableFilterBar } from "@/components/ScrollableFilterBar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Download, Users, MapPin, Eye, Calendar, Sprout, Globe, LayoutGrid, Edit, Trash2, Upload, UserCircle } from "lucide-react";
import { useSharedProgrammeSelection } from "@/hooks/use-shared-programme-selection";
import { useToast } from "@/hooks/use-toast";
import { canViewAllProgrammes, isAdmin } from "@/contexts/authhelper";
import { cacheKey, readCachedValue, removeCachedValue, writeCachedValue } from "@/lib/data-cache";
import { matchesActiveProgramme, resolveAccessibleProgrammes, resolveActiveProgramme } from "@/lib/programme-access";

// --- Types ---

// Updated to match JSON structure (idNo, phoneNo)
interface Farmer {
  idNo?: string;
  name?: string;
  phoneNo?: string;
  gender?: string;
}

interface FodderFarmer {
  id: string;
  date: any;
  landSize?: number;
  location?: string;
  model?: string;
  region?: string; // Mapped from 'county' in JSON
  subcounty?: string; // Added
  username?: string; // Added
  totalAcresPasture?: number;
  totalBales?: number;
  yieldPerHarvest?: number;
  farmers?: Farmer[];
  programme?: string;
}

interface Filters {
  search: string;
  startDate: string;
  endDate: string;
  location: string;
  region: string;
  model: string;
}

interface Stats {
  totalFarmers: number;
  totalRegions: number;
  totalModels: number;
}

interface Pagination {
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

// --- Constants ---
const PAGE_LIMIT = 15;
const SEARCH_DEBOUNCE_DELAY = 300;

// --- Helper Functions ---

const parseDate = (date: any): Date | null => {
  if (!date) return null;
  try {
    // Handle Firestore Timestamp objects
    if (date.toDate && typeof date.toDate === 'function') {
      return date.toDate();
    } else if (date instanceof Date) {
      return date;
    } else if (typeof date === 'string') {
      const parsed = new Date(date);
      return isNaN(parsed.getTime()) ? null : parsed;
    } else if (typeof date === 'number') {
      return new Date(date);
    } else if (date.seconds) {
      return new Date(date.seconds * 1000);
    } else if (date._seconds) {
      return new Date(date._seconds * 1000);
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

const getFodderTimestamp = (record: Partial<FodderFarmer> | null | undefined): number => {
  if (!record) return 0;
  const parsed = parseDate(record.date);
  return parsed ? parsed.getTime() : 0;
};

const sortFodderByLatest = (records: FodderFarmer[]): FodderFarmer[] =>
  [...records].sort((a, b) => getFodderTimestamp(b) - getFodderTimestamp(a));

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

// --- Main Component ---

const FodderFarmersPage = () => {
  const { user, userRole, userAttribute, allowedProgrammes } = useAuth();
  const { toast } = useToast();
  
  // State
  const [allFodder, setAllFodder] = useState<FodderFarmer[]>([]);
  const [filteredFodder, setFilteredFodder] = useState<FodderFarmer[]>([]);
  const [loading, setLoading] = useState(true);
  const [exportLoading, setExportLoading] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [selectedRecords, setSelectedRecords] = useState<string[]>([]);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [viewingRecord, setViewingRecord] = useState<FodderFarmer | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentMonth = useMemo(getCurrentMonthDates, []);

  const [filters, setFilters] = useState<Filters>({
    search: "",
    startDate: currentMonth.startDate,
    endDate: currentMonth.endDate,
    location: "all",
    region: "all",
    model: "all"
  });

  const [stats, setStats] = useState<Stats>({
    totalFarmers: 0,
    totalRegions: 0,
    totalModels: 0
  });

  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: PAGE_LIMIT,
    totalPages: 1,
    hasNext: false,
    hasPrev: false
  });

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
  const availablePrograms = accessibleProgrammes;
  const requireAdmin = () => {
    if (userIsAdmin) return true;
    toast({
      title: "Access denied",
      description: "Only Admin can create, edit, or delete records on this page.",
      variant: "destructive",
    });
    return false;
  };
  const fodderCacheKey = useMemo(
    () => cacheKey("admin-page", "fodder-offtake", activeProgram),
    [activeProgram]
  );

  // --- 1. Fetch User Permissions & Determine Available Programmes ---
  // --- 2. Data Fetching (Realtime with Programme Query) ---
  useEffect(() => {
    if (!activeProgram) {
        setAllFodder([]);
        setLoading(false);
        return;
    }

    const cachedFodder = readCachedValue<FodderFarmer[]>(fodderCacheKey);
    if (cachedFodder) {
      setAllFodder(sortFodderByLatest(cachedFodder));
      setLoading(false);
    } else {
      setLoading(true);
    }

    const unsubscribe = subscribeCollectionByProgramme<Record<string, any>>("fodderFarmers", activeProgram, (data) => {
      
      if (!data || Object.keys(data).length === 0) {
        setAllFodder([]);
        removeCachedValue(fodderCacheKey);
        setLoading(false);
        return;
      }

      const fodderData = Object.keys(data).map((key) => {
        const item = data[key];
        
        // Handle date parsing
        let dateValue = item.date || item.Date || item.createdAt || item.timestamp;
        if (dateValue && typeof dateValue === 'object') {
          if (dateValue.toDate && typeof dateValue.toDate === 'function') {
            dateValue = dateValue.toDate();
          } else if (dateValue.seconds) {
            dateValue = new Date(dateValue.seconds * 1000);
          } else if (dateValue._seconds) {
            dateValue = new Date(dateValue._seconds * 1000);
          }
        }

        // Map farmers array to match interface (idNo, phoneNo)
        const farmersList: Farmer[] = Array.isArray(item.farmers) 
          ? item.farmers.map((f: any) => ({
              idNo: f.idNo || f.id || 'N/A',
              name: f.name || 'N/A',
              phoneNo: f.phoneNo || f.phone || 'N/A',
              gender: f.gender || 'N/A'
            })) 
          : [];

        return {
          id: key,
          date: dateValue,
          landSize: Number(item.landSize || item.LandSize || 0),
          location: item.location || item.Location || item.area || item.Area || '',
          model: item.model || item.Model || '',
          // Map 'county' to 'region' for backwards compatibility with filters
          region: item.county || item.region || item.Region || '',
          subcounty: item.subcounty || '',
          username: item.username || '',
          totalAcresPasture: Number(item.totalAcresPasture || item.TotalAcresPasture || 0),
          totalBales: Number(item.totalBales || item.TotalBales || 0),
          yieldPerHarvest: Number(item.yieldPerHarvest || item.YieldPerHarvest || 0),
          farmers: farmersList,
          programme: item.programme || activeProgram
        };
      }).filter((record) => matchesActiveProgramme(record.programme, activeProgram));

      const sortedFodderData = sortFodderByLatest(fodderData);
      setAllFodder(sortedFodderData);
      writeCachedValue(fodderCacheKey, sortedFodderData);
      setLoading(false);
    }, (error) => {
      console.error("Error fetching fodder data:", error);
      toast({ title: "Error", description: "Failed to load fodder data", variant: "destructive" });
      setLoading(false);
    });

    return () => { if(typeof unsubscribe === 'function') unsubscribe(); };
  }, [activeProgram, toast, fodderCacheKey]);

  // --- Filtering Logic ---
  const applyFilters = useCallback(() => {
    if (allFodder.length === 0) {
      setFilteredFodder([]);
      setStats({ totalFarmers: 0, totalRegions: 0, totalModels: 0 });
      return;
    }

    const filtered = allFodder.filter(record => {
      if (filters.region !== "all" && record.region?.toLowerCase() !== filters.region.toLowerCase()) return false;
      if (filters.location !== "all" && record.location?.toLowerCase() !== filters.location.toLowerCase()) return false;
      if (filters.model !== "all" && record.model?.toLowerCase() !== filters.model.toLowerCase()) return false;

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
          record.location, record.region, record.model, record.subcounty
        ].some(field => field?.toLowerCase().includes(searchTerm));
        if (!searchMatch) return false;
      }

      return true;
    });

    const sortedFiltered = sortFodderByLatest(filtered);
    setFilteredFodder(sortedFiltered);
    
    const totalFarmers = sortedFiltered.reduce((sum, record) => sum + (record.farmers?.length || 0), 0);
    const uniqueRegions = new Set(sortedFiltered.map(f => f.region).filter(Boolean));
    const uniqueModels = new Set(sortedFiltered.map(f => f.model).filter(Boolean));

    setStats({ totalFarmers, totalRegions: uniqueRegions.size, totalModels: uniqueModels.size });

    const totalPages = Math.ceil(sortedFiltered.length / pagination.limit);
    setPagination(prev => ({
      ...prev,
      totalPages,
      hasNext: prev.page < totalPages,
      hasPrev: prev.page > 1
    }));
  }, [allFodder, filters, pagination.limit, pagination.page]);

  useEffect(() => {
    applyFilters();
  }, [applyFilters]);

  // --- Handlers ---

  const handleProgramChange = (program: string) => {
    setActiveProgram(program);
    setFilters(prev => ({ 
        ...prev, 
        search: "", 
        startDate: currentMonth.startDate, 
        endDate: currentMonth.endDate, 
        location: "all", 
        region: "all", 
        model: "all" 
    }));
    setSelectedRecords([]);
    setPagination(prev => ({ ...prev, page: 1 }));
  };

  const handleSearch = (value: string) => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      setFilters(prev => ({ ...prev, search: value }));
      setPagination(prev => ({ ...prev, page: 1 }));
    }, SEARCH_DEBOUNCE_DELAY);
  };

  const handleFilterChange = (key: keyof Filters, value: string) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    setPagination(prev => ({ ...prev, page: 1 }));
  };

  const handlePageChange = (newPage: number) => {
    setPagination(prev => ({ ...prev, page: newPage }));
  };

  const handleSelectRecord = (recordId: string) => {
    setSelectedRecords(prev => prev.includes(recordId) ? prev.filter(id => id !== recordId) : [...prev, recordId]);
  };

  const handleSelectAll = () => {
    const currentPageIds = getCurrentPageRecords().map(f => f.id);
    setSelectedRecords(prev => prev.length === currentPageIds.length ? [] : currentPageIds);
  };

  const getCurrentPageRecords = () => {
    const startIndex = (pagination.page - 1) * pagination.limit;
    const endIndex = startIndex + pagination.limit;
    return filteredFodder.slice(startIndex, endIndex);
  };

  const openViewDialog = (record: FodderFarmer) => {
    setViewingRecord(record);
    setIsViewDialogOpen(true);
  };

  const handleEdit = (record: FodderFarmer) => {
    if (!requireAdmin()) return;
    console.log("Edit record:", record);
    toast({ title: "Edit Feature", description: "Edit functionality will be implemented soon" });
  };

  const handleDelete = (record: FodderFarmer) => {
    if (!requireAdmin()) return;
    console.log("Delete record:", record);
    toast({ title: "Delete Feature", description: "Delete functionality will be implemented soon", variant: "destructive" });
  };

  const handleDeleteMultiple = async () => {
    if (!requireAdmin()) return;
    if (selectedRecords.length === 0) return;
    try {
      setDeleteLoading(true);
      const updates: { [key: string]: null } = {};
      selectedRecords.forEach(id => updates[`fodderFarmers/${id}`] = null);
      await update(ref(db), updates);
      removeCachedValue(fodderCacheKey);
      toast({ title: "Success", description: `${selectedRecords.length} records deleted` });
      setSelectedRecords([]);
      setIsDeleteConfirmOpen(false);
    } catch (error) {
      toast({ title: "Error", description: "Bulk delete failed", variant: "destructive" });
    } finally { setDeleteLoading(false); }
  };

  const openDeleteConfirm = () => {
    if (!requireAdmin()) return;
    if (selectedRecords.length === 0) return;
    setIsDeleteConfirmOpen(true);
  };

  const handleExport = async () => {
    try {
      setExportLoading(true);
      if (filteredFodder.length === 0) return;

      const csvData = filteredFodder.map(record => [
        formatDate(record.date),
        record.location || 'N/A',
        record.region || 'N/A',
        record.subcounty || 'N/A',
        record.model || 'N/A',
        (record.farmers?.length || 0).toString(),
        (record.landSize || 0).toString(),
        (record.totalAcresPasture || 0).toString(),
        (record.totalBales || 0).toString(),
        (record.yieldPerHarvest || 0).toString(),
        record.programme || activeProgram
      ]);

      const headers = ['Date', 'Location', 'County', 'Subcounty', 'Model', 'Number of Farmers', 'Land Size', 'Total Acres Pasture', 'Total Bales', 'Yield per Harvest', 'Programme'];
      const csvContent = [headers, ...csvData].map(row => row.map(f => `"${f}"`).join(',')).join('\n');
      
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `fodder_export_${activeProgram}_${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
      toast({ title: "Success", description: "Data exported successfully" });
    } catch (error) {
      toast({ title: "Error", description: "Export failed", variant: "destructive" });
    } finally { setExportLoading(false); }
  };

  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setUploadFile(file);
    }
  };

  const handleUpload = async () => {
    if (!requireAdmin()) return;
    if (!uploadFile) return;
    setUploadLoading(true);
    try {
      const text = await uploadFile.text();
      const isJSON = uploadFile.name.endsWith('.json');
      let parsedData: any[] = [];

      if (isJSON) {
        parsedData = JSON.parse(text);
      } else {
        const lines = text.split('\n').filter(l => l.trim());
        const headers = lines[0].split(',').map(h => h.trim());
        for (let i = 1; i < lines.length; i++) {
          const values = lines[i].split(',').map(v => v.trim());
          const obj: any = {};
          headers.forEach((h, idx) => obj[h] = values[idx]);
          parsedData.push(obj);
        }
      }

      let count = 0;
      const collectionRef = ref(db, "fodderFarmers");
      
      for (const item of parsedData) {
        await push(collectionRef, {
          ...item,
          programme: activeProgram,
          createdAt: new Date().toISOString(),
          rawTimestamp: Date.now()
        });
        count++;
      }

      removeCachedValue(fodderCacheKey);
      toast({ title: "Success", description: `Uploaded ${count} records to ${activeProgram}.` });
      setIsUploadDialogOpen(false);
      setUploadFile(null);
    } catch (error) {
      console.error(error);
      toast({ title: "Error", description: "Invalid file format", variant: "destructive" });
    } finally {
      setUploadLoading(false);
    }
  };

  const clearAllFilters = () => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    setFilters({
      search: "",
      startDate: "",
      endDate: "",
      location: "all",
      region: "all",
      model: "all"
    });
    setPagination(prev => ({ ...prev, page: 1 }));
  };

  const resetToCurrentMonth = () => {
    setFilters(prev => ({ ...prev, ...currentMonth }));
  };

  // Derived Lists
  const uniqueRegions = useMemo(() => [...new Set(allFodder.map(f => f.region).filter(Boolean))], [allFodder]);
  const uniqueLocations = useMemo(() => [...new Set(allFodder.map(f => f.location).filter(Boolean))], [allFodder]);
  const uniqueModels = useMemo(() => [...new Set(allFodder.map(f => f.model).filter(Boolean))], [allFodder]);
  const currentPageRecords = useMemo(getCurrentPageRecords, [filteredFodder, pagination.page, pagination.limit]);

  // Sub-components
  const StatsCard = useCallback(({ title, value, icon: Icon, description }: any) => (
    <Card className="bg-white text-slate-900 shadow-lg border border-gray-200 relative overflow-hidden">
      <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-green-500 to-emerald-600"></div>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 pt-4 pl-6">
        <CardTitle className="text-sm font-medium text-slate-700">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pl-6 pb-4 flex flex-row">
        <div className="mr-2 rounded-full">
          <Icon className="h-8 w-8 text-green-600" />
        </div>
        <div>
          <div className="text-2xl font-bold text-slate-900 mb-2">{value}</div>
          {description && (
            <p className="text-xs text-slate-600 mt-2 bg-slate-50 px-2 py-1 rounded-md border border-slate-100">
              {description}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  ), []);

  const FilterSection = useMemo(() => (
    <ScrollableFilterBar ariaLabel="Fodder offtake filters" contentClassName="sm:grid-cols-2 lg:grid-cols-6">
      <div className="w-[240px] shrink-0 space-y-2 sm:w-auto">
        <Label htmlFor="search" className="font-semibold text-gray-700">Search</Label>
        <Input
          id="search"
          placeholder="Search records..."
          onChange={(e) => handleSearch(e.target.value)}
          className="border-gray-300 focus:border-green-500 focus:ring-green-500 bg-white"
        />
      </div>

      <div className="w-[190px] shrink-0 space-y-2 sm:w-auto">
        <Label htmlFor="region" className="font-semibold text-gray-700">County</Label>
        <Select value={filters.region} onValueChange={(value) => handleFilterChange("region", value)}>
          <SelectTrigger className="border-gray-300 focus:border-green-500 focus:ring-green-500 bg-white">
            <SelectValue placeholder="Select county" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Counties</SelectItem>
            {uniqueRegions.slice(0, 20).map(region => (
              <SelectItem key={region} value={region}>{region}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="w-[190px] shrink-0 space-y-2 sm:w-auto">
        <Label htmlFor="location" className="font-semibold text-gray-700">Location</Label>
        <Select value={filters.location} onValueChange={(value) => handleFilterChange("location", value)}>
          <SelectTrigger className="border-gray-300 focus:border-green-500 focus:ring-green-500 bg-white">
            <SelectValue placeholder="Select location" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Locations</SelectItem>
            {uniqueLocations.slice(0, 20).map(location => (
              <SelectItem key={location} value={location}>{location}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="w-[190px] shrink-0 space-y-2 sm:w-auto">
        <Label htmlFor="model" className="font-semibold text-gray-700">Model</Label>
        <Select value={filters.model} onValueChange={(value) => handleFilterChange("model", value)}>
          <SelectTrigger className="border-gray-300 focus:border-green-500 focus:ring-green-500 bg-white">
            <SelectValue placeholder="Select model" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Models</SelectItem>
            {uniqueModels.slice(0, 20).map(model => (
              <SelectItem key={model} value={model}>{model}</SelectItem>
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
          onChange={(e) => handleFilterChange("startDate", e.target.value)}
          className="border-gray-300 focus:border-green-500 focus:ring-green-500 bg-white"
        />
      </div>

      <div className="w-[156px] shrink-0 space-y-2 sm:w-auto">
        <Label htmlFor="endDate" className="font-semibold text-gray-700">To Date</Label>
        <Input
          id="endDate"
          type="date"
          value={filters.endDate}
          onChange={(e) => handleFilterChange("endDate", e.target.value)}
          className="border-gray-300 focus:border-green-500 focus:ring-green-500 bg-white"
        />
      </div>
    </ScrollableFilterBar>
  ), [filters, uniqueRegions, uniqueLocations, uniqueModels]);

  const TableRow = useCallback(({ record }: { record: FodderFarmer }) => {
    const farmerCount = record.farmers?.length || 0;
    
    return (
      <tr className="border-b hover:bg-green-50 transition-colors duration-200 group text-sm">
        <td className="py-3 px-4">
          <Checkbox
            checked={selectedRecords.includes(record.id)}
            onCheckedChange={() => handleSelectRecord(record.id)}
          />
        </td>
        <td className="py-3 px-4">{formatDate(record.date)}</td>
        <td className="py-3 px-4">{record.location || 'N/A'}</td>
        <td className="py-3 px-4">{record.region || 'N/A'}</td>
        <td className="py-3 px-4">
          <Badge className="bg-blue-100 text-blue-800">
            {record.model || 'N/A'}
          </Badge>
        </td>
        <td className="py-3 px-4">{record.landSize || 0}</td>
        <td className="py-3 px-4">{record.totalAcresPasture || 0}</td>
        <td className="py-3 px-4">{record.totalBales || 0}</td>
        <td className="py-3 px-4">{record.yieldPerHarvest || 0}</td>
        <td className="py-3 px-4">
          <span className="font-bold text-gray-700">{farmerCount}</span>
        </td>
        <td className="py-3 px-4">
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => openViewDialog(record)}
              className="h-8 w-8 p-0 hover:bg-green-50 hover:text-green-600 border-green-200"
            >
              <Eye className="h-4 w-4 text-green-500" />
            </Button>
            {userIsAdmin && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleEdit(record)}
                  className="h-8 w-8 p-0 hover:bg-blue-50 hover:text-blue-600 border-blue-200"
                >
                  <Edit className="h-4 w-4 text-blue-500" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDelete(record)}
                  className="h-8 w-8 p-0 hover:bg-red-50 hover:text-red-600 border-red-200"
                >
                  <Trash2 className="h-4 w-4 text-red-500" />
                </Button>
              </>
            )}
          </div>
        </td>
      </tr>
    );
  }, [selectedRecords, handleSelectRecord, openViewDialog, handleEdit, handleDelete, userIsAdmin]);

  return (
    <div className="space-y-6">
      {/* Header with Action Buttons */}
      <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4">
        <div>
          <h2 className="text-xl font-bold mb-2 bg-gradient-to-r from-green-600 to-emerald-600 bg-clip-text text-transparent">
            Fodder Farmers
          </h2>
          <div className="flex items-center gap-2 text-sm text-gray-600">
             {activeProgram && <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 font-bold px-3 py-1">{activeProgram} PROJECT</Badge>}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 w-full xl:w-auto">
          {selectedRecords.length > 0 && userIsAdmin && (
            <Button 
              variant="destructive" 
              size="sm" 
              onClick={openDeleteConfirm}
              disabled={deleteLoading}
              className="text-xs"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete ({selectedRecords.length})
            </Button>
          )}
          
          <Button 
            variant="outline" 
            size="sm" 
            onClick={clearAllFilters}
            className="text-xs border-gray-300 hover:bg-gray-50"
          >
            Clear All Filters
          </Button>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={resetToCurrentMonth}
            className="text-xs border-gray-300 hover:bg-gray-50"
          >
            This Month
          </Button>

          {availablePrograms.length > 1 ? (
             <div className="flex justify-end w-full sm:w-auto">
               <Select value={activeProgram} onValueChange={handleProgramChange}>
                  <SelectTrigger className="w-full sm:w-[200px] border-gray-300 focus:border-green-500 bg-white">
                      <SelectValue placeholder="Select Programme" />
                  </SelectTrigger>
                  <SelectContent>
                      {availablePrograms.map(p => (
                          <SelectItem key={p} value={p}>{p}</SelectItem>
                      ))}
                  </SelectContent>
              </Select>
             </div>
          ) : (
            <div className="hidden sm:block sm:w-[200px]"></div>
          )}

          {userIsAdmin && (
            <>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => setIsUploadDialogOpen(true)}
                className="text-xs border-green-300 hover:bg-green-50 text-green-700"
              >
                <Upload className="h-4 w-4 mr-2" />
                Upload Data
              </Button>
              <Button 
                onClick={handleExport} 
                disabled={exportLoading || filteredFodder.length === 0}
                className="bg-gradient-to-r from-green-600 to-emerald-700 hover:from-green-700 hover:to-emerald-800 text-white shadow-md text-xs"
              >
                <Download className="h-4 w-4 mr-2" />
                {exportLoading ? "Exporting..." : `Export (${filteredFodder.length})`}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatsCard 
          title="Total Farmers" 
          value={stats.totalFarmers} 
          icon={Users}
          description="Across all records"
        />

        <StatsCard 
          title="Counties" 
          value={stats.totalRegions} 
          icon={Globe}
          description="Unique counties covered"
        />

        <StatsCard 
          title="Models" 
          value={stats.totalModels} 
          icon={LayoutGrid}
          description="Different farming models"
        />
      </div>

      {/* Filters Section */}
      <Card className="shadow-lg border-0 bg-white">
        <CardContent className="space-y-4 pt-6">
          {FilterSection}
        </CardContent>
      </Card>

      {/* Data Table */}
      <Card className="shadow-lg border-0 bg-white">
        <CardContent className="p-0">
          {loading ? (
            <div className="text-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600 mx-auto"></div>
              <p className="text-muted-foreground mt-2">Loading fodder data...</p>
            </div>
          ) : currentPageRecords.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">{activeProgram ? "No records found matching your criteria" : "You do not have access to any programme data."}</div>
          ) : (
            <>
              <div className="w-full overflow-x-auto rounded-md">
                <table className="w-full border-collapse border border-gray-300 text-sm text-left whitespace-nowrap">
                  <thead className="rounded">
                    <tr className="bg-green-100 p-1 px-3">
                      <th className="py-1 px-6">
                        <Checkbox
                          checked={selectedRecords.length === currentPageRecords.length && currentPageRecords.length > 0}
                          onCheckedChange={handleSelectAll}
                        />
                      </th>
                      <th className="py-1 px-6 font-medium text-gray-600">Date</th>
                      <th className="py-1 px-6 font-medium text-gray-600">Location</th>
                      <th className="py-1 px-6 font-medium text-gray-600">County</th>
                      <th className="py-1 px-6 font-medium text-gray-600">Model</th>
                      <th className="py-1 px-6 font-medium text-gray-600">Land Size</th>
                      <th className="py-1 px-6 font-medium text-gray-600">Pasture Acres</th>
                      <th className="py-1 px-6 font-medium text-gray-600">Total Bales</th>
                      <th className="py-1 px-6 font-medium text-gray-600">Yield/Harvest</th>
                      <th className="py-1 px-6 font-medium text-gray-600">Farmers</th>
                      <th className="py-1 px-6 font-medium text-gray-600">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentPageRecords.map((record) => (
                      <TableRow key={record.id} record={record} />
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between p-4 border-t bg-gray-50">
                <div className="text-sm text-muted-foreground">
                  Page {pagination.page} of {pagination.totalPages} â€¢ {filteredFodder.length} total records â€¢ {currentPageRecords.length} on this page
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!pagination.hasPrev}
                    onClick={() => handlePageChange(pagination.page - 1)}
                    className="border-gray-300 hover:bg-gray-100"
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!pagination.hasNext}
                    onClick={() => handlePageChange(pagination.page + 1)}
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

      {/* Upload Data Dialog */}
      <Dialog open={isUploadDialogOpen} onOpenChange={setIsUploadDialogOpen}>
        <DialogContent className="sm:max-w-md bg-white rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-slate-900">
              <Upload className="h-5 w-5 text-green-600" />
              Upload Fodder Farmers Data
            </DialogTitle>
            <DialogDescription>
              Upload data from CSV or JSON files. Data will be assigned to the <strong>{activeProgram}</strong> Project.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="file-upload">Select File</Label>
              <Input
                id="file-upload"
                ref={fileInputRef}
                type="file"
                accept=".csv,.json"
                onChange={handleFileSelect}
                className="bg-white border-slate-300"
              />
              <p className="text-xs text-slate-500">
                Supported formats: CSV, JSON. Maximum file size: 10MB
              </p>
            </div>
            
            {uploadFile && (
              <div className="bg-slate-50 rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-slate-900">{uploadFile.name}</p>
                    <p className="text-sm text-slate-500">
                      {(uploadFile.size / 1024 / 1024).toFixed(2)} MB
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setUploadFile(null);
                      if (fileInputRef.current) {
                        fileInputRef.current.value = '';
                      }
                    }}
                    className="text-red-600 hover:text-red-700 hover:bg-red-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => {
                setIsUploadDialogOpen(false);
                setUploadFile(null);
                if (fileInputRef.current) {
                  fileInputRef.current.value = '';
                }
              }}
              className="border-slate-300"
            >
              Cancel
            </Button>
            <Button 
              onClick={handleUpload} 
              disabled={!uploadFile || uploadLoading}
              className="bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white"
            >
              {uploadLoading ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  Upload Data
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteConfirmOpen} onOpenChange={setIsDeleteConfirmOpen}>
        <DialogContent className="sm:max-w-md bg-white rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-slate-900">
              <Trash2 className="h-5 w-5 text-red-600" />
              Confirm Deletion
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete {selectedRecords.length} selected records? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => setIsDeleteConfirmOpen(false)}
              className="border-slate-300"
            >
              Cancel
            </Button>
            <Button 
              variant="destructive"
              onClick={handleDeleteMultiple}
              disabled={deleteLoading}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deleteLoading ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete {selectedRecords.length} Records
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View Record Dialog - Updated for JSON structure */}
      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent className="sm:max-w-2xl bg-white rounded-2xl max-h-[90vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-slate-900">
              <Eye className="h-5 w-5 text-green-600" />
              Fodder Farmer Details
            </DialogTitle>
            <DialogDescription>
              Complete information for this fodder farming record
            </DialogDescription>
          </DialogHeader>
          {viewingRecord && (
            <div className="space-y-6 py-4 overflow-y-auto max-h-[60vh]">
              {/* Basic Information */}
              <div className="bg-slate-50 rounded-xl p-4">
                <h3 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
                  <Sprout className="h-4 w-4" />
                  Basic Information
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-sm font-medium text-slate-600">Date</Label>
                    <p className="text-slate-900 font-medium">{formatDate(viewingRecord.date)}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-slate-600">Project</Label>
                    <Badge className="bg-green-100 text-green-800">{viewingRecord.programme || activeProgram}</Badge>
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-slate-600">Location</Label>
                    <p className="text-slate-900 font-medium">{viewingRecord.location || 'N/A'}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-slate-600">County</Label>
                    <p className="text-slate-900 font-medium">{viewingRecord.region || 'N/A'}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-slate-600">Subcounty</Label>
                    <p className="text-slate-900 font-medium">{viewingRecord.subcounty || 'N/A'}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-slate-600">Model</Label>
                    <Badge className="bg-blue-100 text-blue-800">{viewingRecord.model || 'N/A'}</Badge>
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-slate-600">Recorded By</Label>
                    <p className="text-slate-900 font-medium">{viewingRecord.username || 'N/A'}</p>
                  </div>
                </div>
              </div>

              {/* Land Information */}
              <div className="bg-slate-50 rounded-xl p-4">
                <h3 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
                  <MapPin className="h-4 w-4" />
                  Land Information
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-sm font-medium text-slate-600">Land Size</Label>
                    <p className="text-slate-900 font-medium">{(viewingRecord.landSize || 0).toLocaleString()} acres</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-slate-600">Total Acres Pasture</Label>
                    <p className="text-slate-900 font-medium">{(viewingRecord.totalAcresPasture || 0).toLocaleString()} acres</p>
                  </div>
                </div>
              </div>

              {/* Production Information */}
              <div className="bg-slate-50 rounded-xl p-4">
                <h3 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
                  <Calendar className="h-4 w-4" />
                  Production Information
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-sm font-medium text-slate-600">Total Bales</Label>
                    <p className="text-slate-900 font-medium text-lg font-bold">
                      {(viewingRecord.totalBales || 0).toLocaleString()}
                    </p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-slate-600">Yield per Harvest</Label>
                    <p className="text-slate-900 font-medium">{(viewingRecord.yieldPerHarvest || 0).toLocaleString()}</p>
                  </div>
                </div>
              </div>

              {/* Farmers List - Updated to show all farmers */}
              {viewingRecord.farmers && viewingRecord.farmers.length > 0 && (
                <div className="bg-slate-50 rounded-xl p-4">
                  <h3 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
                    <Users className="h-4 w-4" />
                    Associated Farmers ({viewingRecord.farmers.length})
                  </h3>
                  <div className="space-y-3 max-h-60 overflow-y-auto">
                    {viewingRecord.farmers.map((farmer, index) => (
                      <div key={farmer.idNo || index} className="border border-slate-200 rounded-lg p-3 bg-white">
                        <div className="flex items-center gap-3 mb-2">
                           <UserCircle className="h-6 w-6 text-gray-400" />
                           <span className="font-bold text-gray-800">{farmer.name || 'Unknown'}</span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm pl-9">
                          <div>
                            <Label className="text-xs font-medium text-slate-500">ID No</Label>
                            <p className="text-slate-800 font-mono">{farmer.idNo || 'N/A'}</p>
                          </div>
                          <div>
                            <Label className="text-xs font-medium text-slate-500">Gender</Label>
                            <p className="text-slate-800">{farmer.gender || 'N/A'}</p>
                          </div>
                          <div className="col-span-2">
                            <Label className="text-xs font-medium text-slate-500">Phone No</Label>
                            <p className="text-slate-800">{farmer.phoneNo || 'N/A'}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button 
              onClick={() => setIsViewDialogOpen(false)}
              className="bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default FodderFarmersPage;



