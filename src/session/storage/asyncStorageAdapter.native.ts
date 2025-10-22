import AsyncStorage from '@react-native-async-storage/async-storage';
import { deserializeSession, serializeSession } from '../../session/serialization';
import { Session } from '../models';
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

const SESSION_KEY_PREFIX = 'session';

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
  private initialized = false;

  constructor(directory: string) {
    this.prefix = buildPrefix(directory);
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

  private async getRecord(sessionId: string): Promise<StoredSessionRecord | null> {
    await this.initialize();
    try {
      const raw = await AsyncStorage.getItem(this.keyFor(sessionId));
      return parseRecord(raw);
    } catch (error) {
      throw new SessionStorageError(
        `Failed to read session: ${(error as Error).message}`,
      );
    }
  }

  private async setRecord(sessionId: string, record: StoredSessionRecord): Promise<void> {
    try {
      await AsyncStorage.setItem(this.keyFor(sessionId), JSON.stringify(record));
    } catch (error) {
      throw new SessionStorageError(
        `Failed to write session: ${(error as Error).message}`,
      );
    }
  }

  async read(sessionId: string): Promise<Session | null> {
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
  }

  async write(session: Session, options?: WriteOptions): Promise<void> {
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
  }

  async delete(sessionId: string): Promise<void> {
    await this.initialize();
    try {
      await AsyncStorage.removeItem(this.keyFor(sessionId));
    } catch (error) {
      throw new SessionStorageError(
        `Failed to delete session: ${(error as Error).message}`,
      );
    }
  }

  async list(): Promise<SessionRecord[]> {
    await this.initialize();
    try {
      const keys = await AsyncStorage.getAllKeys();
      const sessionKeys = keys.filter((key) => key.startsWith(this.prefix));
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
  }

  async beginTransaction(): Promise<SessionStorageTransaction> {
    await this.initialize();
    return new AsyncStorageSessionStorageTransaction(this);
  }

  async readDirect(sessionId: string): Promise<Session | null> {
    return this.read(sessionId);
  }

  async writeDirect(session: Session): Promise<void> {
    await this.write(session, { expectedRevision: undefined });
  }

  async deleteDirect(sessionId: string): Promise<void> {
    await this.delete(sessionId);
  }
}

interface StagedWrite {
  session: Session;
  expectedRevision?: number;
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
      options?.expectedRevision !== undefined
        ? options.expectedRevision
        : previous?.expectedRevision;
    this.writes.set(session.id, { session, expectedRevision });
    this.deletions.delete(session.id);
  }

  async read(sessionId: string): Promise<Session | null> {
    this.assertOpen();
    if (this.deletions.has(sessionId)) {
      return null;
    }
    if (this.writes.has(sessionId)) {
      return this.writes.get(sessionId)?.session ?? null;
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
    for (const [, staged] of this.writes.entries()) {
      await this.adapter.write(staged.session, {
        expectedRevision: staged.expectedRevision,
      });
    }
    for (const sessionId of this.deletions) {
      await this.adapter.delete(sessionId);
    }
    this.closed = true;
  }

  async rollback(): Promise<void> {
    this.assertOpen();
    this.writes.clear();
    this.deletions.clear();
    this.closed = true;
  }
}
