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

import { Session, SessionManager, SessionStorageError } from '../../session';
import { buildTracks, buildTransport } from './selectors';
import { SessionViewModelState } from './types';
import { useAudioDiagnostics } from './useAudioDiagnostics';

interface SessionViewModelProviderProps extends PropsWithChildren {
  manager: SessionManager;
  sessionId: string;
  bootstrapSession?: () => Session;
  diagnosticsPollIntervalMs?: number;
}

interface SessionViewModelContextValue extends SessionViewModelState {
  manager: SessionManager;
  refresh: () => Promise<void>;
}

const SessionViewModelContext = createContext<SessionViewModelContextValue | undefined>(
  undefined,
);

export const SessionViewModelProvider: React.FC<SessionViewModelProviderProps> = ({
  manager,
  sessionId,
  bootstrapSession,
  diagnosticsPollIntervalMs,
  children,
}) => {
  const mounted = useRef(true);
  const [status, setStatus] = useState<SessionViewModelState['status']>('idle');
  const [error, setError] = useState<Error | undefined>();
  const [session, setSession] = useState<Session | null>(() => manager.getSession());
  const audioDiagnostics = useAudioDiagnostics(diagnosticsPollIntervalMs);

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

  const diagnostics = audioDiagnostics.diagnostics;

  const tracks = useMemo(() => {
    if (!session) {
      return [];
    }
    return buildTracks(session, diagnostics);
  }, [diagnostics, session]);

  const transport = useMemo(() => {
    if (!session) {
      return null;
    }
    return buildTransport(session, diagnostics);
  }, [diagnostics, session]);

  const viewModel: SessionViewModelState = useMemo(
    () => ({
      status,
      sessionId: session?.id,
      sessionName: session?.name,
      tracks,
      transport,
      diagnostics,
      error,
    }),
    [diagnostics, error, session?.id, session?.name, status, tracks, transport],
  );

  const contextValue = useMemo<SessionViewModelContextValue>(
    () => ({
      manager,
      refresh: ensureSession,
      ...viewModel,
    }),
    [ensureSession, manager, viewModel],
  );

  return (
    <SessionViewModelContext.Provider value={contextValue}>
      {children}
    </SessionViewModelContext.Provider>
  );
};

export const useSessionViewModel = (): SessionViewModelContextValue => {
  const context = useContext(SessionViewModelContext);
  if (!context) {
    throw new Error('useSessionViewModel must be used within a SessionViewModelProvider');
  }
  return context;
};
