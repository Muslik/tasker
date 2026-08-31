type BrowserStorage = Readonly<{
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}>;

const browserStorage = (): BrowserStorage | null => {
  const candidate = (globalThis as { readonly localStorage?: unknown }).localStorage;
  if (typeof candidate !== 'object' || candidate === null) return null;
  const storage = candidate as Partial<BrowserStorage>;
  return typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
    ? (storage as BrowserStorage)
    : null;
};

export const readStoredBoolean = (key: string, fallback = false): boolean => {
  const storage = browserStorage();
  if (storage === null) return fallback;
  try {
    return storage.getItem(key) === 'true';
  } catch {
    return fallback;
  }
};

export const writeStoredBoolean = (key: string, value: boolean): void => {
  const storage = browserStorage();
  if (storage === null) return;
  try {
    storage.setItem(key, String(value));
  } catch {
    return;
  }
};
