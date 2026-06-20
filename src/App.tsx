import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { ProgrammeProvider } from "@/contexts/ProgrammeContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import DashboardLayout from "@/components/DashboardLayout";

// Lazy load page components
const Auth = lazy(() => import("./pages/Auth"));
const DashboardOverview = lazy(() => import("./pages/DashboardOverview"));
const PerformanceReport = lazy(() => import("./pages/reportspage"));
const LivestockFarmersPage = lazy(() => import("./pages/LivestockFarmersPage"));
const LivestockFarmersAnalytics = lazy(() => import("./pages/LivestockFarmersAnalytics"));
const FodderFarmersPage = lazy(() => import("./pages/FodderFarmersPage"));
const InfrastructurePage = lazy(() => import("./pages/BoreHole"));
const HayStoragepage = lazy(() => import("./pages/HayStoragepage"));
const CapacityBuildingPage = lazy(() => import("./pages/CapacityBuildingPage"));
const LivestockOfftakePage = lazy(() => import("./pages/LivestockOfftakePage"));
const ActivitiesPage = lazy(() => import("./pages/ActivitiesPage"));
const FieldTeamPage = lazy(() => import("./pages/FieldTeamPage"));
const OnboardingPage = lazy(() => import("./pages/onboardingpage"));
const AnimalHealthPage = lazy(() => import("./pages/Animalhealth"));
const FodderOfftakePage = lazy(() => import("./pages/FodderOfftakePage"));
const SalesReport = lazy(() => import("./pages/salesmetrics"));
const RequisitionExpensesPage = lazy(() => import("./pages/RequisitionExpensesPage"));
const RequisitionTrendsPage = lazy(() => import("./pages/RequisitionTrendsPage"));
const UserManagementPage = lazy(() => import("./pages/UserManagementPage"));
const NotFound = lazy(() => import("./pages/NotFound"));
const RequsitionPage = lazy(() => import("./pages/requisitionpage"));
const OrdersPage = lazy(() => import("./pages/OrdersPage"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      retry: 1,
    },
  },
});
const FULL_ACCESS_IDENTITIES = ["admin", "ceo", "chief executive officer", "chief operations manager", "chief operational manager", "chief operational officer", "mne officer", "m&e officer", "me officer", "monitoring and evaluation officer", "monitoring & evaluation officer"];
const PROJECT_MANAGER_IDENTITIES = ["project manager", "project officer"];
const FINANCE_IDENTITIES = ["finance"];
const HR_IDENTITIES = [
  "human resource manager",
  "humman resource manager",
  "human resource manger",
  "humman resource manger",
  "hr",
];
const DASHBOARD_ALLOWED_IDENTITIES = [
  ...FULL_ACCESS_IDENTITIES,
  ...FINANCE_IDENTITIES,
  ...PROJECT_MANAGER_IDENTITIES,
  ...HR_IDENTITIES,
  "offtake officer",
];
const PROJECT_MANAGER_ALLOWED_IDENTITIES = [...FULL_ACCESS_IDENTITIES, ...PROJECT_MANAGER_IDENTITIES];
const REPORT_ALLOWED_IDENTITIES = [...FULL_ACCESS_IDENTITIES, ...PROJECT_MANAGER_IDENTITIES, ...HR_IDENTITIES];
const FIELD_TEAM_ALLOWED_IDENTITIES = PROJECT_MANAGER_ALLOWED_IDENTITIES;
const LIVESTOCK_ANALYTICS_ALLOWED_IDENTITIES = [...FULL_ACCESS_IDENTITIES, ...PROJECT_MANAGER_IDENTITIES, ...HR_IDENTITIES];
const SALES_REPORT_ALLOWED_IDENTITIES = [...FULL_ACCESS_IDENTITIES, ...FINANCE_IDENTITIES];
const FIELD_ACTIVITIES_ALLOWED_IDENTITIES = [...FULL_ACCESS_IDENTITIES, ...PROJECT_MANAGER_IDENTITIES, ...HR_IDENTITIES, ...FINANCE_IDENTITIES];
const INFRASTRUCTURE_ALLOWED_IDENTITIES = [...FULL_ACCESS_IDENTITIES, ...PROJECT_MANAGER_IDENTITIES, ...HR_IDENTITIES];
const SITE_MANAGEMENT_ALLOWED_IDENTITIES = ["admin"];
const USER_MANAGEMENT_ALLOWED_IDENTITIES = ["admin"];
const ORDERS_ONLY_IDENTITIES = ["executive assistant", "executive assitant", "staff"];
const EXECUTIVE_ASSISTANT_IDENTITIES = ["executive assistant", "executive assitant"];
const CAPACITY_ALLOWED_IDENTITIES = [...SITE_MANAGEMENT_ALLOWED_IDENTITIES, ...HR_IDENTITIES];
const REQUISITION_ALLOWED_IDENTITIES = [
  ...FULL_ACCESS_IDENTITIES,
  ...PROJECT_MANAGER_IDENTITIES,
  ...FINANCE_IDENTITIES,
  ...HR_IDENTITIES,
];
const ORDERS_ALLOWED_IDENTITIES = [...FULL_ACCESS_IDENTITIES, "offtake officer", ...ORDERS_ONLY_IDENTITIES];
const DASHBOARD_SHELL_ALLOWED_IDENTITIES = [...DASHBOARD_ALLOWED_IDENTITIES, ...EXECUTIVE_ASSISTANT_IDENTITIES];

const PageLoader = () => (
  <div className="flex items-center justify-center py-20">
    <div className="flex flex-col items-center gap-3">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      <p className="text-sm text-muted-foreground">Loading page...</p>
    </div>
  </div>
);

const App = () => (
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <AuthProvider>
        <ProgrammeProvider>
          <TooltipProvider>
            <Toaster />
            <Sonner />
            <Suspense fallback={<PageLoader />}>
              <Routes>
              {/* Public Routes */}
              <Route path="/" element={<Navigate to="/auth" replace />} />
              <Route path="/auth" element={<Auth />} />
              
              {/* --- NEW: HR Standalone Route --- */}
              {/* Legacy route: keep it for backward compatibility and redirect to dashboard layout. */}
              <Route
                path="/requisition"
                element={
                  <ProtectedRoute allowedRoles={REQUISITION_ALLOWED_IDENTITIES}>
                    <Navigate to="/dashboard/requisition" replace />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/orders"
                element={
                  <ProtectedRoute allowedRoles={ORDERS_ALLOWED_IDENTITIES}>
                    <div className="min-h-screen bg-slate-50/80 p-4 md:p-6 lg:p-8 pb-20">
                      <OrdersPage />
                    </div>
                  </ProtectedRoute>
                }
              />
              {/* ------------------------------- */}

              {/* Protected Dashboard Routes */}
              <Route
                path="/dashboard"
                element={
                  <ProtectedRoute allowedRoles={DASHBOARD_SHELL_ALLOWED_IDENTITIES}>
                    <DashboardLayout />
                  </ProtectedRoute>
                }
              >
                {/* Nested routes under DashboardLayout */}
                <Route index element={<DashboardOverview />} />
                <Route
                  path="field-team"
                  element={
                    <ProtectedRoute allowedRoles={FIELD_TEAM_ALLOWED_IDENTITIES}>
                      <FieldTeamPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="reports"
                  element={
                    <ProtectedRoute allowedRoles={REPORT_ALLOWED_IDENTITIES}>
                      <PerformanceReport />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="salesreport"
                  element={
                    <ProtectedRoute allowedRoles={SALES_REPORT_ALLOWED_IDENTITIES}>
                      <SalesReport />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="requisition-expenses"
                  element={
                    <ProtectedRoute allowedRoles={SITE_MANAGEMENT_ALLOWED_IDENTITIES}>
                      <RequisitionExpensesPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="requisition-trends"
                  element={
                    <ProtectedRoute allowedRoles={SITE_MANAGEMENT_ALLOWED_IDENTITIES}>
                      <RequisitionTrendsPage />
                    </ProtectedRoute>
                  }
                />
                <Route path="livestock">
                  <Route
                    index
                    element={
                      <ProtectedRoute allowedRoles={SITE_MANAGEMENT_ALLOWED_IDENTITIES}>
                        <LivestockFarmersPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="analytics"
                    element={
                      <ProtectedRoute allowedRoles={LIVESTOCK_ANALYTICS_ALLOWED_IDENTITIES}>
                        <LivestockFarmersAnalytics />
                      </ProtectedRoute>
                    }
                  />
                </Route>
                <Route
                  path="fodder"
                  element={
                    <ProtectedRoute allowedRoles={SITE_MANAGEMENT_ALLOWED_IDENTITIES}>
                      <FodderFarmersPage />
                    </ProtectedRoute>
                  }
                />
                {/* Infrastructure Routes */}
                <Route
                  path="hay-storage"
                  element={
                    <ProtectedRoute allowedRoles={INFRASTRUCTURE_ALLOWED_IDENTITIES}>
                      <HayStoragepage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="borehole"
                  element={
                    <ProtectedRoute allowedRoles={INFRASTRUCTURE_ALLOWED_IDENTITIES}>
                      <InfrastructurePage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="capacity"
                  element={
                    <ProtectedRoute allowedRoles={CAPACITY_ALLOWED_IDENTITIES}>
                      <CapacityBuildingPage />
                    </ProtectedRoute>
                  }
                />
                {/* Offtake Routes */}
                <Route
                  path="livestock-offtake"
                  element={
                    <ProtectedRoute allowedRoles={PROJECT_MANAGER_ALLOWED_IDENTITIES}>
                      <LivestockOfftakePage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="fodder-offtake"
                  element={
                    <ProtectedRoute allowedRoles={SITE_MANAGEMENT_ALLOWED_IDENTITIES}>
                      <FodderOfftakePage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="activities"
                  element={
                    <ProtectedRoute allowedRoles={FIELD_ACTIVITIES_ALLOWED_IDENTITIES}>
                      <ActivitiesPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="onboarding"
                  element={
                    <ProtectedRoute allowedRoles={FIELD_ACTIVITIES_ALLOWED_IDENTITIES}>
                      <OnboardingPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="animalhealth"
                  element={
                    <ProtectedRoute allowedRoles={FIELD_ACTIVITIES_ALLOWED_IDENTITIES}>
                      <AnimalHealthPage />
                    </ProtectedRoute>
                  }
                />
                {/* Admin Only Routes */}
                <Route
                  path="users"
                  element={
                    <ProtectedRoute allowedRoles={USER_MANAGEMENT_ALLOWED_IDENTITIES}>
                      <UserManagementPage />
                    </ProtectedRoute>
                  }
                />
                
                {/* Note: Admins can still access requisition inside the dashboard via sidebar if needed, 
                    or we can remove this if requisition is strictly HR-only. */}
                <Route
                  path="requisition"
                  element={
                    <ProtectedRoute allowedRoles={REQUISITION_ALLOWED_IDENTITIES}>
                      <RequsitionPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="orders"
                  element={
                    <ProtectedRoute allowedRoles={ORDERS_ALLOWED_IDENTITIES}>
                      <OrdersPage />
                    </ProtectedRoute>
                  }
                />
                
              </Route>

              {/* Catch-all route for 404 */}
              <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </TooltipProvider>
        </ProgrammeProvider>
      </AuthProvider>
    </BrowserRouter>
  </QueryClientProvider>
);

export default App;
