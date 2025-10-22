import React, { PropsWithChildren, useEffect, useState } from 'react';

import { demoSession } from '../../session/fixtures/demoSession';
import { SessionViewModelProvider } from './SessionViewModelProvider';
import {
  SessionEnvironment,
  createDemoSessionEnvironment,
  createProductionSessionEnvironment,
  createPassiveSessionEnvironment,
  NativeAudioUnavailableError,
} from './environment';

export const SessionStoryProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const [environment, setEnvironment] = useState<SessionEnvironment | null>(null);

  useEffect(() => {
    let cancelled = false;
    let active: SessionEnvironment | null = null;
    const bootstrap = async () => {
      try {
        const created = await createDemoSessionEnvironment();
        if (cancelled) {
          await created.dispose?.();
          return;
        }
        active = created;
        setEnvironment(created);
      } catch (error) {
        console.error('Failed to bootstrap demo session environment', error);
      }
    };
    bootstrap();
    return () => {
      cancelled = true;
      if (active?.dispose) {
        Promise.resolve(active.dispose()).catch((disposeError: unknown) => {
          console.error('Failed to dispose demo session environment', disposeError);
        });
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
    >
      {children}
    </SessionViewModelProvider>
  );
};

export const SessionAppProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const [environment, setEnvironment] = useState<SessionEnvironment | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    let active: SessionEnvironment | null = null;

    const bootstrap = async () => {
      try {
        const created = await createProductionSessionEnvironment();
        if (cancelled) {
          await created.dispose?.();
          return;
        }
        active = created;
        setEnvironment(created);
      } catch (bootstrapError) {
        if (bootstrapError instanceof NativeAudioUnavailableError) {
          console.info(
            'Audio engine unavailable; falling back to passive session environment.',
          );
          try {
            const fallback = await createPassiveSessionEnvironment();
            if (cancelled) {
              await fallback.dispose?.();
              return;
            }
            active = fallback;
            setEnvironment(fallback);
          } catch (passiveError) {
            console.error(
              'Failed to bootstrap passive session environment',
              passiveError,
            );
            setError(passiveError as Error);
          }
        } else {
          console.error(
            'Failed to bootstrap production session environment',
            bootstrapError,
          );
          setError(bootstrapError as Error);
        }
      }
    };

    bootstrap();

    return () => {
      cancelled = true;
      if (active?.dispose) {
        Promise.resolve(active.dispose()).catch((disposeError: unknown) => {
          console.error('Failed to dispose session environment', disposeError);
        });
      }
    };
  }, []);

  if (error) {
    throw error;
  }

  if (!environment) {
    return null;
  }

  return (
    <SessionViewModelProvider
      manager={environment.manager}
      sessionId={environment.sessionId}
      bootstrapSession={() => demoSession}
      diagnosticsPollIntervalMs={1200}
      pluginHost={environment.pluginHost}
    >
      {children}
    </SessionViewModelProvider>
  );
};
