import React, { PropsWithChildren, useMemo } from 'react';

import { SessionManager, InMemorySessionStorageAdapter } from '../../session';
import { demoSession, DEMO_SESSION_ID } from '../../session/fixtures/demoSession';
import { SessionViewModelProvider } from './SessionViewModelProvider';
import { PassiveAudioEngineBridge } from './environment';

export const SessionStoryProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const manager = useMemo(() => {
    const storage = new InMemorySessionStorageAdapter();
    const bridge = new PassiveAudioEngineBridge();
    const createdManager = new SessionManager(storage, bridge);
    return createdManager;
  }, []);

  return (
    <SessionViewModelProvider
      manager={manager}
      sessionId={DEMO_SESSION_ID}
      bootstrapSession={() => demoSession}
      diagnosticsPollIntervalMs={0}
    >
      {children}
    </SessionViewModelProvider>
  );
};

export const SessionAppProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const manager = useMemo(() => {
    const storage = new InMemorySessionStorageAdapter();
    const bridge = new PassiveAudioEngineBridge();
    return new SessionManager(storage, bridge);
  }, []);

  return (
    <SessionViewModelProvider
      manager={manager}
      sessionId={DEMO_SESSION_ID}
      bootstrapSession={() => demoSession}
      diagnosticsPollIntervalMs={1200}
    >
      {children}
    </SessionViewModelProvider>
  );
};
