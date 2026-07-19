import type { SessionStorageAdapter } from '../../session/storage';
import { AsyncStorageSessionStorageAdapter } from '../../session/storage/asyncStorageAdapter.native';
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
 * Browser builds persist through AsyncStorage's web implementation. The JSON
 * adapter depends on Node's fs/path APIs and cannot execute in React Native Web.
 */
export const createSessionStorageAdapter = (
  directory: string,
  persistentStorageAvailable = hasBrowserLocalStorage(),
): SessionStorageAdapter =>
  persistentStorageAvailable
    ? new AsyncStorageSessionStorageAdapter(directory)
    : new InMemorySessionStorageAdapter();
