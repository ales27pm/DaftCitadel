import React, { PropsWithChildren, useCallback, useEffect, useState } from 'react';
import { Platform, View } from 'react-native';

import { isNativeModuleAvailable } from '../../audio';
import { ScreenState, useTheme } from '../design-system';
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
  const theme = useTheme();
  const [environment, setEnvironment] = useState<SessionEnvironment | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);

  useSessionEnvironmentLifecycle(environment, {
    context: APP_ENVIRONMENT_CONTEXT,
  });

  useEffect(() => {
    let cancelled = false;
    const bridgePreference = resolveNativeBridgePreference();
    const forcePassiveDevelopmentPreview = __DEV__ && bridgePreference === false;
    const shouldUseProduction =
      !forcePassiveDevelopmentPreview &&
      (!__DEV__ || (Platform.OS !== 'web' && isNativeModuleAvailable()));

    const bootstrap = async () => {
      setError(null);
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
  }, [bootstrapAttempt]);

  const retryBootstrap = useCallback(() => {
    setEnvironment(null);
    setError(null);
    setBootstrapAttempt((attempt) => attempt + 1);
  }, []);

  if (error) {
    return (
      <View
        style={{
          alignItems: 'center',
          backgroundColor: theme.colors.background,
          flex: 1,
          justifyContent: 'center',
          padding: theme.spacing.lg,
        }}
      >
        <View style={{ maxWidth: 520, width: '100%' }}>
          <ScreenState
            actionLabel="Try again"
            kind="error"
            message={error.message}
            onAction={retryBootstrap}
            title="Session unavailable"
          />
        </View>
      </View>
    );
  }

  if (!environment) {
    return (
      <View
        style={{
          alignItems: 'center',
          backgroundColor: theme.colors.background,
          flex: 1,
          justifyContent: 'center',
          padding: theme.spacing.lg,
        }}
      >
        <View style={{ maxWidth: 520, width: '100%' }}>
          <ScreenState
            kind="loading"
            message="Starting the audio session and restoring your workspace."
            title="Preparing Daft Citadel"
          />
        </View>
      </View>
    );
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
    Platform.OS === 'web' && resolveNativeBridgePreference() === false;
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

const resolveNativeBridgePreference = (): boolean | undefined => {
  if (typeof process === 'undefined' || typeof process.env === 'undefined') {
    return undefined;
  }
  const raw = process.env.EXPO_PUBLIC_DAFT_CITADEL_USE_NATIVE_BRIDGE;
  if (raw === undefined) {
    return undefined;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (
    normalized === '' ||
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on'
  ) {
    return true;
  }
  if (
    normalized === '0' ||
    normalized === 'false' ||
    normalized === 'no' ||
    normalized === 'off'
  ) {
    return false;
  }
  return undefined;
};
