import { demoSession } from '../../fixtures/demoSession';
import { RevisionConflictError, SessionStorageError } from '../index';
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

  it('discards staged writes when a transaction is rolled back', async () => {
    const adapter = new LocalStorageSessionStorageAdapter('sessions');
    const original = { ...demoSession, revision: 0 };
    await adapter.write(original, { expectedRevision: 0 });

    const transaction = await adapter.beginTransaction();
    await transaction.write(
      { ...original, name: 'Discarded update', revision: 1 },
      { expectedRevision: 0 },
    );
    await transaction.rollback();

    expect(await adapter.read(original.id)).toEqual(original);
    await expect(transaction.commit()).rejects.toBeInstanceOf(SessionStorageError);
  });

  it('restores earlier writes when a later transaction write conflicts', async () => {
    const adapter = new LocalStorageSessionStorageAdapter('sessions');
    const first = { ...demoSession, id: 'first', name: 'First', revision: 0 };
    const second = { ...demoSession, id: 'second', name: 'Second', revision: 0 };
    await adapter.write(first, { expectedRevision: 0 });
    await adapter.write(second, { expectedRevision: 0 });

    const transaction = await adapter.beginTransaction();
    await transaction.write(
      { ...first, name: 'First transaction update', revision: 1 },
      { expectedRevision: 0 },
    );
    await transaction.write(
      { ...second, name: 'Second transaction update', revision: 1 },
      { expectedRevision: 0 },
    );

    const externallyUpdatedSecond = {
      ...second,
      name: 'External update',
      revision: 1,
    };
    await adapter.write(externallyUpdatedSecond, { expectedRevision: 0 });

    await expect(transaction.commit()).rejects.toBeInstanceOf(RevisionConflictError);
    expect(await adapter.read(first.id)).toEqual(first);
    expect(await adapter.read(second.id)).toEqual(externallyUpdatedSecond);
    await expect(transaction.commit()).rejects.toBeInstanceOf(SessionStorageError);
  });

  it('skips malformed records while listing valid sessions', async () => {
    const adapter = new LocalStorageSessionStorageAdapter('sessions');
    await adapter.write(demoSession, { expectedRevision: 0 });
    globalThis.localStorage.setItem(
      'daft-citadel:session:sessions:corrupt',
      '{not valid json',
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const records = await adapter.list();
      expect(records.map((record) => record.session.id)).toEqual([demoSession.id]);
      expect(warn).toHaveBeenCalledWith(
        'Skipping malformed browser session record',
        expect.objectContaining({
          key: 'daft-citadel:session:sessions:corrupt',
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
