import { auth } from "@/lib/firebase";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes for heavy analysis requests

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

export const serverApiFetch = async <T>(
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) {
    throw new Error("You must be signed in.");
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      signal: init.signal ?? controller.signal,
      headers: {
        "Authorization": `Bearer ${idToken}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error("Server request timed out. Please try again.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }

  const result = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(result?.error || "Server request failed.");
  }

  return result as T;
};
