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
  SessionStorageTransaction,
} from './storage';
import { AsyncMutex, deepClone } from './util';

export type AudioTransportSnapshot = {
  frame: number;
  seconds: number;
  beats: number;
  bpm: number;
  sampleRate: number;
  isPlaying: boolean;
  updatedAt: number;
};

export type AudioDiagnosticsSnapshot = {
  status: 'loading' | 'ready' | 'error' | 'unavailable';
  xruns: number;
  renderLoad: number;
  lastRenderDurationMicros?: number;
  clipBufferBytes?: number;
  error?: Error;
  updatedAt?: number;
};

export interface AudioEngineBridge {
  applySessionUpdate(session: Session): Promise<void>;
  resetSession(): Promise<void>;
  startTransport?(): Promise<void>;
  stopTransport?(): Promise<void>;
  locateTransport?(frame: number): Promise<void>;
  getTransportState?(): AudioTransportSnapshot | null;
  subscribeTransport?(listener: (snapshot: AudioTransportSnapshot) => void): () => void;
  getDiagnosticsState?(): AudioDiagnosticsSnapshot | null;
  subscribeDiagnostics?(
    listener: (snapshot: AudioDiagnosticsSnapshot) => void,
  ): () => void;
  retryPluginInstance?(instanceId: string): Promise<boolean>;
}

export interface SessionManagerOptions {
  cloudSyncProvider?: CloudSyncProvider;
  historyCapacity?: number;
}

type SessionRollbackFailure = {
  phase: 'storage' | 'audio-reset' | 'audio-restore';
  error: unknown;
};

class SessionRollbackError extends Error {
  constructor(public readonly failures: ReadonlyArray<SessionRollbackFailure>) {
    super(
      `Session transition rollback failed: ${failures
        .map(
          ({ phase, error }) =>
            `${phase}: ${error instanceof Error ? error.message : String(error)}`,
        )
        .join('; ')}`,
    );
    this.name = 'SessionRollbackError';
  }
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
    this.currentSession = session ? deepClone(session) : null;
    if (notify) {
      this.listeners.forEach((listener) => {
        try {
          listener(this.getSession());
        } catch (error) {
          console.error('SessionManager listener failed', error);
        }
      });
    }
  }

  private async rollbackTransaction(
    transaction: SessionStorageTransaction | null,
  ): Promise<SessionRollbackFailure[]> {
    if (!transaction) {
      return [];
    }
    try {
      await transaction.rollback();
      return [];
    } catch (error) {
      return [{ phase: 'storage', error }];
    }
  }

  private async restoreAudioSession(
    previous: Session | null,
  ): Promise<SessionRollbackFailure[]> {
    const failures: SessionRollbackFailure[] = [];
    try {
      await this.audioEngine.resetSession();
    } catch (error) {
      failures.push({ phase: 'audio-reset', error });
    }
    if (previous) {
      try {
        await this.audioEngine.applySessionUpdate(deepClone(previous));
      } catch (error) {
        failures.push({ phase: 'audio-restore', error });
      }
    }
    return failures;
  }

  private attachRollbackContext(
    operationError: unknown,
    rollbackFailures: SessionRollbackFailure[],
    sessionId: string,
  ): void {
    if (rollbackFailures.length === 0) {
      return;
    }
    const rollbackError = new SessionRollbackError(rollbackFailures);
    console.error('SessionManager transition rollback was incomplete', {
      sessionId,
      operationError,
      rollbackError,
    });
    if (!(operationError instanceof Error)) {
      return;
    }
    try {
      const contextualError = operationError as Error & {
        cause?: unknown;
        rollbackError?: SessionRollbackError;
      };
      if (contextualError.cause === undefined) {
        contextualError.cause = rollbackError;
      }
      contextualError.rollbackError = rollbackError;
    } catch (contextError) {
      console.error('SessionManager could not attach rollback context', {
        sessionId,
        contextError,
      });
    }
  }

  /**
   * Applies a transition without publishing it until both external boundaries agree.
   * Storage remains staged while audio is updated, so an audio failure can be rolled
   * back without changing persisted, in-memory, subscriber, or history state.
   */
  private async applyTransition(
    next: Session,
    previous: Session | null,
    persistence?: { expectedRevision: number },
  ): Promise<void> {
    let transaction: SessionStorageTransaction | null = null;
    let audioAttempted = false;
    try {
      if (persistence) {
        transaction = await this.storage.beginTransaction();
        await transaction.write(next, {
          expectedRevision: persistence.expectedRevision,
        });
      }

      audioAttempted = true;
      await this.audioEngine.applySessionUpdate(deepClone(next));
      await transaction?.commit();
    } catch (error) {
      const rollbackFailures = await this.rollbackTransaction(transaction);
      if (audioAttempted) {
        rollbackFailures.push(...(await this.restoreAudioSession(previous)));
      }
      this.attachRollbackContext(error, rollbackFailures, next.id);
      throw error;
    }
  }

  async loadSession(sessionId: string): Promise<Session> {
    const release = await this.mutex.acquire();
    try {
      await this.initialize();
      const local = await this.storage.read(sessionId);
      let resolved = local;
      let expectedRevision: number | null = null;
      const remote = await this.cloud.pull(sessionId);
      if (remote.session && local) {
        const base = local.revision <= remote.session.revision ? local : remote.session;
        resolved = await this.resolveConflict(base, local, remote.session);
        if (resolved.revision !== local.revision) {
          expectedRevision = local.revision;
        }
      } else if (remote.session && !local) {
        resolved = remote.session;
        expectedRevision = 0;
      }
      if (!resolved) {
        throw new SessionStorageError(`Session ${sessionId} not found`);
      }
      const normalized = normalizeSession(resolved);
      validateSession(normalized);
      await this.applyTransition(
        normalized,
        this.currentSession,
        expectedRevision === null ? undefined : { expectedRevision },
      );
      this.history.clear();
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
      await this.applyTransition(finalSession, this.currentSession, {
        expectedRevision: 0,
      });
      this.history.clear();
      this.setCurrentSession(finalSession);
      await this.pushToCloud(finalSession);
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
      const previous = deepClone(this.currentSession);
      const workingCopy = deepClone(this.currentSession);
      const mutated = (mutator(workingCopy) as Session | void) ?? workingCopy;
      const requestedRevision =
        typeof mutated.revision === 'number' ? mutated.revision : previous.revision;
      const nextRevision =
        requestedRevision > previous.revision ? requestedRevision : previous.revision + 1;
      const normalized = normalizeSession({
        ...mutated,
        revision: nextRevision,
      });
      const finalSession = updateSessionTimestamp(normalized);
      validateSession(finalSession);
      await this.applyTransition(finalSession, previous, {
        expectedRevision: previous.revision,
      });
      this.history.record(previous);
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
      const current = deepClone(this.currentSession);
      const previous = this.history.peekUndo();
      if (!previous) {
        return null;
      }
      const normalized = normalizeSession({
        ...previous,
        revision: current.revision + 1,
      });
      const finalSession = updateSessionTimestamp(normalized);
      validateSession(finalSession);
      await this.applyTransition(finalSession, current, {
        expectedRevision: current.revision,
      });
      this.history.commitUndo(current);
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
      const current = deepClone(this.currentSession);
      const next = this.history.peekRedo();
      if (!next) {
        return null;
      }
      const normalized = normalizeSession({
        ...next,
        revision: current.revision + 1,
      });
      const finalSession = updateSessionTimestamp(normalized);
      validateSession(finalSession);
      await this.applyTransition(finalSession, current, {
        expectedRevision: current.revision,
      });
      this.history.commitRedo(current);
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
        return deepClone(this.currentSession);
      }
      const previous = deepClone(this.currentSession);
      const normalized = normalizeSession(merged);
      const finalSession = updateSessionTimestamp(normalized);
      validateSession(finalSession);
      try {
        await this.applyTransition(finalSession, previous, {
          expectedRevision: previous.revision,
        });
      } catch (error) {
        if (error instanceof RevisionConflictError) {
          return null;
        }
        throw error;
      }
      this.history.record(previous);
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
