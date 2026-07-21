import type { SessionStorageAdapter } from '../../session/storage';
import { LocalStorageSessionStorageAdapter } from '../../session/storage/localStorageAdapter.web';
import { InMemorySessionStorageAdapter } from '../../session/storage/memoryAdapter';

const hasBrowserLocalStorage = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    return window.localStorage != null;
  } catch {
    return false;
  }
};

/**
 * Browser builds persist directly through localStorage. SSR and privacy modes
 * that deny storage fall back to memory instead of failing app startup.
 */
export const createSessionStorageAdapter = (
  directory: string,
  persistentStorageAvailable = hasBrowserLocalStorage(),
): SessionStorageAdapter =>
  persistentStorageAvailable
    ? new LocalStorageSessionStorageAdapter(directory)
    : new InMemorySessionStorageAdapter();
