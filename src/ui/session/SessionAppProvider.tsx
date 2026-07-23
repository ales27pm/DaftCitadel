import React, { PropsWithChildren, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';

import { isNativeModuleAvailable } from '../../audio';
import {
  darkTokens,
  StudioButton,
  StudioIcon,
  StudioPanel,
  StudioText,
  ThemeProvider,
} from '../design-system';
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
const NATIVE_BRIDGE_DEV_FLAG = 'EXPO_PUBLIC_DAFT_CITADEL_USE_NATIVE_BRIDGE';

const getNativeBridgeDevelopmentOverride = (): boolean | undefined => {
  if (typeof process === 'undefined') {
    return undefined;
  }
  const value = process.env.EXPO_PUBLIC_DAFT_CITADEL_USE_NATIVE_BRIDGE;
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return undefined;
};

const isTestRuntime = (): boolean =>
  typeof process !== 'undefined' && process.env.NODE_ENV === 'test';

const shouldAttemptProductionEnvironment = (): boolean => {
  const isNativePlatform = Platform.OS === 'ios' || Platform.OS === 'android';
  if (!isNativePlatform) {
    return false;
  }

  const developmentOverride = getNativeBridgeDevelopmentOverride();
  if (developmentOverride === false) {
    return false;
  }

  // Release builds always exercise the production bootstrap so a missing native
  // binding is reported through its normal fallback. In development, the local
  // AudioEngine module is the reliable distinction between a custom dev client
  // and Expo Go. Jest remains passive unless a test explicitly opts in.
  return (
    !__DEV__ ||
    developmentOverride === true ||
    (!isTestRuntime() && isNativeModuleAvailable())
  );
};

const styles = StyleSheet.create({
  bootstrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
  },
  bootstrapPanel: {
    alignItems: 'center',
    gap: 12,
    maxWidth: 460,
    width: '100%',
  },
  centeredCopy: {
    textAlign: 'center',
  },
});

export const SessionAppProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const [environment, setEnvironment] = useState<SessionEnvironment | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);

  useSessionEnvironmentLifecycle(environment, {
    context: APP_ENVIRONMENT_CONTEXT,
  });

  useEffect(() => {
    let cancelled = false;
    const shouldUseProduction = shouldAttemptProductionEnvironment();

    if (__DEV__ && shouldUseProduction) {
      const override = getNativeBridgeDevelopmentOverride();
      console.info(
        override === true
          ? `Using production native bridge via ${NATIVE_BRIDGE_DEV_FLAG}.`
          : 'Using production native bridge from the custom development client.',
      );
    }

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
    setBootstrapAttempt((attempt) => attempt + 1);
  }, []);

  if (error) {
    return (
      <ThemeProvider scheme="dark">
        <View
          style={[styles.bootstrap, { backgroundColor: darkTokens.colors.background }]}
          accessibilityRole="alert"
        >
          <StudioPanel style={styles.bootstrapPanel}>
            <StudioIcon
              name="diagnostics"
              color={darkTokens.colors.statusCritical}
              size={30}
            />
            <StudioText variant="sectionTitle" tone="critical" weight="bold">
              Daft Citadel could not start
            </StudioText>
            <StudioText selectable tone="secondary" style={styles.centeredCopy}>
              {error.message}
            </StudioText>
            <StudioButton
              accessibilityHint="Retries session and audio initialization"
              icon="engine"
              label="Try again"
              onPress={retryBootstrap}
              variant="primary"
            />
          </StudioPanel>
        </View>
      </ThemeProvider>
    );
  }

  if (!environment) {
    return (
      <ThemeProvider scheme="dark">
        <View
          style={[styles.bootstrap, { backgroundColor: darkTokens.colors.background }]}
          accessibilityRole="progressbar"
        >
          <StudioPanel style={styles.bootstrapPanel}>
            <ActivityIndicator color={darkTokens.colors.accentPrimary} size="large" />
            <StudioText variant="sectionTitle" weight="bold">
              Preparing Daft Citadel
            </StudioText>
            <StudioText tone="secondary" style={styles.centeredCopy}>
              Loading your session and audio environment…
            </StudioText>
          </StudioPanel>
        </View>
      </ThemeProvider>
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
  if (!shouldUseProduction) {
    if (Platform.OS === 'web') {
      console.info('Using passive session environment for web platform.');
    } else if (__DEV__) {
      console.info(
        'Using passive session environment because native audio is unavailable or disabled.',
      );
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
