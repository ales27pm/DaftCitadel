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

const SESSION_KEY_PREFIX = 'daft-citadel:session';

const validateSessionId = (sessionId: string): void => {
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

export class LocalStorageSessionStorageAdapter implements SessionStorageAdapter {
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
      globalThis.localStorage.getItem(`${this.prefix}__probe__`);
      this.initialized = true;
    } catch (error) {
      throw new SessionStorageError(
        `Failed to initialize browser storage: ${(error as Error).message}`,
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
      return parseRecord(globalThis.localStorage.getItem(this.keyFor(sessionId)));
    } catch (error) {
      if (error instanceof SessionStorageError) {
        throw error;
      }
      throw new SessionStorageError(
        `Failed to read session: ${(error as Error).message}`,
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
    try {
      globalThis.localStorage.setItem(this.keyFor(session.id), JSON.stringify(record));
    } catch (error) {
      throw new SessionStorageError(
        `Failed to write session: ${(error as Error).message}`,
      );
    }
  }

  async delete(sessionId: string): Promise<void> {
    await this.initialize();
    try {
      globalThis.localStorage.removeItem(this.keyFor(sessionId));
    } catch (error) {
      throw new SessionStorageError(
        `Failed to delete session: ${(error as Error).message}`,
      );
    }
  }

  async list(): Promise<SessionRecord[]> {
    await this.initialize();
    try {
      const records: SessionRecord[] = [];
      for (let index = 0; index < globalThis.localStorage.length; index += 1) {
        const key = globalThis.localStorage.key(index);
        if (!key?.startsWith(this.prefix)) {
          continue;
        }
        const record = parseRecord(globalThis.localStorage.getItem(key));
        if (record) {
          records.push({
            updatedAt: record.updatedAt,
            session: deserializeSession(record.payload),
          });
        }
      }
      return records;
    } catch (error) {
      if (error instanceof SessionStorageError) {
        throw error;
      }
      throw new SessionStorageError(
        `Failed to list sessions: ${(error as Error).message}`,
      );
    }
  }

  async beginTransaction(): Promise<SessionStorageTransaction> {
    await this.initialize();
    return new LocalStorageSessionStorageTransaction(this);
  }

  async readDirect(sessionId: string): Promise<Session | null> {
    return this.read(sessionId);
  }

  async writeDirect(session: Session): Promise<void> {
    await this.write(session);
  }
}

type StagedWrite = {
  session: Session;
  expectedRevision?: number;
};

class LocalStorageSessionStorageTransaction implements SessionStorageTransaction {
  private closed = false;
  private readonly writes = new Map<string, StagedWrite>();
  private readonly deletions = new Set<string>();

  constructor(private readonly adapter: LocalStorageSessionStorageAdapter) {}

  private assertOpen(): void {
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
    this.writes.set(session.id, {
      session,
      expectedRevision: options?.expectedRevision ?? previous?.expectedRevision,
    });
    this.deletions.delete(session.id);
  }

  async read(sessionId: string): Promise<Session | null> {
    this.assertOpen();
    if (this.deletions.has(sessionId)) {
      return null;
    }
    return this.writes.get(sessionId)?.session ?? this.adapter.readDirect(sessionId);
  }

  async delete(sessionId: string): Promise<void> {
    this.assertOpen();
    this.writes.delete(sessionId);
    this.deletions.add(sessionId);
  }

  async commit(): Promise<void> {
    this.assertOpen();
    for (const [, staged] of this.writes) {
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
