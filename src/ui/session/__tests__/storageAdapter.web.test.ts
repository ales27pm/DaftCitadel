import { AsyncStorageSessionStorageAdapter } from '../../../session/storage/asyncStorageAdapter.native';
import { InMemorySessionStorageAdapter } from '../../../session/storage/memoryAdapter';
import { createSessionStorageAdapter } from '../storageAdapter.web';

describe('web session storage selection', () => {
  it('uses the browser-compatible AsyncStorage adapter', () => {
    expect(createSessionStorageAdapter('web-sessions', true)).toBeInstanceOf(
      AsyncStorageSessionStorageAdapter,
    );
  });

  it('falls back safely when browser persistence is unavailable', () => {
    expect(createSessionStorageAdapter('web-sessions', false)).toBeInstanceOf(
      InMemorySessionStorageAdapter,
    );
  });
});
