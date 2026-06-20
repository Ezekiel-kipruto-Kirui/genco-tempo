import { useState, useEffect, useMemo, useCallback } from "react";
import { db, ref, push, update, remove, fetchCollectionByProgrammes } from "@/lib/firebase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { canViewAllProgrammes, isAdmin } from "@/contexts/authhelper";
import { includesProgramme, normalizeProgramme, resolveAccessibleProgrammes } from "@/lib/programme-access";

import { 
  Users, 
  Plus, 
  Calendar, 
  Eye,
  Edit,
  Trash2,
  X,
  Filter,
  Search,
  ArrowLeft,
  MoreVertical
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cacheKey, readCachedValue, removeCachedValue, writeCachedValue } from "@/lib/data-cache";

interface Participant {
  name: string;
  role: string;
}

interface Activity {
  id: string;
  activityName: string;
  date: string;
  numberOfPersons: number;
  programme?: string;
  county: string;
  location: string;
  participants: Participant[];
  subcounty: string;
  createdAt: any;
  status: 'pending' | 'completed';
  createdBy: string;
}

interface ActivityForm {
  activityName: string;
  date: string;
  numberOfPersons: string;
  programme: string;
  county: string;
  subcounty: string;
  location: string;
}

const UNASSIGNED_PROGRAMME_LABEL = "Unassigned";

const buildEmptyActivityForm = (programme = ""): ActivityForm => ({
  activityName: "",
  date: "",
  numberOfPersons: "",
  programme,
  county: "",
  subcounty: "",
  location: "",
});

const getProgrammeLabel = (programme: string | null | undefined): string =>
  normalizeProgramme(programme) || UNASSIGNED_PROGRAMME_LABEL;

const getActivityTimestamp = (activity: Partial<Activity> | null | undefined): number => {
  if (!activity) return 0;
  const createdAtValue = activity.createdAt ? new Date(activity.createdAt).getTime() : 0;
  if (Number.isFinite(createdAtValue) && createdAtValue > 0) return createdAtValue;
  const dateValue = activity.date ? new Date(activity.date).getTime() : 0;
  return Number.isFinite(dateValue) ? dateValue : 0;
};

const sortActivitiesByLatest = (records: Activity[]): Activity[] =>
  [...records].sort((a, b) => getActivityTimestamp(b) - getActivityTimestamp(a));


const filterActivitiesByProgrammeAccess = (
  records: Activity[],
  allowedProgrammes: string[],
  canViewAllProgrammeData: boolean
): Activity[] => {
  if (canViewAllProgrammeData) return records;
  if (allowedProgrammes.length === 0) return [];

  const allowedProgrammeSet = new Set(allowedProgrammes);
  return records.filter((activity) => {
    const programme = normalizeProgramme(activity.programme);
    return Boolean(programme) && allowedProgrammeSet.has(programme);
  });
};

const ActivitiesPage = () => {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isParticipantsDialogOpen, setIsParticipantsDialogOpen] = useState(false);
  const [selectedActivityParticipants, setSelectedActivityParticipants] = useState<Participant[]>([]);
  const [editingActivity, setEditingActivity] = useState<Activity | null>(null);
  const [participantForm, setParticipantForm] = useState({ name: "", role: "" });
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [activityForm, setActivityForm] = useState<ActivityForm>(() => buildEmptyActivityForm());
  const { user, userRole, userAttribute, allowedProgrammes } = useAuth();
  const userIsAdmin = useMemo(() => isAdmin(userRole), [userRole]);
  const userCanViewAllProgrammeData = useMemo(
    () => canViewAllProgrammes(userRole, userAttribute, allowedProgrammes),
    [allowedProgrammes, userRole, userAttribute]
  );
  const accessibleProgrammes = useMemo(
    () => resolveAccessibleProgrammes(userCanViewAllProgrammeData, allowedProgrammes),
    [allowedProgrammes, userCanViewAllProgrammeData]
  );
  const hasProgrammeAccess = userCanViewAllProgrammeData || accessibleProgrammes.length > 0;
  const defaultActivityProgramme = accessibleProgrammes[0] || "";
  const defaultProgrammeFilter = userCanViewAllProgrammeData ? "all" : accessibleProgrammes[0] || "all";
  const activitiesCacheKey = useMemo(
    () =>
      cacheKey(
        "admin-page",
        "activities",
        user?.uid || "anonymous",
        userCanViewAllProgrammeData ? "all" : accessibleProgrammes.join("|") || "no-programme",
      ),
    [accessibleProgrammes, user?.uid, userCanViewAllProgrammeData]
  );
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterProgramme, setFilterProgramme] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const { toast } = useToast();

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
    setFilterProgramme((prev) => {
      if (userCanViewAllProgrammeData) {
        return prev === "all" || includesProgramme(accessibleProgrammes, prev) ? prev : "all";
      }
      return includesProgramme(accessibleProgrammes, prev) ? prev : defaultProgrammeFilter;
    });
  }, [accessibleProgrammes, defaultProgrammeFilter, userCanViewAllProgrammeData]);

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

  // --- REALTIME DATABASE FETCH ---
  const fetchActivities = useCallback(async () => {
    try {
      if (!hasProgrammeAccess) {
        setActivities([]);
        setLoading(false);
        removeCachedValue(activitiesCacheKey);
        return;
      }

      const cachedActivities = readCachedValue<Activity[]>(activitiesCacheKey);
      if (cachedActivities) {
        setActivities(
          sortActivitiesByLatest(
            filterActivitiesByProgrammeAccess(
              cachedActivities,
              accessibleProgrammes,
              userCanViewAllProgrammeData,
            ),
          ),
        );
        setLoading(false);
      } else {
        setLoading(true);
      }

      const rawActivities = await fetchCollectionByProgrammes<Record<string, any>>(
        "Recent Activities",
        accessibleProgrammes,
      );

      if (rawActivities.length > 0) {
        const activitiesData = rawActivities.map((record) => ({
          ...record,
          programme: normalizeProgramme(record?.programme ?? record?.Programme),
        })) as Activity[];

        const sortedActivitiesData = sortActivitiesByLatest(
          filterActivitiesByProgrammeAccess(
            activitiesData,
            accessibleProgrammes,
            userCanViewAllProgrammeData,
          ),
        );
        setActivities(sortedActivitiesData);
        writeCachedValue(activitiesCacheKey, sortedActivitiesData);
      } else {
        setActivities([]);
        removeCachedValue(activitiesCacheKey);
      }
    } catch (error) {
      console.error("Error fetching activities:", error);
      toast({
        title: "Error",
        description: "Failed to load activities",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [accessibleProgrammes, activitiesCacheKey, hasProgrammeAccess, toast, userCanViewAllProgrammeData]);

  useEffect(() => {
    void fetchActivities();
  }, [fetchActivities]);

  const handleAddParticipant = () => {
    if (participantForm.name.trim() && participantForm.role.trim()) {
      setParticipants([...participants, { ...participantForm }]);
      setParticipantForm({ name: "", role: "" });
    }
  };

  const removeParticipant = (index: number) => {
    const updatedParticipants = participants.filter((_, i) => i !== index);
    setParticipants(updatedParticipants);
  };

  // --- REALTIME DATABASE ADD FUNCTION ---
  const handleAddActivity = async () => {
    if (!requireAdmin()) return;

    if (participants.length === 0) {
      toast({
        title: "Error",
        description: "Please add at least one participant",
        variant: "destructive",
      });
      return;
    }
    if (!includesProgramme(accessibleProgrammes, activityForm.programme)) {
      toast({
        title: "Error",
        description: "Please select an assigned programme",
        variant: "destructive",
      });
      return;
    }

    try {
      await push(ref(db, "Recent Activities"), {
        ...activityForm,
        programme: normalizeProgramme(activityForm.programme),
        numberOfPersons: participants.length,
        participants: participants,
        status: 'pending',
        createdBy: user?.email,
        createdAt: new Date().toISOString(), // RTDB stores dates as ISO strings
      });
      toast({
        title: "Success",
        description: "Activity scheduled successfully.",
        className: "bg-white text-slate-900 border border-slate-200"
      });
      setActivityForm(buildEmptyActivityForm(defaultActivityProgramme));
      setParticipants([]);
      setIsAddDialogOpen(false);
      removeCachedValue(activitiesCacheKey);
      fetchActivities();
    } catch (error) {
      console.error("Error adding activity:", error);
      toast({
        title: "Error",
        description: "Failed to schedule activity. Please try again.",
        variant: "destructive",
      });
    }
  };

  // --- REALTIME DATABASE UPDATE FUNCTION ---
  const handleEditActivity = async () => {
    if (!requireAdmin()) return;
    if (!editingActivity) return;

    try {
      await update(ref(db, "Recent Activities/" + editingActivity.id), {
        ...activityForm,
        programme: normalizeProgramme(activityForm.programme),
        numberOfPersons: participants.length,
        participants: participants,
      });
      toast({
        title: "Success",
        description: "Activity updated successfully.",
        className: "bg-white text-slate-900 border border-slate-200"
      });
      setEditingActivity(null);
      setIsEditDialogOpen(false);
      setActivityForm(buildEmptyActivityForm(defaultActivityProgramme));
      setParticipants([]);
      removeCachedValue(activitiesCacheKey);
      fetchActivities();
    } catch (error) {
      console.error("Error updating activity:", error);
      toast({
        title: "Error",
        description: "Failed to update activity. Please try again.",
        variant: "destructive",
      });
    }
  };

  // --- REALTIME DATABASE DELETE FUNCTION ---
  const handleDeleteActivity = async (activityId: string) => {
    if (!requireAdmin()) return;
    try {
      await remove(ref(db, "Recent Activities/" + activityId));
      toast({
        title: "Success",
        description: "Activity deleted successfully.",
        className: "bg-white text-slate-900 border border-slate-200"
      });
      removeCachedValue(activitiesCacheKey);
      fetchActivities();
    } catch (error) {
      console.error("Error deleting activity:", error);
      toast({
        title: "Error",
        description: "Failed to delete activity. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleStatusChange = async (activityId: string, newStatus: Activity['status']) => {
    if (!requireAdmin()) return;
    try {
      await update(ref(db, "Recent Activities/" + activityId), {
        status: newStatus
      });
      toast({
        title: "Success",
        description: `Activity marked as ${newStatus}`,
        className: "bg-white text-slate-900 border border-slate-200"
      });
      removeCachedValue(activitiesCacheKey);
      fetchActivities();
    } catch (error) {
      console.error("Error updating activity status:", error);
      toast({
        title: "Error",
        description: "Failed to update activity status",
        variant: "destructive",
      });
    }
  };

  const openEditDialog = (activity: Activity) => {
    if (!userIsAdmin) return;
    const activityProgramme = normalizeProgramme(activity.programme);
    setEditingActivity(activity);
    setActivityForm({
      activityName: activity.activityName,
      date: activity.date,
      numberOfPersons: activity.numberOfPersons.toString(),
      programme: includesProgramme(accessibleProgrammes, activityProgramme)
        ? activityProgramme
        : defaultActivityProgramme,
      county: activity.county,
      subcounty: activity.subcounty,
      location: activity.location,
    });
    setParticipants(activity.participants || []);
    setIsEditDialogOpen(true);
  };

  const openParticipantsDialog = (participants: Participant[]) => {
    setSelectedActivityParticipants(participants);
    setIsParticipantsDialogOpen(true);
  };

  const getStatusBadge = (status: string) => {
    const statusConfig = {
      'pending': { color: 'bg-yellow-100 text-yellow-800', label: 'Pending' },
      'completed': { color: 'bg-green-100 text-green-800', label: 'Completed' }
    };
    
    const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.pending;
    return <Badge className={`${config.color} border-0`}>{config.label}</Badge>;
  };

  const filteredActivities = activities.filter(activity => {
    const matchesStatus = filterStatus === "all" || activity.status === filterStatus;
    const activityProgramme = normalizeProgramme(activity.programme);
    const matchesProgramme =
      filterProgramme === "all" || activityProgramme === filterProgramme;
    const matchesSearch = activity.activityName.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         activity.location.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         activity.county.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         activityProgramme.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesStatus && matchesProgramme && matchesSearch;
  });

  const pendingActivitiesCount = activities.filter(activity => activity.status === 'pending').length;
  const completedActivitiesCount = activities.filter(activity => activity.status === 'completed').length;
  const kpmdActivitiesCount = activities.filter(
    (activity) => normalizeProgramme(activity.programme) === "KPMD"
  ).length;
  const rangeActivitiesCount = activities.filter(
    (activity) => normalizeProgramme(activity.programme) === "RANGE"
  ).length;

  const formatDate = (dateString: string) => {
    if (!dateString) return 'No date';
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100/80 p-4 sm:p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div>
              <h1 className="text-md font-bold text-slate-900">Activities Management</h1>
            </div>
          </div>
          <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
            <DialogTrigger asChild>
              {userIsAdmin ? (<Button className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white">
                <Plus className="h-4 w-4 mr-2" />
                Schedule Activity
              </Button>) : <span className="hidden" />}
            </DialogTrigger>
            <DialogContent className="sm:max-w-[700px] bg-white rounded-2xl border-0 shadow-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="text-xl font-semibold text-slate-900">
                  Schedule New Activity
                </DialogTitle>
              </DialogHeader>
              <div className="grid gap-6 py-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="activityName" className="text-sm font-medium text-slate-700">Activity Name</Label>
                    <Input
                      id="activityName"
                      value={activityForm.activityName}
                      onChange={(e) => setActivityForm({...activityForm, activityName: e.target.value})}
                      placeholder="Enter activity name"
                      className="rounded-xl border-slate-300 focus:border-blue-500 focus:ring-blue-500 transition-all bg-white"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="date" className="text-sm font-medium text-slate-700">Date</Label>
                    <Input
                      id="date"
                      type="date"
                      value={activityForm.date}
                      onChange={(e) => setActivityForm({...activityForm, date: e.target.value})}
                      className="rounded-xl border-slate-300 focus:border-blue-500 focus:ring-blue-500 transition-all bg-white"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="programme" className="text-sm font-medium text-slate-700">Programme</Label>
                    <Select
                      value={activityForm.programme}
                      onValueChange={(value) => setActivityForm({ ...activityForm, programme: value })}
                    >
                      <SelectTrigger id="programme" className="rounded-xl border-slate-300 focus:border-blue-500 bg-white">
                        <SelectValue placeholder="Select programme" />
                      </SelectTrigger>
                      <SelectContent>
                        {accessibleProgrammes.map((programmeOption) => (
                          <SelectItem key={programmeOption} value={programmeOption}>
                            {programmeOption}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="county" className="text-sm font-medium text-slate-700">County</Label>
                    <Input
                      id="county"
                      value={activityForm.county}
                      onChange={(e) => setActivityForm({...activityForm, county: e.target.value})}
                      placeholder="Enter county"
                      className="rounded-xl border-slate-300 focus:border-blue-500 focus:ring-blue-500 transition-all bg-white"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="subcounty" className="text-sm font-medium text-slate-700">Subcounty</Label>
                    <Input
                      id="subcounty"
                      value={activityForm.subcounty}
                      onChange={(e) => setActivityForm({...activityForm, subcounty: e.target.value})}
                      placeholder="Enter subcounty"
                      className="rounded-xl border-slate-300 focus:border-blue-500 focus:ring-blue-500 transition-all bg-white"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="location" className="text-sm font-medium text-slate-700">Location</Label>
                  <Input
                    id="location"
                    value={activityForm.location}
                    onChange={(e) => setActivityForm({...activityForm, location: e.target.value})}
                    placeholder="Enter location"
                    className="rounded-xl border-slate-300 focus:border-blue-500 focus:ring-blue-500 transition-all bg-white"
                  />
                </div>

                {/* Participants Section */}
                <div className="space-y-4 border-t pt-4">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium text-slate-700">Participants ({participants.length})</Label>
                    <span className="text-xs text-slate-500">Add participants with their roles</span>
                  </div>
                  
                  {/* Add Participant Form */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Input
                      placeholder="Participant Name"
                      value={participantForm.name}
                      onChange={(e) => setParticipantForm({...participantForm, name: e.target.value})}
                      className="rounded-xl border-slate-300 focus:border-blue-500 focus:ring-blue-500"
                    />
                    <div className="flex gap-2">
                      <Input
                        placeholder="Role"
                        value={participantForm.role}
                        onChange={(e) => setParticipantForm({...participantForm, role: e.target.value})}
                        className="rounded-xl border-slate-300 focus:border-blue-500 focus:ring-blue-500"
                      />
                      <Button 
                        type="button" 
                        onClick={handleAddParticipant}
                        className="bg-blue-500 hover:bg-blue-600 text-white rounded-xl"
                        disabled={!participantForm.name.trim() || !participantForm.role.trim()}
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  {/* Participants List */}
                  {participants.length > 0 && (
                    <div className="space-y-2 max-h-40 overflow-y-auto">
                      {participants.map((participant, index) => (
                        <div key={index} className="flex items-center justify-between bg-slate-50 rounded-lg p-3">
                          <div className="flex-1">
                            <p className="font-medium text-slate-900">{participant.name}</p>
                            <p className="text-sm text-slate-600">{participant.role}</p>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => removeParticipant(index)}
                            className="text-red-500 hover:text-red-700 hover:bg-red-50 rounded-lg"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-4">
                <Button 
                  variant="outline" 
                  onClick={() => {
                    setIsAddDialogOpen(false);
                    setParticipants([]);
                  }}
                  className="rounded-xl border-slate-300 hover:border-slate-400 transition-all text-slate-700"
                >
                  Cancel
                </Button>
                <Button 
                  onClick={handleAddActivity}
                  disabled={participants.length === 0}
                  className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 rounded-xl text-white font-semibold shadow-lg hover:shadow-xl transition-all disabled:opacity-50"
                >
                  <Calendar className="h-4 w-4 mr-2" />
                  Schedule Activity
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Stats Overview — with left gradient borders */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="bg-white/95 backdrop-blur-sm relative overflow-hidden">
            <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-blue-500 to-blue-700"></div>
            <CardContent className="p-4 pl-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-600">Total Activities</p>
                  <p className="text-2xl font-bold text-slate-900">{activities.length}</p>
                </div>
                <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                  <Calendar className="h-5 w-5 text-blue-600" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-white/95 backdrop-blur-sm relative overflow-hidden">
            <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-yellow-400 to-yellow-600"></div>
            <CardContent className="p-4 pl-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-600">Pending</p>
                  <p className="text-2xl font-bold text-yellow-600">{pendingActivitiesCount}</p>
                </div>
                <div className="w-10 h-10 bg-yellow-100 rounded-lg flex items-center justify-center">
                  <Filter className="h-5 w-5 text-yellow-600" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-white/95 backdrop-blur-sm relative overflow-hidden">
            <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-green-500 to-green-700"></div>
            <CardContent className="p-4 pl-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-600">Completed</p>
                  <p className="text-2xl font-bold text-green-600">{completedActivitiesCount}</p>
                </div>
                <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center">
                  <Users className="h-5 w-5 text-green-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex flex-col gap-4 md:flex-row">
          <div className="flex-1">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 h-4 w-4" />
              <Input
                placeholder="Search activities..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10 bg-white rounded-xl"
              />
            </div>
          </div>
          {userIsAdmin && hasProgrammeAccess && (
            <Select value={filterProgramme} onValueChange={setFilterProgramme}>
              <SelectTrigger
                className="w-full md:w-44 bg-white rounded-xl"
                disabled={!userCanViewAllProgrammeData && accessibleProgrammes.length <= 1}
              >
                <SelectValue placeholder="Filter by programme" />
              </SelectTrigger>
              <SelectContent>
                {userCanViewAllProgrammeData && <SelectItem value="all">All Programmes</SelectItem>}
                {accessibleProgrammes.map((programmeOption) => (
                  <SelectItem key={programmeOption} value={programmeOption}>
                    {programmeOption}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-full md:w-40 bg-white rounded-xl">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Activities Table */}
        <Card className="bg-white/95 backdrop-blur-sm">
          <CardContent className="p-0">
            {loading ? (
              // Loading skeletons for table
              <div className="space-y-4 p-6">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-xl" />
                ))}
              </div>
            ) : filteredActivities.length > 0 ? (
              <div className="w-full overflow-x-auto rounded-md">
                <table className="w-full border-collapse border border-gray-300 text-sm text-left whitespace-nowrap">
                  <thead>
                    <tr className="bg-blue-600 text-white text-xs">
                      <th className="py-3 px-3 font-semibold text-white">Activity Name</th>
                      <th className="py-3 px-3 font-semibold text-white">Date</th>
                      <th className="py-3 px-3 font-semibold text-white">Programme</th>
                      <th className="py-3 px-3 font-semibold text-white">Location</th>
                      <th className="py-3 px-3 font-semibold text-white">County</th>
                      <th className="py-3 px-3 font-semibold text-white">Participants</th>
                      <th className="py-3 px-3 font-semibold text-white">Status</th>
                      <th className="py-3 px-3 font-semibold text-white">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredActivities.map((activity) => (
                      <tr
                        key={activity.id}
                        className="border-b hover:bg-blue-50 transition-colors group"
                      >
                        <td className="py-2 px-3 font-medium text-sm">{activity.activityName}</td>
                        <td className="py-2 px-3 text-xs text-gray-500">{formatDate(activity.date)}</td>
                        <td className="py-2 px-3 text-xs">
                          <Badge variant="outline" className="font-semibold">
                            {getProgrammeLabel(activity.programme)}
                          </Badge>
                        </td>
                        <td className="py-2 px-3 text-xs">{activity.location}</td>
                        <td className="py-2 px-3 text-xs">{activity.county}</td>
                        <td className="py-2 px-3">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-blue-700">{activity.numberOfPersons}</span>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openParticipantsDialog(activity.participants || [])}
                              className="h-7 text-xs text-blue-600 hover:bg-blue-50"
                            >
                              View
                            </Button>
                          </div>
                        </td>
                        <td className="py-2 px-3">{getStatusBadge(activity.status)}</td>
                        <td className="py-2 px-3">
                          {userIsAdmin ? (
                            <div className="flex gap-1">
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => openEditDialog(activity)}
                                className="h-7 w-7 text-blue-600 hover:bg-blue-50"
                              >
                                <Edit className="h-3.5 w-3.5" />
                              </Button>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" className="h-7 w-7 text-slate-700 hover:bg-slate-100">
                                    <MoreVertical className="h-3.5 w-3.5" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onClick={() => handleStatusChange(activity.id, 'completed')}>
                                    <Badge className="bg-green-100 text-green-800 mr-2">C</Badge>
                                    Mark Completed
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => handleStatusChange(activity.id, 'pending')}>
                                    <Badge className="bg-yellow-100 text-yellow-800 mr-2">P</Badge>
                                    Mark Pending
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => handleDeleteActivity(activity.id)}
                                    className="text-red-600"
                                  >
                                    <Trash2 className="h-4 w-4 mr-2" />
                                    Delete
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          ) : (
                            <span className="text-xs text-gray-400">-</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center p-8 border-2 border-dashed border-slate-300 rounded-2xl bg-slate-50/50 m-6">
                <div className="w-16 h-16 bg-gradient-to-r from-slate-400 to-slate-600 rounded-full flex items-center justify-center mx-auto mb-4 shadow-lg">
                  <Search className="h-8 w-8 text-white" />
                </div>
                <h4 className="text-xl font-bold text-slate-800 mb-2">
                  {hasProgrammeAccess ? "No activities found" : "No programme access"}
                </h4>
                <p className="text-slate-600 mb-4">
                  {!hasProgrammeAccess
                    ? "You are not assigned to any programme data."
                    : searchTerm || filterStatus !== 'all' || filterProgramme !== defaultProgrammeFilter
                      ? "Try adjusting your search or filter criteria"
                      : "Get started by scheduling your first activity"
                  }
                </p>
                {hasProgrammeAccess && (searchTerm || filterStatus !== 'all' || filterProgramme !== defaultProgrammeFilter) ? (
                  <Button 
                    variant="outline"
                    onClick={() => {
                      setSearchTerm("");
                      setFilterStatus("all");
                      setFilterProgramme(defaultProgrammeFilter);
                    }}
                  >
                    Clear Filters
                  </Button>
                ) : hasProgrammeAccess ? (
                  <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
                    <DialogTrigger asChild>
                      {userIsAdmin ? <Button className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white">
                        <Plus className="h-4 w-4 mr-2" />
                        Schedule Your First Activity
                      </Button> : <span className="hidden" />}
                    </DialogTrigger>
                  </Dialog>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Edit Activity Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="sm:max-w-[700px] bg-white rounded-2xl border-0 shadow-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-xl font-semibold text-slate-900">
              Edit Activity
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-6 py-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-activityName" className="text-sm font-medium text-slate-700">Activity Name</Label>
                <Input
                  id="edit-activityName"
                  value={activityForm.activityName}
                  onChange={(e) => setActivityForm({...activityForm, activityName: e.target.value})}
                  placeholder="Enter activity name"
                  className="rounded-xl border-slate-300 focus:border-blue-500 focus:ring-blue-500 transition-all bg-white"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-date" className="text-sm font-medium text-slate-700">Date</Label>
                <Input
                  id="edit-date"
                  type="date"
                  value={activityForm.date}
                  onChange={(e) => setActivityForm({...activityForm, date: e.target.value})}
                  className="rounded-xl border-slate-300 focus:border-blue-500 focus:ring-blue-500 transition-all bg-white"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-programme" className="text-sm font-medium text-slate-700">Programme</Label>
                <Select
                  value={activityForm.programme}
                  onValueChange={(value) => setActivityForm({ ...activityForm, programme: value })}
                >
                  <SelectTrigger id="edit-programme" className="rounded-xl border-slate-300 focus:border-blue-500 bg-white">
                    <SelectValue placeholder="Select programme" />
                  </SelectTrigger>
                  <SelectContent>
                    {accessibleProgrammes.map((programmeOption) => (
                      <SelectItem key={programmeOption} value={programmeOption}>
                        {programmeOption}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-county" className="text-sm font-medium text-slate-700">County</Label>
                <Input
                  id="edit-county"
                  value={activityForm.county}
                  onChange={(e) => setActivityForm({...activityForm, county: e.target.value})}
                  placeholder="Enter county"
                  className="rounded-xl border-slate-300 focus:border-blue-500 focus:ring-blue-500 transition-all bg-white"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-subcounty" className="text-sm font-medium text-slate-700">Subcounty</Label>
                <Input
                  id="edit-subcounty"
                  value={activityForm.subcounty}
                  onChange={(e) => setActivityForm({...activityForm, subcounty: e.target.value})}
                  placeholder="Enter subcounty"
                  className="rounded-xl border-slate-300 focus:border-blue-500 focus:ring-blue-500 transition-all bg-white"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-location" className="text-sm font-medium text-slate-700">Location</Label>
              <Input
                id="edit-location"
                value={activityForm.location}
                onChange={(e) => setActivityForm({...activityForm, location: e.target.value})}
                placeholder="Enter location"
                className="rounded-xl border-slate-300 focus:border-blue-500 focus:ring-blue-500 transition-all bg-white"
              />
            </div>

            {/* Participants Section */}
            <div className="space-y-4 border-t pt-4">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium text-slate-700">Participants ({participants.length})</Label>
                <span className="text-xs text-slate-500">Add participants with their roles</span>
              </div>
              
              {/* Add Participant Form */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input
                  placeholder="Participant Name"
                  value={participantForm.name}
                  onChange={(e) => setParticipantForm({...participantForm, name: e.target.value})}
                  className="rounded-xl border-slate-300 focus:border-blue-500 focus:ring-blue-500"
                />
                <div className="flex gap-2">
                  <Input
                    placeholder="Role"
                    value={participantForm.role}
                    onChange={(e) => setParticipantForm({...participantForm, role: e.target.value})}
                    className="rounded-xl border-slate-300 focus:border-blue-500 focus:ring-blue-500"
                  />
                  <Button 
                    type="button" 
                    onClick={handleAddParticipant}
                    className="bg-blue-500 hover:bg-blue-600 text-white rounded-xl"
                    disabled={!participantForm.name.trim() || !participantForm.role.trim()}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* Participants List */}
              {participants.length > 0 && (
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {participants.map((participant, index) => (
                    <div key={index} className="flex items-center justify-between bg-slate-50 rounded-lg p-3">
                      <div className="flex-1">
                        <p className="font-medium text-slate-900">{participant.name}</p>
                        <p className="text-sm text-slate-600">{participant.role}</p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeParticipant(index)}
                        className="text-red-500 hover:text-red-700 hover:bg-red-50 rounded-lg"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-4">
            <Button 
              variant="outline" 
              onClick={() => {
                setIsEditDialogOpen(false);
                setParticipants([]);
              }}
              className="rounded-xl border-slate-300 hover:border-slate-400 transition-all text-slate-700"
            >
              Cancel
            </Button>
            <Button 
              onClick={handleEditActivity}
              disabled={participants.length === 0}
              className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 rounded-xl text-white font-semibold shadow-lg hover:shadow-xl transition-all disabled:opacity-50"
            >
              <Edit className="h-4 w-4 mr-2" />
              Update Activity
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Participants Dialog */}
      <Dialog open={isParticipantsDialogOpen} onOpenChange={setIsParticipantsDialogOpen}>
        <DialogContent className="sm:max-w-[500px] bg-white rounded-2xl border-0 shadow-2xl">
          <DialogHeader>
            <DialogTitle className="text-xl font-semibold text-slate-900 flex items-center justify-between">
              <span>Participants</span>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsParticipantsDialogOpen(false)}
                className="h-8 w-8 rounded-lg hover:bg-slate-100 transition-colors text-slate-600"
              >
                <X className="h-4 w-4" />
              </Button>
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 max-h-[60vh] overflow-y-auto">
            {selectedActivityParticipants.map((participant, index) => (
              <div key={index} className="flex items-center justify-between bg-slate-50 rounded-lg p-4">
                <div className="flex-1">
                  <p className="font-semibold text-slate-900">{participant.name}</p>
                  <p className="text-sm text-slate-600 mt-1">{participant.role}</p>
                </div>
                <div className="w-2 h-2 bg-green-500 rounded-full"></div>
              </div>
            ))}
            {selectedActivityParticipants.length === 0 && (
              <div className="text-center p-6 text-slate-500">
                No participants found
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ActivitiesPage;


