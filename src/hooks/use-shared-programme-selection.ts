import { useEffect, useMemo } from "react";
import { useProgrammeContext } from "@/contexts/ProgrammeContext";
import { resolveProgrammeSelection } from "@/lib/programme-access";

type UseSharedProgrammeSelectionOptions = {
  allowAll?: boolean;
  fallbackToAll?: boolean;
};

export const useSharedProgrammeSelection = (
  accessibleProgrammes: readonly string[],
  options?: UseSharedProgrammeSelectionOptions
) => {
  const { allowAll = false, fallbackToAll = false } = options ?? {};
  const { selection: sharedSelection, setSelection: setSharedSelection } =
    useProgrammeContext();

  const selection = useMemo(
    () =>
      resolveProgrammeSelection(sharedSelection, accessibleProgrammes, {
        allowAll,
        fallbackToAll,
      }),
    [accessibleProgrammes, allowAll, fallbackToAll, sharedSelection]
  );

  useEffect(() => {
    if (selection === sharedSelection) {
      return;
    }

    setSharedSelection(selection);
  }, [selection, setSharedSelection, sharedSelection]);

  const setSelection = (nextSelection: string) => {
    setSharedSelection(
      resolveProgrammeSelection(nextSelection, accessibleProgrammes, {
        allowAll,
        fallbackToAll,
      })
    );
  };

  return [selection, setSelection] as const;
};
