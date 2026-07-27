import React, { PropsWithChildren, useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

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
    const shouldUseProduction = !__DEV__;

    const bootstrap = async () => {
      try {
        const created = await bootstrapEnvironment(shouldUseProduction);
        if (cancelled) {
          await disposeSessionEnvironment(created, APP_ENVIRONMENT_CONTEXT);
          return;
        }
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
    };
  }, []);

  if (error) {
    return (
      <View style={styles.bootstrapErrorContainer}>
        <Text style={styles.bootstrapErrorTitle}>Session unavailable</Text>
        <Text style={styles.bootstrapErrorBody}>{error.message}</Text>
      </View>
    );
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
  const isWebBridgeDisabled =
    Platform.OS === 'web' &&
    resolveWebNativeBridgePreference() === false;
  if (isWebBridgeDisabled) {
    if (__DEV__) {
      console.info('Forcing passive session environment due web preview setting.');
    } else {
      console.info('Forcing passive session environment for web preview mode.');
    }
    return createPassiveSessionEnvironment();
  }

  if (!shouldUseProduction) {
    if (__DEV__) {
      console.info('Using passive session environment for development build.');
    }
    return createPassiveSessionEnvironment();
  }
  try {
    return await createProductionSessionEnvironment();
  } catch (error) {
    if (shouldUseProduction) {
      if (error instanceof NativeAudioUnavailableError) {
        throw new NativeAudioUnavailableError(
          `Native audio engine is required for release builds: ${error.message}`,
        );
      }
      console.error('Failed to bootstrap production session environment.', error);
      throw error;
    }
    console.error('Failed to bootstrap production session environment.', error);
    return createPassiveSessionEnvironment();
  }
};

const resolveWebNativeBridgePreference = (): boolean | undefined => {
  if (typeof process === 'undefined' || typeof process.env === 'undefined') {
    return undefined;
  }
  const raw = process.env.EXPO_PUBLIC_DAFT_CITADEL_USE_NATIVE_BRIDGE;
  if (raw === undefined) {
    return undefined;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === '' || normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return undefined;
};

const styles = StyleSheet.create({
  bootstrapErrorContainer: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  bootstrapErrorTitle: {
    color: '#111111',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  bootstrapErrorBody: {
    color: '#444444',
    fontSize: 14,
    textAlign: 'center',
  },
});
