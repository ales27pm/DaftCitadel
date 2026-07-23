import React, { PropsWithChildren, useEffect, useState } from 'react';

import { demoSession } from '../../session/fixtures/demoSession';
import { SessionViewModelProvider } from './SessionViewModelProvider';
import {
  SessionEnvironment,
  createDemoSessionEnvironment,
  disposeSessionEnvironment,
  useSessionEnvironmentLifecycle,
} from './environment';

export const SessionStoryProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const [environment, setEnvironment] = useState<SessionEnvironment | null>(null);

  useSessionEnvironmentLifecycle(environment, {
    context: 'demo session environment',
  });

  useEffect(() => {
    let cancelled = false;
    let active: SessionEnvironment | null = null;
    let committed = false;
    const bootstrap = async () => {
      try {
        const created = await createDemoSessionEnvironment();
        if (cancelled) {
          await disposeSessionEnvironment(created, 'demo session environment');
          return;
        }
        active = created;
        committed = true;
        setEnvironment(created);
      } catch (error) {
        console.error('Failed to bootstrap demo session environment', error);
      }
    };
    bootstrap();
    return () => {
      cancelled = true;
      if (!committed && active) {
        disposeSessionEnvironment(active, 'demo session environment').catch(
          () => undefined,
        );
      }
    };
  }, []);

  if (!environment) {
    return null;
  }

  return (
    <SessionViewModelProvider
      manager={environment.manager}
      sessionId={environment.sessionId}
      bootstrapSession={() => demoSession}
      diagnosticsPollIntervalMs={0}
      audioBridge={environment.audioBridge}
    >
      {children}
    </SessionViewModelProvider>
  );
};
