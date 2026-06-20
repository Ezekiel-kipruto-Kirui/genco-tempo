import { useEffect, useMemo, useState } from "react";
import { Loader2, Mail, MapPin, Phone, UserPlus, Users } from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { isProjectManager, resolvePermissionPrincipal } from "@/contexts/authhelper";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { db, onValue, push, ref, set } from "@/lib/firebase";
import { useToast } from "@/hooks/use-toast";

type FieldTeamForm = {
  name: string;
  county: string;
  subcounty: string;
  email: string;
  phone: string;
};

type FieldTeamMember = FieldTeamForm & {
  id: string;
  createdAt?: number;
  createdBy?: string;
  createdByRole?: string;
  createdByUid?: string;
};

const EMPTY_FORM: FieldTeamForm = {
  name: "",
  county: "",
  subcounty: "",
  email: "",
  phone: "",
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const formatTimestamp = (value: number | undefined): string => {
  if (!value) return "Unknown date";

  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) return "Unknown date";

  return parsedDate.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const FieldTeamPage = () => {
  const { user, userName, userRole, userAttribute } = useAuth();
  const { toast } = useToast();
  const [form, setForm] = useState<FieldTeamForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fieldTeamMembers, setFieldTeamMembers] = useState<FieldTeamMember[]>([]);

  const permissionPrincipal = useMemo(
    () => resolvePermissionPrincipal(userRole, userAttribute),
    [userRole, userAttribute]
  );
  const userCanCreateFieldTeam = useMemo(
    () => isProjectManager(permissionPrincipal),
    [permissionPrincipal]
  );

  useEffect(() => {
    const fieldTeamRef = ref(db, "fieldTeam");

    const unsubscribe = onValue(
      fieldTeamRef,
      (snapshot) => {
        const data = snapshot.val();
        if (!data) {
          setFieldTeamMembers([]);
          setLoading(false);
          return;
        }

        const records = Object.entries(data as Record<string, Omit<FieldTeamMember, "id">>)
          .map(([id, value]) => ({
            id,
            ...value,
          }))
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        setFieldTeamMembers(records);
        setLoading(false);
      },
      (error) => {
        console.error("Failed to load field team members:", error);
        toast({
          title: "Error",
          description: "Failed to load field team members.",
          variant: "destructive",
        });
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [toast]);

  const handleInputChange = (key: keyof FieldTeamForm, value: string) => {
    setForm((current) => ({
      ...current,
      [key]: value,
    }));
  };

  const handleSubmit = async () => {
    if (!userCanCreateFieldTeam) {
      toast({
        title: "Unauthorized",
        description: "Only project managers can add field team members.",
        variant: "destructive",
      });
      return;
    }

    const trimmedForm = {
      name: form.name.trim(),
      county: form.county.trim(),
      subcounty: form.subcounty.trim(),
      email: form.email.trim().toLowerCase(),
      phone: form.phone.trim(),
    };

    if (!trimmedForm.name || !trimmedForm.county || !trimmedForm.subcounty || !trimmedForm.email || !trimmedForm.phone) {
      toast({
        title: "Missing details",
        description: "Fill in name, county, subcounty, email, and phone before saving.",
        variant: "destructive",
      });
      return;
    }

    if (!emailPattern.test(trimmedForm.email)) {
      toast({
        title: "Invalid email",
        description: "Enter a valid email address for the field team member.",
        variant: "destructive",
      });
      return;
    }

    try {
      setSaving(true);
      const newFieldTeamRef = push(ref(db, "fieldTeam"));

      await set(newFieldTeamRef, {
        ...trimmedForm,
        createdAt: Date.now(),
        createdBy: userName || user?.displayName || user?.email || "Unknown user",
        createdByRole: permissionPrincipal || "unknown",
        createdByUid: user?.uid || "",
      });

      setForm(EMPTY_FORM);
      toast({
        title: "Field team member added",
        description: `${trimmedForm.name} has been saved successfully.`,
      });
    } catch (error) {
      console.error("Failed to save field team member:", error);
      toast({
        title: "Save failed",
        description: "The field team member could not be saved. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-wide text-green-700">Project Manager</p>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">Field Team Page</h1>
        <p className="mt-3 max-w-3xl text-sm text-slate-600">
          Add and review field team members from one place. Project managers can register team members with their
          county, subcounty, email, and phone details, while other authorized users can view the roster in read-only mode.
        </p>
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.1fr,1.4fr]">
        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="space-y-2">
            <CardTitle className="flex items-center gap-2 text-slate-900">
              <UserPlus className="h-5 w-5 text-green-600" />
              Add Field Team Member
            </CardTitle>
            <p className="text-sm text-slate-500">
              Capture the field team member details requested for project operations.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {!userCanCreateFieldTeam && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                Only project managers can add field team members on this page. You currently have read-only access.
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="field-team-name">Name</Label>
              <Input
                id="field-team-name"
                value={form.name}
                onChange={(event) => handleInputChange("name", event.target.value)}
                placeholder="Enter full name"
                disabled={!userCanCreateFieldTeam || saving}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="field-team-county">County</Label>
                <Input
                  id="field-team-county"
                  value={form.county}
                  onChange={(event) => handleInputChange("county", event.target.value)}
                  placeholder="Enter county"
                  disabled={!userCanCreateFieldTeam || saving}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="field-team-subcounty">Subcounty</Label>
                <Input
                  id="field-team-subcounty"
                  value={form.subcounty}
                  onChange={(event) => handleInputChange("subcounty", event.target.value)}
                  placeholder="Enter subcounty"
                  disabled={!userCanCreateFieldTeam || saving}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="field-team-email">Email</Label>
              <Input
                id="field-team-email"
                type="email"
                value={form.email}
                onChange={(event) => handleInputChange("email", event.target.value)}
                placeholder="name@example.com"
                disabled={!userCanCreateFieldTeam || saving}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="field-team-phone">Phone</Label>
              <Input
                id="field-team-phone"
                value={form.phone}
                onChange={(event) => handleInputChange("phone", event.target.value)}
                placeholder="07XXXXXXXX"
                disabled={!userCanCreateFieldTeam || saving}
              />
            </div>

            <Button
              type="button"
              className="w-full bg-green-600 text-white hover:bg-green-700"
              onClick={handleSubmit}
              disabled={!userCanCreateFieldTeam || saving}
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving Member...
                </>
              ) : (
                <>
                  <UserPlus className="mr-2 h-4 w-4" />
                  Add Field Team Member
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="space-y-2">
            <CardTitle className="flex items-center gap-2 text-slate-900">
              <Users className="h-5 w-5 text-blue-600" />
              Field Team Roster
            </CardTitle>
            <p className="text-sm text-slate-500">
              {fieldTeamMembers.length.toLocaleString()} member{fieldTeamMembers.length === 1 ? "" : "s"} currently recorded.
            </p>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex min-h-[240px] items-center justify-center">
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading field team members...
                </div>
              </div>
            ) : fieldTeamMembers.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
                No field team members have been added yet.
              </div>
            ) : (
              <div className="space-y-3">
                {fieldTeamMembers.map((member) => (
                  <div
                    key={member.id}
                    className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 transition-colors hover:border-slate-300 hover:bg-white"
                  >
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div>
                        <h3 className="text-base font-semibold text-slate-900">{member.name}</h3>
                        <p className="mt-1 flex items-center gap-2 text-sm text-slate-600">
                          <MapPin className="h-4 w-4 text-slate-400" />
                          {member.county}, {member.subcounty}
                        </p>
                      </div>

                      <div className="text-sm text-slate-500">
                        Added {formatTimestamp(member.createdAt)}
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 text-sm text-slate-600 md:grid-cols-2">
                      <a href={`mailto:${member.email}`} className="flex items-center gap-2 break-all hover:text-blue-700">
                        <Mail className="h-4 w-4 text-slate-400" />
                        {member.email}
                      </a>
                      <a href={`tel:${member.phone}`} className="flex items-center gap-2 hover:text-blue-700">
                        <Phone className="h-4 w-4 text-slate-400" />
                        {member.phone}
                      </a>
                    </div>

                    <p className="mt-3 text-xs text-slate-500">
                      Added by {member.createdBy || "Unknown user"}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default FieldTeamPage;
