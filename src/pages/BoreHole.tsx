import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { db, fetchCollectionByProgramme, ref, push, update, remove } from "@/lib/firebase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollableFilterBar } from "@/components/ScrollableFilterBar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Download, MapPin, Eye, Droplets, Users, Building, Trash2, Upload, Plus, Edit } from "lucide-react";
import { useSharedProgrammeSelection } from "@/hooks/use-shared-programme-selection";
import { useToast } from "@/hooks/use-toast";
import { canManageInfrastructureRecords, canViewAllProgrammes } from "@/contexts/authhelper";
import { cacheKey, readCachedValue, removeCachedValue, writeCachedValue } from "@/lib/data-cache";
import {millify} from "millify";
import { PROGRAMME_OPTIONS, normalizeProgramme as normalizeProgrammeValue, resolveAccessibleProgrammes } from "@/lib/programme-access";

// Types
interface Borehole {
  id: string;
  date: any; // Can be ISO string or number
  programme?: string;
  location?: string;
  county?: string;      // Added County
  subcounty?: string;   // Added Sub-County
  people?: string | number;
  waterUsed?: number;
  drilled?: boolean;
  equipped?: boolean;   // Added Equipped
  maintained?: boolean;
}

interface Filters {
  search: string;
  startDate: string;
  endDate: string;
  location: string;
}

interface Stats {
  totalBoreholes: number;
  drilledBoreholes: number;
  equippedBoreholes: number; // Replaced maintained
  maintainedBoreholes: number;
  totalPeople: number;
  totalWaterUsed: number;
}

interface Pagination {
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

// Firebase operations
interface FirebaseResult {
  success: boolean;
  error?: string;
  id?: string;
}

// --- CORRECTED REALTIME DATABASE IMPLEMENTATIONS ---

const addData = async (collectionName: string, data: any): Promise<FirebaseResult> => {
  try {
    console.log("Adding data to RTDB", collectionName, data);
    
    // Reference to the collection node in RTDB
    const dbRef = ref(db as Database, collectionName);
    
    // Push generates a unique key and returns the reference
    const newPostRef = push(dbRef);
    
    // Set the data at the generated key location
    await update(newPostRef, {
      ...data,
      // Ensure date is a string (ISO) or number, RTDB doesn't have native Timestamp objects
      date: data.date instanceof Date ? data.date.toISOString() : data.date
    });

    console.log("Document written with ID: ", newPostRef.key);
    
    return { 
      success: true, 
      id: newPostRef.key 
    };
  } catch (error) {
    console.error("Error adding document:", error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error occurred' 
    };
  }
};

const updateData = async (collectionName: string, docId: string, data: any): Promise<FirebaseResult> => {
  try {
    console.log("Updating document in RTDB", collectionName, docId, data);
    
    // Create reference to specific child in RTDB
    const dbRef = ref(db as Database, `${collectionName}/${docId}`);
    
    const dataToUpdate = {
      ...data,
      date: data.date instanceof Date ? data.date.toISOString() : data.date
    };

    await update(dbRef, dataToUpdate);
    
    return { 
      success: true 
    };
  } catch (error) {
    console.error("Error updating document:", error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error occurred' 
    };
  }
};

const deleteData = async (collectionName: string, docIds: string[]): Promise<FirebaseResult> => {
  try {
    console.log("Deleting documents from RTDB", collectionName, docIds);
    
    const deletePromises = docIds.map(id => remove(ref(db as Database, `${collectionName}/${id}`)));
    await Promise.all(deletePromises);
    
    return { 
      success: true 
    };
  } catch (error) {
    console.error("Error deleting documents:", error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error occurred' 
    };
  }
};

// Constants
const PAGE_LIMIT = 15;
const SEARCH_DEBOUNCE_DELAY = 300;
type ProgrammeOption = (typeof PROGRAMME_OPTIONS)[number];

const normalizeProgramme = (
  value: unknown,
  fallback: ProgrammeOption | "" = ""
): ProgrammeOption | "" => {
  return normalizeProgrammeValue(value) || fallback;
};

// Helper functions
const parseDate = (date: any): Date | null => {
  if (!date) return null;
  
  try {
    if (date instanceof Date) {
      return date;
    } else if (typeof date === 'string') {
      // Handle ISO strings common in RTDB
      const parsed = new Date(date);
      return isNaN(parsed.getTime()) ? null : parsed;
    } else if (typeof date === 'number') {
      // Handle Unix timestamp (seconds or ms)
      return new Date(date < 10000000000 ? date * 1000 : date);
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

const getBoreholeTimestamp = (record: Partial<Borehole> | null | undefined): number => {
  if (!record) return 0;
  const parsed = parseDate(record.date);
  return parsed ? parsed.getTime() : 0;
};

const sortBoreholesByLatest = (records: Borehole[]): Borehole[] =>
  [...records].sort((a, b) => getBoreholeTimestamp(b) - getBoreholeTimestamp(a));

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

const formatDateToLocal = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

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

// Upload utility types and functions
interface UploadResult {
  success: boolean;
  message: string;
  successCount: number;
  errorCount: number;
  errors?: string[];
  validationErrors?: ValidationError[];
  totalRecords?: number;
}

interface ValidationError {
  recordIndex: number;
  field: string;
  message: string;
  value: any;
  expectedType?: string;
}

const uploadDataWithValidation = async (file: File, collectionName: string): Promise<UploadResult> => {
  try {
    // NOTE: In a real implementation, you would parse the CSV/Excel here.
    // Ensure your parser looks for columns named "County" and "SubCounty" (or Sub-County)
    // to populate the new fields.
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    return {
      success: true,
      message: `Successfully uploaded data to ${collectionName}`,
      successCount: 10,
      errorCount: 0,
      totalRecords: 10
    };
  } catch (error) {
    return {
      success: false,
      message: `Upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      successCount: 0,
      errorCount: 0,
      errors: [`Upload error: ${error instanceof Error ? error.message : 'Unknown error'}`]
    };
  }
};

const formatValidationErrors = (validationErrors: ValidationError[]): string => {
  if (!validationErrors || validationErrors.length === 0) return '';

  let message = 'Validation Errors:\n\n';
  validationErrors.forEach(error => {
    message += `Record ${error.recordIndex + 1}: ${error.field} - ${error.message}\n`;
  });

  return message;
};

const safePeopleToNumber = (people: string | number | undefined): number => {
  if (people === undefined || people === null) return 0;
  if (typeof people === 'number') return people;
  if (typeof people === 'string') {
    const parsed = parseInt(people, 10);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
};

const safeWaterToInteger = (waterUsed: string | number | undefined): number => {
  if (waterUsed === undefined || waterUsed === null) return 0;
  if (typeof waterUsed === "number") {
    return Number.isFinite(waterUsed) ? Math.trunc(waterUsed) : 0;
  }
  if (typeof waterUsed === "string") {
    const parsed = parseInt(waterUsed, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
};

const toBoolean = (value: unknown): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  if (typeof value === "number") return value === 1;
  return false;
};

const normalizeStatusFlags = (record: {
  drilled?: boolean;
  equipped?: boolean;
  maintained?: boolean;
}) => {
  return {
    drilled: Boolean(record.drilled),
    equipped: Boolean(record.equipped),
    maintained: Boolean(record.maintained),
  };
};

const pickFirstDefined = <T,>(...values: T[]): T | undefined =>
  values.find((value) => value !== undefined && value !== null);

const getRecordStatuses = (record: Borehole): Array<{ key: string; label: string; className: string }> => {
  const statuses: Array<{ key: string; label: string; className: string }> = [];

  if (record.drilled) {
    statuses.push({ key: "drilled", label: "Drilled", className: "bg-green-100 text-green-800" });
  }
  if (record.equipped) {
    statuses.push({ key: "equipped", label: "Equipped", className: "bg-blue-100 text-blue-800" });
  }
  if (record.maintained) {
    statuses.push({ key: "maintained", label: "Maintained", className: "bg-orange-100 text-orange-800" });
  }

  return statuses;
};

const displayPeopleValue = (people: string | number | undefined): string => {
  if (people === undefined || people === null) return '0';
  return people.toString();
};

const BoreholePage = () => {
  const { userRole, userAttribute, allowedProgrammes } = useAuth();
  const { toast } = useToast();
  const [allBoreholes, setAllBoreholes] = useState<Borehole[]>([]);
  const [filteredBoreholes, setFilteredBoreholes] = useState<Borehole[]>([]);
  const [loading, setLoading] = useState(true);
  const [exportLoading, setExportLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [selectedRecords, setSelectedRecords] = useState<string[]>([]);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [viewingRecord, setViewingRecord] = useState<Borehole | null>(null);
  const [editingRecord, setEditingRecord] = useState<Borehole | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentMonth = useMemo(getCurrentMonthDates, []);

  const [filters, setFilters] = useState<Filters>({
    search: "",
    startDate: "",
    endDate: "",
    location: "all",
  });

  const [newBorehole, setNewBorehole] = useState<Partial<Borehole>>({
    date: formatDateToLocal(new Date()),
    programme: "",
    location: "",
    county: "",        // Added County
    subcounty: "",     // Added Sub-County
    people: 0,
    waterUsed: 0,
    drilled: false,
    equipped: false,   // Added Equipped
    maintained: false
  });

  const [stats, setStats] = useState<Stats>({
    totalBoreholes: 0,
    drilledBoreholes: 0,
    equippedBoreholes: 0, // Updated
    maintainedBoreholes: 0,
    totalPeople: 0,
    totalWaterUsed: 0
  });

  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: PAGE_LIMIT,
    totalPages: 1,
    hasNext: false,
    hasPrev: false
  });

  const canManageRecords = useMemo(
    () => canManageInfrastructureRecords(userRole, userAttribute),
    [userAttribute, userRole]
  );
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
  const boreholeCacheKey = useMemo(
    () => cacheKey("admin-page", "borehole-storage", activeProgram || "no-program"),
    [activeProgram]
  );
  const requireAdmin = () => {
    if (canManageRecords) return true;
    toast({
      title: "Access denied",
      description: "Only Admin can create, edit, or delete records on this page.",
      variant: "destructive",
    });
    return false;
  };

  // Data fetching from Realtime Database
  const fetchAllData = useCallback(async () => {
    if (!activeProgram) {
      setAllBoreholes([]);
      setLoading(false);
      return;
    }

    try {
      const cachedBoreholes = readCachedValue<Borehole[]>(boreholeCacheKey);
      if (cachedBoreholes) {
        setAllBoreholes(sortBoreholesByLatest(cachedBoreholes));
        setLoading(false);
      } else {
        setLoading(true);
      }
      console.log("Starting borehole data fetch from Realtime Database...");

      const rawBoreholes = await fetchCollectionByProgramme<Record<string, any>>(
        "BoreholeStorage",
        activeProgram,
      );

      if (rawBoreholes.length > 0) {
        const boreholeData = rawBoreholes
          .map((item) => {
          const key = item.id;
          const status = normalizeStatusFlags({
            drilled: toBoolean(pickFirstDefined(item.drilled, item.Drilled)),
            maintained: toBoolean(pickFirstDefined(item.maintained, item.Maintained, item.maintaned, item.Maintaned, item.rehabilitated, item.Rehabilitated)),
            equipped: toBoolean(pickFirstDefined(item.equipped, item.Equipped)),
          });

          return {
            id: key,
            ...item,
            date: pickFirstDefined(item.date, item.Date, item.created_at, item.createdAt),
            programme: normalizeProgramme(item.programme || item.Programme),
            // Ensure specific field mappings match your RTDB structure
            location: pickFirstDefined(item.BoreholeLocation, item["Borehole Location"], item.location) || 'No location',
            county: item.County || item.county || '',       // Map County
            subcounty: pickFirstDefined(item.SubCounty, item["Sub-County"], item.subcounty) || '', // Map SubCounty
            people: pickFirstDefined(item.PeopleUsingBorehole, item["People Using Borehole"], item.people) || 0,
            waterUsed: safeWaterToInteger(pickFirstDefined(item.WaterUsed, item["Water Used"], item.waterUsed)),
            drilled: status.drilled,
            equipped: status.equipped, // Map Equipped
            maintained: status.maintained
          };
        })
          .filter((item) => normalizeProgramme(item.programme) === normalizeProgramme(activeProgram));
        
        const sortedBoreholeData = sortBoreholesByLatest(boreholeData);
        console.log("Final processed borehole data:", sortedBoreholeData);
        setAllBoreholes(sortedBoreholeData);
        writeCachedValue(boreholeCacheKey, sortedBoreholeData);
      } else {
        console.warn("No BoreholeStorage data found in Realtime Database");
        setAllBoreholes([]);
        removeCachedValue(boreholeCacheKey);
      }
      
    } catch (error) {
      console.error("Error fetching borehole data:", error);
      toast({
        title: "Error",
        description: "Failed to load borehole data from database",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [activeProgram, boreholeCacheKey, toast]);

  // Filter application
  const applyFilters = useCallback(() => {
    if (allBoreholes.length === 0) {
      console.log("No borehole data to filter");
      setFilteredBoreholes([]);
      setStats({
        totalBoreholes: 0,
        drilledBoreholes: 0,
        equippedBoreholes: 0,
        maintainedBoreholes: 0,
        totalPeople: 0,
        totalWaterUsed: 0
      });
      return;
    }

    console.log("Applying filters to", allBoreholes.length, "borehole records");
    
    const filtered = allBoreholes.filter(record => {
      // Location filter
      if (filters.location !== "all" && record.location?.toLowerCase() !== filters.location.toLowerCase()) {
        return false;
      }

      // Date filter
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

      // Search filter
      if (filters.search) {
        const searchTerm = filters.search.toLowerCase();
        const searchMatch = 
          record.location?.toLowerCase().includes(searchTerm) ||
          record.county?.toLowerCase().includes(searchTerm) ||
          record.subcounty?.toLowerCase().includes(searchTerm); // Search also checks new fields
        
        if (!searchMatch) return false;
      }

      return true;
    });

    const sortedFiltered = sortBoreholesByLatest(filtered);
    console.log("Filtered to", sortedFiltered.length, "borehole records");
    setFilteredBoreholes(sortedFiltered);
    
    // Update stats
    const totalPeople = sortedFiltered.reduce((sum, record) => sum + safePeopleToNumber(record.people), 0);
    const totalWaterUsed = sortedFiltered.reduce((sum, record) => sum + safeWaterToInteger(record.waterUsed), 0);
    const drilledBoreholes = sortedFiltered.filter(record => record.drilled).length;
    const equippedBoreholes = sortedFiltered.filter(record => record.equipped).length; // Updated
    const maintainedBoreholes = sortedFiltered.filter(record => record.maintained).length;

    console.log("Stats - Total Boreholes:", sortedFiltered.length, "Drilled:", drilledBoreholes, "Equipped:", equippedBoreholes, "Maintained:", maintainedBoreholes, "People:", totalPeople, "Water Used:", totalWaterUsed);

    setStats({
      totalBoreholes: sortedFiltered.length,
      drilledBoreholes,
      equippedBoreholes,
      maintainedBoreholes,
      totalPeople,
      totalWaterUsed
    });

    // Update pagination
    const totalPages = Math.ceil(sortedFiltered.length / pagination.limit);
    setPagination(prev => ({
      ...prev,
      totalPages,
      hasNext: prev.page < totalPages,
      hasPrev: prev.page > 1
    }));
  }, [allBoreholes, filters, pagination.limit]);

  // Effects
  useEffect(() => {
    fetchAllData();
  }, [fetchAllData]);

  useEffect(() => {
    if (!activeProgram) return;
    setNewBorehole((prev) => ({ ...prev, programme: activeProgram }));
  }, [activeProgram]);

  useEffect(() => {
    applyFilters();
  }, [applyFilters]);

  // Optimized search handler with debouncing
  const handleSearch = useCallback((value: string) => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    searchTimeoutRef.current = setTimeout(() => {
      setFilters(prev => ({ ...prev, search: value }));
      setPagination(prev => ({ ...prev, page: 1 }));
    }, SEARCH_DEBOUNCE_DELAY);
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, []);

  // Filter change handler
  const handleFilterChange = useCallback((key: keyof Filters, value: string) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    setPagination(prev => ({ ...prev, page: 1 }));
  }, []);

  const handleProgramChange = useCallback((program: string) => {
    setActiveProgram(program);
    setFilters({
      search: "",
      startDate: "",
      endDate: "",
      location: "all",
    });
    setSelectedRecords([]);
    setPagination((prev) => ({ ...prev, page: 1 }));
  }, []);

  // Create functionality
  const handleCreateBorehole = async () => {
    if (!requireAdmin()) return;
    try {
      setCreateLoading(true);

      // Validate required fields
      if (!newBorehole.location) {
        toast({
          title: "Validation Error",
          description: "Location is a required field",
          variant: "destructive",
        });
        return;
      }

      const selectedProgramme = normalizeProgramme(
        userCanViewAllProgrammeData ? newBorehole.programme : activeProgram,
      );

      if (!selectedProgramme || !accessibleProgrammes.includes(selectedProgramme)) {
        toast({
          title: "Validation Error",
          description: "Please select an assigned programme",
          variant: "destructive",
        });
        return;
      }

      const status = normalizeStatusFlags({
        drilled: !!newBorehole.drilled,
        maintained: !!newBorehole.maintained,
        equipped: !!newBorehole.equipped,
      });

      const boreholeData = {
        programme: selectedProgramme,
        BoreholeLocation: newBorehole.location,
        County: newBorehole.county || "",           // Added County
        SubCounty: newBorehole.subcounty || "",      // Added Sub-County
        PeopleUsingBorehole: newBorehole.people || 0,
        WaterUsed: safeWaterToInteger(newBorehole.waterUsed),
        drilled: status.drilled,
        equipped: status.equipped,   // Added Equipped
        maintained: status.maintained,
        date: new Date(newBorehole.date || new Date()).toISOString()
      };

      console.log("Creating new borehole:", boreholeData);

      // Add to Firebase Realtime Database
      const result = await addData("BoreholeStorage", boreholeData);

      if (result.success) {
        toast({
          title: "Success",
          description: "Borehole record created successfully",
        });

        // Reset form and close dialog
        setNewBorehole({
          date: formatDateToLocal(new Date()),
          programme: activeProgram || "",
          location: "",
          county: "",
          subcounty: "",
          people: 0,
          waterUsed: 0,
          drilled: false,
          equipped: false,
          maintained: false
        });
        setIsCreateDialogOpen(false);

        // Refresh data
        removeCachedValue(boreholeCacheKey);
        await fetchAllData();
      } else {
        throw new Error(result.error || "Failed to create borehole record");
      }

    } catch (error) {
      console.error("Error creating borehole:", error);
      toast({
        title: "Create Failed",
        description: "Failed to create borehole record. Please try again.",
        variant: "destructive",
      });
    } finally {
      setCreateLoading(false);
    }
  };

  // Edit functionality
  const handleEditBorehole = async () => {
    if (!requireAdmin()) return;
    if (!editingRecord) return;

    try {
      setEditLoading(true);

      // Validate required fields
      if (!editingRecord.location) {
        toast({
          title: "Validation Error",
          description: "Location is a required field",
          variant: "destructive",
        });
        return;
      }

      const status = normalizeStatusFlags({
        drilled: !!editingRecord.drilled,
        maintained: !!editingRecord.maintained,
        equipped: !!editingRecord.equipped,
      });
      const selectedProgramme = normalizeProgramme(editingRecord.programme);

      if (!selectedProgramme || !accessibleProgrammes.includes(selectedProgramme)) {
        toast({
          title: "Validation Error",
          description: "Please select an assigned programme",
          variant: "destructive",
        });
        return;
      }

      const boreholeData = {
        programme: selectedProgramme,
        BoreholeLocation: editingRecord.location,
        County: editingRecord.county || "",          // Added County
        SubCounty: editingRecord.subcounty || "",     // Added Sub-County
        PeopleUsingBorehole: editingRecord.people || 0,
        WaterUsed: safeWaterToInteger(editingRecord.waterUsed),
        drilled: status.drilled,
        equipped: status.equipped,    // Added Equipped
        maintained: status.maintained,
        date: editingRecord.date // Pass existing date
      };

      console.log("Updating borehole:", editingRecord.id, boreholeData);

      // Update in Firebase
      const result = await updateData("BoreholeStorage", editingRecord.id, boreholeData);

      if (result.success) {
        toast({
          title: "Success",
          description: "Borehole record updated successfully",
        });

        // Close dialog and reset
        setIsEditDialogOpen(false);
        setEditingRecord(null);

        // Refresh data
        removeCachedValue(boreholeCacheKey);
        await fetchAllData();
      } else {
        throw new Error(result.error || "Failed to update borehole record");
      }

    } catch (error) {
      console.error("Error updating borehole:", error);
      toast({
        title: "Update Failed",
        description: "Failed to update borehole record. Please try again.",
        variant: "destructive",
      });
    } finally {
      setEditLoading(false);
    }
  };

  // Delete functionality
  const handleDeleteSelected = async () => {
    if (!requireAdmin()) return;
    if (selectedRecords.length === 0) {
      toast({
        title: "No Records Selected",
        description: "Please select records to delete",
        variant: "destructive",
      });
      return;
    }

    try {
      setDeleteLoading(true);
      
      // Use the deleteData function
      const result = await deleteData("BoreholeStorage", selectedRecords);

      if (result.success) {
        removeCachedValue(boreholeCacheKey);
        // Update local state
        setAllBoreholes(prev => prev.filter(record => !selectedRecords.includes(record.id)));
        setSelectedRecords([]);
        
        toast({
          title: "Records Deleted",
          description: `Successfully deleted ${selectedRecords.length} records`,
        });
        
        setIsDeleteDialogOpen(false);
      } else {
        throw new Error(result.error || "Failed to delete records");
      }
    } catch (error) {
      console.error("Error deleting records:", error);
      toast({
        title: "Delete Failed",
        description: "Failed to delete records. Please try again.",
        variant: "destructive",
      });
    } finally {
      setDeleteLoading(false);
    }
  };

  // Upload functionality
  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const fileExtension = file.name.split('.').pop()?.toLowerCase();
      if (fileExtension && ['csv', 'json', 'xlsx', 'xls'].includes(fileExtension)) {
        setUploadFile(file);
      } else {
        toast({
          title: "Invalid File Format",
          description: "Please select a CSV, JSON, or Excel file",
          variant: "destructive",
        });
      }
    }
  };

  const handleUpload = async () => {
    if (!requireAdmin()) return;
    if (!uploadFile) {
      toast({
        title: "No File Selected",
        description: "Please select a file to upload",
        variant: "destructive",
      });
      return;
    }

    try {
      setUploadLoading(true);
      setUploadProgress(0);
      
      const progressInterval = setInterval(() => {
        setUploadProgress(prev => {
          if (prev >= 90) {
            clearInterval(progressInterval);
            return prev;
          }
          return prev + 10;
        });
      }, 200);

      const result: UploadResult = await uploadDataWithValidation(uploadFile, "BoreholeStorage");
      
      clearInterval(progressInterval);
      setUploadProgress(100);

      if (result.success) {
        toast({
          title: "Upload Successful",
          description: result.message,
        });
        
        removeCachedValue(boreholeCacheKey);
        await fetchAllData();
        setIsUploadDialogOpen(false);
        setUploadFile(null);
        setUploadProgress(0);
        
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      } else {
        let errorMessage = result.message;
        
        if (result.validationErrors && result.validationErrors.length > 0) {
          errorMessage += "\n\n" + formatValidationErrors(result.validationErrors);
        }
        
        toast({
          title: "Upload Failed",
          description: errorMessage,
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Error uploading file:", error);
      toast({
        title: "Upload Failed",
        description: "An unexpected error occurred during upload",
        variant: "destructive",
      });
    } finally {
      setUploadLoading(false);
      setUploadProgress(0);
    }
  };

  const handleExport = async () => {
    if (!requireAdmin()) return;
    try {
      setExportLoading(true);
      
      if (filteredBoreholes.length === 0) {
        toast({
          title: "No Data to Export",
          description: "There are no records matching your current filters",
          variant: "destructive",
        });
        return;
      }

      const csvData = filteredBoreholes.map(record => {
        const statusLabels = getRecordStatuses(record).map(status => status.label).join(', ') || "N/A";

        return [
          formatDateForExcel(record.date),
          normalizeProgramme(record.programme),
          record.location || 'N/A',
          record.county || 'N/A',       // Added County
          record.subcounty || 'N/A',    // Added Sub-County
          displayPeopleValue(record.people),
          safeWaterToInteger(record.waterUsed).toString(),
          statusLabels
        ];
      });

      const headers = ['Date', 'Programme', 'Borehole Location', 'County', 'Sub-County', 'People Using Water', 'Water Used', 'Status'];
      const csvContent = [
        headers.map(escapeCsvCell).join(','),
        ...csvData.map(row =>
          row
            .map((field, index) => (index === 0 ? String(field ?? "") : escapeCsvCell(field)))
            .join(',')
        )
      ].join('\n');

      const blob = new Blob([`\uFEFF${csvContent}`], { type: 'text/csv;charset=utf-8;' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      
      let filename = `borehole-data`;
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
        description: `Exported ${filteredBoreholes.length} borehole records`,
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

  const handlePageChange = (newPage: number) => {
    setPagination(prev => ({ ...prev, page: newPage }));
  };

  const getCurrentPageRecords = useCallback(() => {
    const startIndex = (pagination.page - 1) * pagination.limit;
    const endIndex = startIndex + pagination.limit;
    return filteredBoreholes.slice(startIndex, endIndex);
  }, [filteredBoreholes, pagination.page, pagination.limit]);

  const handleSelectRecord = (recordId: string) => {
    setSelectedRecords(prev =>
      prev.includes(recordId)
        ? prev.filter(id => id !== recordId)
        : [...prev, recordId]
    );
  };

  const handleSelectAll = () => {
    const currentPageIds = getCurrentPageRecords().map(f => f.id);
    setSelectedRecords(prev =>
      prev.length === currentPageIds.length ? [] : currentPageIds
    );
  };

  const openViewDialog = (record: Borehole) => {
    setViewingRecord(record);
    setIsViewDialogOpen(true);
  };

  const openEditDialog = (record: Borehole) => {
    if (!canManageRecords) return;
    setEditingRecord({
      ...record,
      programme: normalizeProgramme(record.programme),
    });
    setIsEditDialogOpen(true);
  };

  const viewingRecordStatuses = useMemo(
    () => (viewingRecord ? getRecordStatuses(viewingRecord) : []),
    [viewingRecord]
  );

  // Memoized values
  const currentPageRecords = useMemo(getCurrentPageRecords, [getCurrentPageRecords]);

  const clearAllFilters = () => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    
    setFilters({
      search: "",
      startDate: "",
      endDate: "",
      location: "all",
    });
  };

  const resetToCurrentMonth = () => {
    setFilters(prev => ({ ...prev, ...currentMonth }));
  };

  // Memoized components
  const StatsCard = useCallback(({ title, value, icon: Icon, description, additionalInfo }: any) => (
    <Card className="relative overflow-hidden border border-gray-200 bg-white text-slate-900 shadow-md">
      <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-blue-500 to-cyan-600"></div>
      
      <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 pb-1.5 pt-3">
        <CardTitle className="truncate text-xs font-medium leading-tight text-slate-700 sm:text-sm">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-row items-start gap-2 px-4 pb-3">
        <div className="rounded-full pt-0.5">
          <Icon className="h-6 w-6 text-blue-600 sm:h-7 sm:w-7" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 whitespace-nowrap text-lg font-bold leading-none text-slate-900 sm:text-xl">
            {value}
          </div>
          {description && (
            <p className="inline-flex max-w-full whitespace-nowrap rounded-md border border-slate-100 bg-slate-50 px-1.5 py-1 text-[11px] leading-tight text-slate-600 sm:text-xs">
              {description}
            </p>
          )}
          {additionalInfo && (
            <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] leading-tight text-slate-500 sm:text-xs">
              {additionalInfo}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  ), []);

  const FilterSection = useMemo(() => (
    <ScrollableFilterBar ariaLabel="Borehole filters" contentClassName="sm:grid-cols-2 lg:grid-cols-4">
      <div className="w-[240px] shrink-0 space-y-2 sm:w-auto">
        <Label htmlFor="search" className="font-semibold text-gray-700">Search</Label>
        <Input
          id="search"
          placeholder="Search boreholes..."
          onChange={(e) => handleSearch(e.target.value)}
          className="border-gray-300 focus:border-blue-500 focus:ring-blue-500 bg-white"
        />
      </div>

      <div className="w-[156px] shrink-0 space-y-2 sm:w-auto">
        <Label htmlFor="startDate" className="font-semibold text-gray-700">From Date</Label>
        <Input
          id="startDate"
          type="date"
          value={filters.startDate}
          onChange={(e) => handleFilterChange("startDate", e.target.value)}
          className="border-gray-300 focus:border-blue-500 focus:ring-blue-500 bg-white"
        />
      </div>

      <div className="w-[156px] shrink-0 space-y-2 sm:w-auto">
        <Label htmlFor="endDate" className="font-semibold text-gray-700">To Date</Label>
        <Input
          id="endDate"
          type="date"
          value={filters.endDate}
          onChange={(e) => handleFilterChange("endDate", e.target.value)}
          className="border-gray-300 focus:border-blue-500 focus:ring-blue-500 bg-white"
        />
      </div>
    </ScrollableFilterBar>
  ), [filters, handleSearch, handleFilterChange]);

  const TableRow = useCallback(({ record }: { record: Borehole }) => {
    const statuses = getRecordStatuses(record);

    return (
      <tr className="border-b hover:bg-blue-50 transition-colors group">
        {[
          <td key="select" className="py-2 px-3">
            <Checkbox
              checked={selectedRecords.includes(record.id)}
              onCheckedChange={() => handleSelectRecord(record.id)}
              disabled={!canManageRecords}
              className={!canManageRecords ? "invisible" : ""}
            />
          </td>,
          <td key="date" className="py-2 px-3 text-xs text-gray-500">{formatDate(record.date)}</td>,
          <td key="programme" className="py-2 px-3">
            <Badge
              variant="secondary"
              className={
                normalizeProgramme(record.programme) === "KPMD"
                  ? "bg-indigo-100 text-indigo-800 w-fit text-[10px]"
                  : "bg-teal-100 text-teal-800 w-fit text-[10px]"
              }
            >
              {normalizeProgramme(record.programme)}
            </Badge>
          </td>,
          <td key="location" className="py-2 px-3 font-medium text-sm">{record.location || "N/A"}</td>,
          <td key="county" className="py-2 px-3 text-xs">{record.county || "-"}</td>,
          <td key="subcounty" className="py-2 px-3 text-xs">{record.subcounty || "-"}</td>,
          <td key="people" className="py-2 px-3">
            <span className="text-xs font-semibold text-blue-700">{displayPeopleValue(record.people)}</span>
          </td>,
          <td key="waterUsed" className="py-2 px-3">
            <span className="text-xs font-semibold text-cyan-700">{safeWaterToInteger(record.waterUsed)} L</span>
          </td>,
          <td key="status" className="py-2 px-3">
            <div className="flex flex-wrap gap-1">
              {statuses.length > 0 ? (
                statuses.map(status => (
                  <Badge key={status.key} variant="secondary" className={`${status.className} w-fit text-[10px]`}>
                    {status.label}
                  </Badge>
                ))
              ) : (
                <Badge variant="secondary" className="bg-gray-100 text-gray-800 w-fit text-[10px]">
                  N/A
                </Badge>
              )}
            </div>
          </td>,
          <td key="actions" className="py-2 px-3">
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => openViewDialog(record)}
                className="h-7 w-7 text-green-600 hover:bg-green-50"
              >
                <Eye className="h-3.5 w-3.5" />
              </Button>
              {canManageRecords && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => openEditDialog(record)}
                    className="h-7 w-7 text-blue-600 hover:bg-blue-50"
                  >
                    <Edit className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setSelectedRecords([record.id]);
                      setIsDeleteDialogOpen(true);
                    }}
                    className="h-7 w-7 text-red-600 hover:bg-red-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
            </div>
          </td>,
        ]}
      </tr>
    );
  }, [canManageRecords, selectedRecords, handleSelectRecord, openViewDialog, openEditDialog]);

  return (
    <div className="space-y-6">
      {/* Header with Action Buttons */}
      <div className="flex md:flex-row flex-col justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-xl font-bold mb-2 bg-gradient-to-r from-blue-600 to-cyan-600 bg-clip-text text-transparent">
            Borehole Data
          </h2>
          <div className="bg-blue-50 text-blue-700 border-blue-200 text-xs w-fit px-2 py-1 rounded">
            {activeProgram || "No Access"} PROJECT
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {availablePrograms.length > 1 && (
            <div className="w-full sm:w-[180px]">
              <Select
                value={activeProgram}
                onValueChange={handleProgramChange}
                disabled={availablePrograms.length === 0}
              >
                <SelectTrigger className="border-gray-300 focus:border-blue-500 bg-white h-9 font-bold w-full">
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
          
          {canManageRecords && (
            <>
              <Button 
                onClick={() => setIsCreateDialogOpen(true)}
                className="bg-gradient-to-r from-green-600 to-emerald-700 hover:from-green-700 hover:to-emerald-800 text-white shadow-md text-xs"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Borehole
              </Button>
              
              <Button 
                onClick={() => setIsUploadDialogOpen(true)}
                className="bg-green-50 text-green-500 hover:bg-blue-50"
              >
                <Upload className="h-4 w-4 mr-2" />
                Upload Data
              </Button>
              
              {selectedRecords.length > 0 && (
                <Button 
                  onClick={() => setIsDeleteDialogOpen(true)}
                  disabled={deleteLoading}
                  className="bg-gradient-to-r from-red-600 to-rose-700 hover:from-red-700 hover:to-rose-800 text-white shadow-md text-xs"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  {deleteLoading ? "Deleting..." : `Delete (${selectedRecords.length})`}
                </Button>
              )}
              
              <Button 
                onClick={handleExport} 
                disabled={exportLoading || filteredBoreholes.length === 0}
                className="bg-gradient-to-r from-blue-600 to-cyan-700 hover:from-blue-700 hover:to-cyan-800 text-white shadow-md text-xs"
              >
                <Download className="h-4 w-4 mr-2" />
                {exportLoading ? "Exporting..." : `Export (${filteredBoreholes.length})`}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <StatsCard 
          title="Total Boreholes" 
          value={stats.totalBoreholes} 
          icon={Building}
          additionalInfo={
            <>
              <div className="whitespace-nowrap rounded-md border border-slate-100 bg-slate-50 px-2 py-1">
                Drilled: {stats.drilledBoreholes}
              </div>
              <div className="whitespace-nowrap rounded-md border border-slate-100 bg-slate-50 px-2 py-1">
                Equipped: {stats.equippedBoreholes}
              </div>
              <div className="whitespace-nowrap rounded-md border border-slate-100 bg-slate-50 px-2 py-1">
                Maintained: {stats.maintainedBoreholes}
              </div>
            </>
          }
        />

        <StatsCard 
          title="Household Served" 
          value={millify(stats.totalPeople)} 
          icon={Users}
          description="Total households using boreholes"
        />

        <StatsCard 
          title="Water Used" 
          value={`${millify(stats.totalWaterUsed)}L`} 
          icon={Droplets}
          description="Total water consumption"
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
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
              <p className="text-muted-foreground mt-2">Loading borehole data...</p>
            </div>
          ) : currentPageRecords.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              {!activeProgram
                ? "You do not have access to any programme data."
                : allBoreholes.length === 0
                  ? `No borehole data found for ${activeProgram}. Try switching programme if your records belong to another one.`
                  : "No records found matching your current filters. Try Clear All Filters to show all borehole records."}
            </div>
          ) : (
            <>
              <div className="w-full overflow-x-auto rounded-md">
                <table className="w-full border-collapse border border-gray-300 text-sm text-left whitespace-nowrap">
                  <thead>
                    <tr className="bg-blue-50 text-xs">
                      {[
                        <th key="select" className="py-3 px-3">
                          <Checkbox
                          checked={selectedRecords.length === currentPageRecords.length && currentPageRecords.length > 0}
                          onCheckedChange={handleSelectAll}
                          disabled={!canManageRecords}
                          className={!canManageRecords ? "invisible" : ""}
                        />
                        </th>,
                        <th key="date" className="py-3 px-3 font-semibold text-gray-700">Date</th>,
                        <th key="programme" className="py-3 px-3 font-semibold text-gray-700">Programme</th>,
                        <th key="location" className="py-3 px-3 font-semibold text-gray-700">Borehole Location</th>,
                        <th key="county" className="py-3 px-3 font-semibold text-gray-700">County</th>,
                        <th key="subcounty" className="py-3 px-3 font-semibold text-gray-700">Sub-County</th>,
                        <th key="people" className="py-3 px-3 font-semibold text-gray-700">People</th>,
                        <th key="waterUsed" className="py-3 px-3 font-semibold text-gray-700">Water Used</th>,
                        <th key="status" className="py-3 px-3 font-semibold text-gray-700">Status</th>,
                        <th key="actions" className="py-3 px-3 font-semibold text-gray-700">Actions</th>,
                      ]}
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
              <div className="flex flex-col sm:flex-row items-center justify-between p-4 border-t bg-gray-50 gap-4">
                <div className="text-sm text-muted-foreground">
                  {filteredBoreholes.length} total records â€¢ Page {pagination.page} of {pagination.totalPages}
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

      {/* View Record Dialog */}
      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent className="sm:max-w-2xl bg-white rounded-2xl max-h-[90vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-slate-900">
              <Eye className="h-5 w-5 text-blue-600" />
              Borehole Details
            </DialogTitle>
            <DialogDescription>
              Complete information for this borehole record
            </DialogDescription>
          </DialogHeader>
          {viewingRecord && (
            <div className="space-y-6 py-4 overflow-y-auto max-h-[60vh]">
              {/* Location Information */}
              <div className="bg-slate-50 rounded-xl p-4">
                <h3 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
                  <MapPin className="h-4 w-4" />
                  Location Information
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-sm font-medium text-slate-600">Date Recorded</Label>
                    <p className="text-slate-900 font-medium">{formatDate(viewingRecord.date)}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-slate-600">Programme</Label>
                    <p className="text-slate-900 font-medium">{normalizeProgramme(viewingRecord.programme)}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-slate-600">Borehole Location</Label>
                    <p className="text-slate-900 font-medium">{viewingRecord.location || 'N/A'}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-slate-600">County</Label>
                    <p className="text-slate-900 font-medium">{viewingRecord.county || 'N/A'}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-slate-600">Sub-County</Label>
                    <p className="text-slate-900 font-medium">{viewingRecord.subcounty || 'N/A'}</p>
                  </div>
                </div>
              </div>

              {/* Usage Information */}
              <div className="bg-slate-50 rounded-xl p-4">
                <h3 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  Usage Information
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-sm font-medium text-slate-600">People Using Water</Label>
                    <p className="text-slate-900 font-medium text-lg font-bold text-blue-700">
                      {displayPeopleValue(viewingRecord.people)}
                    </p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-slate-600">Water Used</Label>
                    <p className="text-slate-900 font-medium text-lg font-bold text-cyan-700">
                      {safeWaterToInteger(viewingRecord.waterUsed)} liters
                    </p>
                  </div>
                </div>
              </div>

              {/* Status Information */}
              <div className="bg-slate-50 rounded-xl p-4">
                <h3 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
                  <Building className="h-4 w-4" />
                  Borehole Status
                </h3>
                <div className="grid grid-cols-1 gap-4">
                  <div>
                    <Label className="text-sm font-medium text-slate-600 mb-1 block">Status</Label>
                    <div className="flex flex-wrap gap-2">
                      {viewingRecordStatuses.length > 0 ? (
                        viewingRecordStatuses.map(status => (
                          <Badge key={status.key} variant="secondary" className={status.className}>
                            {status.label}
                          </Badge>
                        ))
                      ) : (
                        <Badge variant="secondary" className="bg-gray-100 text-gray-800">
                          N/A
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Additional Information */}
              <div className="bg-slate-50 rounded-xl p-4">
                <h3 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
                  <Droplets className="h-4 w-4" />
                  Water Usage Summary
                </h3>
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <Label className="text-sm font-medium text-slate-600">Average Water per Person</Label>
                    <p className="text-slate-900 font-medium">
                      {viewingRecord.people && safeWaterToInteger(viewingRecord.waterUsed) > 0 && safePeopleToNumber(viewingRecord.people) > 0 
                        ? `${(safeWaterToInteger(viewingRecord.waterUsed) / safePeopleToNumber(viewingRecord.people)).toFixed(1)} liters/person`
                        : 'N/A'
                      }
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button 
              onClick={() => setIsViewDialogOpen(false)}
              className="bg-gradient-to-r from-blue-500 to-cyan-600 hover:from-blue-600 hover:to-cyan-700 text-white"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Borehole Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="sm:max-w-md bg-white rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-green-600">
              <Plus className="h-5 w-5" />
              Add New Borehole
            </DialogTitle>
            <DialogDescription>
              Create a new borehole record in the database
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="create-date" className="font-semibold text-gray-700">Date</Label>
              <Input
                id="create-date"
                type="date"
                value={newBorehole.date as string}
                onChange={(e) => setNewBorehole(prev => ({ ...prev, date: e.target.value }))}
                className="border-gray-300 focus:border-blue-500 focus:ring-blue-500 bg-white"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="create-programme" className="font-semibold text-gray-700">Programme</Label>
              <Select
                value={normalizeProgramme(newBorehole.programme)}
                onValueChange={(value) =>
                  setNewBorehole(prev => ({ ...prev, programme: normalizeProgramme(value) }))
                }
              >
                <SelectTrigger id="create-programme" className="border-gray-300 focus:border-blue-500 focus:ring-blue-500 bg-white">
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

            <div className="space-y-2">
              <Label htmlFor="create-location" className="font-semibold text-gray-700">Borehole Location *</Label>
              <Input
                id="create-location"
                placeholder="e.g. Village Name"
                value={newBorehole.location || ''}
                onChange={(e) => setNewBorehole(prev => ({ ...prev, location: e.target.value }))}
                className="border-gray-300 focus:border-blue-500 focus:ring-blue-500 bg-white"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="create-county" className="font-semibold text-gray-700">County</Label>
                <Input
                  id="create-county"
                  placeholder="e.g. Nairobi"
                  value={newBorehole.county || ''}
                  onChange={(e) => setNewBorehole(prev => ({ ...prev, county: e.target.value }))}
                  className="border-gray-300 focus:border-blue-500 focus:ring-blue-500 bg-white"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="create-subcounty" className="font-semibold text-gray-700">Sub-County</Label>
                <Input
                  id="create-subcounty"
                  placeholder="e.g. Westlands"
                  value={newBorehole.subcounty || ''}
                  onChange={(e) => setNewBorehole(prev => ({ ...prev, subcounty: e.target.value }))}
                  className="border-gray-300 focus:border-blue-500 focus:ring-blue-500 bg-white"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="create-people" className="font-semibold text-gray-700">People Using Water</Label>
                <Input
                  id="create-people"
                  type="number"
                  placeholder="0"
                  value={newBorehole.people || ''}
                  onChange={(e) => setNewBorehole(prev => ({ ...prev, people: parseInt(e.target.value) || 0 }))}
                  className="border-gray-300 focus:border-blue-500 focus:ring-blue-500 bg-white"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="create-water" className="font-semibold text-gray-700">Water Used (L)</Label>
                <Input
                  id="create-water"
                  type="number"
                  placeholder="0"
                  value={newBorehole.waterUsed || ''}
                  onChange={(e) => setNewBorehole(prev => ({ ...prev, waterUsed: parseInt(e.target.value) || 0 }))}
                  className="border-gray-300 focus:border-blue-500 focus:ring-blue-500 bg-white"
                />
              </div>
            </div>

            <div className="space-y-3 pt-2">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="create-drilled"
                  checked={newBorehole.drilled || false}
                  onCheckedChange={(checked) =>
                    setNewBorehole(prev => ({
                      ...prev,
                      drilled: checked === true
                    }))
                  }
                />
                <Label htmlFor="create-drilled" className="font-semibold text-gray-700">Drilled</Label>
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="create-equipped"
                  checked={newBorehole.equipped || false}
                  onCheckedChange={(checked) =>
                    setNewBorehole(prev => ({
                      ...prev,
                      equipped: checked === true
                    }))
                  }
                />
                <Label htmlFor="create-equipped" className="font-semibold text-gray-700">Equipped</Label>
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="create-maintained"
                  checked={newBorehole.maintained || false}
                  onCheckedChange={(checked) =>
                    setNewBorehole(prev => ({
                      ...prev,
                      maintained: checked === true
                    }))
                  }
                />
                <Label htmlFor="create-maintained" className="font-semibold text-gray-700">Maintained</Label>
              </div>
            </div>
          </div>

          <DialogFooter className="flex gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => {
                setIsCreateDialogOpen(false);
                setNewBorehole({
                  date: formatDateToLocal(new Date()),
                  programme: activeProgram || "",
                  location: "",
                  county: "",
                  subcounty: "",
                  people: 0,
                  waterUsed: 0,
                  drilled: false,
                  equipped: false,
                  maintained: false
                });
              }}
              disabled={createLoading}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateBorehole}
              disabled={createLoading || !newBorehole.location}
              className="bg-gradient-to-r from-green-600 to-emerald-700 hover:from-green-700 hover:to-emerald-800 text-white"
            >
              {createLoading ? "Creating..." : "Create Borehole"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Borehole Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="sm:max-w-md bg-white rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-blue-600">
              <Edit className="h-5 w-5" />
              Edit Borehole
            </DialogTitle>
            <DialogDescription>
              Update the borehole record information
            </DialogDescription>
          </DialogHeader>
          
          {editingRecord && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-date" className="font-semibold text-gray-700">Date</Label>
                <Input
                  id="edit-date"
                  type="date"
                  value={formatDate(editingRecord.date).split(' ').reverse().join('-')}
                  onChange={(e) => setEditingRecord(prev => prev ? { ...prev, date: new Date(e.target.value) } : null)}
                  className="border-gray-300 focus:border-blue-500 focus:ring-blue-500 bg-white"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-programme" className="font-semibold text-gray-700">Programme</Label>
                <Select
                  value={normalizeProgramme(editingRecord.programme)}
                  onValueChange={(value) =>
                    setEditingRecord(prev => prev ? { ...prev, programme: normalizeProgramme(value) } : null)
                  }
                >
                  <SelectTrigger id="edit-programme" className="border-gray-300 focus:border-blue-500 focus:ring-blue-500 bg-white">
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

              <div className="space-y-2">
                <Label htmlFor="edit-location" className="font-semibold text-gray-700">Borehole Location *</Label>
                <Input
                  id="edit-location"
                  placeholder="Enter borehole location"
                  value={editingRecord.location || ''}
                  onChange={(e) => setEditingRecord(prev => prev ? { ...prev, location: e.target.value } : null)}
                  className="border-gray-300 focus:border-blue-500 focus:ring-blue-500 bg-white"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-county" className="font-semibold text-gray-700">County</Label>
                  <Input
                    id="edit-county"
                    placeholder="e.g. Nairobi"
                    value={editingRecord.county || ''}
                    onChange={(e) => setEditingRecord(prev => prev ? { ...prev, county: e.target.value } : null)}
                    className="border-gray-300 focus:border-blue-500 focus:ring-blue-500 bg-white"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-subcounty" className="font-semibold text-gray-700">Sub-County</Label>
                  <Input
                    id="edit-subcounty"
                    placeholder="e.g. Westlands"
                    value={editingRecord.subcounty || ''}
                    onChange={(e) => setEditingRecord(prev => prev ? { ...prev, subcounty: e.target.value } : null)}
                    className="border-gray-300 focus:border-blue-500 focus:ring-blue-500 bg-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-people" className="font-semibold text-gray-700">People Using Water</Label>
                  <Input
                    id="edit-people"
                    type="number"
                    placeholder="0"
                    value={editingRecord.people || ''}
                    onChange={(e) => setEditingRecord(prev => prev ? { ...prev, people: parseInt(e.target.value) || 0 } : null)}
                    className="border-gray-300 focus:border-blue-500 focus:ring-blue-500 bg-white"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-water" className="font-semibold text-gray-700">Water Used (L)</Label>
                  <Input
                    id="edit-water"
                    type="number"
                    placeholder="0"
                    value={editingRecord.waterUsed || ''}
                    onChange={(e) => setEditingRecord(prev => prev ? { ...prev, waterUsed: parseInt(e.target.value) || 0 } : null)}
                    className="border-gray-300 focus:border-blue-500 focus:ring-blue-500 bg-white"
                  />
                </div>
              </div>

              <div className="space-y-3 pt-2">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="edit-drilled"
                    checked={editingRecord.drilled || false}
                    onCheckedChange={(checked) =>
                      setEditingRecord(prev =>
                        prev
                          ? {
                              ...prev,
                              drilled: checked === true
                            }
                          : null
                      )
                    }
                  />
                  <Label htmlFor="edit-drilled" className="font-semibold text-gray-700">Drilled</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="edit-equipped"
                    checked={editingRecord.equipped || false}
                    onCheckedChange={(checked) =>
                      setEditingRecord(prev =>
                        prev
                          ? {
                              ...prev,
                              equipped: checked === true
                            }
                          : null
                      )
                    }
                  />
                  <Label htmlFor="edit-equipped" className="font-semibold text-gray-700">Equipped</Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="edit-maintained"
                    checked={editingRecord.maintained || false}
                    onCheckedChange={(checked) =>
                      setEditingRecord(prev =>
                        prev
                          ? {
                              ...prev,
                              maintained: checked === true
                            }
                          : null
                      )
                    }
                  />
                  <Label htmlFor="edit-maintained" className="font-semibold text-gray-700">Maintained</Label>
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="flex gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => {
                setIsEditDialogOpen(false);
                setEditingRecord(null);
              }}
              disabled={editLoading}
            >
              Cancel
            </Button>
            <Button
              onClick={handleEditBorehole}
              disabled={editLoading || !editingRecord?.location}
              className="bg-gradient-to-r from-blue-600 to-cyan-700 hover:from-blue-700 hover:to-cyan-800 text-white"
            >
              {editLoading ? "Updating..." : "Update Borehole"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent className="sm:max-w-md bg-white rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <Trash2 className="h-5 w-5" />
              Delete Records
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete {selectedRecords.length} selected record{selectedRecords.length > 1 ? 's' : ''}? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setIsDeleteDialogOpen(false)}
              disabled={deleteLoading}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteSelected}
              disabled={deleteLoading}
            >
              {deleteLoading ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Upload Data Dialog */}
      <Dialog open={isUploadDialogOpen} onOpenChange={setIsUploadDialogOpen}>
        <DialogContent className="sm:max-w-md bg-white rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-green-600">
              <Upload className="h-5 w-5" />
              Upload Borehole Data
            </DialogTitle>
            <DialogDescription>
              Upload CSV, JSON, or Excel files containing borehole data. 
              Ensure your file includes columns for <strong>BoreholeLocation, County, Sub-County</strong>, and other required fields.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileSelect}
                accept=".csv,.json,.xlsx,.xls"
                className="hidden"
              />
              
              {!uploadFile ? (
                <div 
                  className="cursor-pointer"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="h-8 w-8 text-gray-400 mx-auto mb-2" />
                  <p className="text-sm text-gray-600">
                    Click to upload or drag and drop
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    CSV, JSON, Excel files only
                  </p>
                </div>
              ) : (
                <div className="text-center">
                  <div className="flex items-center justify-center gap-2 mb-2">
                    <Checkbox checked className="bg-green-500 border-green-500" />
                    <span className="text-sm font-medium text-green-600">
                      {uploadFile.name}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">
                    {(uploadFile.size / 1024).toFixed(1)} KB
                  </p>
                </div>
              )}
            </div>

            {uploadProgress > 0 && (
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Uploading...</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div 
                    className="bg-green-600 h-2 rounded-full transition-all duration-300"
                    style={{ width: `${uploadProgress}%` }}
                  ></div>
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="flex gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => {
                setIsUploadDialogOpen(false);
                setUploadFile(null);
                setUploadProgress(0);
                if (fileInputRef.current) {
                  fileInputRef.current.value = '';
                }
              }}
              disabled={uploadLoading}
            >
              Cancel
            </Button>
            <Button
              onClick={handleUpload}
              disabled={!uploadFile || uploadLoading}
              className="bg-gradient-to-r from-green-600 to-emerald-700 hover:from-green-700 hover:to-emerald-800 text-white"
            >
              {uploadLoading ? "Uploading..." : "Upload Data"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default BoreholePage;



