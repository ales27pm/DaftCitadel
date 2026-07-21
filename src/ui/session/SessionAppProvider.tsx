import React, { PropsWithChildren, useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

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

const styles = StyleSheet.create({
  bootstrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
    backgroundColor: '#080A12',
  },
  title: {
    color: '#F7F8FF',
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  message: {
    color: '#AEB4CC',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  retryButton: {
    minHeight: 44,
    minWidth: 120,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingHorizontal: 20,
    backgroundColor: '#50E3C2',
  },
  retryLabel: {
    color: '#080A12',
    fontSize: 16,
    fontWeight: '700',
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
    const shouldUseProduction =
      !__DEV__ && (Platform.OS === 'ios' || Platform.OS === 'android');

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
      <View style={styles.bootstrap} accessibilityRole="alert">
        <Text style={styles.title}>Daft Citadel could not start</Text>
        <Text style={styles.message} selectable>
          {error.message}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityHint="Retries session and audio initialization"
          onPress={retryBootstrap}
          style={styles.retryButton}
        >
          <Text style={styles.retryLabel}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (!environment) {
    return (
      <View style={styles.bootstrap} accessibilityRole="progressbar">
        <ActivityIndicator color="#50E3C2" size="large" />
        <Text style={styles.title}>Preparing Daft Citadel</Text>
        <Text style={styles.message}>Loading your session and audio environment…</Text>
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
