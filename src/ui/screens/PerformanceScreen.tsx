import React, { useCallback, useRef, useState } from 'react';
import { Image } from 'expo-image';
import { ScrollView, StyleSheet, View } from 'react-native';

import {
  AnimatedSignal,
  ScreenScaffold,
  SegmentedControl,
  StatusBadge,
  StudioAlertText,
  StudioButton,
  StudioPanel,
  StudioText,
  TransportBar,
} from '../design-system';
import { useAdaptiveLayout } from '../layout';
import {
  useProjectedTransport,
  useSessionViewModel,
  useTransportControls,
} from '../session';
import { useUserPreferences } from '../settings';
import { JunoMidiLooperPanel } from './JunoMidiLooperPanel';
import { JunoPerformancePanel } from './JunoPerformancePanel';

type PerformanceMode = 'instrument' | 'scenes';

const PERFORMANCE_MODES: ReadonlyArray<{
  value: PerformanceMode;
  label: string;
  icon: 'instrument' | 'scenes';
}> = [
  {
    value: 'instrument',
    label: 'Instrument',
    icon: 'instrument',
  },
  {
    value: 'scenes',
    label: 'Scenes',
    icon: 'scenes',
  },
];

const formatError = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

const safeTempo = (bpm: number | undefined): number =>
  Number.isFinite(bpm) && (bpm ?? 0) > 0 ? Math.round(bpm ?? 120) : 120;

const safeRenderLoadPercent = (renderLoad: number): number => {
  if (!Number.isFinite(renderLoad)) {
    return 0;
  }
  return Math.round(Math.min(1, Math.max(0, renderLoad)) * 100);
};

export interface PerformanceScreenProps {
  isActive?: boolean;
}

export const PerformanceScreen: React.FC<PerformanceScreenProps> = ({
  isActive = true,
}) => {
  const adaptive = useAdaptiveLayout();
  const { status, sessionName, transport, tracks, diagnostics, error, refresh } =
    useSessionViewModel();
  const transportControls = useTransportControls();
  const { preferences } = useUserPreferences();
  const { projectedBeats } = useProjectedTransport(transport);
  const [mode, setMode] = useState<PerformanceMode>('scenes');
  const [actionError, setActionError] = useState<string>();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const screenScrollRef = useRef<ScrollView>(null);

  const bpm = safeTempo(transport?.bpm);
  const timeSignature = transport?.timeSignature?.trim() || '4/4';
  const positionBeats =
    Number.isFinite(projectedBeats) && projectedBeats >= 0 ? projectedBeats : 0;

  const runTransportAction = useCallback(
    (action: () => Promise<void>, fallback: string) => {
      setActionError(undefined);
      action().catch((actionFailure) => {
        setActionError(formatError(actionFailure, fallback));
      });
    },
    [],
  );

  const handlePlay = useCallback(() => {
    runTransportAction(transportControls.play, 'Unable to start playback.');
  }, [runTransportAction, transportControls.play]);

  const handleStop = useCallback(() => {
    runTransportAction(transportControls.stop, 'Unable to stop playback.');
  }, [runTransportAction, transportControls.stop]);

  const handleRewind = useCallback(() => {
    runTransportAction(transportControls.locateStart, 'Unable to rewind playback.');
  }, [runTransportAction, transportControls.locateStart]);

  const handleRefresh = useCallback(() => {
    if (isRefreshing) {
      return;
    }
    setActionError(undefined);
    setIsRefreshing(true);
    refresh()
      .catch((refreshFailure) => {
        setActionError(formatError(refreshFailure, 'Unable to refresh the session.'));
      })
      .finally(() => {
        setIsRefreshing(false);
      });
  }, [isRefreshing, refresh]);

  const handleModeChange = useCallback(
    (nextMode: PerformanceMode) => {
      if (nextMode === mode) {
        return;
      }
      setActionError(undefined);
      screenScrollRef.current?.scrollTo({ animated: false, y: 0 });
      setMode(nextMode);
    },
    [mode],
  );

  const renderSessionState = () => {
    if (status === 'error') {
      const sessionError = formatError(
        error,
        'The performance session could not be loaded.',
      );
      return (
        <StudioPanel padding={16} testID="performance-session-error" variant="raised">
          <View style={styles.stateCopy}>
            <StudioText variant="sectionTitle" tone="critical" weight="bold">
              Performance unavailable
            </StudioText>
            <StudioAlertText
              announcement={`Performance unavailable. ${sessionError}`}
              selectable
              testID="performance-session-error-announcement"
              tone="secondary"
              variant="body"
            >
              {sessionError}
            </StudioAlertText>
          </View>
          <StudioButton
            accessibilityHint="Attempts to load the performance session again"
            label={isRefreshing ? 'Retrying…' : 'Retry'}
            disabled={isRefreshing}
            onPress={handleRefresh}
            style={styles.stateAction}
            variant="primary"
          />
        </StudioPanel>
      );
    }

    const idle = status === 'idle';
    return (
      <StudioPanel
        accessibilityLabel={
          idle ? 'Performance session waiting to load' : 'Performance session loading'
        }
        accessibilityLiveRegion="polite"
        padding={16}
        role="status"
        testID="performance-session-loading"
        variant="subtle"
      >
        <StatusBadge
          icon="engine"
          label={idle ? 'Waiting' : 'Loading'}
          tone={idle ? 'secondary' : 'cyan'}
        />
        <View style={styles.stateCopy}>
          <StudioText variant="sectionTitle" weight="bold">
            {idle ? 'Preparing performance' : 'Loading performance'}
          </StudioText>
          <StudioText variant="body" tone="secondary">
            {idle
              ? 'Waiting for the session engine to start.'
              : 'Connecting the 120 BPM · 4/4 transport and restoring your tracks.'}
          </StudioText>
        </View>
      </StudioPanel>
    );
  };

  const diagnosticsStatus =
    diagnostics.status === 'ready'
      ? `${Number.isFinite(diagnostics.xruns) ? Math.max(0, Math.round(diagnostics.xruns)) : 0} XRuns · ${safeRenderLoadPercent(diagnostics.renderLoad)}% render load`
      : diagnostics.status === 'loading'
        ? 'Reading audio engine diagnostics…'
        : diagnostics.status === 'error'
          ? formatError(diagnostics.error, 'Audio engine diagnostics failed.')
          : 'Audio engine diagnostics are unavailable in this build.';
  const diagnosticsTone =
    diagnostics.status === 'error'
      ? 'critical'
      : diagnostics.status === 'ready'
        ? 'mint'
        : diagnostics.status === 'unavailable'
          ? 'warning'
          : 'cyan';
  const showDiagnosticsPanel =
    preferences.showDiagnostics && diagnostics.status !== 'unavailable';

  return (
    <ScreenScaffold
      actions={
        <StudioButton
          compact
          accessibilityHint="Reloads the active session and audio engine state"
          disabled={isRefreshing}
          icon="refresh"
          label={isRefreshing ? 'Refreshing…' : 'Refresh'}
          onPress={handleRefresh}
          variant="ghost"
        />
      }
      scrollViewRef={screenScrollRef}
      testID="performance-screen"
      title="Performance"
    >
      {mode === 'scenes' ? (
        <View style={styles.signalHeader} testID="performance-signal-shell">
          <Image
            accessible={false}
            contentFit="cover"
            source={require('../../../assets/ui/performance-signal-header.webp')}
            style={StyleSheet.absoluteFillObject}
            testID="performance-signal-header"
          />
          <AnimatedSignal
            enabled={isActive}
            height={104}
            style={styles.signalVector}
            testID="performance-signal-motion"
          />
        </View>
      ) : null}

      {status !== 'ready' ? (
        renderSessionState()
      ) : (
        <>
          <TransportBar
            bpm={bpm}
            compact={adaptive.breakpoint === 'phone'}
            isAvailable={transportControls.isAvailable}
            isPlaying={transportControls.isPlaying}
            onPlay={handlePlay}
            onRewind={handleRewind}
            onStop={handleStop}
            positionBeats={positionBeats}
            sessionName={sessionName}
            timeSignature={timeSignature}
          />

          {actionError ? (
            <StudioPanel
              padding={12}
              testID="performance-action-error"
              variant="critical"
            >
              <StudioText variant="label" tone="critical" weight="bold">
                Performance action failed
              </StudioText>
              <StudioAlertText
                announcement={`Performance action failed. ${actionError}`}
                selectable
                testID="performance-action-error-announcement"
                tone="critical"
                variant="caption"
              >
                {actionError}
              </StudioAlertText>
            </StudioPanel>
          ) : null}

          <View testID="performance-mode-switch">
            <SegmentedControl
              accessibilityLabel="Performance mode"
              onChange={handleModeChange}
              options={PERFORMANCE_MODES}
              value={mode}
            />
          </View>

          <View
            accessibilityLabel={
              mode === 'instrument'
                ? 'Instrument performance controls'
                : 'Scene performance controls'
            }
            nativeID={`performance-${mode}-panel`}
            role="tabpanel"
            style={styles.workspace}
            testID={`performance-${mode}-panel`}
          >
            {mode === 'instrument' ? (
              <JunoPerformancePanel status={status} tracks={tracks} />
            ) : (
              <JunoMidiLooperPanel
                autoPlayScenes={preferences.autoPlayScenes}
                bpm={bpm}
                status={status}
                timeSignature={timeSignature}
                tracks={tracks}
              />
            )}
          </View>

          {showDiagnosticsPanel ? (
            <StudioPanel
              accessibilityLabel={
                diagnostics.status === 'error'
                  ? undefined
                  : `Audio engine diagnostics. ${diagnosticsStatus}`
              }
              accessibilityLiveRegion={
                diagnostics.status === 'error' ? undefined : 'polite'
              }
              padding={12}
              role={diagnostics.status === 'error' ? undefined : 'status'}
              style={styles.diagnostics}
              testID="performance-diagnostics"
              variant="subtle"
            >
              <View style={styles.diagnosticsCopy}>
                <StudioText variant="caption" tone="muted" weight="bold">
                  AUDIO ENGINE
                </StudioText>
                {diagnostics.status === 'error' ? (
                  <StudioAlertText
                    announcement={`Audio engine diagnostics failed. ${diagnosticsStatus}`}
                    selectable
                    testID="performance-diagnostics-error-announcement"
                    tone={diagnosticsTone}
                    variant="label"
                    weight="medium"
                  >
                    {diagnosticsStatus}
                  </StudioAlertText>
                ) : (
                  <StudioText
                    selectable
                    tone={diagnosticsTone}
                    variant="label"
                    weight="medium"
                  >
                    {diagnosticsStatus}
                  </StudioText>
                )}
              </View>
              <StatusBadge
                icon="diagnostics"
                label={diagnostics.status === 'ready' ? 'Live' : diagnostics.status}
                tone={diagnosticsTone}
              />
            </StudioPanel>
          ) : null}
        </>
      )}
    </ScreenScaffold>
  );
};

const styles = StyleSheet.create({
  signalHeader: {
    alignSelf: 'stretch',
    aspectRatio: 4,
    borderRadius: 12,
    maxHeight: 104,
    minHeight: 72,
    opacity: 0.72,
    overflow: 'hidden',
    position: 'relative',
  },
  signalVector: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  stateCopy: {
    gap: 4,
    marginTop: 12,
  },
  stateAction: {
    marginTop: 16,
  },
  diagnostics: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  diagnosticsCopy: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  workspace: {
    gap: 12,
  },
});
