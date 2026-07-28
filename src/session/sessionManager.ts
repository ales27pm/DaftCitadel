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

export type AudioInstrumentMidiEvent = {
  type: number;
  channel: number;
  data1: number;
  data2: number;
  frameOffset?: number;
};

export type InstrumentMidiEvent = AudioInstrumentMidiEvent;

export type InstrumentParameterChange = {
  parameterId: number;
  value: number;
  frameOffset?: number;
};

export interface AudioEngineBridge {
  applySessionUpdate(session: Session): Promise<void>;
  resetSession?(): Promise<void>;
  startTransport?(): Promise<void>;
  stopTransport?(): Promise<void>;
  locateTransport?(frame: number): Promise<void>;
  sendInstrumentMidi?(nodeId: string, event: AudioInstrumentMidiEvent): Promise<void>;
  setInstrumentParameter?(
    nodeId: string,
    change: InstrumentParameterChange,
  ): Promise<void>;
  allNotesOff?(nodeId: string): Promise<void>;
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
      const previousSession = this.currentSession ? deepClone(this.currentSession) : null;
      await this.commitSessionTransition(normalized, previousSession, expectedRevision);
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
      const previousSession = this.currentSession ? deepClone(this.currentSession) : null;
      await this.commitSessionTransition(finalSession, previousSession, 0);
      this.history.clear();
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
      await this.commitSessionTransition(finalSession, previous, previous.revision);
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
      const current = this.currentSession;
      const previous = this.history.undo(current);
      if (!previous) {
        return null;
      }
      const normalized = normalizeSession({
        ...previous,
        revision: current.revision + 1,
      });
      const finalSession = updateSessionTimestamp(normalized);
      validateSession(finalSession);
      try {
        await this.commitSessionTransition(finalSession, current, current.revision);
      } catch (error) {
        this.history.redo(previous);
        throw error;
      }
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
      const current = this.currentSession;
      const next = this.history.redo(current);
      if (!next) {
        return null;
      }
      const normalized = normalizeSession({
        ...next,
        revision: current.revision + 1,
      });
      const finalSession = updateSessionTimestamp(normalized);
      validateSession(finalSession);
      try {
        await this.commitSessionTransition(finalSession, current, current.revision);
      } catch (error) {
        this.history.undo(next);
        throw error;
      }
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
      const previousSession = this.currentSession;
      if (!previousSession) {
        return null;
      }
      try {
        await this.commitSessionTransition(
          finalSession,
          previousSession,
          previousSession.revision,
        );
      } catch (error) {
        if (error instanceof RevisionConflictError) {
          return null;
        }
        throw error;
      }
      this.history.record(previousSession);
      this.setCurrentSession(finalSession);
      await this.pushToCloud(finalSession);
      return deepClone(finalSession);
    } finally {
      release();
    }
  }

  private async commitSessionTransition(
    finalSession: Session,
    previousSession: Session | null,
    expectedRevision: number | null,
  ): Promise<void> {
    const tx = expectedRevision === null ? null : await this.storage.beginTransaction();
    let audioMutationAttempted = false;
    try {
      if (tx && expectedRevision !== null) {
        await tx.write(finalSession, { expectedRevision });
      }
      audioMutationAttempted = true;
      await this.audioEngine.applySessionUpdate(finalSession);
      await tx?.commit();
    } catch (error) {
      await tx?.rollback().catch(() => undefined);
      if (audioMutationAttempted) {
        const restoreAudio = previousSession
          ? this.audioEngine.applySessionUpdate(previousSession)
          : (this.audioEngine.resetSession?.() ?? Promise.resolve());
        await restoreAudio.catch((rollbackError) => {
          console.error('Failed to restore the previous audio graph', {
            sessionId: previousSession?.id,
            rollbackError,
          });
        });
      }
      throw error;
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
