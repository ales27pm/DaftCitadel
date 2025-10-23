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
}

const SessionViewModelContext = createContext<SessionViewModelContextValue | undefined>(
  undefined,
);

interface TransportController {
  isAvailable: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  locateFrame: (frame: number) => Promise<void>;
}

export const TransportControlsContext = createContext<TransportController | undefined>(
  undefined,
);

type TransportCapableBridge = AudioEngineBridge & {
  startTransport: NonNullable<AudioEngineBridge['startTransport']>;
  stopTransport: NonNullable<AudioEngineBridge['stopTransport']>;
  locateTransport: NonNullable<AudioEngineBridge['locateTransport']>;
};

const hasTransportControls = (
  bridge: AudioEngineBridge | undefined,
): bridge is TransportCapableBridge =>
  !!bridge &&
  typeof bridge.startTransport === 'function' &&
  typeof bridge.stopTransport === 'function' &&
  typeof bridge.locateTransport === 'function';

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
  const shouldPollDiagnostics =
    !audioBridge?.subscribeDiagnostics && !audioBridge?.getDiagnosticsState;
  const audioDiagnostics = useAudioDiagnostics(
    shouldPollDiagnostics ? diagnosticsPollIntervalMs : 0,
  );
  const [pluginCrashMap, setPluginCrashMap] = useState<Map<string, PluginCrashReport>>(
    () => new Map(),
  );
  const [pluginAlerts, setPluginAlerts] = useState<PluginCrashReport[]>([]);
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

  const contextValue = useMemo<SessionViewModelContextValue>(
    () => ({
      manager,
      refresh: ensureSession,
      ...viewModel,
    }),
    [ensureSession, manager, viewModel],
  );

  const transportControls = useMemo<TransportController>(() => {
    if (!hasTransportControls(audioBridge)) {
      const fallback = async () => {
        console.warn('Transport controls unavailable in current session environment.');
      };
      return {
        isAvailable: false,
        start: fallback,
        stop: fallback,
        locateFrame: fallback,
      };
    }
    return {
      isAvailable: true,
      start: () => audioBridge.startTransport(),
      stop: () => audioBridge.stopTransport(),
      locateFrame: (frame: number) => audioBridge.locateTransport(frame),
    };
  }, [audioBridge]);

  return (
    <TransportControlsContext.Provider value={transportControls}>
      <SessionViewModelContext.Provider value={contextValue}>
        {children}
      </SessionViewModelContext.Provider>
    </TransportControlsContext.Provider>
  );
};

export const useSessionViewModel = (): SessionViewModelContextValue => {
  const context = useContext(SessionViewModelContext);
  if (!context) {
    throw new Error('useSessionViewModel must be used within a SessionViewModelProvider');
  }
  return context;
};
