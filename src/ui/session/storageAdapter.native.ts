import type { SessionStorageAdapter } from '../../session/storage';
import { InMemorySessionStorageAdapter } from '../../session/storage/memoryAdapter';

export const createSessionStorageAdapter = (
  _directory: string,
): SessionStorageAdapter => {
  return new InMemorySessionStorageAdapter();
};
