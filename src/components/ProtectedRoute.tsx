import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { getLandingRouteForRole, hasAnyRole, isMobileUser } from "@/contexts/authhelper";

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRoles?: string[];
}

const ProtectedRoute = ({ children, allowedRoles }: ProtectedRouteProps) => {
  const { user, userRole, userAttribute, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user || isMobileUser(userRole, userAttribute)) {
    return <Navigate to="/auth" replace />;
  }

  if (allowedRoles && !hasAnyRole(userRole, allowedRoles, userAttribute)) {
    const fallbackRoute = getLandingRouteForRole(userRole, userAttribute);
    const redirectTo = fallbackRoute === location.pathname ? "/auth" : fallbackRoute;
    return <Navigate to={redirectTo} replace />;
  }

  return <>{children}</>;
};

export default ProtectedRoute;
