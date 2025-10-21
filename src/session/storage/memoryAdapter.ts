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
}

export class InMemorySessionStorageAdapter implements SessionStorageAdapter {
  private readonly store = new Map<string, MemoryEntry>();

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

  internalWrite(session: Session, expectedRevision?: number) {
    this.writeEntry(session, expectedRevision);
  }

  internalDelete(sessionId: string) {
    this.deleteEntry(sessionId);
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
    const baseline = staged ?? {
      session: this.adapter.internalRead(session.id)?.session ?? null,
      expectedRevision: undefined,
    };
    const baselineRevision = baseline.session?.revision ?? 0;
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
      options?.expectedRevision !== undefined
        ? options.expectedRevision
        : staged?.expectedRevision;
    this.writes.set(session.id, {
      session: deepClone(session),
      expectedRevision,
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
    this.writes.forEach(({ session, expectedRevision }) => {
      this.adapter.internalWrite(session, expectedRevision);
    });
    this.deletions.forEach((sessionId) => {
      this.adapter.internalDelete(sessionId);
    });
    this.closed = true;
  }

  async rollback(): Promise<void> {
    this.assertOpen();
    this.writes.clear();
    this.deletions.clear();
    this.closed = true;
  }
}
