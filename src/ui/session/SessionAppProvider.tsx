import React, { PropsWithChildren, useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { SessionViewModelProvider } from './SessionViewModelProvider';
import {
  NativeAudioUnavailableError,
  createPassiveSessionEnvironment,
  createProductionSessionEnvironment,
  disposeSessionEnvironment,
  useSessionEnvironmentLifecycle,
  type SessionEnvironment,
} from './environment';

const APP_ENVIRONMENT_CONTEXT = 'app session environment';

export const SessionAppProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const [environment, setEnvironment] = useState<SessionEnvironment | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useSessionEnvironmentLifecycle(environment, {
    context: APP_ENVIRONMENT_CONTEXT,
  });

  useEffect(() => {
    let cancelled = false;
    let active: SessionEnvironment | null = null;
    let committed = false;
    const shouldUseProduction =
      !__DEV__ && (Platform.OS === 'ios' || Platform.OS === 'android');

    const bootstrap = async () => {
      try {
        const created = await bootstrapEnvironment(shouldUseProduction);
        if (cancelled) {
          await disposeSessionEnvironment(created, APP_ENVIRONMENT_CONTEXT);
          return;
        }
        active = created;
        committed = true;
        setEnvironment(created);
      } catch (bootstrapError) {
        if (cancelled) {
          return;
        }
        setError(bootstrapError as Error);
      }
    };

    bootstrap();

    return () => {
      cancelled = true;
      if (!committed && active) {
        disposeSessionEnvironment(active, APP_ENVIRONMENT_CONTEXT).catch(() => undefined);
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
      diagnosticsPollIntervalMs={1200}
      pluginHost={environment.pluginHost}
      audioBridge={environment.audioBridge}
    >
      {children}
    </SessionViewModelProvider>
  );
};

const bootstrapEnvironment = async (
  shouldUseProduction: boolean,
): Promise<SessionEnvironment> => {
  if (!shouldUseProduction) {
    if (Platform.OS === 'web') {
      console.info('Using passive session environment for web platform.');
    } else if (__DEV__) {
      console.info('Using passive session environment for development build.');
    }
    return createPassiveSessionEnvironment();
  }
  try {
    return await createProductionSessionEnvironment();
  } catch (error) {
    if (error instanceof NativeAudioUnavailableError) {
      console.info(
        'Audio engine unavailable; falling back to passive session environment.',
      );
      return createPassiveSessionEnvironment();
    }
    console.error('Failed to bootstrap production session environment', error);
    throw error;
  }
};
