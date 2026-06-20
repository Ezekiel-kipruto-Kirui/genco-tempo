import {
  createContext,
  useContext,
  useEffect,
  useState,
  type FC,
  type ReactNode,
} from "react";
import {
  normalizeProgrammeSelection,
  type ProgrammeSelection,
} from "@/lib/programme-access";

const DEFAULT_STORAGE_KEY = "dashboard-shared-programme-selection";

interface ProgrammeContextValue {
  selection: ProgrammeSelection;
  setSelection: (nextSelection: string) => void;
}

const ProgrammeContext = createContext<ProgrammeContextValue | undefined>(
  undefined,
);

const normalizeStoredSelection = (value: unknown): ProgrammeSelection =>
  normalizeProgrammeSelection(value);

export const ProgrammeProvider: FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [selection, setSelectionState] = useState<ProgrammeSelection>(() => {
    if (typeof window === "undefined") return "";
    return normalizeStoredSelection(
      window.localStorage.getItem(DEFAULT_STORAGE_KEY),
    );
  });

  useEffect(() => {
    if (typeof window === "undefined") return;

    if (selection) {
      window.localStorage.setItem(DEFAULT_STORAGE_KEY, selection);
      return;
    }

    window.localStorage.removeItem(DEFAULT_STORAGE_KEY);
  }, [selection]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== DEFAULT_STORAGE_KEY) return;
      setSelectionState(normalizeStoredSelection(event.newValue));
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  return (
    <ProgrammeContext.Provider
      value={{
        selection,
        setSelection: (nextSelection) => {
          setSelectionState(normalizeStoredSelection(nextSelection));
        },
      }}
    >
      {children}
    </ProgrammeContext.Provider>
  );
};

export const useProgrammeContext = (): ProgrammeContextValue => {
  const context = useContext(ProgrammeContext);
  if (!context) {
    throw new Error(
      "useProgrammeContext must be used within a ProgrammeProvider",
    );
  }
  return context;
};
