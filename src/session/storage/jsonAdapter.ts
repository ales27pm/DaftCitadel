import { promises as fs } from 'fs';
import path from 'path';
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

interface JsonSessionFile {
  payload: string;
  revision: number;
  updatedAt: string;
}

interface JsonTransactionJournal {
  version: 1;
  originals: Array<[sessionId: string, raw: string | null]>;
}

const TRANSACTION_JOURNAL = '.session-transaction.journal';

const directoryMutexes = new Map<string, AsyncMutex>();

const mutexForDirectory = (directory: string): AsyncMutex => {
  const key = path.resolve(directory);
  const existing = directoryMutexes.get(key);
  if (existing) {
    return existing;
  }
  const mutex = new AsyncMutex();
  directoryMutexes.set(key, mutex);
  return mutex;
};

export class JsonSessionStorageAdapter implements SessionStorageAdapter {
  private readonly mutex: AsyncMutex;

  constructor(private readonly directory: string) {
    this.mutex = mutexForDirectory(directory);
  }

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

  private journalPath(): string {
    return path.resolve(this.directory, TRANSACTION_JOURNAL);
  }

  private async writeJournal(
    originals: ReadonlyMap<string, string | null>,
  ): Promise<void> {
    const journal: JsonTransactionJournal = {
      version: 1,
      originals: Array.from(originals),
    };
    const journalPath = this.journalPath();
    const tempPath = `${journalPath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(journal));
    await fs.rename(tempPath, journalPath);
  }

  private async recoverPendingTransaction(): Promise<void> {
    const journalPath = this.journalPath();
    let rawJournal: string;
    try {
      rawJournal = await fs.readFile(journalPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw new SessionStorageError(
        `Failed to read the JSON transaction journal: ${(error as Error).message}`,
      );
    }

    let journal: JsonTransactionJournal;
    try {
      const parsed = JSON.parse(rawJournal) as Partial<JsonTransactionJournal>;
      if (parsed.version !== 1 || !Array.isArray(parsed.originals)) {
        throw new Error('Invalid journal shape');
      }
      journal = parsed as JsonTransactionJournal;
    } catch (error) {
      throw new SessionStorageError(
        `Failed to parse the JSON transaction journal: ${(error as Error).message}`,
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
        await fs.rm(`${this.filePath(sessionId)}.tmp`, { force: true });
        if (raw === null) {
          await this.deleteFile(sessionId);
        } else {
          await fs.writeFile(this.filePath(sessionId), raw);
        }
      } catch (error) {
        restoreErrors.push(error as Error);
      }
    }
    if (restoreErrors.length > 0) {
      throw new SessionStorageError(
        `Failed to recover the JSON transaction journal: ${restoreErrors.map(({ message }) => message).join('; ')}`,
      );
    }
    await fs.rm(journalPath, { force: true });
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

  private async readSessionUnlocked(sessionId: string): Promise<Session | null> {
    const file = await this.readFile(sessionId);
    return file ? deserializeSession(file.payload) : null;
  }

  private async readRawFile(sessionId: string): Promise<string | null> {
    try {
      return await fs.readFile(this.filePath(sessionId), 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private async deleteFile(sessionId: string): Promise<void> {
    try {
      await fs.unlink(this.filePath(sessionId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async read(sessionId: string): Promise<Session | null> {
    await this.initialize();
    return this.runExclusive(() => this.readSessionUnlocked(sessionId));
  }

  async write(session: Session, options?: WriteOptions): Promise<void> {
    await this.initialize();
    await this.runExclusive(async () => {
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
    });
  }

  async delete(sessionId: string): Promise<void> {
    await this.initialize();
    await this.runExclusive(() => this.deleteFile(sessionId));
  }

  async list(): Promise<SessionRecord[]> {
    await this.initialize();
    return this.runExclusive(async () => {
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
    });
  }

  async beginTransaction(): Promise<SessionStorageTransaction> {
    await this.initialize();
    return new JsonSessionStorageTransaction(this);
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
      const prepared = new Map<string, JsonSessionFile>();

      for (const [sessionId, staged] of writes) {
        const existing = await this.readFile(sessionId);
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
        prepared.set(sessionId, {
          payload: serializeSession(staged.session),
          revision: staged.session.revision,
          updatedAt: new Date().toISOString(),
        });
      }

      for (const sessionId of targetIds) {
        originals.set(sessionId, await this.readRawFile(sessionId));
      }

      try {
        await this.writeJournal(originals);
      } catch (error) {
        throw new SessionStorageError(
          `Failed to prepare the JSON transaction journal: ${(error as Error).message}`,
        );
      }

      try {
        for (const [sessionId, data] of prepared) {
          await this.writeFile(sessionId, data);
        }
        for (const sessionId of deletions) {
          await this.deleteFile(sessionId);
        }
        await fs.rm(this.journalPath(), { force: true });
      } catch (error) {
        try {
          await this.recoverPendingTransaction();
        } catch (rollbackError) {
          throw new SessionStorageError(
            `Transaction failed (${(error as Error).message}) and rollback could not restore the JSON store: ${(rollbackError as Error).message}`,
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

  async delete(sessionId: string): Promise<void> {
    this.assertOpen();
    this.writes.delete(sessionId);
    this.deletions.add(sessionId);
  }
}
