import { deepClone } from '../util';
import { Session } from '../models';
import {
  RevisionConflictError,
  SessionRecord,
  SessionStorageAdapter,
  SessionStorageError,
  SessionStorageTransaction,
  WriteOptions,
} from './index';

interface MemoryEntry {
  session: Session;
  updatedAt: string;
}

interface StagedWrite {
  session: Session;
  expectedRevision?: number;
  originalRevision: number;
}

export class InMemorySessionStorageAdapter implements SessionStorageAdapter {
  private store = new Map<string, MemoryEntry>();

  async initialize(): Promise<void> {
    // No-op for in-memory storage.
  }

  private getEntry(sessionId: string): MemoryEntry | undefined {
    return this.store.get(sessionId);
  }

  private writeEntry(session: Session, expectedRevision?: number) {
    const existing = this.getEntry(session.id);
    const currentRevision = existing?.session.revision ?? 0;
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      throw new RevisionConflictError(session.id, expectedRevision, currentRevision);
    }
    this.store.set(session.id, {
      session: deepClone(session),
      updatedAt: new Date().toISOString(),
    });
  }

  private deleteEntry(sessionId: string) {
    this.store.delete(sessionId);
  }

  async read(sessionId: string): Promise<Session | null> {
    const entry = this.getEntry(sessionId);
    return entry ? deepClone(entry.session) : null;
  }

  async write(session: Session, options?: WriteOptions): Promise<void> {
    this.writeEntry(session, options?.expectedRevision);
  }

  async delete(sessionId: string): Promise<void> {
    this.deleteEntry(sessionId);
  }

  async list(): Promise<SessionRecord[]> {
    return Array.from(this.store.values()).map(({ session, updatedAt }) => ({
      session: deepClone(session),
      updatedAt,
    }));
  }

  async beginTransaction(): Promise<SessionStorageTransaction> {
    return new InMemorySessionStorageTransaction(this);
  }

  // Internal helpers used by transactions.
  internalRead(sessionId: string): MemoryEntry | undefined {
    const entry = this.getEntry(sessionId);
    if (!entry) {
      return undefined;
    }
    return { session: deepClone(entry.session), updatedAt: entry.updatedAt };
  }

  internalCommit(
    writes: ReadonlyMap<string, StagedWrite>,
    deletions: ReadonlySet<string>,
  ): void {
    for (const [sessionId, { expectedRevision }] of writes) {
      if (expectedRevision === undefined) {
        continue;
      }
      const currentRevision = this.store.get(sessionId)?.session.revision ?? 0;
      if (currentRevision !== expectedRevision) {
        throw new RevisionConflictError(sessionId, expectedRevision, currentRevision);
      }
    }

    const nextStore = new Map<string, MemoryEntry>();
    this.store.forEach((entry, sessionId) => {
      nextStore.set(sessionId, {
        session: deepClone(entry.session),
        updatedAt: entry.updatedAt,
      });
    });
    const committedAt = new Date().toISOString();
    writes.forEach(({ session }) => {
      nextStore.set(session.id, {
        session: deepClone(session),
        updatedAt: committedAt,
      });
    });
    deletions.forEach((sessionId) => {
      nextStore.delete(sessionId);
    });
    this.store = nextStore;
  }
}

class InMemorySessionStorageTransaction implements SessionStorageTransaction {
  private closed = false;
  private readonly writes = new Map<string, StagedWrite>();
  private readonly deletions = new Set<string>();

  constructor(private readonly adapter: InMemorySessionStorageAdapter) {}

  private assertOpen() {
    if (this.closed) {
      throw new SessionStorageError('Transaction already closed');
    }
  }

  async write(session: Session, options?: WriteOptions): Promise<void> {
    this.assertOpen();
    const staged = this.writes.get(session.id);
    const storedRevision = this.adapter.internalRead(session.id)?.session.revision ?? 0;
    const originalRevision = staged?.originalRevision ?? storedRevision;
    const baselineRevision = staged?.session.revision ?? storedRevision;
    if (
      options?.expectedRevision !== undefined &&
      options.expectedRevision !== baselineRevision
    ) {
      throw new RevisionConflictError(
        session.id,
        options.expectedRevision,
        baselineRevision,
      );
    }
    const expectedRevision =
      staged?.expectedRevision ??
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
    const staged = this.writes.get(sessionId);
    if (staged) {
      return deepClone(staged.session);
    }
    const entry = this.adapter.internalRead(sessionId);
    return entry ? deepClone(entry.session) : null;
  }

  async delete(sessionId: string): Promise<void> {
    this.assertOpen();
    this.writes.delete(sessionId);
    this.deletions.add(sessionId);
  }

  async commit(): Promise<void> {
    this.assertOpen();
    this.adapter.internalCommit(this.writes, this.deletions);
    this.closed = true;
  }

  async rollback(): Promise<void> {
    this.assertOpen();
    this.writes.clear();
    this.deletions.clear();
    this.closed = true;
  }
}
