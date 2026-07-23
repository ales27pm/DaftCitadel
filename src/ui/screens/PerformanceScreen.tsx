import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  StatusBadge,
  StudioButton,
  StudioHeader,
  StudioIcon,
  StudioPanel,
  StudioText,
  TransportBar,
  useTheme,
  type StudioTone,
} from '../design-system';
import { useAdaptiveLayout } from '../layout';
import {
  useProjectedTransport,
  useSessionViewModel,
  useTransportControls,
} from '../session';
import { useUserPreferences } from '../settings';
import { JunoMidiLooperPanel } from './JunoMidiLooperPanel';

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingBottom: 28 },
  content: {
    alignSelf: 'center',
    gap: 16,
    width: '100%',
  },
  statePanel: {
    alignItems: 'center',
    alignSelf: 'stretch',
    gap: 6,
  },
  stateCopy: { maxWidth: 440, textAlign: 'center' },
  diagnostics: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  diagnosticsCopy: { flex: 1, minWidth: 180 },
  errorPanel: { gap: 4 },
});

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

export const PerformanceScreen: React.FC = () => {
  const theme = useTheme();
  const adaptive = useAdaptiveLayout();
  const {
    status,
    sessionName,
    transport,
    tracks,
    diagnostics,
    refresh,
    error: sessionError,
  } = useSessionViewModel();
  const transportControls = useTransportControls();
  const activeTransport = transportControls.transport ?? transport;
  const { projectedBeats } = useProjectedTransport(activeTransport);
  const { preferences } = useUserPreferences();
  const [actionError, setActionError] = useState<string>();
  const [isRetryingSession, setIsRetryingSession] = useState(false);
  const sessionRetryInFlightRef = useRef(false);

  const contentStyle = useMemo<ViewStyle>(
    () => ({
      maxWidth: Math.min(adaptive.maxContentWidth, 960),
      padding: adaptive.contentPadding,
    }),
    [adaptive.contentPadding, adaptive.maxContentWidth],
  );

  const readiness = useMemo<{ label: string; tone: StudioTone }>(() => {
    if (status !== 'ready') {
      return { label: 'Connecting', tone: 'secondary' };
    }
    if (!transportControls.isAvailable) {
      return { label: 'Audio unavailable', tone: 'warning' };
    }
    if (!transportControls.isLoopAvailable) {
      return { label: 'Update dev build', tone: 'warning' };
    }
    if (transportControls.isPlaying) {
      return { label: 'Looping', tone: 'mint' };
    }
    return { label: 'Ready', tone: 'cyan' };
  }, [
    status,
    transportControls.isAvailable,
    transportControls.isLoopAvailable,
    transportControls.isPlaying,
  ]);

  const handlePlay = useCallback(() => {
    setActionError(undefined);
    transportControls.play().catch((error) => {
      setActionError(errorMessage(error, 'Unable to start transport.'));
    });
  }, [transportControls]);

  const handleStop = useCallback(() => {
    setActionError(undefined);
    transportControls.stop().catch((error) => {
      setActionError(errorMessage(error, 'Unable to stop transport.'));
    });
  }, [transportControls]);

  const handleRewind = useCallback(() => {
    setActionError(undefined);
    transportControls.locateStart().catch((error) => {
      setActionError(errorMessage(error, 'Unable to rewind transport.'));
    });
  }, [transportControls]);

  const handleSessionRetry = useCallback(async () => {
    if (sessionRetryInFlightRef.current) {
      return;
    }
    sessionRetryInFlightRef.current = true;
    setIsRetryingSession(true);
    try {
      await refresh();
    } catch {
      // The session view model exposes the refreshed load error.
    } finally {
      sessionRetryInFlightRef.current = false;
      setIsRetryingSession(false);
    }
  }, [refresh]);

  const diagnosticsSummary = useMemo(() => {
    if (diagnostics.status === 'error') {
      return diagnostics.error?.message
        ? `Diagnostics error: ${diagnostics.error.message}`
        : 'Diagnostics unavailable due to an error.';
    }
    if (diagnostics.status === 'unavailable') {
      return 'Audio diagnostics unavailable.';
    }
    if (diagnostics.status !== 'ready') {
      return 'Gathering audio diagnostics…';
    }
    const renderLoad = Number.isFinite(diagnostics.renderLoad)
      ? Math.round(Math.max(0, Math.min(1, diagnostics.renderLoad)) * 100)
      : 0;
    return `${diagnostics.xruns} XRuns · ${renderLoad}% engine load`;
  }, [diagnostics]);

  const diagnosticsTone: StudioTone =
    diagnostics.status === 'error'
      ? 'critical'
      : diagnostics.status === 'unavailable'
        ? 'warning'
        : 'secondary';

  const renderSessionState = () => {
    if (status === 'error') {
      return (
        <StudioPanel
          accessibilityLabel="Performance unavailable"
          accessibilityRole="alert"
          padding={14}
          style={styles.statePanel}
          variant="subtle"
        >
          <StudioIcon color={theme.colors.statusCritical} name="diagnostics" size={24} />
          <StudioText variant="body" tone="critical" weight="bold">
            Performance session unavailable
          </StudioText>
          <StudioText
            selectable
            variant="caption"
            tone="critical"
            style={styles.stateCopy}
          >
            {sessionError?.message ?? 'The current session could not be loaded.'}
          </StudioText>
          <StudioButton
            accessibilityHint="Attempts to load the current session again"
            compact
            label="Retry"
            loading={isRetryingSession}
            onPress={() => {
              handleSessionRetry().catch(() => undefined);
            }}
          />
        </StudioPanel>
      );
    }

    if (status !== 'ready') {
      return (
        <StudioPanel
          accessibilityLabel="Performance loading"
          accessibilityRole="progressbar"
          padding={14}
          style={styles.statePanel}
          variant="subtle"
        >
          <StudioIcon color={theme.colors.accentTertiary} name="engine" size={24} />
          <StudioText variant="body" weight="bold">
            Preparing the scene launcher
          </StudioText>
          <StudioText variant="caption" tone="secondary" style={styles.stateCopy}>
            Restoring the shared session and native audio transport…
          </StudioText>
        </StudioPanel>
      );
    }

    return (
      <JunoMidiLooperPanel
        autoPlayScenes={preferences.autoPlayScenes}
        bpm={activeTransport?.bpm ?? 120}
        status={status}
        timeSignature={activeTransport?.timeSignature ?? '4/4'}
        tracks={tracks}
      />
    );
  };

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.background }]}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        contentInsetAdjustmentBehavior="automatic"
      >
        <View style={[styles.content, contentStyle]}>
          <StudioHeader
            compact={adaptive.isLandscape}
            eyebrow={sessionName ?? 'Live session'}
            title="Perform"
            detail="Layer Juno parts, record takes, and launch synchronized scene variations."
            actions={
              <StatusBadge icon="engine" label={readiness.label} tone={readiness.tone} />
            }
          />

          <TransportBar
            bpm={activeTransport?.bpm ?? 0}
            compact={adaptive.breakpoint === 'phone'}
            isAvailable={transportControls.isAvailable}
            isPlaying={transportControls.isPlaying}
            onPlay={handlePlay}
            onRewind={handleRewind}
            onStop={handleStop}
            positionBeats={projectedBeats}
            sessionName={sessionName}
            timeSignature={activeTransport?.timeSignature ?? '4/4'}
          />

          {renderSessionState()}

          {preferences.showDiagnostics ? (
            <StudioPanel padding={12} variant="subtle">
              <View accessibilityLabel="Audio diagnostics" style={styles.diagnostics}>
                <StatusBadge icon="diagnostics" label="Engine" tone={diagnosticsTone} />
                <StudioText
                  selectable
                  variant="caption"
                  tone={diagnosticsTone}
                  style={styles.diagnosticsCopy}
                >
                  {diagnosticsSummary} · {projectedBeats.toFixed(2)} beats
                </StudioText>
              </View>
            </StudioPanel>
          ) : null}

          {actionError ? (
            <StudioPanel
              accessibilityLabel="Transport error"
              accessibilityRole="alert"
              padding={12}
              style={styles.errorPanel}
              variant="subtle"
            >
              <StudioText variant="label" tone="critical" weight="bold">
                Transport action failed
              </StudioText>
              <StudioText selectable variant="caption" tone="critical">
                {actionError}
              </StudioText>
            </StudioPanel>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};
