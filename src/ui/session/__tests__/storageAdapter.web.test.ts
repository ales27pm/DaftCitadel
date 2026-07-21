import { LocalStorageSessionStorageAdapter } from '../../../session/storage/localStorageAdapter.web';
import { InMemorySessionStorageAdapter } from '../../../session/storage/memoryAdapter';
import { createSessionStorageAdapter } from '../storageAdapter.web';

describe('web session storage selection', () => {
  it('uses the browser-compatible localStorage adapter', () => {
    expect(createSessionStorageAdapter('web-sessions', true)).toBeInstanceOf(
      LocalStorageSessionStorageAdapter,
    );
  });

  it('falls back safely when browser persistence is unavailable', () => {
    expect(createSessionStorageAdapter('web-sessions', false)).toBeInstanceOf(
      InMemorySessionStorageAdapter,
    );
  });
});
