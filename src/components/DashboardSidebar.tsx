import {
  Activity,
  Beef,
  Building2,
  ChevronRight,
  ClipboardList,
  Database,
  GraduationCap,
  HeartPulse,
  LineChart,
  LogOut,
  Settings,
  ShoppingCart,
  TrendingUp,
} from "lucide-react";

import { NavLink } from "@/components/NavLink";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useAuth } from "@/contexts/AuthContext";
import {
  canAccessDashboard,
  canAccessFarmerData,
  canAccessFieldActivities,
  canAccessInfrastructure,
  canAccessOrdersSection,
  canAccessProjectManagerSection,
  canAccessRequisition,
  canAccessReports,
  canAccessUserManagement,
  isFinance,
  isHummanResourceManager,
  isProjectManager,
  resolvePermissionPrincipal,
  canAccessSiteManagement,
} from "@/contexts/authhelper";

type NavSubItem = {
  title: string;
  url: string;
  icon: typeof Activity;
};

type NavSection = {
  title: string;
  icon: typeof Activity;
  visible: boolean;
  items: NavSubItem[];
};

const buildSections = (userRole: string | null, userAttribute: string | null): NavSection[] => {
  const canAccessLivestockOfftake = canAccessProjectManagerSection(userRole, userAttribute);
  const canAccessFodderOfftake = canAccessSiteManagement(userRole, userAttribute);

  return [
    {
      title: "Reports",
      icon: LineChart,
      visible: canAccessReports(userRole, userAttribute),
      items: [
        { title: "Performance Report", url: "/dashboard/reports", icon: LineChart },
        { title: "Sales Metrics", url: "/dashboard/salesreport", icon: TrendingUp },
      ],
    },
    {
      title: "Farmer Data",
      icon: Beef,
      visible: canAccessFarmerData(userRole, userAttribute),
      items: [
         { title: "Progress Dashboard", url: "/dashboard/livestock/analytics", icon: TrendingUp },
        { title: "Livestock Farmers", url: "/dashboard/livestock", icon: Database },
       
        { title: "Fodder Farmers", url: "/dashboard/fodder", icon: Database },
        { title: "Capacity Building", url: "/dashboard/capacity", icon: GraduationCap },
      ],
    },
    {
      title: "Offtake",
      icon: Beef,
      visible: canAccessLivestockOfftake || canAccessFodderOfftake,
      items: [
        ...(canAccessLivestockOfftake
          ? [{ title: "Livestock Offtake", url: "/dashboard/livestock-offtake", icon: Beef }]
          : []),
      ],
    },
    {
      title: "Infrastructure",
      icon: Building2,
      visible: canAccessInfrastructure(userRole, userAttribute),
      items: [
        { title: "Hay Storage", url: "/dashboard/hay-storage", icon: Database },
        { title: "Borehole", url: "/dashboard/borehole", icon: Database },
      ],
    },
    {
      title: "Field Activities",
      icon: Activity,
      visible: canAccessFieldActivities(userRole, userAttribute),
      items: [
        { title: "Activity Overview", url: "/dashboard/activities", icon: Activity },
        { title: "Animal Health", url: "/dashboard/animalhealth", icon: HeartPulse },
        { title: "Onboarding", url: "/dashboard/onboarding", icon: GraduationCap },
      ],
    },
  ];
};

const buildHrSections = (userRole: string | null, userAttribute: string | null): NavSection[] => {
  return buildSections(userRole, userAttribute).filter((section) =>
    section.title === "Farmer Data" ||
    section.title === "Field Activities" ||
    section.title === "Infrastructure"
  );
};

const buildProjectManagerSections = (userRole: string | null, userAttribute: string | null): NavSection[] => {
  return buildSections(userRole, userAttribute)
    .filter((section) =>
      section.title === "Farmer Data" ||
      section.title === "Field Activities" ||
      section.title === "Infrastructure"
    )
    .map((section) =>
      section.title === "Farmer Data"
        ? {
            ...section,
            items: section.items.filter((item) => item.url === "/dashboard/livestock/analytics"),
          }
        : section
    );
};

const buildFinanceSections = (userRole: string | null, userAttribute: string | null): NavSection[] => {
  return buildSections(userRole, userAttribute).filter((section) => section.title === "Field Activities");
};

const buildRoleMenuItems = (userRole: string | null, userAttribute: string | null): NavSubItem[] => {
  const principal = resolvePermissionPrincipal(userRole, userAttribute);

  if (isProjectManager(principal)) {
    return [
      { title: "Dashboard Overview", url: "/dashboard", icon: TrendingUp },
      { title: "Field Team Page", url: "/dashboard/field-team", icon: ClipboardList },
      { title: "Report", url: "/dashboard/reports", icon: LineChart },
    ];
  }

  if (isHummanResourceManager(principal)) {
    return [
      { title: "Dashboard Overview", url: "/dashboard", icon: TrendingUp },
      { title: "General Report", url: "/dashboard/reports", icon: LineChart },
      { title: "Progress Dashboard", url: "/dashboard/livestock/analytics", icon: TrendingUp },
      { title: "Capacity Building", url: "/dashboard/capacity", icon: GraduationCap },
    ];
  }

  if (isFinance(principal)) {
    return [
      { title: "Dashboard Overview", url: "/dashboard", icon: TrendingUp },
      { title: "Sales Metrics", url: "/dashboard/salesreport", icon: TrendingUp },
    ];
  }

  return [];
};

export function DashboardSidebar() {
  const { state } = useSidebar();
  const { signOutUser, userRole, userAttribute } = useAuth();
  const collapsed = state === "collapsed";
  const principal = resolvePermissionPrincipal(userRole, userAttribute);
  const sections = buildSections(userRole, userAttribute);
  const roleMenuItems = buildRoleMenuItems(userRole, userAttribute);
  const roleMenuSections = isProjectManager(principal)
    ? buildProjectManagerSections(userRole, userAttribute)
    : isHummanResourceManager(principal)
      ? buildHrSections(userRole, userAttribute)
      : isFinance(principal)
        ? buildFinanceSections(userRole, userAttribute)
        : roleMenuItems.length === 0
          ? sections
          : [];
  const showStandaloneDashboard = roleMenuItems.length === 0 && canAccessDashboard(userRole, userAttribute);
  const showBottomRequisition = canAccessRequisition(userRole, userAttribute);
  const sidebarItemClassName = "h-7 gap-1 px-1 py-0 text-base";
  const sidebarSubItemClassName = "h-6 gap-1 px-1 py-0 text-base";
  const footerItemClassName = "h-10 gap-1 px-1 py-1 text-base border-l-2 border-l-yellow-500/80";

  return (
    <Sidebar className={`${collapsed ? "w-14" : "w-64"} bg-green-700 text-white`} collapsible="icon">
      <SidebarHeader className="border-b border-orange-500 bg-green-700 p-2">
        <div className="flex items-center gap-2 p-1.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 shadow backdrop-blur">
            <img src="/img/logo.png" className="h-8 w-8 rounded-full object-cover" alt="GenCo Logo" />
          </div>
          {!collapsed && (
            <div className="truncate">
              <h1 className="text-base font-bold text-white">GENCO Livestock</h1>
            </div>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent className="bg-green-700">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {showStandaloneDashboard && (
                <SidebarMenuItem>
                  <SidebarMenuButton asChild className={sidebarItemClassName}>
                    <NavLink
                      to="/dashboard"
                      end
                      className="text-green-50 transition-colors hover:bg-green-600"
                      activeClassName="bg-white font-bold text-green-700 shadow-sm"
                    >
                      <TrendingUp className="h-4 w-4" />
                      {!collapsed && <span>Dashboard Overview</span>}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}

              {roleMenuItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild className={sidebarItemClassName}>
                    <NavLink
                      to={item.url}
                      end={item.url === "/dashboard"}
                      className="text-green-50 transition-colors hover:bg-green-600"
                      activeClassName="bg-white font-bold text-green-700 shadow-sm"
                    >
                      <item.icon className="h-4 w-4" />
                      {!collapsed && <span>{item.title}</span>}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}

            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {roleMenuSections.map((section) => {
          if (!section.visible) return null;

          return (
            <SidebarGroup key={section.title}>
              <SidebarGroupContent>
                <SidebarMenu>
                  <Collapsible defaultOpen className="group/collapsible">
                    <SidebarMenuItem>
                      <CollapsibleTrigger asChild>
                        <SidebarMenuButton className={`${sidebarItemClassName} text-green-50 transition-colors hover:bg-green-600`}>
                          <section.icon className="h-4 w-4" />
                          {!collapsed && (
                            <>
                              <span>{section.title}</span>
                              <ChevronRight className="ml-auto h-4 w-4 transition-transform group-data-[state=open]/collapsible:rotate-90" />
                            </>
                          )}
                        </SidebarMenuButton>
                      </CollapsibleTrigger>

                      {!collapsed && (
                        <CollapsibleContent>
                          <SidebarMenuSub>
                            {section.items.map((item) => (
                              <SidebarMenuSubItem key={item.title}>
                                <SidebarMenuSubButton asChild className={sidebarSubItemClassName}>
                                  <NavLink
                                    to={item.url}
                                    className="text-green-100/70 transition-colors hover:bg-green-600"
                                    activeClassName="bg-white font-bold text-green-700"
                                  >
                                    <item.icon className="h-3.5 w-3.5" />
                                    <span>{item.title}</span>
                                  </NavLink>
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            ))}
                          </SidebarMenuSub>
                        </CollapsibleContent>
                      )}
                    </SidebarMenuItem>
                  </Collapsible>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}

        {canAccessOrdersSection(userRole, userAttribute) && (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild className={sidebarItemClassName}>
                    <NavLink
                      to="/dashboard/orders"
                      className="text-green-50 transition-colors hover:bg-green-600"
                      activeClassName="bg-white font-bold text-green-700 shadow-sm"
                    >
                      <ShoppingCart className="h-4 w-4" />
                      {!collapsed && <span>Orders</span>}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {showBottomRequisition && (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild className={sidebarItemClassName}>
                    <NavLink
                      to="/dashboard/requisition"
                      className="text-green-50 transition-colors hover:bg-green-600"
                      activeClassName="bg-white font-bold text-green-700 shadow-sm"
                    >
                      <ClipboardList className="h-4 w-4" />
                      {!collapsed && <span>Requisitions</span>}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter className="border-t border-yellow-500 bg-green-700 py-4 px-2">
        <SidebarMenu>
          {canAccessUserManagement(userRole, userAttribute) && (
            <SidebarMenuItem>
              <SidebarMenuButton asChild className={footerItemClassName}>
                <NavLink
                  to="/dashboard/users"
                  className="text-green-50 transition-colors hover:bg-green-600"
                  activeClassName="border-yellow-500 bg-white font-bold text-green-700 shadow-sm"
                >
                  <Settings className="h-4 w-4" />
                  {!collapsed && <span>Site Management</span>}
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}

          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={signOutUser}
              className={`${footerItemClassName} text-green-50 transition-colors hover:bg-green-600`}
            >
              <LogOut className="h-4 w-4" />
              {!collapsed && <span>Logout</span>}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
