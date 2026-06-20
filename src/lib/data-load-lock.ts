const activeLoads = new Map<string, Promise<unknown>>();

export const runSingleActiveDataLoad = async <T>(
  load: () => Promise<T>,
  key?: string,
): Promise<T> => {
  if (!key) {
    return load();
  }

  const activeLoad = activeLoads.get(key) as Promise<T> | undefined;
  if (activeLoad) return activeLoad;

  const request = load().finally(() => {
    if (activeLoads.get(key) === request) {
      activeLoads.delete(key);
    }
  });

  activeLoads.set(key, request);

  return request;
};
