import AsyncStorage from '@react-native-async-storage/async-storage';
import { deserializeSession, serializeSession } from '../../session/serialization';
import { Session } from '../models';
import { AsyncMutex, deepClone } from '../util';
import {
  RevisionConflictError,
  SessionRecord,
  SessionStorageAdapter,
  SessionStorageError,
  SessionStorageTransaction,
  WriteOptions,
} from './index';

type StoredSessionRecord = {
  payload: string;
  revision: number;
  updatedAt: string;
};

type StoredTransactionJournal = {
  version: 1;
  originals: Array<[sessionId: string, raw: string | null]>;
};

const SESSION_KEY_PREFIX = 'session';
const namespaceMutexes = new Map<string, AsyncMutex>();

const mutexForPrefix = (prefix: string): AsyncMutex => {
  const existing = namespaceMutexes.get(prefix);
  if (existing) {
    return existing;
  }
  const mutex = new AsyncMutex();
  namespaceMutexes.set(prefix, mutex);
  return mutex;
};

const validateSessionId = (sessionId: string) => {
  if (!sessionId || /[\\/]/.test(sessionId)) {
    throw new SessionStorageError('Invalid session identifier');
  }
};

const buildPrefix = (directory: string): string => {
  if (!directory) {
    throw new SessionStorageError('Storage directory is required');
  }
  return `${SESSION_KEY_PREFIX}:${encodeURIComponent(directory)}:`;
};

const parseRecord = (raw: string | null): StoredSessionRecord | null => {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSessionRecord>;
    if (
      typeof parsed.payload !== 'string' ||
      typeof parsed.revision !== 'number' ||
      typeof parsed.updatedAt !== 'string'
    ) {
      throw new Error('Invalid record shape');
    }
    return {
      payload: parsed.payload,
      revision: parsed.revision,
      updatedAt: parsed.updatedAt,
    };
  } catch (error) {
    throw new SessionStorageError(
      `Failed to parse stored session: ${(error as Error).message}`,
    );
  }
};

export class AsyncStorageSessionStorageAdapter implements SessionStorageAdapter {
  private readonly prefix: string;
  private readonly journalKey: string;
  private readonly mutex: AsyncMutex;
  private initialized = false;

  constructor(directory: string) {
    this.prefix = buildPrefix(directory);
    this.journalKey = `${SESSION_KEY_PREFIX}-transaction:${encodeURIComponent(directory)}`;
    this.mutex = mutexForPrefix(this.prefix);
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    try {
      await AsyncStorage.getAllKeys();
      this.initialized = true;
    } catch (error) {
      throw new SessionStorageError(
        `Failed to initialize storage: ${(error as Error).message}`,
      );
    }
  }

  private keyFor(sessionId: string): string {
    validateSessionId(sessionId);
    return `${this.prefix}${sessionId}`;
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.mutex.acquire();
    try {
      await this.recoverPendingTransaction();
      return await operation();
    } finally {
      release();
    }
  }

  private async getRawRecord(sessionId: string): Promise<string | null> {
    try {
      return await AsyncStorage.getItem(this.keyFor(sessionId));
    } catch (error) {
      throw new SessionStorageError(
        `Failed to read session: ${(error as Error).message}`,
      );
    }
  }

  private async getRecord(sessionId: string): Promise<StoredSessionRecord | null> {
    return parseRecord(await this.getRawRecord(sessionId));
  }

  private async setRawRecord(sessionId: string, raw: string): Promise<void> {
    try {
      await AsyncStorage.setItem(this.keyFor(sessionId), raw);
    } catch (error) {
      throw new SessionStorageError(
        `Failed to write session: ${(error as Error).message}`,
      );
    }
  }

  private async setRecord(sessionId: string, record: StoredSessionRecord): Promise<void> {
    await this.setRawRecord(sessionId, JSON.stringify(record));
  }

  private async removeRecord(sessionId: string): Promise<void> {
    try {
      await AsyncStorage.removeItem(this.keyFor(sessionId));
    } catch (error) {
      throw new SessionStorageError(
        `Failed to delete session: ${(error as Error).message}`,
      );
    }
  }

  private async writeJournal(
    originals: ReadonlyMap<string, string | null>,
  ): Promise<void> {
    const journal: StoredTransactionJournal = {
      version: 1,
      originals: Array.from(originals),
    };
    try {
      await AsyncStorage.setItem(this.journalKey, JSON.stringify(journal));
    } catch (error) {
      throw new SessionStorageError(
        `Failed to prepare the AsyncStorage transaction journal: ${(error as Error).message}`,
      );
    }
  }

  private async recoverPendingTransaction(): Promise<void> {
    let rawJournal: string | null;
    try {
      rawJournal = await AsyncStorage.getItem(this.journalKey);
    } catch (error) {
      throw new SessionStorageError(
        `Failed to read the AsyncStorage transaction journal: ${(error as Error).message}`,
      );
    }
    if (!rawJournal) {
      return;
    }

    let journal: StoredTransactionJournal;
    try {
      const parsed = JSON.parse(rawJournal) as Partial<StoredTransactionJournal>;
      if (parsed.version !== 1 || !Array.isArray(parsed.originals)) {
        throw new Error('Invalid journal shape');
      }
      journal = parsed as StoredTransactionJournal;
    } catch (error) {
      throw new SessionStorageError(
        `Failed to parse the AsyncStorage transaction journal: ${(error as Error).message}`,
      );
    }

    const restoreErrors: Error[] = [];
    for (const entry of journal.originals) {
      try {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== 'string' ||
          (entry[1] !== null && typeof entry[1] !== 'string')
        ) {
          throw new Error('Invalid journal entry');
        }
        const [sessionId, raw] = entry;
        if (raw === null) {
          await this.removeRecord(sessionId);
        } else {
          await this.setRawRecord(sessionId, raw);
        }
      } catch (error) {
        restoreErrors.push(error as Error);
      }
    }
    if (restoreErrors.length > 0) {
      throw new SessionStorageError(
        `Failed to recover the AsyncStorage transaction journal: ${restoreErrors.map(({ message }) => message).join('; ')}`,
      );
    }
    try {
      await AsyncStorage.removeItem(this.journalKey);
    } catch (error) {
      throw new SessionStorageError(
        `Failed to clear the AsyncStorage transaction journal: ${(error as Error).message}`,
      );
    }
  }

  async read(sessionId: string): Promise<Session | null> {
    await this.initialize();
    return this.runExclusive(async () => {
      const record = await this.getRecord(sessionId);
      if (!record) {
        return null;
      }
      try {
        return deserializeSession(record.payload);
      } catch (error) {
        throw new SessionStorageError(
          `Failed to deserialize session: ${(error as Error).message}`,
        );
      }
    });
  }

  async write(session: Session, options?: WriteOptions): Promise<void> {
    await this.initialize();
    await this.runExclusive(async () => {
      const existing = await this.getRecord(session.id);
      if (options?.expectedRevision !== undefined) {
        const currentRevision = existing?.revision ?? 0;
        if (currentRevision !== options.expectedRevision) {
          throw new RevisionConflictError(
            session.id,
            options.expectedRevision,
            currentRevision,
          );
        }
      }

      const record: StoredSessionRecord = {
        payload: serializeSession(session),
        revision: session.revision,
        updatedAt: new Date().toISOString(),
      };
      await this.setRecord(session.id, record);
    });
  }

  async delete(sessionId: string): Promise<void> {
    await this.initialize();
    await this.runExclusive(() => this.removeRecord(sessionId));
  }

  async list(): Promise<SessionRecord[]> {
    await this.initialize();
    return this.runExclusive(async () => {
      try {
        const keys = await AsyncStorage.getAllKeys();
        const sessionKeys = keys.filter((key: string) => key.startsWith(this.prefix));
        if (sessionKeys.length === 0) {
          return [];
        }
        const entries = await AsyncStorage.multiGet(sessionKeys);
        const records: SessionRecord[] = [];
        for (const [, value] of entries) {
          const record = parseRecord(value);
          if (record) {
            records.push({
              updatedAt: record.updatedAt,
              session: deserializeSession(record.payload),
            });
          }
        }
        return records;
      } catch (error) {
        throw new SessionStorageError(
          `Failed to list sessions: ${(error as Error).message}`,
        );
      }
    });
  }

  async beginTransaction(): Promise<SessionStorageTransaction> {
    await this.initialize();
    return new AsyncStorageSessionStorageTransaction(this);
  }

  async readDirect(sessionId: string): Promise<Session | null> {
    return this.read(sessionId);
  }

  async commitTransaction(
    writes: ReadonlyMap<string, StagedWrite>,
    deletions: ReadonlySet<string>,
  ): Promise<void> {
    await this.initialize();
    await this.runExclusive(async () => {
      const targetIds = new Set([...writes.keys(), ...deletions]);
      const originals = new Map<string, string | null>();
      const prepared = new Map<string, string>();

      for (const [sessionId, staged] of writes) {
        const existing = await this.getRecord(sessionId);
        if (
          staged.expectedRevision !== undefined &&
          (existing?.revision ?? 0) !== staged.expectedRevision
        ) {
          throw new RevisionConflictError(
            sessionId,
            staged.expectedRevision,
            existing?.revision ?? 0,
          );
        }
        prepared.set(
          sessionId,
          JSON.stringify({
            payload: serializeSession(staged.session),
            revision: staged.session.revision,
            updatedAt: new Date().toISOString(),
          } satisfies StoredSessionRecord),
        );
      }

      for (const sessionId of targetIds) {
        originals.set(sessionId, await this.getRawRecord(sessionId));
      }

      await this.writeJournal(originals);

      try {
        for (const [sessionId, raw] of prepared) {
          await this.setRawRecord(sessionId, raw);
        }
        for (const sessionId of deletions) {
          await this.removeRecord(sessionId);
        }
        await AsyncStorage.removeItem(this.journalKey);
      } catch (error) {
        try {
          await this.recoverPendingTransaction();
        } catch (rollbackError) {
          throw new SessionStorageError(
            `Transaction failed (${(error as Error).message}) and rollback could not restore AsyncStorage: ${(rollbackError as Error).message}`,
          );
        }
        if (
          error instanceof RevisionConflictError ||
          error instanceof SessionStorageError
        ) {
          throw error;
        }
        throw new SessionStorageError((error as Error).message);
      }
    });
  }
}

interface StagedWrite {
  session: Session;
  expectedRevision?: number;
  originalRevision: number;
}

class AsyncStorageSessionStorageTransaction implements SessionStorageTransaction {
  private closed = false;
  private readonly writes = new Map<string, StagedWrite>();
  private readonly deletions = new Set<string>();

  constructor(private readonly adapter: AsyncStorageSessionStorageAdapter) {}

  private assertOpen() {
    if (this.closed) {
      throw new SessionStorageError('Transaction already closed');
    }
  }

  async write(session: Session, options?: WriteOptions): Promise<void> {
    this.assertOpen();
    const previous = this.writes.get(session.id);
    const baseline = previous?.session ?? (await this.adapter.readDirect(session.id));
    const originalRevision = previous?.originalRevision ?? baseline?.revision ?? 0;
    if (options?.expectedRevision !== undefined) {
      const currentRevision = baseline?.revision ?? 0;
      if (currentRevision !== options.expectedRevision) {
        throw new RevisionConflictError(
          session.id,
          options.expectedRevision,
          currentRevision,
        );
      }
    }
    const expectedRevision =
      previous?.expectedRevision ??
      (options?.expectedRevision !== undefined ? originalRevision : undefined);
    this.writes.set(session.id, {
      session: deepClone(session),
      expectedRevision,
      originalRevision,
    });
    this.deletions.delete(session.id);
  }

  async read(sessionId: string): Promise<Session | null> {
    this.assertOpen();
    if (this.deletions.has(sessionId)) {
      return null;
    }
    if (this.writes.has(sessionId)) {
      const session = this.writes.get(sessionId)?.session;
      return session ? deepClone(session) : null;
    }
    return this.adapter.readDirect(sessionId);
  }

  async delete(sessionId: string): Promise<void> {
    this.assertOpen();
    this.writes.delete(sessionId);
    this.deletions.add(sessionId);
  }

  async commit(): Promise<void> {
    this.assertOpen();
    await this.adapter.commitTransaction(this.writes, this.deletions);
    this.closed = true;
  }

  async rollback(): Promise<void> {
    this.assertOpen();
    this.writes.clear();
    this.deletions.clear();
    this.closed = true;
  }
}
