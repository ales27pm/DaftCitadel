import { deserializeSession, serializeSession } from '../../session/serialization';
import { Session } from '../models';
import {
  RevisionConflictError,
  SessionRecord,
  SessionStorageAdapter,
  SessionStorageTransaction,
  SessionStorageError,
  WriteOptions,
} from './index';

export interface SQLiteConnection {
  run(sql: string, params?: unknown[]): Promise<void>;
  get<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T | null>;
  all<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

const ensureInitialized = async (connection: SQLiteConnection) => {
  await connection.run(
    'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL)',
  );
};

export class SQLiteSessionStorageAdapter implements SessionStorageAdapter {
  private initialized = false;

  constructor(private readonly connection: SQLiteConnection) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await ensureInitialized(this.connection);
    this.initialized = true;
  }

  private async ensureReady() {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  async read(sessionId: string): Promise<Session | null> {
    await this.ensureReady();
    const row = await this.connection.get<{
      payload: string;
    }>('SELECT payload FROM sessions WHERE id = ?', [sessionId]);
    if (!row) {
      return null;
    }
    return deserializeSession(row.payload);
  }

  async write(session: Session, options?: WriteOptions): Promise<void> {
    await this.ensureReady();
    await this.connection.beginTransaction();
    try {
      const existing = await this.connection.get<{
        revision: number;
      }>('SELECT revision FROM sessions WHERE id = ?', [session.id]);
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

      const payload = serializeSession(session);
      const updatedAt = new Date().toISOString();

      if (existing) {
        await this.connection.run(
          'UPDATE sessions SET payload = ?, revision = ?, updated_at = ? WHERE id = ?',
          [payload, session.revision, updatedAt, session.id],
        );
      } else {
        await this.connection.run(
          'INSERT INTO sessions (id, payload, revision, updated_at) VALUES (?, ?, ?, ?)',
          [session.id, payload, session.revision, updatedAt],
        );
      }
      await this.connection.commit();
    } catch (error) {
      await this.connection.rollback().catch(() => undefined);
      if (error instanceof RevisionConflictError) {
        throw error;
      }
      throw new SessionStorageError((error as Error).message);
    }
  }

  async delete(sessionId: string): Promise<void> {
    await this.ensureReady();
    await this.connection.run('DELETE FROM sessions WHERE id = ?', [sessionId]);
  }

  async list(): Promise<SessionRecord[]> {
    await this.ensureReady();
    const rows = await this.connection.all<{
      payload: string;
      updated_at: string;
    }>('SELECT payload, updated_at FROM sessions');
    return rows.map((row) => ({
      updatedAt: row.updated_at,
      session: deserializeSession(row.payload),
    }));
  }

  async beginTransaction(): Promise<SessionStorageTransaction> {
    await this.ensureReady();
    await this.connection.beginTransaction();
    return new SQLiteSessionStorageTransaction(this.connection);
  }
}

class SQLiteSessionStorageTransaction implements SessionStorageTransaction {
  private finished = false;

  constructor(private readonly connection: SQLiteConnection) {}

  private assertActive() {
    if (this.finished) {
      throw new SessionStorageError('Transaction already finished');
    }
  }

  async write(session: Session, options?: WriteOptions): Promise<void> {
    this.assertActive();
    const existing = await this.connection.get<{
      revision: number;
    }>('SELECT revision FROM sessions WHERE id = ?', [session.id]);
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
    const payload = serializeSession(session);
    const updatedAt = new Date().toISOString();
    if (existing) {
      await this.connection.run(
        'UPDATE sessions SET payload = ?, revision = ?, updated_at = ? WHERE id = ?',
        [payload, session.revision, updatedAt, session.id],
      );
    } else {
      await this.connection.run(
        'INSERT INTO sessions (id, payload, revision, updated_at) VALUES (?, ?, ?, ?)',
        [session.id, payload, session.revision, updatedAt],
      );
    }
  }

  async read(sessionId: string): Promise<Session | null> {
    this.assertActive();
    const row = await this.connection.get<{
      payload: string;
    }>('SELECT payload FROM sessions WHERE id = ?', [sessionId]);
    return row ? deserializeSession(row.payload) : null;
  }

  async delete(sessionId: string): Promise<void> {
    this.assertActive();
    await this.connection.run('DELETE FROM sessions WHERE id = ?', [sessionId]);
  }

  async commit(): Promise<void> {
    this.assertActive();
    await this.connection.commit();
    this.finished = true;
  }

  async rollback(): Promise<void> {
    this.assertActive();
    await this.connection.rollback();
    this.finished = true;
  }
}
