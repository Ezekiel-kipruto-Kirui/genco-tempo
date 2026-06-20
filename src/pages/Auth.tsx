import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, EyeOff, Mail, Lock } from "lucide-react";
import { getLandingRouteForRole } from "@/contexts/authhelper";

const Auth = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [navigating, setNavigating] = useState(false);

  // Retrieve userRole from the auth context
  const { signIn, user, userRole, userAttribute, loading } = useAuth();
  const navigate = useNavigate();
  const navigatedRef = useRef(false);

  // Navigate once either role or custom attribute has loaded.
  useEffect(() => {
    if (navigatedRef.current) return;
    if (!loading && user && (userRole || userAttribute)) {
      navigatedRef.current = true;
      setNavigating(true);
      navigate(getLandingRouteForRole(userRole, userAttribute), { replace: true });
    }
  }, [loading, user, userRole, userAttribute, navigate]);

  // Also navigate if user is already logged in on mount (e.g., page refresh)
  useEffect(() => {
    if (navigatedRef.current) return;
    if (!loading && user && (userRole || userAttribute)) {
      navigatedRef.current = true;
      setNavigating(true);
      navigate(getLandingRouteForRole(userRole, userAttribute), { replace: true });
    }
  }, [loading, user, userRole, userAttribute, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      await signIn(email, password);

      // Poll for auth state to be ready (max 10 seconds)
      // This handles the case where onAuthStateChanged + fetchUserProfile takes time
      let attempts = 0;
      const maxAttempts = 100; // 100 × 100ms = 10 seconds
      const poll = setInterval(() => {
        attempts++;
        if (user && (userRole || userAttribute) && !loading) {
          clearInterval(poll);
          if (!navigatedRef.current) {
            navigatedRef.current = true;
            setNavigating(true);
            navigate(getLandingRouteForRole(userRole, userAttribute), { replace: true });
          }
        } else if (attempts >= maxAttempts) {
          clearInterval(poll);
          // If polling fails, try navigating anyway with whatever we have
          if (!navigatedRef.current && user) {
            navigatedRef.current = true;
            setNavigating(true);
            navigate(getLandingRouteForRole(userRole, userAttribute), { replace: true });
          }
        }
      }, 100);
    } catch (error) {
      // Error is handled in the context (toast notification)
    } finally {
      setIsLoading(false);
    }
  };

  const togglePasswordVisibility = () => {
    setShowPassword(!showPassword);
  };

  if (navigating) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-slate-50">
        <div className="text-center">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
          <p className="text-sm text-muted-foreground">Redirecting...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen w-full overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: "url('./img/bg-img.png')",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
          backgroundSize: "cover",
        }}
      />

      {/* Dark overlay */}
      <div className="absolute inset-0 bg-black/40" />

      <div className="relative z-10 flex min-h-screen w-full items-center justify-center px-4 py-12 sm:px-6 lg:px-8">
        <div className="max-w-md w-full">
          <div className="bg-white rounded-2xl shadow-xl overflow-hidden border border-gray-100">
            {/* Header */}
            <div className="bg-gradient-to-r from-blue-600 to-indigo-700 py-8 px-8 relative overflow-hidden">
              <div className="absolute inset-0 opacity-10">
                <div 
                  className="inset-0"
                  style={{
                    backgroundImage: `url("data:image/svg+xml,%3Csvg width='20' height='20' viewBox='0 0 20 20' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M0 0h20L0 20z' fill='%23ffffff' fill-opacity='0.2'/%3E%3C/svg%3E")`
                  }}
                ></div>
              </div>

              <div className="flex items-center justify-center relative z-10">
                <div 
                  className="bg-blue-500 rounded-full shadow-xl flex items-center justify-center"
                  style={{ width: '70px', height: '70px' }}
                >
                  <img 
                    src="./img/logo.png" 
                    alt="Clean Page Laundry Logo" 
                    className="w-full h-full rounded-full object-contain"
                  />
                </div>
              </div>

              <p className="mt-2 text-center text-blue-100 text-sm font-medium">
                Sign in to your Genco account
              </p>
            </div>

            {/* Form */}
            <div className="px-6 py-4">
              <form className="space-y-6 p-4" onSubmit={handleSubmit}>
                <div className="space-y-5">
                  {/* Email */}
                  <div>
                    <Label htmlFor="email" className="block text-sm font-semibold text-gray-800 mb-2">
                      Email
                    </Label>
                    <div className="relative">
                      <div className="flex flex-row items-center justify-center">
                        <div className="absolute ml-2 inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                          <Mail className="w-5 h-5 text-gray-500" />
                        </div>
                        <Input
                          id="email"
                          type="email"
                          required
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          className="block w-full pl-10 pr-3 py-3 border border-gray-300 rounded-lg 
                                 focus:ring-2 focus:ring-blue-600 focus:border-blue-600 
                                 transition duration-200 ease-in-out bg-gray-50/50 hover:bg-gray-50"
                          placeholder="Enter your email"
                          disabled={isLoading}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Password */}
                  <div>
                    <Label htmlFor="password" className="block text-sm font-semibold text-gray-800 mb-2">
                      Password
                    </Label>
                    <div className="relative">
                      <div className="flex flex-row items-center justify-center">
                        <div className="absolute ml-2 inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                          <Lock className="w-5 h-5 text-gray-500" />
                        </div>

                        <Input
                          id="password"
                          type={showPassword ? "text" : "password"}
                          required
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          className="block w-full pl-10 pr-12 py-3 border border-gray-300 rounded-lg 
                                 focus:ring-2 focus:ring-blue-600 focus:border-blue-600 
                                 transition duration-200 ease-in-out bg-gray-50/50 hover:bg-gray-50"
                          placeholder="Enter your password"
                          disabled={isLoading}
                        />

                        {/* Toggle Password Button */}
                        <Button
                          type="button"
                          onClick={togglePasswordVisibility}
                          disabled={isLoading}
                          className="absolute inset-y-0 right-0 pr-3 mr-2 flex items-center text-gray-500 hover:text-blue-600 focus:outline-none focus:text-blue-600 transition-colors duration-200 bg-transparent hover:bg-transparent p-0 h-auto"
                          aria-label={showPassword ? "Hide password" : "Show password"}
                        >
                          {showPassword ? (
                            <EyeOff className="w-5 h-5" />
                          ) : (
                            <Eye className="w-5 h-5" />
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Submit Button */}
                <Button
                  type="submit"
                  disabled={isLoading}
                  className="mt-6 w-full py-3 flex justify-center items-center text-base font-semibold rounded-lg text-white
                         bg-gradient-to-r from-blue-600 to-indigo-700 
                         hover:from-blue-700 hover:to-indigo-800 
                         focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-600
                         transition-all duration-300 ease-in-out shadow-md hover:shadow-lg
                         disabled:opacity-50 disabled:cursor-not-allowed relative overflow-hidden h-12"
                >
                  {/* Button Text */}
                  <span className={`transition-all duration-300 ${isLoading ? 'opacity-0' : 'opacity-100'}`}>
                    Sign in
                  </span>

                  {/* Spinner */}
                  <div className={`absolute inset-0 flex items-center justify-center bg-gradient-to-r from-blue-600 to-indigo-700 rounded-lg transition-opacity duration-300 ${isLoading ? 'opacity-100' : 'opacity-0'}`}>
                    <div className="flex items-center space-x-2">
                      {/* Spinner SVG */}
                      <div 
                        className="rounded-full h-5 w-5 border-2 border-white border-t-transparent"
                        style={{ animation: 'spin 1s linear infinite' }}
                      ></div>
                      <span className="text-white text-sm font-medium">Signing in...</span>
                    </div>
                  </div>
                </Button>
              </form>

              {/* Forgot Password */}
              <p className="mt-4 text-sm text-gray-600 text-center">
                Forgot your password?
                <a href="#" className="text-blue-600 hover:underline ml-1">
                  Reset it here
                </a>
              </p>

              <div className="mt-8 text-center pt-5 border-t border-gray-200">
               
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Add CSS animation in a style tag */}
      <style>{`
        @keyframes spin {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </div>
  );
};

export default Auth;
