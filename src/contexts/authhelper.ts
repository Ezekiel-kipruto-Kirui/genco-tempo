import { PROGRAMME_OPTIONS } from "@/lib/programme-access";

const normalizeText = (value: string) => {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");

  if (normalized === "chief admin" || normalized === "chief-admin") return "admin";
  if (normalized === "mobile user" || normalized === "mobile") return "field officer";
  return normalized;
};

const HR_IDENTIFIERS = new Set([
  "humman resource manager",
  "human resource manager",
  "humman resource manger",
  "human resource manger",
  "hr",
]);

const PROJECT_MANAGER_IDENTIFIERS = new Set(["project manager", "project officer"]);
const FINANCE_IDENTIFIERS = new Set(["finance"]);
const OFFTAKE_IDENTIFIERS = new Set(["offtake officer"]);
const EXECUTIVE_ASSISTANT_IDENTIFIERS = new Set(["executive assistant", "executive assitant"]);
const STAFF_IDENTIFIERS = new Set(["staff"]);
const FIELD_OFFICER_IDENTIFIERS = new Set(["field officer", "fieldofficer", "mobile", "mobile user"]);
const BLOCKED_STATUS_IDENTIFIERS = new Set([
  "inactive",
  "disabled",
  "deactivated",
  "deactivate",
  "suspended",
]);
const ME_IDENTIFIERS = new Set([
  "m&e officer",
  "mne officer",
  "me officer",
  "monitoring and evaluation officer",
  "monitoring & evaluation officer",
]);
const FULL_ACCESS_ATTRIBUTE_IDENTIFIERS = new Set([
  "ceo",
  "chief executive officer",
  "chief operations manager",
  "chief operational manager",
  "chief operations officer",
  "chief operational officer",
  "chief operatons manger",
  "project manager",
  "project officer",
  "m&e officer",
  "mne officer",
  "me officer",
  "monitoring and evaluation officer",
  "monitoring & evaluation officer",
]);
const DISPLAY_NAME_MAP = new Map<string, string>([
  ["admin", "Admin"],
  ["field officer", "Field Officer"],
  ["fieldofficer", "Field Officer"],
  ["mobile", "Field Officer"],
  ["mobile user", "Field Officer"],
  ["user", "User"],
  ["ceo", "Chief Executive Officer"],
  ["cio", "Chief Executive Officer"],
  ["chief executive officer", "Chief Executive Officer"],
  ["project manager", "Project Officer"],
  ["project officer", "Project Officer"],
  ["humman resource manager", "Human Resource Manager"],
  ["human resource manager", "Human Resource Manager"],
  ["humman resource manger", "Human Resource Manager"],
  ["human resource manger", "Human Resource Manager"],
  ["finance", "Finance"],
  ["offtake officer", "Offtake Officer"],
  ["executive assistant", "Executive Assistant"],
  ["executive assitant", "Executive Assistant"],
  ["staff", "Staff"],
  ["chief operations manager", "Chief Operations Officer"],
  ["chief operational manager", "Chief Operations Officer"],
  ["chief operations officer", "Chief Operations Officer"],
  ["chief operational officer", "Chief Operations Officer"],
  ["chief operatons manger", "Chief Operations Officer"],
  ["m&e officer", "M&E Officer"],
  ["mne officer", "M&E Officer"],
  ["me officer", "M&E Officer"],
  ["monitoring and evaluation officer", "M&E Officer"],
  ["monitoring & evaluation officer", "M&E Officer"],
]);

const toTitleCase = (value: string): string =>
  value
    .split("-")
    .join(" ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

const formatDisplayName = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const normalized = normalizeText(trimmed);
  const mappedDisplayName = DISPLAY_NAME_MAP.get(normalized);
  if (mappedDisplayName) return mappedDisplayName;

  if (/[A-Z]/.test(trimmed)) return trimmed;
  return toTitleCase(normalized);
};

export const normalizeRole = (userRole: string | null | undefined): string => {
  if (!userRole) return "";
  return normalizeText(userRole);
};

export const normalizeAttribute = (userAttribute: string | null | undefined): string => {
  if (!userAttribute) return "";
  return normalizeText(userAttribute);
};

export const normalizeUserStatus = (status: string | null | undefined): string => {
  if (!status) return "";
  return normalizeText(status);
};

export const isBlockedUserStatus = (status: string | null | undefined): boolean =>
  BLOCKED_STATUS_IDENTIFIERS.has(normalizeUserStatus(status));

export const isActiveUserStatus = (status: string | null | undefined): boolean =>
  !isBlockedUserStatus(status);

export const resolvePermissionPrincipal = (
  userRole: string | null | undefined,
  userAttribute?: string | null
): string => {
  const normalizedAttribute = normalizeAttribute(userAttribute);
  if (normalizedAttribute) return normalizedAttribute;
  return normalizeRole(userRole);
};

export const isAdmin = (value: string | null | undefined): boolean => normalizeRole(value) === "admin";

export const isProjectManager = (value: string | null | undefined): boolean => {
  const normalized = normalizeAttribute(value) || normalizeRole(value);
  return PROJECT_MANAGER_IDENTIFIERS.has(normalized);
};

export const isHummanResourceManager = (value: string | null | undefined): boolean => {
  const normalized = normalizeAttribute(value) || normalizeRole(value);
  return HR_IDENTIFIERS.has(normalized);
};

export const isFinance = (value: string | null | undefined): boolean => {
  const normalized = normalizeAttribute(value) || normalizeRole(value);
  return FINANCE_IDENTIFIERS.has(normalized);
};

export const isOfftakeOfficer = (value: string | null | undefined): boolean => {
  const normalized = normalizeAttribute(value) || normalizeRole(value);
  return OFFTAKE_IDENTIFIERS.has(normalized);
};

export const isExecutiveAssistant = (value: string | null | undefined): boolean => {
  const normalized = normalizeAttribute(value) || normalizeRole(value);
  return EXECUTIVE_ASSISTANT_IDENTIFIERS.has(normalized);
};

export const isStaff = (value: string | null | undefined): boolean => {
  const normalized = normalizeAttribute(value) || normalizeRole(value);
  return STAFF_IDENTIFIERS.has(normalized);
};

export const isOrdersOnlyRole = (value: string | null | undefined): boolean =>
  isExecutiveAssistant(value) || isStaff(value);

export const isMobileUser = (
  userRole: string | null | undefined,
  userAttribute?: string | null
): boolean => {
  const normalizedRole = normalizeRole(userRole);
  const normalizedAttribute = normalizeAttribute(userAttribute);
  const principal = resolvePermissionPrincipal(userRole, userAttribute);

  return (
    FIELD_OFFICER_IDENTIFIERS.has(normalizedRole) ||
    FIELD_OFFICER_IDENTIFIERS.has(normalizedAttribute) ||
    FIELD_OFFICER_IDENTIFIERS.has(principal)
  );
};

export const isFieldOfficer = isMobileUser;

export const isMonitoringAndEvaluationOfficer = (
  value: string | null | undefined
): boolean => {
  const normalized = normalizeAttribute(value) || normalizeRole(value);
  return ME_IDENTIFIERS.has(normalized);
};

export const isFullAccessAttribute = (value: string | null | undefined): boolean =>
  FULL_ACCESS_ATTRIBUTE_IDENTIFIERS.has(normalizeAttribute(value));

export const canViewAllProgrammes = (
  userRole: string | null | undefined,
  userAttribute?: string | null,
  allowedProgrammes?: Record<string, boolean> | null
): boolean => {
  if (isMobileUser(userRole, userAttribute)) return false;
  const principal = resolvePermissionPrincipal(userRole, userAttribute);
  if (isAdmin(principal) || isFullAccessAttribute(principal)) return true;

  const assignedProgrammes = PROGRAMME_OPTIONS.filter(
    (programme) => allowedProgrammes?.[programme] === true
  );
  return assignedProgrammes.length >= PROGRAMME_OPTIONS.length;
};

export const canAccessDashboard = (
  userRole: string | null | undefined,
  userAttribute?: string | null
): boolean => {
  if (isMobileUser(userRole, userAttribute)) return false;
  const principal = resolvePermissionPrincipal(userRole, userAttribute);
  return (
    isAdmin(principal) ||
    isFinance(principal) ||
    isProjectManager(principal) ||
    isHummanResourceManager(principal) ||
    isExecutiveAssistant(principal) ||
    isOfftakeOfficer(principal) ||
    isFullAccessAttribute(principal)
  );
};

export const canAccessReports = (
  userRole: string | null | undefined,
  userAttribute?: string | null
): boolean => {
  if (isMobileUser(userRole, userAttribute)) return false;
  const principal = resolvePermissionPrincipal(userRole, userAttribute);

  if (
    isFinance(principal) ||
    isOfftakeOfficer(principal)
  ) {
    return false;
  }

  return (
    isAdmin(principal) ||
    isFullAccessAttribute(principal) ||
    isProjectManager(principal) ||
    isHummanResourceManager(principal)
  );
};

export const canAccessSiteManagement = (
  userRole: string | null | undefined,
  userAttribute?: string | null
): boolean => {
  if (isMobileUser(userRole, userAttribute)) return false;
  const principal = resolvePermissionPrincipal(userRole, userAttribute);

  if (
    isProjectManager(principal) ||
    isHummanResourceManager(principal) ||
    isFinance(principal) ||
    isOfftakeOfficer(principal)
  ) {
    return false;
  }

  return isAdmin(userRole);
};

export const canAccessUserManagement = (
  userRole: string | null | undefined,
  userAttribute?: string | null
): boolean => {
  if (isMobileUser(userRole, userAttribute)) return false;
  return isAdmin(userRole);
};

export const canAccessFarmerData = (
  userRole: string | null | undefined,
  userAttribute?: string | null
): boolean => {
  if (isMobileUser(userRole, userAttribute)) return false;
  const principal = resolvePermissionPrincipal(userRole, userAttribute);
  return (
    isAdmin(principal) ||
    isFullAccessAttribute(principal) ||
    isProjectManager(principal) ||
    isMonitoringAndEvaluationOfficer(principal)
  );
};

export const canAccessInfrastructure = (
  userRole: string | null | undefined,
  userAttribute?: string | null
): boolean => {
  if (isMobileUser(userRole, userAttribute)) return false;
  const principal = resolvePermissionPrincipal(userRole, userAttribute);
  return canAccessFarmerData(userRole, userAttribute) || isHummanResourceManager(principal);
};

export const canManageInfrastructureRecords = (
  userRole: string | null | undefined,
  userAttribute?: string | null
): boolean => {
  if (isMobileUser(userRole, userAttribute)) return false;
  const principal = resolvePermissionPrincipal(userRole, userAttribute);
  return isAdmin(principal);
};

export const canAccessFieldActivities = (
  userRole: string | null | undefined,
  userAttribute?: string | null
): boolean => {
  if (isMobileUser(userRole, userAttribute)) return false;
  const principal = resolvePermissionPrincipal(userRole, userAttribute);
  return (
    isAdmin(principal) ||
    isFullAccessAttribute(principal) ||
    isProjectManager(principal) ||
    isHummanResourceManager(principal) ||
    isFinance(principal) ||
    isMonitoringAndEvaluationOfficer(principal)
  );
};

export const canAccessProjectManagerSection = (
  userRole: string | null | undefined,
  userAttribute?: string | null
): boolean => {
  if (isMobileUser(userRole, userAttribute)) return false;
  const principal = resolvePermissionPrincipal(userRole, userAttribute);
  return (
    isProjectManager(principal) ||
    isAdmin(principal) ||
    isFullAccessAttribute(principal) ||
    isMonitoringAndEvaluationOfficer(principal)
  );
};

export const canAccessHrManagement = (
  userRole: string | null | undefined,
  userAttribute?: string | null
): boolean => {
  if (isMobileUser(userRole, userAttribute)) return false;
  const principal = resolvePermissionPrincipal(userRole, userAttribute);
  return (
    isHummanResourceManager(principal) ||
    isAdmin(principal) ||
    isFullAccessAttribute(principal)
  );
};

export const canAccessFinanceSection = (
  userRole: string | null | undefined,
  userAttribute?: string | null
): boolean => {
  if (isMobileUser(userRole, userAttribute)) return false;
  const principal = resolvePermissionPrincipal(userRole, userAttribute);
  return (
    isFinance(principal) ||
    isAdmin(principal) ||
    isFullAccessAttribute(principal)
  );
};

export const canAccessRequisition = (
  userRole: string | null | undefined,
  userAttribute?: string | null
): boolean => {
  if (isMobileUser(userRole, userAttribute)) return false;
  const principal = resolvePermissionPrincipal(userRole, userAttribute);
  return (
    isAdmin(principal) ||
    isFullAccessAttribute(principal) ||
    isProjectManager(principal) ||
    isHummanResourceManager(principal) ||
    isFinance(principal)
  );
};

export const canAccessOrdersSection = (
  userRole: string | null | undefined,
  userAttribute?: string | null
): boolean => {
  if (isMobileUser(userRole, userAttribute)) return false;
  const principal = resolvePermissionPrincipal(userRole, userAttribute);
  return (
    isOrdersOnlyRole(principal) ||
    isOfftakeOfficer(principal) ||
    isAdmin(principal) ||
    isFullAccessAttribute(principal)
  );
};

export const getLandingRouteForRole = (
  userRole: string | null | undefined,
  userAttribute?: string | null
): string => {
  if (isMobileUser(userRole, userAttribute)) return "/auth";
  const principal = resolvePermissionPrincipal(userRole, userAttribute);

  if (isExecutiveAssistant(principal)) return "/dashboard";
  if (isStaff(principal)) return "/orders";
  if (isOfftakeOfficer(principal)) return "/orders";
  if (canAccessDashboard(userRole, userAttribute)) return "/dashboard";
  return "/auth";
};

export const hasAnyRole = (
  userRole: string | null | undefined,
  allowedRoles: string[],
  userAttribute?: string | null
): boolean => {
  if (isMobileUser(userRole, userAttribute)) return false;
  const normalizedRole = normalizeRole(userRole);
  const normalizedAttribute = normalizeAttribute(userAttribute);
  const principal = resolvePermissionPrincipal(userRole, userAttribute);
  const permissionTokens = Array.from(
    new Set([normalizedRole, normalizedAttribute, principal].filter(Boolean))
  );

  return allowedRoles
    .map(normalizeText)
    .some((allowedRole) => {
      if (HR_IDENTIFIERS.has(allowedRole)) return permissionTokens.some((token) => isHummanResourceManager(token));
      if (PROJECT_MANAGER_IDENTIFIERS.has(allowedRole)) return permissionTokens.some((token) => isProjectManager(token));
      if (FINANCE_IDENTIFIERS.has(allowedRole)) return permissionTokens.some((token) => isFinance(token));
      if (OFFTAKE_IDENTIFIERS.has(allowedRole)) return permissionTokens.some((token) => isOfftakeOfficer(token));
      if (EXECUTIVE_ASSISTANT_IDENTIFIERS.has(allowedRole)) return permissionTokens.some((token) => isExecutiveAssistant(token));
      if (STAFF_IDENTIFIERS.has(allowedRole)) return permissionTokens.some((token) => isStaff(token));
      if (FULL_ACCESS_ATTRIBUTE_IDENTIFIERS.has(allowedRole)) return permissionTokens.some((token) => isFullAccessAttribute(token));
      return permissionTokens.includes(allowedRole);
    });
};

export const getRoleDisplayName = (
  userRole: string | null | undefined,
  userAttribute?: string | null
): string => {
  const attribute = typeof userAttribute === "string" ? userAttribute.trim() : "";
  if (attribute) return formatDisplayName(attribute);

  const role = typeof userRole === "string" ? userRole.trim() : "";
  if (!role) return "User";
  return formatDisplayName(role);
};


