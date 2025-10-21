import { Session } from '../../session/models';

export interface SessionRecord {
  session: Session;
  updatedAt: string;
}

export interface WriteOptions {
  expectedRevision?: number;
}

export interface SessionStorageTransaction {
  commit(): Promise<void>;
  rollback(): Promise<void>;
  write(session: Session, options?: WriteOptions): Promise<void>;
  read(sessionId: string): Promise<Session | null>;
  delete(sessionId: string): Promise<void>;
}

export interface SessionStorageAdapter {
  initialize(): Promise<void>;
  read(sessionId: string): Promise<Session | null>;
  write(session: Session, options?: WriteOptions): Promise<void>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<SessionRecord[]>;
  beginTransaction(): Promise<SessionStorageTransaction>;
}

export class RevisionConflictError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `Revision conflict for session ${sessionId}: expected ${expected}, got ${actual}`,
    );
  }
}

export class SessionStorageError extends Error {}
