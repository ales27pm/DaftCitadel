import React, {
  PropsWithChildren,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  Session,
  SessionManager,
  SessionStorageError,
  type AudioDiagnosticsSnapshot,
  type AudioEngineBridge,
  type AudioInstrumentMidiEvent,
  type InstrumentParameterChange,
  type AudioTransportSnapshot,
} from '../../session';
import type { PluginHost, PluginCrashReport } from '../../audio';
import { buildTracks, buildTransport } from './selectors';
import { SessionDiagnosticsView, SessionViewModelState } from './types';
import { useAudioDiagnostics } from './useAudioDiagnostics';

interface SessionViewModelProviderProps extends PropsWithChildren {
  manager: SessionManager;
  sessionId: string;
  bootstrapSession?: () => Session;
  diagnosticsPollIntervalMs?: number;
  pluginHost?: PluginHost;
  audioBridge?: AudioEngineBridge;
}

interface SessionViewModelContextValue extends SessionViewModelState {
  manager: SessionManager;
  refresh: () => Promise<void>;
  retryPlugin: (instanceId: string) => Promise<boolean>;
}

const SessionViewModelContext = createContext<SessionViewModelContextValue | undefined>(
  undefined,
);

interface TransportController {
  isAvailable: boolean;
  isLoopAvailable: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  locateFrame: (frame: number) => Promise<void>;
  setLoopBeats: (startBeat: number, endBeat: number, enabled: boolean) => Promise<void>;
}

export interface InstrumentControlsHandle {
  isAvailable: boolean;
  sendInstrumentMidi: (
    nodeId: string,
    event: AudioInstrumentMidiEvent,
  ) => Promise<void>;
  setInstrumentParameter: (
    nodeId: string,
    change: InstrumentParameterChange,
  ) => Promise<void>;
  allNotesOff: (nodeId: string) => Promise<void>;
}

export const TransportControlsContext = createContext<TransportController | undefined>(
  undefined,
);

export const InstrumentControlsContext = createContext<
  InstrumentControlsHandle | undefined
>(undefined);

type TransportCapableBridge = AudioEngineBridge & {
  startTransport: NonNullable<AudioEngineBridge['startTransport']>;
  stopTransport: NonNullable<AudioEngineBridge['stopTransport']>;
  locateTransport: NonNullable<AudioEngineBridge['locateTransport']>;
};

type InstrumentCapableBridge = AudioEngineBridge & {
  sendInstrumentMidi: NonNullable<AudioEngineBridge['sendInstrumentMidi']>;
  allNotesOff: NonNullable<AudioEngineBridge['allNotesOff']>;
};

type InstrumentParameterCapableBridge = AudioEngineBridge & {
  setInstrumentParameter: NonNullable<AudioEngineBridge['setInstrumentParameter']>;
};

const hasTransportControls = (
  bridge: AudioEngineBridge | undefined,
): bridge is TransportCapableBridge =>
  !!bridge &&
  typeof bridge.startTransport === 'function' &&
  typeof bridge.stopTransport === 'function' &&
  typeof bridge.locateTransport === 'function';

const hasInstrumentControls = (
  bridge: AudioEngineBridge | undefined,
): bridge is InstrumentCapableBridge =>
  !!bridge &&
  typeof bridge.sendInstrumentMidi === 'function' &&
  typeof bridge.allNotesOff === 'function';

const hasInstrumentParameterControls = (
  bridge: AudioEngineBridge | undefined,
): bridge is InstrumentParameterCapableBridge =>
  !!bridge && typeof bridge.setInstrumentParameter === 'function';

export const SessionViewModelProvider: React.FC<SessionViewModelProviderProps> = ({
  manager,
  sessionId,
  bootstrapSession,
  diagnosticsPollIntervalMs,
  pluginHost,
  audioBridge,
  children,
}) => {
  const mounted = useRef(true);
  const [status, setStatus] = useState<SessionViewModelState['status']>('idle');
  const [error, setError] = useState<Error | undefined>();
  const [session, setSession] = useState<Session | null>(() => manager.getSession());
  // Poll when the bridge cannot push diagnostics updates.
  const shouldPollDiagnostics = !audioBridge?.subscribeDiagnostics;
  const audioDiagnostics = useAudioDiagnostics(
    shouldPollDiagnostics ? diagnosticsPollIntervalMs : 0,
  );
  const [pluginCrashMap, setPluginCrashMap] = useState<Map<string, PluginCrashReport>>(
    () => new Map(),
  );
  const [pluginAlerts, setPluginAlerts] = useState<PluginCrashReport[]>([]);
  const recoveryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [transportRuntime, setTransportRuntime] = useState<AudioTransportSnapshot | null>(
    () => audioBridge?.getTransportState?.() ?? null,
  );
  const [bridgeDiagnostics, setBridgeDiagnostics] =
    useState<AudioDiagnosticsSnapshot | null>(
      () => audioBridge?.getDiagnosticsState?.() ?? null,
    );

  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  const ensureSession = useCallback(async () => {
    if (!mounted.current) {
      return;
    }
    setStatus((previous) => (previous === 'ready' ? previous : 'loading'));
    setError(undefined);
    const existing = manager.getSession();
    if (existing && existing.id === sessionId) {
      setSession(existing);
      setStatus('ready');
      return;
    }
    try {
      let loaded: Session;
      try {
        loaded = await manager.loadSession(sessionId);
      } catch (loadError) {
        if (loadError instanceof SessionStorageError) {
          if (!bootstrapSession) {
            throw loadError;
          }
          const seed = bootstrapSession();
          const sessionSeed = seed.id === sessionId ? seed : { ...seed, id: sessionId };
          loaded = await manager.createSession(sessionSeed);
        } else {
          throw loadError;
        }
      }
      if (!mounted.current) {
        return;
      }
      setSession(loaded);
      setStatus('ready');
    } catch (loadError) {
      if (!mounted.current) {
        return;
      }
      setError(loadError as Error);
      setStatus('error');
      throw loadError;
    }
  }, [bootstrapSession, manager, sessionId]);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = manager.subscribe((nextSession) => {
      if (cancelled || !mounted.current) {
        return;
      }
      setSession(nextSession);
      if (nextSession) {
        setStatus('ready');
      }
    });
    if (!manager.getSession()) {
      ensureSession().catch(() => undefined);
    } else {
      setStatus('ready');
    }
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [ensureSession, manager]);

  useEffect(() => {
    if (!pluginHost) {
      return undefined;
    }
    const unsubscribe = pluginHost.onCrash((report) => {
      setPluginCrashMap((previous) => {
        const next = new Map(previous);
        next.set(report.instanceId, report);
        return next;
      });
      setPluginAlerts((previous) => {
        const deduped = previous.filter(
          (existing) =>
            existing.instanceId !== report.instanceId ||
            existing.timestamp !== report.timestamp,
        );
        const next = [report, ...deduped];
        return next.slice(0, 5);
      });
    });
    return unsubscribe;
  }, [pluginHost]);

  const removePluginAlert = useCallback((key: string) => {
    setPluginAlerts((previous) =>
      previous.filter((alert) => `${alert.instanceId}:${alert.timestamp}` !== key),
    );
  }, []);

  useEffect(() => {
    pluginAlerts.forEach((alert) => {
      const key = `${alert.instanceId}:${alert.timestamp}`;
      if (alert.recovered) {
        if (!recoveryTimers.current.has(key)) {
          const timer = setTimeout(() => {
            recoveryTimers.current.delete(key);
            removePluginAlert(key);
          }, 4000);
          recoveryTimers.current.set(key, timer);
        }
      } else if (recoveryTimers.current.has(key)) {
        const timer = recoveryTimers.current.get(key);
        if (timer) {
          clearTimeout(timer);
        }
        recoveryTimers.current.delete(key);
      }
    });

    const activeKeys = new Set(
      pluginAlerts.map((alert) => `${alert.instanceId}:${alert.timestamp}`),
    );
    recoveryTimers.current.forEach((timer, key) => {
      if (!activeKeys.has(key)) {
        clearTimeout(timer);
        recoveryTimers.current.delete(key);
      }
    });
  }, [pluginAlerts, removePluginAlert]);

  useEffect(() => {
    const timers = recoveryTimers.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  useEffect(() => {
    setTransportRuntime(audioBridge?.getTransportState?.() ?? null);
    setBridgeDiagnostics(audioBridge?.getDiagnosticsState?.() ?? null);
  }, [audioBridge]);

  useEffect(() => {
    if (!audioBridge?.subscribeTransport) {
      return undefined;
    }
    const unsubscribe = audioBridge.subscribeTransport((snapshot) => {
      setTransportRuntime(snapshot);
    });
    return unsubscribe;
  }, [audioBridge]);

  useEffect(() => {
    if (!audioBridge?.subscribeDiagnostics) {
      return undefined;
    }
    const unsubscribe = audioBridge.subscribeDiagnostics((snapshot) => {
      setBridgeDiagnostics(snapshot);
    });
    return unsubscribe;
  }, [audioBridge]);

  const diagnostics: SessionDiagnosticsView = useMemo(() => {
    if (bridgeDiagnostics) {
      return {
        status: bridgeDiagnostics.status,
        xruns: bridgeDiagnostics.xruns,
        renderLoad: bridgeDiagnostics.renderLoad,
        lastRenderDurationMicros: bridgeDiagnostics.lastRenderDurationMicros,
        clipBufferBytes: bridgeDiagnostics.clipBufferBytes,
        error: bridgeDiagnostics.error,
        updatedAt: bridgeDiagnostics.updatedAt,
      };
    }
    return audioDiagnostics.diagnostics;
  }, [audioDiagnostics.diagnostics, bridgeDiagnostics]);

  const tracks = useMemo(() => {
    if (!session) {
      return [];
    }
    return buildTracks(session, diagnostics, pluginCrashMap);
  }, [diagnostics, pluginCrashMap, session]);

  const transport = useMemo(() => {
    if (!session) {
      return null;
    }
    return buildTransport(session, diagnostics, transportRuntime ?? undefined);
  }, [diagnostics, session, transportRuntime]);

  const viewModel: SessionViewModelState = useMemo(
    () => ({
      status,
      sessionId: session?.id,
      sessionName: session?.name,
      tracks,
      transport,
      diagnostics,
      transportRuntime,
      error,
      pluginAlerts,
    }),
    [
      diagnostics,
      error,
      pluginAlerts,
      session?.id,
      session?.name,
      status,
      tracks,
      transport,
      transportRuntime,
    ],
  );

  const retryPlugin = useCallback(
    async (instanceId: string) => {
      const candidates: Array<() => Promise<boolean>> = [];
      const audioRetry = audioBridge?.retryPluginInstance;
      if (audioRetry) {
        candidates.push(() => audioRetry(instanceId));
      }
      const hostRetry = pluginHost?.retryInstance;
      if (hostRetry) {
        candidates.push(() => hostRetry.call(pluginHost, instanceId));
      }
      if (candidates.length === 0) {
        console.warn('No plugin retry handler available in current session');
        return false;
      }
      try {
        for (const attempt of candidates) {
          const success = await attempt();
          if (success) {
            setPluginCrashMap((previous) => {
              if (!previous.has(instanceId)) {
                return previous;
              }
              const next = new Map(previous);
              const existing = next.get(instanceId);
              if (existing) {
                next.set(instanceId, { ...existing, recovered: true });
              }
              return next;
            });
            setPluginAlerts((previous) =>
              previous.map((alert) =>
                alert.instanceId === instanceId ? { ...alert, recovered: true } : alert,
              ),
            );
            return true;
          }
        }
        return false;
      } catch (retryPluginError) {
        console.error('Failed to retry plugin instance', retryPluginError);
        return false;
      }
    },
    [audioBridge, pluginHost],
  );

  const contextValue = useMemo<SessionViewModelContextValue>(
    () => ({
      manager,
      refresh: ensureSession,
      retryPlugin,
      ...viewModel,
    }),
    [ensureSession, manager, retryPlugin, viewModel],
  );

  const transportControls = useMemo<TransportController>(() => {
    if (!hasTransportControls(audioBridge)) {
      const fallback = async () => {
        console.warn('Transport controls unavailable in current session environment.');
      };
      return {
        isAvailable: false,
        isLoopAvailable: false,
        start: fallback,
        stop: fallback,
        locateFrame: fallback,
        setLoopBeats: fallback,
      };
    }
    const unavailableLoop = async () => {
      throw new Error('Transport loop controls unavailable');
    };
    return {
      isAvailable: true,
      isLoopAvailable: false,
      start: () => audioBridge.startTransport(),
      stop: () => audioBridge.stopTransport(),
      locateFrame: (frame: number) => audioBridge.locateTransport(frame),
      setLoopBeats: unavailableLoop,
    };
  }, [audioBridge]);

  const instrumentControls = useMemo<InstrumentControlsHandle>(() => {
    const unavailable = async () => {
      throw new Error('Live instrument controls are unavailable');
    };
    if (!hasInstrumentControls(audioBridge)) {
      return {
        isAvailable: false,
        sendInstrumentMidi: unavailable,
        setInstrumentParameter: unavailable,
        allNotesOff: unavailable,
      };
    }
    return {
      isAvailable: true,
      sendInstrumentMidi: (nodeId, event) =>
        audioBridge.sendInstrumentMidi(nodeId, event),
      setInstrumentParameter: hasInstrumentParameterControls(audioBridge)
        ? (nodeId, change) => audioBridge.setInstrumentParameter(nodeId, change)
        : unavailable,
      allNotesOff: (nodeId) => audioBridge.allNotesOff(nodeId),
    };
  }, [audioBridge]);

  return (
    <InstrumentControlsContext.Provider value={instrumentControls}>
      <TransportControlsContext.Provider value={transportControls}>
        <SessionViewModelContext.Provider value={contextValue}>
          {children}
        </SessionViewModelContext.Provider>
      </TransportControlsContext.Provider>
    </InstrumentControlsContext.Provider>
  );
};

export const useSessionViewModel = (): SessionViewModelContextValue => {
  const context = useContext(SessionViewModelContext);
  if (!context) {
    throw new Error('useSessionViewModel must be used within a SessionViewModelProvider');
  }
  return context;
};

export const useInstrumentControls = (): InstrumentControlsHandle => {
  const context = useContext(InstrumentControlsContext);
  if (!context) {
    throw new Error(
      'useInstrumentControls must be used within a SessionViewModelProvider',
    );
  }
  return context;
};
