import { Outlet } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { LogOut, Bell } from "lucide-react";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { DashboardSidebar } from "./DashboardSidebar";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getRoleDisplayName } from "@/contexts/authhelper";
import { useDashboardNotifications } from "@/hooks/use-dashboard-notifications";

const getCurrentMonthLabel = () => {
  const now = new Date();
  return now.toLocaleDateString("en-US", { timeZone: "Africa/Nairobi", month: "long", year: "numeric" });
};

const DashboardLayout = () => {
  const { user, userRole, userAttribute, userName, signOutUser } = useAuth();
  const navigate = useNavigate();
  const notifications = useDashboardNotifications();
  const totalNotifications = useMemo(() => notifications.totalCount, [notifications.totalCount]);

  const goToNotification = (path: string, markSeen?: () => void) => {
    markSeen?.();
    navigate(path);
  };

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full bg-gradient-to-br from-primary/5 via-background to-accent/5">
        
        <DashboardSidebar />

        <div className="flex-1 flex flex-col w-full min-w-0">
          <header className="border-b bg-card/50 bg-white sticky top-0 z-10 h-16">
            <div className="w-full px-4 sm:px-6 lg:px-8 h-full flex items-center justify-between">

              <div className="flex items-center gap-2 sm:gap-3">
                <SidebarTrigger className="flex-shrink-0" />
                <p className="text-sm text-muted-foreground truncate">
                  {userName || user?.email || "User"}
                </p>
                <span className="hidden sm:inline-flex text-xs px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 font-semibold whitespace-nowrap">
                  {getCurrentMonthLabel()}
                </span>
              </div>

              <div className="flex items-center gap-2 sm:gap-3">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="relative">
                      <Bell className="h-4 w-4" />
                      {totalNotifications > 0 && (
                        <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                          {totalNotifications > 99 ? "99+" : totalNotifications}
                        </span>
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-80 p-0">
                    <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
                      <DropdownMenuLabel className="text-xs font-semibold uppercase tracking-wide text-slate-500 m-0">
                        New Notifications
                      </DropdownMenuLabel>
                      {totalNotifications > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            notifications.markSeen("activities");
                            notifications.markSeen("farmers");
                            notifications.markSeen("fodder");
                            notifications.markSeen("capacity");
                            notifications.markSeen("hayStorage");
                            notifications.markSeen("borehole");
                          }}
                          className="h-6 text-[10px] text-slate-500 hover:text-slate-700"
                        >
                          Clear all
                        </Button>
                      )}
                    </div>

                    <div className="max-h-[400px] overflow-y-auto divide-y divide-slate-50">
                      {notifications.activities.count > 0 && (
                        <DropdownMenuItem
                          onSelect={() => goToNotification("/dashboard/activities", () => notifications.markSeen("activities"))}
                          className="flex items-center justify-between gap-3 rounded-none"
                        >
                          <span className="truncate text-sm">Field Activities</span>
                          <Badge className="shrink-0 rounded-full bg-amber-100 px-2 py-0 text-[10px] font-semibold text-amber-800 hover:bg-amber-100">
                            {notifications.activities.count}
                          </Badge>
                        </DropdownMenuItem>
                      )}

                      {notifications.farmers.count > 0 && (
                        <DropdownMenuItem
                          onSelect={() => goToNotification("/dashboard/livestock", () => notifications.markSeen("farmers"))}
                          className="flex items-center justify-between gap-3 rounded-none"
                        >
                          <span className="truncate text-sm">Livestock Farmers</span>
                          <Badge className="shrink-0 rounded-full bg-blue-100 px-2 py-0 text-[10px] font-semibold text-blue-800 hover:bg-blue-100">
                            {notifications.farmers.count}
                          </Badge>
                        </DropdownMenuItem>
                      )}

                      {notifications.fodder.count > 0 && (
                        <DropdownMenuItem
                          onSelect={() => goToNotification("/dashboard/fodder", () => notifications.markSeen("fodder"))}
                          className="flex items-center justify-between gap-3 rounded-none"
                        >
                          <span className="truncate text-sm">Fodder Farmers</span>
                          <Badge className="shrink-0 rounded-full bg-emerald-100 px-2 py-0 text-[10px] font-semibold text-emerald-800 hover:bg-emerald-100">
                            {notifications.fodder.count}
                          </Badge>
                        </DropdownMenuItem>
                      )}

                      {notifications.capacity.count > 0 && (
                        <DropdownMenuItem
                          onSelect={() => goToNotification("/dashboard/capacity", () => notifications.markSeen("capacity"))}
                          className="flex items-center justify-between gap-3 rounded-none"
                        >
                          <span className="truncate text-sm">Capacity Building</span>
                          <Badge className="shrink-0 rounded-full bg-violet-100 px-2 py-0 text-[10px] font-semibold text-violet-800 hover:bg-violet-100">
                            {notifications.capacity.count}
                          </Badge>
                        </DropdownMenuItem>
                      )}

                      {(notifications.hayStorage.count > 0 || notifications.borehole.count > 0) && (
                        <>
                          <div className="px-3 py-1.5 bg-slate-50">
                            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Infrastructure</span>
                          </div>
                          {notifications.hayStorage.count > 0 && (
                            <DropdownMenuItem
                              onSelect={() => goToNotification("/dashboard/hay-storage", () => notifications.markSeen("hayStorage"))}
                              className="flex items-center justify-between gap-3 rounded-none"
                            >
                              <span className="truncate text-sm">Hay Storage</span>
                              <Badge className="shrink-0 rounded-full bg-sky-100 px-2 py-0 text-[10px] font-semibold text-sky-800 hover:bg-sky-100">
                                {notifications.hayStorage.count}
                              </Badge>
                            </DropdownMenuItem>
                          )}
                          {notifications.borehole.count > 0 && (
                            <DropdownMenuItem
                              onSelect={() => goToNotification("/dashboard/borehole", () => notifications.markSeen("borehole"))}
                              className="flex items-center justify-between gap-3 rounded-none"
                            >
                              <span className="truncate text-sm">Borehole</span>
                              <Badge className="shrink-0 rounded-full bg-cyan-100 px-2 py-0 text-[10px] font-semibold text-cyan-800 hover:bg-cyan-100">
                                {notifications.borehole.count}
                              </Badge>
                            </DropdownMenuItem>
                          )}
                        </>
                      )}

                      {notifications.requisitions.count > 0 && (
                        <>
                          <div className="px-3 py-1.5 bg-slate-50">
                            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Requisitions</span>
                          </div>
                          <DropdownMenuItem
                            onSelect={() => goToNotification(notifications.requisitions.href)}
                            className="flex items-center justify-between gap-3 rounded-none"
                          >
                            <div className="min-w-0">
                              <span className="block truncate text-sm">{notifications.requisitions.label}</span>
                              <span className="block text-[11px] text-slate-500">
                                {notifications.requisitions.description}
                              </span>
                            </div>
                            <Badge className="shrink-0 rounded-full bg-rose-100 px-2 py-0 text-[10px] font-semibold text-rose-800 hover:bg-rose-100">
                              {notifications.requisitions.count}
                            </Badge>
                          </DropdownMenuItem>
                        </>
                      )}

                      {totalNotifications === 0 && (
                        <div className="px-4 py-8 text-center">
                          <Bell className="mx-auto h-8 w-8 text-slate-300" />
                          <p className="mt-2 text-sm text-slate-500">No new notifications</p>
                        </div>
                      )}
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>

                <span className="text-xs sm:text-sm px-2 sm:px-3 py-1 rounded-full bg-primary/10 text-primary font-medium whitespace-nowrap flex-shrink-0">
                  {getRoleDisplayName(userRole, userAttribute)}
                </span>

                {/* Desktop signout */}
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={signOutUser}
                  className="hidden xs:flex flex-shrink-0"
                >
                  <LogOut className="h-3 w-3 sm:h-4 sm:w-4 mr-1 sm:mr-2" />
                  <span className="hidden sm:inline">Sign Out</span>
                </Button>

                {/* Mobile signout */}
                <Button 
                  variant="outline" 
                  size="icon"
                  onClick={signOutUser}
                  className="xs:hidden flex-shrink-0"
                >
                  <LogOut className="h-4 w-4" />
                </Button>
              </div>

            </div>
          </header>

          <main className="flex-1 overflow-auto">
            <div className="w-full px-3 sm:px-4 lg:px-6 xl:px-8 py-4 sm:py-6 lg:py-8">
              <Outlet />
            </div>
          </main>

        </div>
      </div>
    </SidebarProvider>
  );
};

export default DashboardLayout;
