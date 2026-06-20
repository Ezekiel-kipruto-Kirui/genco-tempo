import { createContext, useContext, useEffect, useRef, useState, type FC, type ReactNode } from "react";
import { User, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { auth, db, invalidateCollectionCache, ref, get, set, update, serverTimestamp, onValue, query, orderByChild, equalTo } from "@/lib/firebase";
import { useToast } from "@/hooks/use-toast";
import {
  canViewAllProgrammes,
  getLandingRouteForRole,
  isActiveUserStatus,
  isMobileUser,
} from "@/contexts/authhelper";
import { resolveAccessibleProgrammes } from "@/lib/programme-access";

interface UserProfile {
  recordId: string | null;
  role: string | null;
  allowedProgrammes: Record<string, boolean> | null;
  name: string | null;
  userAttribute: string | null;
  status: string | null;
}

interface AuthContextType {
  user: User | null;
  userRole: string | null;
  userAttribute: string | null;
  userName: string | null;
  allowedProgrammes: Record<string, boolean> | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOutUser: () => Promise<void>;
}

declare global {
  var __gencoAuthContext__: ReturnType<typeof createContext<AuthContextType | undefined>> | undefined;
}

const AuthContext =
  globalThis.__gencoAuthContext__ ??
  createContext<AuthContextType | undefined>(undefined);

if (typeof globalThis !== "undefined") {
  globalThis.__gencoAuthContext__ = AuthContext;
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};

const ROLE_STORAGE_KEY = "user_role";

export const AuthProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [userAttribute, setUserAttribute] = useState<string | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [allowedProgrammes, setAllowedProgrammes] = useState<Record<string, boolean> | null>(null);
  const [loading, setLoading] = useState(true);
  const pendingLoginRef = useRef(false);
  const blockedSessionRef = useRef<string | null>(null);
  const profileListenerRef = useRef<(() => void) | null>(null);
  const { toast } = useToast();

  const clearAuthState = () => {
    setUser(null);
    setUserRole(null);
    setUserAttribute(null);
    setAllowedProgrammes(null);
    setUserName(null);
    localStorage.removeItem(ROLE_STORAGE_KEY);
  };

  const extractUserAttribute = (userData: any): string | null => {
    const directAttribute = userData?.accessControl?.customAttribute;
    if (typeof directAttribute === "string" && directAttribute.trim()) {
      return directAttribute.trim();
    }

    const legacyAttributes = userData?.accessControl?.customAttributes;
    if (legacyAttributes && typeof legacyAttributes === "object") {
      const firstKey = Object.keys(legacyAttributes)[0];
      if (firstKey && firstKey.trim()) {
        return firstKey.trim();
      }
    }

    const fallbackAttribute = userData?.customAttribute;
    if (typeof fallbackAttribute === "string" && fallbackAttribute.trim()) {
      return fallbackAttribute.trim();
    }

    return null;
  };

  const extractUserStatus = (userData: any): string | null =>
    typeof userData?.status === "string" && userData.status.trim()
      ? userData.status.trim()
      : null;

  const buildUserProfile = (
    recordId: string | null,
    userData: any,
  ): UserProfile => ({
    recordId,
    role: userData?.role || null,
    allowedProgrammes: userData?.allowedProgrammes || null,
    name: userData?.name || null,
    userAttribute: extractUserAttribute(userData),
    status: extractUserStatus(userData),
  });

  const syncProfileState = (firebaseUser: User, profile: UserProfile) => {
    blockedSessionRef.current = null;
    setUser(firebaseUser);
    setUserRole(profile.role);
    setUserAttribute(profile.userAttribute);
    setAllowedProgrammes(profile.allowedProgrammes);
    setUserName(profile.name || firebaseUser.displayName || firebaseUser.email || "Admin");

    if (profile.role) {
      localStorage.setItem(ROLE_STORAGE_KEY, profile.role);
    } else {
      localStorage.removeItem(ROLE_STORAGE_KEY);
    }
  };

  const getAccessibleProgrammesForProfile = (
    profile: UserProfile,
  ): string[] =>
    resolveAccessibleProgrammes(
      canViewAllProgrammes(
        profile.role,
        profile.userAttribute,
        profile.allowedProgrammes,
      ),
      profile.allowedProgrammes,
    );

  const resolveBlockedAccessMessage = (profile: UserProfile): string => {
    if (isMobileUser(profile.role, profile.userAttribute)) {
      return "Field Officers can submit data only and cannot access the web dashboard.";
    }

    if (!isActiveUserStatus(profile.status)) {
      return "Your account has been deactivated or disabled. Contact an admin for help.";
    }

    if (getAccessibleProgrammesForProfile(profile).length === 0) {
      return "Your account is not assigned to any programme. Contact an admin for help.";
    }

    return "Your account is not authorized to access the web dashboard.";
  };

  const canAccessWebDashboard = (profile: UserProfile): boolean => {
    if (!profile.recordId) return false;
    if (isMobileUser(profile.role, profile.userAttribute)) return false;
    if (!isActiveUserStatus(profile.status)) return false;
    if (getAccessibleProgrammesForProfile(profile).length === 0) return false;
    return getLandingRouteForRole(profile.role, profile.userAttribute) !== "/auth";
  };

  const blockUserSession = async (
    firebaseUser: User,
    profile: UserProfile,
    title = "Access restricted",
  ) => {
    profileListenerRef.current?.();
    profileListenerRef.current = null;
    pendingLoginRef.current = false;
    clearAuthState();

    if (blockedSessionRef.current !== firebaseUser.uid) {
      blockedSessionRef.current = firebaseUser.uid;
      toast({
        title,
        description: resolveBlockedAccessMessage(profile),
        variant: "destructive",
      });
    }

    await signOut(auth);
  };

  const touchLastLogin = async (recordId: string | null) => {
    if (!recordId) return;

    try {
      await set(ref(db, `users/${recordId}/lastLogin`), serverTimestamp());
      invalidateCollectionCache("users");
    } catch (error) {
      console.error("Error updating last login:", error);
    }
  };

  const fetchUserProfile = async (uid: string): Promise<UserProfile> => {
    try {
      const userRef = ref(db, `users/${uid}`);
      const snapshot = await get(userRef);

      if (snapshot.exists()) {
        return buildUserProfile(uid, snapshot.val());
      }

      console.warn("User not found at direct UID path, falling back to uid query...");
      const usersByUidQuery = query(ref(db, "users"), orderByChild("uid"), equalTo(uid));
      const matchingUsersSnapshot = await get(usersByUidQuery);

      if (matchingUsersSnapshot.exists()) {
        const data = matchingUsersSnapshot.val() as Record<string, any>;
        const matchEntry = Object.entries(data)[0];
        if (matchEntry) {
          const [recordId, match] = matchEntry;
          return buildUserProfile(recordId, match);
        }
      }

      return {
        recordId: null,
        role: null,
        allowedProgrammes: null,
        name: null,
        userAttribute: null,
        status: null,
      };
    } catch (error) {
      console.error("Error fetching user profile:", error);
      return {
        recordId: null,
        role: null,
        allowedProgrammes: null,
        name: null,
        userAttribute: null,
        status: null,
      };
    }
  };

  useEffect(() => {
    let isMounted = true;

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!isMounted) return;

      setLoading(true);

      if (!firebaseUser) {
        pendingLoginRef.current = false;
        blockedSessionRef.current = null;
        profileListenerRef.current?.();
        profileListenerRef.current = null;
        clearAuthState();
        if (isMounted) setLoading(false);
        return;
      }

      setUser(firebaseUser);

      try {
        const profile = await fetchUserProfile(firebaseUser.uid);
        if (!isMounted) return;

        if (!canAccessWebDashboard(profile)) {
          await blockUserSession(firebaseUser, profile);
          return;
        }

        profileListenerRef.current?.();
        profileListenerRef.current = onValue(
          ref(db, `users/${profile.recordId}`),
          (snapshot) => {
            if (!snapshot.exists()) {
              void blockUserSession(
                firebaseUser,
                {
                  recordId: profile.recordId,
                  role: profile.role,
                  allowedProgrammes: profile.allowedProgrammes,
                  name: profile.name,
                  userAttribute: profile.userAttribute,
                  status: "disabled",
                },
                "Account removed",
              );
              return;
            }

            const liveProfile = buildUserProfile(profile.recordId, snapshot.val());
            if (!canAccessWebDashboard(liveProfile)) {
              void blockUserSession(firebaseUser, liveProfile);
              return;
            }

            syncProfileState(firebaseUser, liveProfile);
          },
          (error) => {
            console.error("Error watching user profile:", error);
          },
        );

        if (pendingLoginRef.current) {
          await touchLastLogin(profile.recordId);
        }

        syncProfileState(firebaseUser, profile);

        if (pendingLoginRef.current) {
          pendingLoginRef.current = false;
          toast({
            title: "Welcome back!",
            description: "You have successfully signed in.",
          });
        }
      } catch (error) {
        console.error("Auth initialization error:", error);
        pendingLoginRef.current = false;
        clearAuthState();
      } finally {
        if (isMounted) setLoading(false);
      }
    });

    return () => {
      isMounted = false;
      profileListenerRef.current?.();
      profileListenerRef.current = null;
      unsubscribe();
    };
  }, [toast]);

  const signIn = async (email: string, password: string) => {
    try {
      pendingLoginRef.current = true;
      setLoading(true);
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error: any) {
      pendingLoginRef.current = false;
      setLoading(false);
      console.error("Sign in error:", error);

      let message = "Invalid credentials. Please try again.";

      if (
        error.code === "auth/invalid-credential" ||
        error.code === "auth/user-not-found" ||
        error.code === "auth/wrong-password"
      ) {
        message = "Incorrect email or password.";
      } else if (error.code === "auth/too-many-requests") {
        message = "Too many failed attempts. Please try again later.";
      } else if (error.message) {
        message = error.message;
      }

      toast({
        title: "Sign In Failed",
        description: message,
        variant: "destructive",
      });
      throw error;
    }
  };

  const signOutUser = async () => {
    try {
      await signOut(auth);
      toast({
        title: "Signed Out",
        description: "You have been successfully signed out.",
      });
    } catch (error: any) {
      console.error("Sign out error:", error);
      toast({
        title: "Error",
        description: "Failed to sign out. Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <AuthContext.Provider
      value={{ user, userRole, userAttribute, userName, allowedProgrammes, loading, signIn, signOutUser }}
    >
      {children}
    </AuthContext.Provider>
  );
};

