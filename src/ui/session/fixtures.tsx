import React, { PropsWithChildren, useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { demoSession } from '../../session/fixtures/demoSession';
import { SessionViewModelProvider } from './SessionViewModelProvider';
import {
  SessionEnvironment,
  createDemoSessionEnvironment,
  createProductionSessionEnvironment,
  createPassiveSessionEnvironment,
  NativeAudioUnavailableError,
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

export const SessionAppProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const [environment, setEnvironment] = useState<SessionEnvironment | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useSessionEnvironmentLifecycle(environment, {
    context: 'app session environment',
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
          await disposeSessionEnvironment(created, 'app session environment');
          return;
        }
        active = created;
        committed = true;
        setEnvironment(created);
      } catch (bootstrapError) {
        setError(bootstrapError as Error);
      }
    };

    bootstrap();

    return () => {
      cancelled = true;
      if (!committed && active) {
        disposeSessionEnvironment(active, 'app session environment').catch(
          () => undefined,
        );
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
