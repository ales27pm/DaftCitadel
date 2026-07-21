import { demoSession } from '../../fixtures/demoSession';
import { RevisionConflictError } from '../index';
import { LocalStorageSessionStorageAdapter } from '../localStorageAdapter.web';

class MemoryWebStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('LocalStorageSessionStorageAdapter', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new MemoryWebStorage(),
    });
  });

  it('persists, lists, and deletes sessions', async () => {
    const adapter = new LocalStorageSessionStorageAdapter('sessions');
    await adapter.initialize();

    expect(await adapter.read(demoSession.id)).toBeNull();
    await adapter.write(demoSession, { expectedRevision: 0 });
    expect(await adapter.read(demoSession.id)).toEqual(demoSession);

    const records = await adapter.list();
    expect(records).toHaveLength(1);
    expect(records[0].session.id).toBe(demoSession.id);

    await adapter.delete(demoSession.id);
    expect(await adapter.read(demoSession.id)).toBeNull();
  });

  it('enforces revisions when committing a transaction', async () => {
    const adapter = new LocalStorageSessionStorageAdapter('sessions');
    await adapter.write(demoSession, { expectedRevision: 0 });
    const nextSession = { ...demoSession, name: 'Updated', revision: 1 };

    const transaction = await adapter.beginTransaction();
    await transaction.write(nextSession, { expectedRevision: 0 });
    await transaction.commit();
    expect((await adapter.read(demoSession.id))?.name).toBe('Updated');

    await expect(
      adapter.write({ ...nextSession, revision: 2 }, { expectedRevision: 0 }),
    ).rejects.toBeInstanceOf(RevisionConflictError);
  });
});
