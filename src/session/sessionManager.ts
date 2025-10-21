import { CloudSyncProvider, NoopCloudSyncProvider } from './cloud';
import { SessionHistory } from './history';
import {
  normalizeSession,
  Session,
  updateSessionTimestamp,
  validateSession,
} from './models';
import { mergeSessions } from './serialization';
import {
  RevisionConflictError,
  SessionStorageAdapter,
  SessionStorageError,
} from './storage';
import { AsyncMutex, deepClone } from './util';

export interface AudioEngineBridge {
  applySessionUpdate(session: Session): Promise<void>;
}

export interface SessionManagerOptions {
  cloudSyncProvider?: CloudSyncProvider;
  historyCapacity?: number;
}

export class SessionManager {
  private currentSession: Session | null = null;
  private readonly mutex = new AsyncMutex();
  private readonly history: SessionHistory;
  private readonly cloud: CloudSyncProvider;
  private readonly listeners = new Set<(session: Session | null) => void>();

  constructor(
    private readonly storage: SessionStorageAdapter,
    private readonly audioEngine: AudioEngineBridge,
    options: SessionManagerOptions = {},
  ) {
    this.history = new SessionHistory(options.historyCapacity);
    this.cloud = options.cloudSyncProvider ?? new NoopCloudSyncProvider();
  }

  async initialize(): Promise<void> {
    await this.storage.initialize();
  }

  getSession(): Session | null {
    return this.currentSession ? deepClone(this.currentSession) : null;
  }

  subscribe(listener: (session: Session | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSession());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setCurrentSession(session: Session | null, notify = true) {
    this.currentSession = session;
    if (notify) {
      const snapshot = this.getSession();
      this.listeners.forEach((listener) => {
        try {
          listener(snapshot);
        } catch (error) {
          console.error('SessionManager listener failed', error);
        }
      });
    }
  }

  async loadSession(sessionId: string): Promise<Session> {
    const release = await this.mutex.acquire();
    try {
      await this.initialize();
      const local = await this.storage.read(sessionId);
      let resolved = local;
      const remote = await this.cloud.pull(sessionId);
      if (remote.session && local) {
        const base = local.revision <= remote.session.revision ? local : remote.session;
        resolved = await this.resolveConflict(base, local, remote.session);
        if (resolved.revision !== local.revision) {
          await this.storage.write(resolved, { expectedRevision: local.revision });
        }
      } else if (remote.session && !local) {
        resolved = remote.session;
        await this.storage.write(resolved, { expectedRevision: 0 });
      }
      if (!resolved) {
        throw new SessionStorageError(`Session ${sessionId} not found`);
      }
      const normalized = normalizeSession(resolved);
      validateSession(normalized);
      this.setCurrentSession(normalized, false);
      this.history.clear();
      await this.audioEngine.applySessionUpdate(normalized);
      this.setCurrentSession(normalized);
      return deepClone(normalized);
    } finally {
      release();
    }
  }

  async createSession(session: Session): Promise<Session> {
    const release = await this.mutex.acquire();
    try {
      const normalized = normalizeSession(session);
      const finalSession = updateSessionTimestamp(normalized);
      validateSession(finalSession);
      await this.storage.write(finalSession, { expectedRevision: 0 });
      this.setCurrentSession(finalSession, false);
      this.history.clear();
      await this.audioEngine.applySessionUpdate(finalSession);
      this.setCurrentSession(finalSession);
      await this.cloud.push(finalSession);
      return deepClone(finalSession);
    } finally {
      release();
    }
  }

  async updateSession(mutator: (session: Session) => Session | void): Promise<Session> {
    const release = await this.mutex.acquire();
    try {
      if (!this.currentSession) {
        throw new SessionStorageError('No active session to update');
      }
      const previous = JSON.parse(JSON.stringify(this.currentSession)) as Session;
      const workingCopy = JSON.parse(JSON.stringify(this.currentSession)) as Session;
      const mutated = (mutator(workingCopy) as Session | void) ?? workingCopy;
      const normalized = normalizeSession({
        ...mutated,
        revision: previous.revision + 1,
      });
      const finalSession = updateSessionTimestamp(normalized);
      validateSession(finalSession);
      const tx = await this.storage.beginTransaction();
      try {
        await tx.write(finalSession, { expectedRevision: previous.revision });
        await tx.commit();
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        throw error;
      }
      this.history.record(previous);
      this.setCurrentSession(finalSession, false);
      await this.audioEngine.applySessionUpdate(finalSession);
      this.setCurrentSession(finalSession);
      await this.pushToCloud(finalSession);
      return deepClone(finalSession);
    } finally {
      release();
    }
  }

  async undo(): Promise<Session | null> {
    const release = await this.mutex.acquire();
    try {
      if (!this.currentSession) {
        return null;
      }
      const previous = this.history.undo(this.currentSession);
      if (!previous) {
        return null;
      }
      const normalized = normalizeSession({
        ...previous,
        revision: this.currentSession.revision + 1,
      });
      const finalSession = updateSessionTimestamp(normalized);
      validateSession(finalSession);
      const tx = await this.storage.beginTransaction();
      try {
        await tx.write(finalSession, { expectedRevision: this.currentSession.revision });
        await tx.commit();
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        throw error;
      }
      this.setCurrentSession(finalSession, false);
      await this.audioEngine.applySessionUpdate(finalSession);
      this.setCurrentSession(finalSession);
      await this.pushToCloud(finalSession);
      return deepClone(finalSession);
    } finally {
      release();
    }
  }

  async redo(): Promise<Session | null> {
    const release = await this.mutex.acquire();
    try {
      if (!this.currentSession) {
        return null;
      }
      const next = this.history.redo(this.currentSession);
      if (!next) {
        return null;
      }
      const normalized = normalizeSession({
        ...next,
        revision: this.currentSession.revision + 1,
      });
      const finalSession = updateSessionTimestamp(normalized);
      validateSession(finalSession);
      const tx = await this.storage.beginTransaction();
      try {
        await tx.write(finalSession, { expectedRevision: this.currentSession.revision });
        await tx.commit();
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        throw error;
      }
      this.setCurrentSession(finalSession, false);
      await this.audioEngine.applySessionUpdate(finalSession);
      this.setCurrentSession(finalSession);
      await this.pushToCloud(finalSession);
      return deepClone(finalSession);
    } finally {
      release();
    }
  }

  async syncWithCloud(): Promise<Session | null> {
    const release = await this.mutex.acquire();
    try {
      if (!this.currentSession) {
        return null;
      }
      const remote = await this.cloud.pull(this.currentSession.id);
      if (!remote.session) {
        return null;
      }
      if (remote.session.revision === this.currentSession.revision) {
        return deepClone(this.currentSession);
      }
      const base =
        remote.session.revision <= this.currentSession.revision
          ? remote.session
          : this.currentSession;
      const merged = await this.resolveConflict(
        base,
        this.currentSession,
        remote.session,
      );
      if (merged.revision === this.currentSession.revision) {
        return JSON.parse(JSON.stringify(this.currentSession));
      }
      const normalized = normalizeSession(merged);
      const finalSession = updateSessionTimestamp(normalized);
      validateSession(finalSession);
      const tx = await this.storage.beginTransaction();
      try {
        await tx.write(finalSession, { expectedRevision: this.currentSession.revision });
        await tx.commit();
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        if (error instanceof RevisionConflictError) {
          return null;
        }
        throw error;
      }
      this.history.record(this.currentSession);
      this.setCurrentSession(finalSession, false);
      await this.audioEngine.applySessionUpdate(finalSession);
      this.setCurrentSession(finalSession);
      await this.pushToCloud(finalSession);
      return deepClone(finalSession);
    } finally {
      release();
    }
  }

  private async resolveConflict(
    base: Session,
    local: Session,
    remote: Session,
  ): Promise<Session> {
    if (this.cloud.resolveConflict) {
      return this.cloud.resolveConflict({ base, local, remote });
    }
    return mergeSessions(base, local, remote);
  }

  private async pushToCloud(session: Session): Promise<void> {
    try {
      await this.cloud.push(session);
    } catch (error) {
      console.warn('Cloud sync push failed', error);
    }
  }
}
