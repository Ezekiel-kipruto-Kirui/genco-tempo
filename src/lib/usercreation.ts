// SECONDARY APP — used ONLY for creating users without logging out the admin
import { initializeApp as initializeAppSecondary } from "firebase/app";
import { getAuth } from "firebase/auth";
import { firebaseConfig } from "./firebase";

const secondaryApp = initializeAppSecondary(firebaseConfig, "Secondary");
export const secondaryAuth = getAuth(secondaryApp);
