import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { db, ref, push, remove, update, fetchCollectionByProgrammes } from "@/lib/firebase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  canViewAllProgrammes,
  isAdmin,
} from "@/contexts/authhelper";
import { includesProgramme, normalizeProgramme as normalizeProg, resolveAccessibleProgrammes } from "@/lib/programme-access";
import { 
  Users, 
  Plus, 
  Eye,
  Edit,
  Trash2,
  X,
  Search,
  Syringe,
  Activity,
  TrendingUp,
  TrendingDown,
  Download,
  CheckSquare,
  Save,
  User,
  Upload,
  MapPin,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import * as XLSX from 'xlsx'; 
import { cacheKey, readCachedValue, removeCachedValue, writeCachedValue } from "@/lib/data-cache";

// ----------------------------------------------
// Utility: Format large numbers (e.g. 1,200 ? 1.2K, 1,500,000 ? 1.5M)
// ----------------------------------------------
const formatNumber = (num: number): string => {
  if (num == null || !Number.isFinite(num)) return "0";
  const abs = Math.abs(num);
  if (abs >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (abs >= 1_000_000) return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return num.toLocaleString();
};

// ----------------------------------------------
// Types
// ----------------------------------------------
interface FieldOfficer {
  name: string;
  role: string;
}

interface Vaccine {
  type: string;
  doses: number;
}

interface Beneficiary {
  id: string;
  name: string;
  gender: 'Male' | 'Female';
  nationalId: string;
  goats: number;
  sheep: number;
}

interface Issue {
  id: string; 
  name: string;
  raisedBy: string;
  county: string;
  subcounty: string;
  location: string;
  programme: string;
  description: string;
  status: 'responded' | 'not responded';
}

interface AnimalHealthActivity {
  id: string;
  date: string;
  county: string;
  subcounty: string;
  location: string;
  comment: string;
  malebeneficiaries?: number;
  femalebeneficiaries?: number;
  vaccines?: Vaccine[];
  vaccinetype?: string;
  number_doses?: number;
  fieldofficers?: FieldOfficer[];
  issues?: Issue[];
  beneficiaries?: Beneficiary[];
  programme: string;
  createdAt: any;
  createdBy: string;
  status: 'completed';
}

// ----------------------------------------------
// Helpers
// ----------------------------------------------
const safeParseDate = (value: string | number | undefined | null): number => {
  if (!value) return 0;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
};

const getAnimalHealthTimestamp = (
  activity: Partial<AnimalHealthActivity> | null | undefined
): number => {
  if (!activity) return 0;
  const dateValue = safeParseDate(activity.date);
  if (dateValue > 0) return dateValue;
  return safeParseDate(activity.createdAt);
};

const sortAnimalHealthByLatest = (records: AnimalHealthActivity[]): AnimalHealthActivity[] =>
  [...records].sort((a, b) => getAnimalHealthTimestamp(b) - getAnimalHealthTimestamp(a));

const VACCINE_OPTIONS = [
  "PPR", "CCPP", "Sheep and Goat Pox", "Enterotoxemia", "Anthrax",
  "Rift Valley Fever", "Brucellosis", "Foot and Mouth Disease"
];

type ProgrammeView = "ALL" | "KPMD" | "RANGE" | "KPMD 2";
const FARMERS_PER_PAGE = 20;

const normalizeProgramme = (programme: string | null | undefined): string => normalizeProg(programme);

const filterActivitiesByProgrammeAccess = (
  records: AnimalHealthActivity[],
  allowedProgrammes: string[],
  canViewAllProgrammeData: boolean
): AnimalHealthActivity[] => {
  if (canViewAllProgrammeData) return records;
  if (allowedProgrammes.length === 0) return [];

  const allowedProgrammeSet = new Set(allowedProgrammes);
  return records.filter((activity) => allowedProgrammeSet.has(normalizeProgramme(activity.programme)));
};

const toFarmerArray = (records: unknown): Record<string, unknown>[] => {
  if (Array.isArray(records)) {
    return records.filter((record): record is Record<string, unknown> => Boolean(record) && typeof record === "object");
  }
  if (records && typeof records === "object") {
    return Object.values(records as Record<string, unknown>).filter(
      (record): record is Record<string, unknown> => Boolean(record) && typeof record === "object"
    );
  }
  return [];
};

const normalizeFarmers = (
  records: Record<string, unknown>[],
  activityId: string,
  source: "beneficiaries" | "farmers"
): Beneficiary[] =>
  records.map((farmer, index) => {
    const genderRaw = String(farmer.gender || "").toLowerCase();
    const normalizedGender: "Male" | "Female" = genderRaw.startsWith("f") ? "Female" : "Male";
    const fallbackId = `${activityId}-${source}-${index}`;
    const nationalId =
      farmer.nationalId ||
      farmer.idNo ||
      farmer.idNumber ||
      farmer.ID ||
      farmer.identifier ||
      "N/A";
    const goats = farmer.goats ?? farmer.goat ?? farmer.noOfGoats ?? 0;
    const sheep = farmer.sheep ?? farmer.sheeps ?? farmer.noOfSheep ?? 0;

    return {
      id: String(farmer.id || farmer.farmerId || farmer.farmer_id || fallbackId),
      name: String(farmer.name || farmer.farmerName || farmer.fullName || "N/A"),
      gender: normalizedGender,
      nationalId: String(nationalId),
      goats: Number(goats) || 0,
      sheep: Number(sheep) || 0,
    };
  });

const mergeFarmerRecords = (
  rawBeneficiaries: Record<string, unknown>[],
  rawFarmers: Record<string, unknown>[],
  activityId: string
): Beneficiary[] => {
  const merged = [
    ...normalizeFarmers(rawBeneficiaries, activityId, "beneficiaries"),
    ...normalizeFarmers(rawFarmers, activityId, "farmers"),
  ];

  const seen = new Set<string>();
  return merged.filter((farmer) => {
    const key = `${farmer.id}|${farmer.nationalId}|${farmer.name}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const getActivityVaccines = (activity: AnimalHealthActivity): Vaccine[] => activity.vaccines || [];
const getActivityTotalDoses = (activity: AnimalHealthActivity): number => 
  (activity.vaccines || []).reduce((sum, v) => sum + (Number(v.doses) || 0), 0);

const formatDate = (d: string): string => {
  if (!d) return "No date";
  const parsed = new Date(d);
  if (!Number.isFinite(parsed.getTime())) return "Invalid date";
  return parsed.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

// ----------------------------------------------
// Component
// ----------------------------------------------
const AnimalHealthPage = () => {
  const [activities, setActivities] = useState<AnimalHealthActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [isFieldOfficersDialogOpen, setIsFieldOfficersDialogOpen] = useState(false);
  const [selectedActivityFieldOfficers, setSelectedActivityFieldOfficers] = useState<FieldOfficer[]>([]);
  const [viewingActivity, setViewingActivity] = useState<AnimalHealthActivity | null>(null);
  const [editingActivity, setEditingActivity] = useState<AnimalHealthActivity | null>(null);
  const [viewFarmersPage, setViewFarmersPage] = useState(1);
  
  const [fieldOfficerForm, setFieldOfficerForm] = useState({ name: "", role: "" });
  const [fieldOfficers, setFieldOfficers] = useState<FieldOfficer[]>([]);
  
  const [selectedVaccines, setSelectedVaccines] = useState<string[]>([]);
  const [totalDoses, setTotalDoses] = useState<string>("");
  
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([]);
  const [beneficiaryForm, setBeneficiaryForm] = useState({
    name: "",
    gender: "Male" as 'Male' | 'Female',
    nationalId: "",
    goats: "",
    sheep: "",
  });
  
  // FIX: Track whether user manually edited beneficiary counts so we don't
  // overwrite their input when the beneficiaries array changes from an upload.
  const manualCountOverride = useRef(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editFileInputRef = useRef<HTMLInputElement>(null);

  const [issues, setIssues] = useState<Issue[]>([]);
  const [issueForm, setIssueForm] = useState<Partial<Issue>>({
    name: "", raisedBy: "", description: "", status: "not responded",
  });
  
  const [showIssueForm, setShowIssueForm] = useState(false);

  const [activityForm, setActivityForm] = useState({
    date: "", county: "", subcounty: "", location: "",
    malebeneficiaries: "", femalebeneficiaries: "", comment: "", programme: "",
  });
  
  const { user, userRole, userAttribute, allowedProgrammes } = useAuth();
  const { toast } = useToast();

  const [searchTerm, setSearchTerm] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [programmeView, setProgrammeView] = useState<ProgrammeView>("KPMD");
  const [selectedActivities, setSelectedActivities] = useState<string[]>([]);
  const [isSelecting, setIsSelecting] = useState(false);

  // -- Auth / access --
  const userIsAdmin = useMemo(() => isAdmin(userRole), [userRole]);
  const userCanViewAllProgrammeData = useMemo(
    () => canViewAllProgrammes(userRole, userAttribute, allowedProgrammes),
    [allowedProgrammes, userRole, userAttribute],
  );
  const userCanReadAllAnimalHealthProgrammes = userCanViewAllProgrammeData;
  const accessibleProgrammes = useMemo(
    () => resolveAccessibleProgrammes(userCanReadAllAnimalHealthProgrammes, allowedProgrammes),
    [allowedProgrammes, userCanReadAllAnimalHealthProgrammes],
  );
  const hasProgrammeAccess = userCanReadAllAnimalHealthProgrammes || accessibleProgrammes.length > 0;
  const defaultActivityProgramme = accessibleProgrammes[0] || "";
  const defaultProgrammeView = useMemo<ProgrammeView>(
    () => (accessibleProgrammes[0] || "KPMD") as Exclude<ProgrammeView, "ALL">,
    [accessibleProgrammes],
  );
  const animalHealthCacheKey = useMemo(
    () =>
      cacheKey(
        "admin-page",
        "animal-health",
        user?.uid || "anonymous",
        userCanReadAllAnimalHealthProgrammes ? "all" : accessibleProgrammes.join("|") || "no-programme",
      ),
    [accessibleProgrammes, user?.uid, userCanReadAllAnimalHealthProgrammes],
  );

  // -- Helpers --
  const requireAdmin = () => {
    if (userIsAdmin) return true;
    toast({
      title: "Access denied",
      description: "Only Admin can create, edit, or delete records on this page.",
      variant: "destructive",
    });
    return false;
  };

  // -- Auto-sync beneficiary counts (only when NOT manually overridden) --
  useEffect(() => {
    if (manualCountOverride.current) return;
    const maleCount = beneficiaries.filter((b) => b.gender === "Male").length;
    const femaleCount = beneficiaries.filter((b) => b.gender === "Female").length;
    setActivityForm((prev) => ({
      ...prev,
      malebeneficiaries: maleCount.toString(),
      femalebeneficiaries: femaleCount.toString(),
    }));
  }, [beneficiaries]);

  // Sync programme view to valid option when access changes
  useEffect(() => {
    setProgrammeView((prev) => {
      if (userCanReadAllAnimalHealthProgrammes) {
        return prev === "ALL" || includesProgramme(accessibleProgrammes, prev) ? prev : defaultProgrammeView;
      }
      return includesProgramme(accessibleProgrammes, prev) ? prev : defaultProgrammeView;
    });
  }, [accessibleProgrammes, defaultProgrammeView, userCanReadAllAnimalHealthProgrammes]);

  useEffect(() => {
    setActivityForm((prev) => {
      if (!defaultActivityProgramme) {
        return prev.programme ? { ...prev, programme: "" } : prev;
      }

      return includesProgramme(accessibleProgrammes, prev.programme)
        ? prev
        : { ...prev, programme: defaultActivityProgramme };
    });
  }, [accessibleProgrammes, defaultActivityProgramme]);

  // -- Fetch activities --
  const fetchActivities = useCallback(async () => {
    try {
      if (!hasProgrammeAccess) {
        setActivities([]);
        setLoading(false);
        removeCachedValue(animalHealthCacheKey);
        return;
      }

      const cachedActivities = readCachedValue<AnimalHealthActivity[]>(animalHealthCacheKey);
      if (cachedActivities) {
        setActivities(
          sortAnimalHealthByLatest(
            filterActivitiesByProgrammeAccess(
              cachedActivities,
              accessibleProgrammes,
              userCanReadAllAnimalHealthProgrammes,
            ),
          ),
        );
        setLoading(false);
      } else {
        setLoading(true);
      }

      const rawActivities = await fetchCollectionByProgrammes<Record<string, any>>(
        "AnimalHealthActivities",
        accessibleProgrammes,
      );

      if (rawActivities.length > 0) {
        const activitiesData = rawActivities.map((item) => {
          const key = item.id;
          let vaccines: Vaccine[] = [];
          const rawBeneficiaries = toFarmerArray(item.beneficiaries);
          const rawFarmers = toFarmerArray(item.farmers);
          const beneficiariesForView = mergeFarmerRecords(rawBeneficiaries, rawFarmers, key);
          
          if (item.vaccines && Array.isArray(item.vaccines)) {
            vaccines = item.vaccines
              .map((v: any) => ({
                type: v.type || "Unknown",
                doses: Number(v.doses) || 0,
              }))
              .filter((v: Vaccine) => v.type && v.doses > 0);
          } else if (item.vaccinetype) {
            vaccines = [{ type: item.vaccinetype, doses: Number(item.number_doses) || 0 }];
          }
          
          return {
            id: key,
            date: item.date || "",
            county: item.county || "",
            subcounty: item.subcounty || "",
            location: item.location || "",
            comment: item.comment || "",
            malebeneficiaries: Number(item.malebeneficiaries ?? item.maleneneficiaries) || 0,
            femalebeneficiaries: Number(item.femalebeneficiaries) || 0,
            vaccines,
            fieldofficers: Array.isArray(item.fieldofficers) ? item.fieldofficers : [],
            issues: Array.isArray(item.issues) ? item.issues : [],
            beneficiaries: beneficiariesForView,
            programme: normalizeProgramme(item.programme ?? item.Programme),
            createdAt: item.createdAt,
            createdBy: item.createdBy || "unknown",
            status: item.status || "completed",
          } as AnimalHealthActivity;
        });
        
        const sorted = sortAnimalHealthByLatest(
          filterActivitiesByProgrammeAccess(
            activitiesData,
            accessibleProgrammes,
            userCanReadAllAnimalHealthProgrammes,
          ),
        );
        setActivities(sorted);
        writeCachedValue(animalHealthCacheKey, sorted);
      } else {
        setActivities([]);
        removeCachedValue(animalHealthCacheKey);
      }
    } catch (error) {
      console.error("Error fetching:", error);
      toast({ title: "Error", description: "Failed to load activities", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [accessibleProgrammes, animalHealthCacheKey, hasProgrammeAccess, toast, userCanReadAllAnimalHealthProgrammes]);

  useEffect(() => {
    void fetchActivities();
  }, [fetchActivities]);

  // -- Beneficiary handlers --
  const handleAddBeneficiary = () => {
    if (!beneficiaryForm.name || !beneficiaryForm.nationalId) {
      toast({ title: "Missing Info", description: "Please provide Name and National ID.", variant: "destructive" });
      return;
    }
    const newBeneficiary: Beneficiary = {
      id: Date.now().toString() + Math.random().toString(36).substring(2, 7),
      name: beneficiaryForm.name,
      gender: beneficiaryForm.gender,
      nationalId: beneficiaryForm.nationalId,
      goats: parseInt(beneficiaryForm.goats) || 0,
      sheep: parseInt(beneficiaryForm.sheep) || 0,
    };
    setBeneficiaries((prev) => [...prev, newBeneficiary]);
    // Reset manual override since beneficiaries changed programmatically
    manualCountOverride.current = false;
    setBeneficiaryForm({ name: "", gender: "Male", nationalId: "", goats: "", sheep: "" });
  };

  const handleRemoveBeneficiary = (id: string) => {
    setBeneficiaries((prev) => prev.filter((b) => b.id !== id));
    manualCountOverride.current = false;
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: "binary" });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const data = XLSX.utils.sheet_to_json(ws);

        if (data.length === 0) {
          toast({ title: "Empty File", description: "No data found in the file.", variant: "destructive" });
          return;
        }

        const mappedData: Beneficiary[] = data.map((row: any, index: number) => {
          const getVal = (keys: string[]) => {
            for (const key of keys) {
              const found = Object.keys(row).find(
                (k) => k.toLowerCase().trim() === key.toLowerCase().trim(),
              );
              if (found) return row[found];
            }
            return undefined;
          };

          const genderRaw = getVal(["gender", "sex"]);
          let gender: "Male" | "Female" = "Male";
          if (genderRaw) {
            const gStr = String(genderRaw).toLowerCase();
            if (gStr.startsWith("f") || gStr === "female") gender = "Female";
          }

          return {
            id: `upload-${Date.now()}-${index}`,
            name: String(
              getVal(["name", "full name", "farmer name", "beneficiary"]) || "Unknown",
            ),
            gender,
            nationalId: String(
              getVal(["nationalid", "national id", "id", "id number", "idno"]) || "N/A",
            ),
            goats: Number(getVal(["goats", "goat", "no of goats"])) || 0,
            sheep: Number(getVal(["sheep", "sheeps", "no of sheep"])) || 0,
          };
        });

        setBeneficiaries((prev) => [...prev, ...mappedData]);
        manualCountOverride.current = false;
        toast({
          title: "Success",
          description: `${mappedData.length} farmers imported successfully.`,
        });
      } catch (error) {
        console.error("Parse error:", error);
        toast({
          title: "Error",
          description: "Failed to parse file. Ensure it is a valid CSV or Excel file.",
          variant: "destructive",
        });
      }
    };
    reader.readAsBinaryString(file);
    // Reset file input so the same file can be re-uploaded
    if (e.target) e.target.value = "";
  };

  // -- Issue handlers --
  const handleAddIssue = () => {
    if (!issueForm.name || !issueForm.raisedBy || !issueForm.description) {
      toast({
        title: "Missing Info",
        description: "Please fill Name, Raised By, and Description.",
        variant: "destructive",
      });
      return;
    }
    const newIssue: Issue = {
      id: Date.now().toString(),
      name: issueForm.name,
      raisedBy: issueForm.raisedBy,
      county: activityForm.county,
      subcounty: activityForm.subcounty,
      location: activityForm.location,
      programme: activityForm.programme,
      description: issueForm.description,
      status: issueForm.status || "not responded",
    };
    setIssues((prev) => [...prev, newIssue]);
    setIssueForm((prev) => ({ ...prev, name: "", description: "", status: "not responded" }));
  };

  const handleRemoveIssue = (issueId: string) =>
    setIssues((prev) => prev.filter((i) => i.id !== issueId));

  // -- Field Officer handlers --
  const handleAddFieldOfficer = () => {
    if (fieldOfficerForm.name.trim() && fieldOfficerForm.role.trim()) {
      setFieldOfficers((prev) => [
        ...prev,
        { name: fieldOfficerForm.name.trim(), role: fieldOfficerForm.role.trim() },
      ]);
      setFieldOfficerForm({ name: "", role: "" });
    }
  };
  const removeFieldOfficer = (index: number) =>
    setFieldOfficers((prev) => prev.filter((_, i) => i !== index));

  // -- Vaccine helpers --
  const handleVaccineSelection = (vaccineType: string) => {
    setSelectedVaccines((prev) =>
      prev.includes(vaccineType) ? prev.filter((v) => v !== vaccineType) : [...prev, vaccineType],
    );
  };

  const getVaccinesFromSelection = (): Vaccine[] => {
    const parsedTotal = parseInt(totalDoses);
    if (selectedVaccines.length === 0 || !totalDoses || parsedTotal <= 0) return [];
    const dosesPerVaccine = Math.floor(parsedTotal / selectedVaccines.length);
    const remainder = parsedTotal % selectedVaccines.length;
    return selectedVaccines.map((type, index) => ({
      type,
      doses: index === 0 ? dosesPerVaccine + remainder : dosesPerVaccine,
    }));
  };

  // -- Form reset --
  const resetForms = () => {
    setActivityForm({
      date: "", county: "", subcounty: "", location: "",
      malebeneficiaries: "", femalebeneficiaries: "", comment: "", programme: defaultActivityProgramme,
    });
    setFieldOfficers([]);
    setFieldOfficerForm({ name: "", role: "" });
    setSelectedVaccines([]);
    setTotalDoses("");
    setIssues([]);
    setBeneficiaries([]);
    setBeneficiaryForm({ name: "", gender: "Male", nationalId: "", goats: "", sheep: "" });
    setIssueForm({ name: "", raisedBy: "", description: "", status: "not responded" });
    setShowIssueForm(false);
    manualCountOverride.current = false;
  };

  // -- CRUD operations --
  const handleAddActivity = async () => {
    if (!requireAdmin()) return;
    if (fieldOfficers.length === 0) {
      toast({ title: "Error", description: "Add at least one field officer", variant: "destructive" });
      return;
    }
    if (selectedVaccines.length === 0) {
      toast({ title: "Error", description: "Select at least one vaccine", variant: "destructive" });
      return;
    }
    if (!totalDoses || parseInt(totalDoses) <= 0) {
      toast({ title: "Error", description: "Enter valid total doses", variant: "destructive" });
      return;
    }
    if (!activityForm.date || !activityForm.county || !activityForm.location || !includesProgramme(accessibleProgrammes, activityForm.programme)) {
      toast({ title: "Error", description: "Fill Date, County, Location, and Programme", variant: "destructive" });
      return;
    }

    try {
      const vaccines = getVaccinesFromSelection();
      const activityData = {
        ...activityForm,
        county: activityForm.county.trim(),
        subcounty: activityForm.subcounty.trim(),
        location: activityForm.location.trim(),
        malebeneficiaries: Number(activityForm.malebeneficiaries) || 0,
        femalebeneficiaries: Number(activityForm.femalebeneficiaries) || 0,
        comment: activityForm.comment.trim(),
        vaccines,
        fieldofficers: fieldOfficers,
        issues,
        beneficiaries,
        status: "completed" as const,
        createdBy: user?.email || "unknown",
        createdAt: new Date().toISOString(),
      };
      await push(ref(db, "AnimalHealthActivities"), activityData);
      toast({ title: "Success", description: "Activity recorded.", className: "bg-green-50 text-green-800" });
      setIsAddDialogOpen(false);
      resetForms();
      removeCachedValue(animalHealthCacheKey);
      fetchActivities();
    } catch (error) {
      console.error(error);
      toast({ title: "Error", description: "Failed to record activity.", variant: "destructive" });
    }
  };

  const handleEditActivity = async () => {
    if (!requireAdmin()) return;
    if (!editingActivity) return;
    try {
      const vaccines = getVaccinesFromSelection();
      const activityData = {
        ...activityForm,
        county: activityForm.county.trim(),
        subcounty: activityForm.subcounty.trim(),
        location: activityForm.location.trim(),
        malebeneficiaries: Number(activityForm.malebeneficiaries) || 0,
        femalebeneficiaries: Number(activityForm.femalebeneficiaries) || 0,
        comment: activityForm.comment.trim(),
        vaccines,
        fieldofficers: fieldOfficers,
        issues,
        beneficiaries,
      };
      await update(ref(db, `AnimalHealthActivities/${editingActivity.id}`), activityData);
      toast({ title: "Success", description: "Activity updated.", className: "bg-green-50 text-green-800" });
      setIsEditDialogOpen(false);
      resetForms();
      removeCachedValue(animalHealthCacheKey);
      fetchActivities();
    } catch (error) {
      console.error(error);
      toast({ title: "Error", description: "Failed to update.", variant: "destructive" });
    }
  };

  const handleDeleteActivity = async (activityId: string) => {
    if (!requireAdmin()) return;
    try {
      await remove(ref(db, `AnimalHealthActivities/${activityId}`));
      toast({ title: "Success", description: "Deleted." });
      removeCachedValue(animalHealthCacheKey);
      fetchActivities();
    } catch (error) {
      toast({ title: "Error", description: "Failed.", variant: "destructive" });
    }
  };

  const handleDeleteMultipleActivities = async () => {
    if (!requireAdmin()) return;
    if (selectedActivities.length === 0) return;
    try {
      await Promise.all(
        selectedActivities.map((id) => remove(ref(db, `AnimalHealthActivities/${id}`))),
      );
      toast({ title: "Success", description: `${selectedActivities.length} deleted.` });
      removeCachedValue(animalHealthCacheKey);
      setSelectedActivities([]);
      setIsSelecting(false);
      fetchActivities();
    } catch (error) {
      toast({ title: "Error", description: "Failed.", variant: "destructive" });
    }
  };

  // -- Selection --
  const toggleActivitySelection = (activityId: string) => {
    setSelectedActivities((prev) =>
      prev.includes(activityId) ? prev.filter((id) => id !== activityId) : [...prev, activityId],
    );
  };
  const selectAllActivities = () => {
    setSelectedActivities((prev) =>
      prev.length === displayedActivities.length ? [] : displayedActivities.map((a) => a.id),
    );
  };

  // -- Dialog openers --
  const openViewDialog = (activity: AnimalHealthActivity) => {
    setViewingActivity(activity);
    setViewFarmersPage(1);
    setIsViewDialogOpen(true);
  };
  const openFieldOfficersDialog = (fo: FieldOfficer[] = []) => {
    setSelectedActivityFieldOfficers(fo);
    setIsFieldOfficersDialogOpen(true);
  };

  const handleAddDialogOpenChange = (open: boolean) => {
    setIsAddDialogOpen(open);
    if (open) resetForms();
  };

  // --------------------------------------------
  // CALCULATIONS FOR STATS
  // --------------------------------------------
  const statsActivities = useMemo(() => {
    if (programmeView === "ALL") return activities;
    return activities.filter((a) => a.programme === programmeView);
  }, [activities, programmeView]);

  const totalDosesAdministered = useMemo(
    () => statsActivities.reduce((s, a) => s + getActivityTotalDoses(a), 0),
    [statsActivities],
  );

  // Regional coverage: unique counties
  const regionalCoverage = useMemo(() => {
    const counties = new Set<string>();
    statsActivities.forEach((a) => {
      if (a.county) counties.add(a.county.trim());
    });
    return counties.size;
  }, [statsActivities]);

  // Unique locations (subcounty + location pairs)
  const uniqueLocations = useMemo(() => {
    const locs = new Set<string>();
    statsActivities.forEach((a) => {
      if (a.location) locs.add(`${a.subcounty?.trim() || ""}-${a.location.trim()}`);
    });
    return locs.size;
  }, [statsActivities]);

  // Beneficiary Calculations
  const totalMaleBeneficiaries = useMemo(
    () => statsActivities.reduce((sum, a) => sum + (a.malebeneficiaries || 0), 0),
    [statsActivities],
  );
  const totalFemaleBeneficiaries = useMemo(
    () => statsActivities.reduce((sum, a) => sum + (a.femalebeneficiaries || 0), 0),
    [statsActivities],
  );
  const totalBeneficiaries = useMemo(
    () => totalMaleBeneficiaries + totalFemaleBeneficiaries,
    [totalMaleBeneficiaries, totalFemaleBeneficiaries],
  );

  // Vaccination rate (compare last two activities by date)
  const vaccinationRate = useMemo(() => {
    if (statsActivities.length < 2)
      return { rate: 0, trend: "neutral" as const, currentDoses: 0, previousDoses: 0 };
    const sorted = [...statsActivities].sort(
      (a, b) => getAnimalHealthTimestamp(b) - getAnimalHealthTimestamp(a),
    );
    const curr = sorted[0];
    const prev = sorted[1];
    const currD = getActivityTotalDoses(curr);
    const prevD = getActivityTotalDoses(prev);
    if (prevD === 0)
      return {
        rate: currD > 0 ? 100 : 0,
        trend: (currD > 0 ? "up" : "neutral") as "up" | "down" | "neutral",
        currentDoses: currD,
        previousDoses: prevD,
      };
    const rate = Math.round(((currD - prevD) / prevD) * 100);
    return {
      rate,
      trend: (rate > 0 ? "up" : rate < 0 ? "down" : "neutral") as "up" | "down" | "neutral",
      currentDoses: currD,
      previousDoses: prevD,
    };
  }, [statsActivities]);

  // -- Filtering --
  const filteredActivities = useMemo(
    () =>
      activities.filter((activity) => {
        const vacs = getActivityVaccines(activity);
        const s = searchTerm.toLowerCase();
        const matchSearch =
          (activity.comment?.toLowerCase() || "").includes(s) ||
          (activity.location?.toLowerCase() || "").includes(s) ||
          (activity.county?.toLowerCase() || "").includes(s) ||
          (activity.programme?.toLowerCase() || "").includes(s) ||
          vacs.some((v) => (v.type?.toLowerCase() || "").includes(s));
        const matchIssue = (activity.issues || []).some(
          (i) => i.name?.toLowerCase().includes(s) || i.raisedBy?.toLowerCase().includes(s),
        );
        const aDate = activity.date ? new Date(activity.date) : new Date(0);
        const matchStart = !startDate || aDate >= new Date(startDate);
        const matchEnd = !endDate || aDate <= new Date(endDate + "T23:59:59");
        return (matchSearch || matchIssue) && matchStart && matchEnd;
      }),
    [activities, searchTerm, startDate, endDate],
  );

  const activitiesByProgramme = useMemo(
    () => ({
      KPMD: filteredActivities.filter((a) => a.programme === "KPMD"),
      RANGE: filteredActivities.filter((a) => a.programme === "RANGE"),
      "KPMD 2": filteredActivities.filter((a) => a.programme === "KPMD 2"),
    }),
    [filteredActivities],
  );

  const displayedActivities = useMemo(() => {
    if (programmeView === "ALL") return filteredActivities;
    return activitiesByProgramme[programmeView];
  }, [activitiesByProgramme, filteredActivities, programmeView]);

  // Prune selected IDs when they go out of view
  useEffect(() => {
    const visibleIds = new Set(displayedActivities.map((a) => a.id));
    setSelectedActivities((prev) => prev.filter((id) => visibleIds.has(id)));
  }, [displayedActivities]);

  // -- Edit dialog --
  const openEditDialog = (activity: AnimalHealthActivity) => {
    if (!userIsAdmin) return;
    setEditingActivity(activity);
    setActivityForm({
      date: activity.date || "",
      county: activity.county || "",
      subcounty: activity.subcounty || "",
      location: activity.location || "",
      malebeneficiaries: (activity.malebeneficiaries || 0).toString(),
      femalebeneficiaries: (activity.femalebeneficiaries || 0).toString(),
      comment: activity.comment || "",
      programme: includesProgramme(accessibleProgrammes, activity.programme)
        ? activity.programme
        : defaultActivityProgramme,
    });
    setFieldOfficers(activity.fieldofficers || []);
    const aVacs = getActivityVaccines(activity);
    setSelectedVaccines(aVacs.map((v) => v.type));
    setTotalDoses(getActivityTotalDoses(activity).toString());
    setIssues(activity.issues || []);
    setBeneficiaries(activity.beneficiaries || []);
    setShowIssueForm(false);
    manualCountOverride.current = true; // Editing � don't auto-sync until user adds/removes
    setIsEditDialogOpen(true);
  };

  // -- Export --
  const exportToCSV = () => {
    try {
      const headers = [
        "Date", "Programme", "County", "Subcounty", "Location",
        "Male Ben.", "Female Ben.", "Total Goats", "Total Sheep",
        "Vaccines", "Total Doses", "Field Officers", "Issues", "Comment",
      ];
      const csvData = displayedActivities.map((a) => {
        const vText = getActivityVaccines(a).map((v) => `${v.type}(${v.doses})`).join(";");
        const iText = (a.issues || []).map((i) => `${i.name}(${i.status})`).join(";");
        const tGoats = (a.beneficiaries || []).reduce((s, b) => s + (b.goats || 0), 0);
        const tSheep = (a.beneficiaries || []).reduce((s, b) => s + (b.sheep || 0), 0);
        return [
          formatDate(a.date), a.programme, a.county, a.subcounty, a.location,
          a.malebeneficiaries, a.femalebeneficiaries, tGoats, tSheep,
          vText, getActivityTotalDoses(a),
          (a.fieldofficers || []).map((o) => `${o.name}(${o.role})`).join(";"),
          iText, a.comment,
        ];
      });
      const csvContent = [
        headers.join(","),
        ...csvData.map((r) => r.map((f) => `"${f}"`).join(",")),
      ].join("\n");
      const blob = new Blob([csvContent], { type: "text/csv" });
      const link = document.createElement("a");
      link.href = window.URL.createObjectURL(blob);
      const programmeSuffix = programmeView === "ALL" ? "all-programmes" : programmeView.toLowerCase();
      link.download = `vaccination-${programmeSuffix}-${new Date().toISOString().split("T")[0]}.csv`;
      link.click();
      window.URL.revokeObjectURL(link.href);
      toast({ title: "Success", description: "Exported" });
    } catch (e) {
      toast({ title: "Error", description: "Export failed", variant: "destructive" });
    }
  };

  // -- Render helpers --
  const renderVaccinesInTable = (activity: AnimalHealthActivity) => {
    const v = getActivityVaccines(activity);
    if (v.length === 0) return "None";
    if (v.length === 1) return `${v[0].type} (${v[0].doses})`;
    return `${v.length} types`;
  };

  const isSaveDisabled =
    fieldOfficers.length === 0 ||
    selectedVaccines.length === 0 ||
    !totalDoses ||
    parseInt(totalDoses) <= 0 ||
    !activityForm.date ||
    !activityForm.county ||
    !activityForm.location ||
    !includesProgramme(accessibleProgrammes, activityForm.programme);

  // -- View dialog pagination --
  const viewingFarmers = viewingActivity?.beneficiaries || [];
  const totalViewFarmerPages = Math.max(1, Math.ceil(viewingFarmers.length / FARMERS_PER_PAGE));
  const safeViewFarmersPage = Math.min(viewFarmersPage, totalViewFarmerPages);
  const paginatedViewingFarmers = viewingFarmers.slice(
    (safeViewFarmersPage - 1) * FARMERS_PER_PAGE,
    safeViewFarmersPage * FARMERS_PER_PAGE,
  );

  // Dynamic colSpan for the table (accounts for the checkbox column)
  const baseColCount = 5; // Date, Location, Doses, Team, Actions
  const tableColSpan = isSelecting ? baseColCount + 1 : baseColCount;

  // --------------------------------------------
  // RENDER
  // --------------------------------------------
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100/80 p-4 sm:p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* --- Header --- */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-xl font-bold text-slate-900">Animal Health Management</h1>
          <Dialog open={isAddDialogOpen} onOpenChange={handleAddDialogOpenChange}>
            <DialogTrigger asChild>
              {userIsAdmin && (
                <Button className="bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white">
                  <Plus className="h-4 w-4 mr-2" /> Record Vaccination
                </Button>
              )}
            </DialogTrigger>
            <DialogContent className="sm:max-w-[900px] bg-white rounded-2xl border-0 shadow-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="text-lg font-semibold text-slate-900">
                  Record New Vaccination Activity
                </DialogTitle>
              </DialogHeader>
              {/* ADD FORM CONTENT */}
              <div className="grid gap-6 py-4">
                {/* Basic Info */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>
                      Date <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      type="date"
                      value={activityForm.date}
                      onChange={(e) => setActivityForm({ ...activityForm, date: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>
                      Programme <span className="text-red-500">*</span>
                    </Label>
                    <Select
                      value={activityForm.programme}
                      onValueChange={(v) => setActivityForm({ ...activityForm, programme: v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {accessibleProgrammes.map((p) => (
                          <SelectItem key={p} value={p}>
                            {p}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>
                      County <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      value={activityForm.county}
                      onChange={(e) => setActivityForm({ ...activityForm, county: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Subcounty</Label>
                    <Input
                      value={activityForm.subcounty}
                      onChange={(e) => setActivityForm({ ...activityForm, subcounty: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>
                      Location <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      value={activityForm.location}
                      onChange={(e) => setActivityForm({ ...activityForm, location: e.target.value })}
                    />
                  </div>
                </div>

                {/* Beneficiaries Counts */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Male Beneficiaries</Label>
                    <Input
                      type="number"
                      value={activityForm.malebeneficiaries}
                      onChange={(e) => {
                        manualCountOverride.current = true;
                        setActivityForm({ ...activityForm, malebeneficiaries: e.target.value });
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Female Beneficiaries</Label>
                    <Input
                      type="number"
                      value={activityForm.femalebeneficiaries}
                      onChange={(e) => {
                        manualCountOverride.current = true;
                        setActivityForm({ ...activityForm, femalebeneficiaries: e.target.value });
                      }}
                    />
                  </div>
                </div>

                {/* Vaccines */}
                <div className="space-y-2">
                  <Label>
                    Vaccines <span className="text-red-500">*</span>
                  </Label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                    {VACCINE_OPTIONS.map((vaccine) => (
                      <div key={vaccine} className="flex items-center space-x-2">
                        <Checkbox
                          id={`vaccine-${vaccine}`}
                          checked={selectedVaccines.includes(vaccine)}
                          onCheckedChange={() => handleVaccineSelection(vaccine)}
                        />
                        <Label htmlFor={`vaccine-${vaccine}`} className="text-xs">
                          {vaccine}
                        </Label>
                      </div>
                    ))}
                  </div>
                  <Input
                    type="number"
                    placeholder="Total Doses"
                    value={totalDoses}
                    onChange={(e) => setTotalDoses(e.target.value)}
                    className="mt-2"
                  />
                </div>

                {/* Farmers Upload */}
                <div className="space-y-2 border p-4 rounded-xl bg-blue-50/30">
                  <div className="flex justify-between items-center mb-2">
                    <Label className="font-semibold text-blue-900">
                      Farmers ({beneficiaries.length})
                    </Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="text-blue-600 border-blue-600"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="h-3 w-3 mr-1" /> Upload Excel
                    </Button>
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileUpload}
                      className="hidden"
                      accept=".csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel"
                    />
                  </div>
                  {/* Manual Add Form */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                    <Input
                      placeholder="Name"
                      value={beneficiaryForm.name}
                      onChange={(e) =>
                        setBeneficiaryForm({ ...beneficiaryForm, name: e.target.value })
                      }
                      className="h-8"
                    />
                    <Select
                      value={beneficiaryForm.gender}
                      onValueChange={(v: any) =>
                        setBeneficiaryForm({ ...beneficiaryForm, gender: v })
                      }
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Male">Male</SelectItem>
                        <SelectItem value="Female">Female</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      placeholder="ID"
                      value={beneficiaryForm.nationalId}
                      onChange={(e) =>
                        setBeneficiaryForm({ ...beneficiaryForm, nationalId: e.target.value })
                      }
                      className="h-8"
                    />
                    <Input
                      placeholder="Goats"
                      type="number"
                      value={beneficiaryForm.goats}
                      onChange={(e) =>
                        setBeneficiaryForm({ ...beneficiaryForm, goats: e.target.value })
                      }
                      className="h-8"
                    />
                    <Input
                      placeholder="Sheep"
                      type="number"
                      value={beneficiaryForm.sheep}
                      onChange={(e) =>
                        setBeneficiaryForm({ ...beneficiaryForm, sheep: e.target.value })
                      }
                      className="h-8"
                    />
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleAddBeneficiary}
                      className="h-8 bg-blue-600"
                    >
                      Add
                    </Button>
                  </div>
                  {/* Farmer List */}
                  <div className="max-h-32 overflow-y-auto mt-2 space-y-1">
                    {beneficiaries.map((b) => (
                      <div
                        key={b.id}
                        className="flex justify-between items-center bg-white p-1 px-2 rounded border text-xs"
                      >
                        <span>
                          {b.name} ({b.gender}) - {b.nationalId}
                        </span>
                        <span>
                          G: {b.goats} S: {b.sheep}
                        </span>
                        <X
                          className="h-3 w-3 cursor-pointer text-red-500"
                          onClick={() => handleRemoveBeneficiary(b.id)}
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {/* Field Officers */}
                <div className="space-y-2">
                  <Label>
                    Vaccination Team <span className="text-red-500">*</span>
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Name"
                      value={fieldOfficerForm.name}
                      onChange={(e) =>
                        setFieldOfficerForm({ ...fieldOfficerForm, name: e.target.value })
                      }
                    />
                    <Input
                      placeholder="Role"
                      value={fieldOfficerForm.role}
                      onChange={(e) =>
                        setFieldOfficerForm({ ...fieldOfficerForm, role: e.target.value })
                      }
                    />
                    <Button
                      type="button"
                      onClick={handleAddFieldOfficer}
                      className="bg-green-600"
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {fieldOfficers.map((fo, i) => (
                      <Badge key={i} variant="outline" className="py-1 px-2">
                        {fo.name} ({fo.role}){" "}
                        <X
                          className="h-3 w-3 ml-1 cursor-pointer"
                          onClick={() => removeFieldOfficer(i)}
                        />
                      </Badge>
                    ))}
                  </div>
                </div>

                {/* Issues */}
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <Label>Issues (Optional)</Label>
                    {!showIssueForm && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setShowIssueForm(true)}
                      >
                        Add Issue
                      </Button>
                    )}
                  </div>
                  {showIssueForm && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 border p-2 rounded bg-slate-50">
                      <Input
                        placeholder="Issue Name"
                        value={issueForm.name}
                        onChange={(e) => setIssueForm({ ...issueForm, name: e.target.value })}
                      />
                      <Input
                        placeholder="Raised By"
                        value={issueForm.raisedBy}
                        onChange={(e) => setIssueForm({ ...issueForm, raisedBy: e.target.value })}
                      />
                      <Textarea
                        placeholder="Description"
                        className="col-span-2"
                        value={issueForm.description}
                        onChange={(e) =>
                          setIssueForm({ ...issueForm, description: e.target.value })
                        }
                      />
                      <Button
                        type="button"
                        size="sm"
                        onClick={handleAddIssue}
                        className="bg-orange-500 col-span-2"
                      >
                        Save Issue
                      </Button>
                    </div>
                  )}
                  {issues.map((iss) => (
                    <div
                      key={iss.id}
                      className="text-xs bg-white border p-2 rounded flex justify-between items-center"
                    >
                      <span>
                        <b>{iss.name}</b> - {iss.status}
                      </span>
                      <X
                        className="h-3 w-3 cursor-pointer"
                        onClick={() => handleRemoveIssue(iss.id)}
                      />
                    </div>
                  ))}
                </div>

                <div className="space-y-2">
                  <Label>Comment</Label>
                  <Textarea
                    value={activityForm.comment}
                    onChange={(e) => setActivityForm({ ...activityForm, comment: e.target.value })}
                    placeholder="Observations..."
                  />
                </div>

                <div className="flex justify-end gap-3 pt-4">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setIsAddDialogOpen(false);
                      resetForms();
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleAddActivity}
                    disabled={isSaveDisabled}
                    className="bg-gradient-to-r from-green-500 to-emerald-600 text-white"
                  >
                    <Save className="h-4 w-4 mr-2" /> Save Activity
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* --- Stats Overview --- */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Card 1: Regional Coverage */}
          <Card className="bg-white shadow-sm border-slate-200">
            <CardHeader className="flex flex-row items-center justify-between pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium text-slate-600">Total Doses</CardTitle>
              <MapPin className="h-4 w-4 text-emerald-500" />
            </CardHeader>
            <CardContent className="pb-4 px-4">
              <div className="text-2xl font-bold text-slate-900">
                {formatNumber(totalDosesAdministered)}
              </div>
              <p className="text-xs text-slate-500 mt-1">
                {regionalCoverage === 1 ? "county" : "counties"} covered
              </p>
              {uniqueLocations > 0 && (
                <div className="mt-3 pt-3 border-t border-slate-100">
                  <div className="flex items-center gap-1.5 text-xs text-slate-500">
                    <Activity className="h-3.5 w-3.5 text-blue-400" />
                    <span>
                      <span className="font-semibold text-slate-700">
                        {formatNumber(uniqueLocations)}
                      </span>{" "}
                      unique locations
                    </span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Card 2: Total Farmers */}
          <Card className="bg-white shadow-sm border-slate-200">
            <CardHeader className="flex flex-row items-center justify-between pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium text-slate-600">Beneficiaries (farmers)</CardTitle>
              <Users className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardContent className="pb-4 px-4">
              <div className="text-2xl font-bold text-slate-900">
                {formatNumber(totalBeneficiaries)}
              </div>
              <div className="flex items-center gap-4 mt-2">
                <p className="text-xs text-slate-500 flex items-center">
                  <span className="w-2 h-2 rounded-full bg-blue-500 mr-1" />
                  <span className="font-semibold text-slate-700">
                    {formatNumber(totalMaleBeneficiaries)}
                  </span>{" "}
                  Male
                </p>
                <p className="text-xs text-slate-500 flex items-center">
                  <span className="w-2 h-2 rounded-full bg-pink-500 mr-1" />
                  <span className="font-semibold text-slate-700">
                    {formatNumber(totalFemaleBeneficiaries)}
                  </span>{" "}
                  Female
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Card 3: Vaccination Rate + Total Doses */}
          <Card className="bg-white shadow-sm border-slate-200">
            <CardHeader className="flex flex-row items-center justify-between pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium text-slate-600">
                Vaccination Rate
              </CardTitle>
              {vaccinationRate.trend === "up" ? (
                <TrendingUp className="h-4 w-4 text-green-500" />
              ) : vaccinationRate.trend === "down" ? (
                <TrendingDown className="h-4 w-4 text-red-500" />
              ) : (
                <Activity className="h-4 w-4 text-slate-400" />
              )}
            </CardHeader>
            <CardContent className="pb-4 px-4">
              <div className="text-2xl font-bold text-slate-900 flex items-center gap-2">
                {vaccinationRate.rate}%
                {vaccinationRate.trend === "up" && (
                  <span className="text-xs text-green-500">(inc)</span>
                )}
                {vaccinationRate.trend === "down" && (
                  <span className="text-xs text-red-500">(dec)</span>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-1">Vs previous activity</p>
              {/* Total Doses */}
              <div className="mt-3 pt-3 border-t border-slate-100">
                <div className="flex items-center gap-1.5 text-xs text-slate-500">
                  <Syringe className="h-3.5 w-3.5 text-green-500" />
                  <span>
                    Total Doses:{" "}
                    <span className="font-semibold text-slate-700">
                      {formatNumber(totalDosesAdministered)}
                    </span>
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-1 text-[11px] text-slate-400">
                  <span>
                    Current: {formatNumber(vaccinationRate.currentDoses)}
                  </span>
                  {statsActivities.length >= 2 && (
                    <span>
                      Previous: {formatNumber(vaccinationRate.previousDoses)}
                    </span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* --- Action Buttons & Search --- */}
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 space-y-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-end">
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 min-w-0">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <Input
                  placeholder="Search..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-9 w-full"
                />
              </div>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full sm:max-w-[160px]"
              />
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full sm:max-w-[160px]"
              />
            </div>

            {(userCanReadAllAnimalHealthProgrammes || accessibleProgrammes.length > 1) &&
              hasProgrammeAccess && (
                <div className="w-full sm:w-[280px] space-y-1">
                  <Label className="text-xs text-slate-600">Programme View</Label>
                  <Select
                    value={programmeView}
                    onValueChange={(value) => setProgrammeView(value as ProgrammeView)}
                  >
                    <SelectTrigger
                      className="h-9"
                      disabled={
                        !userCanReadAllAnimalHealthProgrammes && accessibleProgrammes.length <= 1
                      }
                    >
                      <SelectValue placeholder="Select programme" />
                    </SelectTrigger>
                    <SelectContent>
                      {accessibleProgrammes.map((programmeOption) => (
                        <SelectItem key={programmeOption} value={programmeOption}>
                          {programmeOption} (
                          {
                            activitiesByProgramme[
                              programmeOption as keyof typeof activitiesByProgramme
                            ].length
                          }
                          )
                        </SelectItem>
                      ))}
                      {userCanReadAllAnimalHealthProgrammes && (
                        <SelectItem value="ALL">
                          ALL ({filteredActivities.length})
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              )}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              {userIsAdmin && isSelecting && selectedActivities.length > 0 && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDeleteMultipleActivities}
                >
                  <Trash2 className="h-4 w-4 mr-1" /> Delete Selected ({selectedActivities.length})
                </Button>
              )}
              {userIsAdmin && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setIsSelecting(!isSelecting);
                    setSelectedActivities([]);
                  }}
                >
                  {isSelecting ? (
                    "Cancel Selection"
                  ) : (
                    <>
                      <CheckSquare className="h-4 w-4 mr-1" /> Select
                    </>
                  )}
                </Button>
              )}
            </div>
            {userIsAdmin && (
              <div className="flex items-center gap-2 sm:justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={exportToCSV}
                  className="w-full sm:w-auto"
                >
                  <Download className="h-4 w-4 mr-1" /> Export
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* --- Activities Table --- */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 px-1">
          <h2 className="text-sm font-semibold text-slate-700">
            {programmeView === "ALL"
              ? "All Programme Activities"
              : `${programmeView} Activities`}
          </h2>
          <p className="text-xs text-slate-500">
            Showing {displayedActivities.length} records
          </p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  {isSelecting && (
                    <th className="py-3 px-4 text-left w-12">
                      <Checkbox
                        checked={
                          selectedActivities.length === displayedActivities.length &&
                          displayedActivities.length > 0
                        }
                        onCheckedChange={selectAllActivities}
                      />
                    </th>
                  )}
                  <th className="py-3 px-4 text-left font-semibold text-slate-600">
                    Vaccination Date
                  </th>
                  <th className="py-3 px-4 text-left font-semibold text-slate-600">Location</th>
                  <th className="py-3 px-4 text-left font-semibold text-slate-600">Doses</th>
                  <th className="py-3 px-4 text-left font-semibold text-slate-600">Team</th>
                  <th className="py-3 px-4 text-left font-semibold text-slate-600">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={tableColSpan} className="text-center py-10">
                      <Skeleton className="h-8 w-full" />
                    </td>
                  </tr>
                ) : displayedActivities.length === 0 ? (
                  <tr>
                    <td colSpan={tableColSpan} className="text-center py-10 text-slate-500">
                      {hasProgrammeAccess
                        ? "No activities found."
                        : "You do not have access to any programme data."}
                    </td>
                  </tr>
                ) : (
                  displayedActivities.map((activity) => (
                    <tr
                      key={activity.id}
                      className="border-b border-slate-100 hover:bg-slate-50/50 transition-colors"
                    >
                      {isSelecting && (
                        <td className="py-3 px-4">
                          <Checkbox
                            checked={selectedActivities.includes(activity.id)}
                            onCheckedChange={() => toggleActivitySelection(activity.id)}
                          />
                        </td>
                      )}
                      <td className="py-3 px-4 font-medium text-slate-800">
                        {formatDate(activity.date)}
                      </td>
                      <td className="py-3 px-4 text-slate-600">
                        <div className="flex flex-col">
                          <span className="font-medium">{activity.county}</span>
                          <span className="text-xs text-slate-400">
                            {activity.subcounty} - {activity.location}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex flex-col">
                          <span className="font-bold text-green-700">
                            {formatNumber(getActivityTotalDoses(activity))}
                          </span>
                          <span className="text-xs text-slate-500">
                            {renderVaccinesInTable(activity)}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-blue-600 h-7 text-xs"
                          onClick={() => openFieldOfficersDialog(activity.fieldofficers)}
                        >
                          <Users className="h-3 w-3 mr-1" /> {activity.fieldofficers?.length || 0}
                        </Button>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-500 hover:text-blue-600"
                            onClick={() => openViewDialog(activity)}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          {userIsAdmin && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-slate-500 hover:text-green-600"
                                onClick={() => openEditDialog(activity)}
                              >
                                <Edit className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-slate-500 hover:text-red-600"
                                onClick={() => handleDeleteActivity(activity.id)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* --- EDIT DIALOG --- */}
        <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
          <DialogContent className="sm:max-w-[900px] bg-white rounded-2xl border-0 shadow-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="text-xl font-semibold text-slate-900">
                Edit Vaccination Activity
              </DialogTitle>
            </DialogHeader>
            <div className="grid gap-6 py-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Date</Label>
                  <Input
                    type="date"
                    value={activityForm.date}
                    onChange={(e) => setActivityForm({ ...activityForm, date: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Project</Label>
                  <Select
                    value={activityForm.programme}
                    onValueChange={(v) => setActivityForm({ ...activityForm, programme: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {accessibleProgrammes.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>County</Label>
                  <Input
                    value={activityForm.county}
                    onChange={(e) => setActivityForm({ ...activityForm, county: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Subcounty</Label>
                  <Input
                    value={activityForm.subcounty}
                    onChange={(e) =>
                      setActivityForm({ ...activityForm, subcounty: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>Location</Label>
                  <Input
                    value={activityForm.location}
                    onChange={(e) => setActivityForm({ ...activityForm, location: e.target.value })}
                  />
                </div>
              </div>

              {/* Beneficiaries Counts */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Male Beneficiaries</Label>
                  <Input
                    type="number"
                    value={activityForm.malebeneficiaries}
                    onChange={(e) => {
                      manualCountOverride.current = true;
                      setActivityForm({ ...activityForm, malebeneficiaries: e.target.value });
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Female Beneficiaries</Label>
                  <Input
                    type="number"
                    value={activityForm.femalebeneficiaries}
                    onChange={(e) => {
                      manualCountOverride.current = true;
                      setActivityForm({ ...activityForm, femalebeneficiaries: e.target.value });
                    }}
                  />
                </div>
              </div>

              {/* Vaccines in Edit */}
              <div className="space-y-2">
                <Label>Vaccines</Label>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                  {VACCINE_OPTIONS.map((vaccine) => (
                    <div key={vaccine} className="flex items-center space-x-2">
                      <Checkbox
                        id={`edit-vaccine-${vaccine}`}
                        checked={selectedVaccines.includes(vaccine)}
                        onCheckedChange={() => handleVaccineSelection(vaccine)}
                      />
                      <Label htmlFor={`edit-vaccine-${vaccine}`} className="text-xs">
                        {vaccine}
                      </Label>
                    </div>
                  ))}
                </div>
                <Input
                  type="number"
                  placeholder="Total Doses"
                  value={totalDoses}
                  onChange={(e) => setTotalDoses(e.target.value)}
                  className="mt-2"
                />
              </div>

              {/* Beneficiaries in Edit */}
              <div className="border p-4 rounded-xl bg-blue-50/30 space-y-2">
                <Label className="font-semibold text-blue-900">
                  Farmers ({beneficiaries.length})
                </Label>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
                  <Input
                    placeholder="Name"
                    value={beneficiaryForm.name}
                    onChange={(e) =>
                      setBeneficiaryForm({ ...beneficiaryForm, name: e.target.value })
                    }
                    className="h-8"
                  />
                  <Select
                    value={beneficiaryForm.gender}
                    onValueChange={(v: any) =>
                      setBeneficiaryForm({ ...beneficiaryForm, gender: v })
                    }
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Male">Male</SelectItem>
                      <SelectItem value="Female">Female</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    placeholder="ID"
                    value={beneficiaryForm.nationalId}
                    onChange={(e) =>
                      setBeneficiaryForm({ ...beneficiaryForm, nationalId: e.target.value })
                    }
                    className="h-8"
                  />
                  <Input
                    placeholder="Goats"
                    type="number"
                    value={beneficiaryForm.goats}
                    onChange={(e) =>
                      setBeneficiaryForm({ ...beneficiaryForm, goats: e.target.value })
                    }
                    className="h-8"
                  />
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      onClick={handleAddBeneficiary}
                      className="h-8 bg-blue-600 flex-1"
                    >
                      Add
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 px-2 border-blue-600 text-blue-600"
                      onClick={() => editFileInputRef.current?.click()}
                    >
                      <Upload className="h-3 w-3" />
                    </Button>
                    <input
                      type="file"
                      ref={editFileInputRef}
                      onChange={handleFileUpload}
                      className="hidden"
                      accept=".csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel"
                    />
                  </div>
                </div>
                <div className="max-h-32 overflow-y-auto mt-2 space-y-1">
                  {beneficiaries.map((b) => (
                    <div
                      key={b.id}
                      className="flex justify-between items-center bg-white p-1 px-2 rounded border text-xs"
                    >
                      <span>
                        {b.name} ({b.gender}) - {b.nationalId}
                      </span>
                      <span>
                        G: {b.goats} S: {b.sheep}
                      </span>
                      <X
                        className="h-3 w-3 cursor-pointer text-red-500"
                        onClick={() => handleRemoveBeneficiary(b.id)}
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Issues in Edit */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <Label>Issues (Optional)</Label>
                  {!showIssueForm && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setShowIssueForm(true)}
                    >
                      Add Issue
                    </Button>
                  )}
                </div>
                {showIssueForm && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 border p-2 rounded bg-slate-50">
                    <Input
                      placeholder="Issue Name"
                      value={issueForm.name}
                      onChange={(e) => setIssueForm({ ...issueForm, name: e.target.value })}
                    />
                    <Input
                      placeholder="Raised By"
                      value={issueForm.raisedBy}
                      onChange={(e) => setIssueForm({ ...issueForm, raisedBy: e.target.value })}
                    />
                    <Textarea
                      placeholder="Description"
                      className="col-span-2"
                      value={issueForm.description}
                      onChange={(e) =>
                        setIssueForm({ ...issueForm, description: e.target.value })
                      }
                    />
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleAddIssue}
                      className="bg-orange-500 col-span-2"
                    >
                      Save Issue
                    </Button>
                  </div>
                )}
                {issues.map((iss) => (
                  <div
                    key={iss.id}
                    className="text-xs bg-white border p-2 rounded flex justify-between items-center"
                  >
                    <span>
                      <b>{iss.name}</b> - {iss.status}
                    </span>
                    <X
                      className="h-3 w-3 cursor-pointer"
                      onClick={() => handleRemoveIssue(iss.id)}
                    />
                  </div>
                ))}
              </div>

              {/* Field Officers in Edit */}
              <div className="space-y-2">
                <Label>Field Officers</Label>
                <div className="flex gap-2">
                  <Input
                    placeholder="Name"
                    value={fieldOfficerForm.name}
                    onChange={(e) =>
                      setFieldOfficerForm({ ...fieldOfficerForm, name: e.target.value })
                    }
                  />
                  <Input
                    placeholder="Role"
                    value={fieldOfficerForm.role}
                    onChange={(e) =>
                      setFieldOfficerForm({ ...fieldOfficerForm, role: e.target.value })
                    }
                  />
                  <Button
                    onClick={handleAddFieldOfficer}
                    className="bg-green-600"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2 mt-2">
                  {fieldOfficers.map((fo, i) => (
                    <Badge key={i} variant="outline" className="py-1 px-2">
                      {fo.name} ({fo.role}){" "}
                      <X
                        className="h-3 w-3 ml-1 cursor-pointer"
                        onClick={() => removeFieldOfficer(i)}
                      />
                    </Badge>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label>Comment</Label>
                <Textarea
                  value={activityForm.comment}
                  onChange={(e) => setActivityForm({ ...activityForm, comment: e.target.value })}
                  placeholder="Observations..."
                />
              </div>

              <div className="flex justify-end gap-3 pt-4">
                <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleEditActivity}
                  disabled={isSaveDisabled}
                  className="bg-blue-600 text-white"
                >
                  Update Activity
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* --- VIEW DIALOG --- */}
        <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
          <DialogContent className="sm:max-w-[800px] bg-white rounded-2xl max-h-[90vh] overflow-y-auto">
            {viewingActivity && (
              <>
                <DialogHeader>
                  <DialogTitle className="flex justify-between items-center">
                    <span>Activity Details</span>
                    <Badge
                      variant={viewingActivity.programme === "KPMD" ? "default" : "secondary"}
                      className={
                        viewingActivity.programme === "KPMD"
                          ? "bg-indigo-100 text-indigo-800"
                          : "bg-teal-100 text-teal-800"
                      }
                    >
                      {viewingActivity.programme}
                    </Badge>
                  </DialogTitle>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border p-4 rounded-xl bg-slate-50">
                    <div>
                      <Label className="text-xs text-slate-500">Date</Label>
                      <p className="font-semibold">{formatDate(viewingActivity.date)}</p>
                    </div>
                    <div>
                      <Label className="text-xs text-slate-500">County</Label>
                      <p className="font-semibold">{viewingActivity.county}</p>
                    </div>
                    <div>
                      <Label className="text-xs text-slate-500">Subcounty</Label>
                      <p className="font-semibold">{viewingActivity.subcounty || "N/A"}</p>
                    </div>
                    <div>
                      <Label className="text-xs text-slate-500">Location</Label>
                      <p className="font-semibold">{viewingActivity.location}</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 border p-4 rounded-xl bg-green-50">
                    <div className="text-center">
                      <p className="text-2xl font-bold text-green-700">
                        {formatNumber(getActivityTotalDoses(viewingActivity))}
                      </p>
                      <p className="text-xs text-green-900">Total Doses</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-bold text-blue-700">
                        {formatNumber(viewingActivity.malebeneficiaries || 0)}
                      </p>
                      <p className="text-xs text-blue-900">Male Farmers</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-bold text-purple-700">
                        {formatNumber(viewingActivity.femalebeneficiaries || 0)}
                      </p>
                      <p className="text-xs text-purple-900">Female Farmers</p>
                    </div>
                  </div>

                  <div>
                    <Label className="text-xs text-slate-500 mb-2 block">Vaccines</Label>
                    <div className="flex flex-wrap gap-2">
                      {getActivityVaccines(viewingActivity).map((v, i) => (
                        <Badge key={i} className="bg-emerald-100 text-emerald-800">
                          {v.type} ({formatNumber(v.doses)})
                        </Badge>
                      ))}
                    </div>
                  </div>

                  {/* Issues in View */}
                  {viewingActivity.issues && viewingActivity.issues.length > 0 && (
                    <div>
                      <Label className="text-xs text-slate-500 mb-2 block">
                        Issues ({viewingActivity.issues.length})
                      </Label>
                      <div className="space-y-1">
                        {viewingActivity.issues.map((iss, i) => (
                          <div
                            key={iss.id || i}
                            className="flex justify-between items-center bg-orange-50 border border-orange-100 p-2 rounded text-xs"
                          >
                            <div>
                              <span className="font-semibold">{iss.name}</span> � raised by{" "}
                              {iss.raisedBy}
                              <p className="text-slate-500 mt-0.5">{iss.description}</p>
                            </div>
                            <Badge
                              variant={
                                iss.status === "responded" ? "default" : "secondary"
                              }
                              className={
                                iss.status === "responded"
                                  ? "bg-green-100 text-green-800 text-[10px]"
                                  : "bg-red-100 text-red-800 text-[10px]"
                              }
                            >
                              {iss.status}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
                      <Label className="text-xs text-slate-600">
                        Farmers Details ({viewingActivity.beneficiaries?.length || 0})
                      </Label>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200">
                            <th className="py-2 px-4 text-left font-semibold text-slate-600">#</th>
                            <th className="py-2 px-4 text-left font-semibold text-slate-600">
                              Name
                            </th>
                            <th className="py-2 px-4 text-left font-semibold text-slate-600">
                              Gender
                            </th>
                            <th className="py-2 px-4 text-left font-semibold text-slate-600">
                              National ID
                            </th>
                            <th className="py-2 px-4 text-left font-semibold text-slate-600">
                              Goats
                            </th>
                            <th className="py-2 px-4 text-left font-semibold text-slate-600">
                              Sheep
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {(viewingActivity.beneficiaries || []).length > 0 ? (
                            paginatedViewingFarmers.map((farmer, index) => (
                              <tr
                                key={farmer.id || `${farmer.nationalId}-${index}`}
                                className="border-b border-slate-100 last:border-b-0"
                              >
                                <td className="py-2 px-4 text-slate-600">
                                  {(safeViewFarmersPage - 1) * FARMERS_PER_PAGE + index + 1}
                                </td>
                                <td className="py-2 px-4 font-medium text-slate-800">
                                  {farmer.name || "N/A"}
                                </td>
                                <td className="py-2 px-4 text-slate-700">
                                  {farmer.gender || "N/A"}
                                </td>
                                <td className="py-2 px-4 text-slate-700 font-mono">
                                  {farmer.nationalId || "N/A"}
                                </td>
                                <td className="py-2 px-4 text-slate-700">
                                  {farmer.goats ?? 0}
                                </td>
                                <td className="py-2 px-4 text-slate-700">
                                  {farmer.sheep ?? 0}
                                </td>
                              </tr>
                            ))
                          ) : (
                            <tr>
                              <td colSpan={6} className="py-4 px-4 text-center text-slate-500">
                                No farmer details recorded.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    {(viewingActivity.beneficiaries || []).length > FARMERS_PER_PAGE && (
                      <div className="flex items-center justify-between px-4 py-3 border-t border-slate-200 bg-white">
                        <p className="text-xs text-slate-500">
                          Showing{" "}
                          {Math.min(
                            (safeViewFarmersPage - 1) * FARMERS_PER_PAGE + 1,
                            viewingFarmers.length,
                          )}
                          -{Math.min(safeViewFarmersPage * FARMERS_PER_PAGE, viewingFarmers.length)}{" "}
                          of {viewingFarmers.length}
                        </p>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={safeViewFarmersPage <= 1}
                            onClick={() =>
                              setViewFarmersPage((prev) => Math.max(1, prev - 1))
                            }
                          >
                            Previous
                          </Button>
                          <span className="text-xs text-slate-600">
                            Page {safeViewFarmersPage} of {totalViewFarmerPages}
                          </span>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={safeViewFarmersPage >= totalViewFarmerPages}
                            onClick={() =>
                              setViewFarmersPage((prev) =>
                                Math.min(totalViewFarmerPages, prev + 1),
                              )
                            }
                          >
                            Next
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>

                  {viewingActivity.comment && (
                    <div>
                      <Label className="text-xs text-slate-500">Comment</Label>
                      <p className="text-sm mt-1 bg-slate-100 p-2 rounded">
                        {viewingActivity.comment}
                      </p>
                    </div>
                  )}
                </div>
              </>
            )}
          </DialogContent>
        </Dialog>

        {/* --- FIELD OFFICERS DIALOG --- */}
        <Dialog open={isFieldOfficersDialogOpen} onOpenChange={setIsFieldOfficersDialogOpen}>
          <DialogContent className="sm:max-w-[400px] bg-white">
            <DialogHeader>
              <DialogTitle>Vaccination Team</DialogTitle>
            </DialogHeader>
            <div className="space-y-2 py-4">
              {selectedActivityFieldOfficers.length === 0 ? (
                <p className="text-sm text-slate-500">No officers recorded.</p>
              ) : (
                selectedActivityFieldOfficers.map((fo, i) => (
                  <div
                    key={i}
                    className="flex justify-between items-center bg-slate-50 p-3 rounded-lg border"
                  >
                    <div className="flex items-center gap-2">
                      <User className="h-4 w-4 text-slate-500" />
                      <span className="font-medium">{fo.name}</span>
                    </div>
                    <Badge variant="secondary">{fo.role}</Badge>
                  </div>
                ))
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};

export default AnimalHealthPage;


