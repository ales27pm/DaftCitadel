import { promises as fs } from 'fs';
import path from 'path';
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

interface JsonSessionFile {
  payload: string;
  revision: number;
  updatedAt: string;
}

export class JsonSessionStorageAdapter implements SessionStorageAdapter {
  constructor(private readonly directory: string) {}

  async initialize(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
  }

  private filePath(sessionId: string): string {
    if (!sessionId || path.basename(sessionId) !== sessionId) {
      throw new SessionStorageError('Invalid session identifier');
    }

    const basePath = path.resolve(this.directory);
    const resolvedPath = path.resolve(this.directory, `${sessionId}.json`);
    const relative = path.relative(basePath, resolvedPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new SessionStorageError('Invalid session identifier');
    }

    return resolvedPath;
  }

  private async readFile(sessionId: string): Promise<JsonSessionFile | null> {
    try {
      const raw = await fs.readFile(this.filePath(sessionId), 'utf-8');
      return JSON.parse(raw) as JsonSessionFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw new SessionStorageError((error as Error).message);
    }
  }

  private async writeFile(sessionId: string, data: JsonSessionFile): Promise<void> {
    const tempPath = `${this.filePath(sessionId)}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(data));
    await fs.rename(tempPath, this.filePath(sessionId));
  }

  async read(sessionId: string): Promise<Session | null> {
    await this.initialize();
    const file = await this.readFile(sessionId);
    return file ? deserializeSession(file.payload) : null;
  }

  async write(session: Session, options?: WriteOptions): Promise<void> {
    await this.initialize();
    const existing = await this.readFile(session.id);
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
    const data: JsonSessionFile = {
      payload: serializeSession(session),
      revision: session.revision,
      updatedAt: new Date().toISOString(),
    };
    await this.writeFile(session.id, data);
  }

  async delete(sessionId: string): Promise<void> {
    await this.initialize();
    try {
      await fs.unlink(this.filePath(sessionId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new SessionStorageError((error as Error).message);
      }
    }
  }

  async list(): Promise<SessionRecord[]> {
    await this.initialize();
    const entries = await fs.readdir(this.directory);
    const results: SessionRecord[] = [];
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map(async (entry) => {
          const sessionId = entry.replace(/\.json$/, '');
          const file = await this.readFile(sessionId);
          if (file) {
            results.push({
              updatedAt: file.updatedAt,
              session: deserializeSession(file.payload),
            });
          }
        }),
    );
    return results;
  }

  async beginTransaction(): Promise<SessionStorageTransaction> {
    await this.initialize();
    return new JsonSessionStorageTransaction(this);
  }

  async readDirect(sessionId: string): Promise<Session | null> {
    return this.read(sessionId);
  }

  async writeDirect(session: Session): Promise<void> {
    await this.write(session, { expectedRevision: undefined });
  }
}

interface StagedWrite {
  session: Session;
  expectedRevision?: number;
}

class JsonSessionStorageTransaction implements SessionStorageTransaction {
  private closed = false;
  private readonly writes = new Map<string, StagedWrite>();
  private readonly deletions = new Set<string>();

  constructor(private readonly adapter: JsonSessionStorageAdapter) {}

  private assertOpen() {
    if (this.closed) {
      throw new SessionStorageError('Transaction already closed');
    }
  }

  async write(session: Session, options?: WriteOptions): Promise<void> {
    this.assertOpen();
    const previous = this.writes.get(session.id);
    const staged = previous?.session;
    const baseline = staged ?? (await this.adapter.readDirect(session.id));
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

  async commit(): Promise<void> {
    this.assertOpen();
    for (const [_sessionId, staged] of this.writes.entries()) {
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

  async delete(sessionId: string): Promise<void> {
    this.assertOpen();
    this.writes.delete(sessionId);
    this.deletions.add(sessionId);
  }
}
