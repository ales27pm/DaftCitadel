import React, { useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { useNavigation, type NavigationProp } from '@react-navigation/native';

import { MidiPianoRoll, WaveformEditor } from '../editors';
import {
  ScreenScaffold,
  ScreenState,
  StudioButton,
  StudioPanel,
  StudioText,
  TransportBar,
  useTheme,
} from '../design-system';
import { useAdaptiveLayout } from '../layout';
import type { AppTabParamList } from '../navigation/tab-spec';
import {
  useProjectedTransport,
  useSessionViewModel,
  useTransportControls,
} from '../session';

export const resolveArrangementWaveformWidth = (
  viewportWidth: number,
  horizontalPadding: number,
): number => Math.max(160, Math.min(640, viewportWidth - horizontalPadding * 2 - 32));

const formatDiagnostics = (
  diagnostics: ReturnType<typeof useSessionViewModel>['diagnostics'],
): string => {
  if (diagnostics.status === 'ready') {
    const renderPercent = Number.isFinite(diagnostics.renderLoad)
      ? `${Math.round(diagnostics.renderLoad * 100)}%`
      : 'Unavailable';
    const clipBytes = diagnostics.clipBufferBytes ?? 0;
    const clipInfo =
      clipBytes > 0 ? ` · Clip buffers ${(clipBytes / 1024).toFixed(0)} KB` : '';
    return `${diagnostics.xruns} XRuns · ${renderPercent} render load${clipInfo}`;
  }
  if (diagnostics.status === 'error') {
    return `Diagnostics error · ${diagnostics.error?.message ?? 'Unknown failure'}`;
  }
  if (diagnostics.status === 'unavailable') {
    return 'Audio diagnostics unavailable';
  }
  return 'Gathering audio diagnostics';
};

export const ArrangementScreen: React.FC = () => {
  const adaptive = useAdaptiveLayout();
  const theme = useTheme();
  const navigation = useNavigation<NavigationProp<AppTabParamList>>();
  const {
    diagnostics,
    error,
    pluginAlerts,
    refresh,
    sessionName,
    status,
    tracks,
    transport,
  } = useSessionViewModel();
  const transportControls = useTransportControls();
  const { projectedRatio } = useProjectedTransport(transport);

  const arrangementTrack = useMemo(
    () => tracks.find((track) => track.waveform.length > 0) ?? tracks[0],
    [tracks],
  );
  const midiSourceTrack = useMemo(
    () => tracks.find((track) => track.midiNotes.length > 0) ?? arrangementTrack,
    [arrangementTrack, tracks],
  );
  const contentWidth = Math.min(
    adaptive.maxContentWidth,
    adaptive.width - adaptive.contentPadding * 2,
  );
  const waveformWidth = resolveArrangementWaveformWidth(contentWidth, theme.spacing.md);
  const waveform = arrangementTrack?.waveform ?? new Float32Array(0);
  const playhead = transport ? projectedRatio : 0;
  const midiNotes = midiSourceTrack?.midiNotes ?? [];
  const totalBars = transport?.totalBars ?? 4;
  const diagnosticsSummary = useMemo(() => formatDiagnostics(diagnostics), [diagnostics]);
  const automationSummary = useMemo(() => {
    if (!arrangementTrack) {
      return 'No automation lanes yet';
    }
    if (arrangementTrack.automationCurves.length === 0) {
      return 'No automation configured';
    }
    return arrangementTrack.automationCurves
      .map((curve) => `${curve.parameter} (${curve.points.length} points)`)
      .join(' · ');
  }, [arrangementTrack]);

  const handlePlay = useCallback(() => {
    transportControls.play().catch((transportError) => {
      console.error('Failed to start transport playback', transportError);
    });
  }, [transportControls]);

  const handleStop = useCallback(() => {
    transportControls.stop().catch((transportError) => {
      console.error('Failed to stop transport playback', transportError);
    });
  }, [transportControls]);

  const handleRewind = useCallback(() => {
    transportControls.locateStart().catch((transportError) => {
      console.error('Failed to rewind transport', transportError);
    });
  }, [transportControls]);

  const handleRefresh = useCallback(() => {
    refresh().catch((refreshError) => {
      console.error('Failed to refresh session data', refreshError);
    });
  }, [refresh]);

  const openPerformance = useCallback(() => {
    navigation.navigate('Performance');
  }, [navigation]);

  const headerAction = (
    <StudioButton
      compact
      icon="refresh"
      label="Refresh"
      onPress={handleRefresh}
      variant="ghost"
    />
  );

  const renderState = () => {
    if (status === 'loading' || status === 'idle') {
      return (
        <ScreenState
          kind="loading"
          message="Loading tracks, clips, and transport state."
          title="Preparing arrangement"
        />
      );
    }
    if (status === 'error') {
      return (
        <ScreenState
          actionLabel="Try again"
          kind="error"
          message={error?.message ?? 'The session could not be loaded.'}
          onAction={handleRefresh}
          title="Arrangement unavailable"
        />
      );
    }
    if (!arrangementTrack) {
      return (
        <ScreenState
          actionLabel="Open Performance"
          illustrationSource={require('../../../assets/ui/signal-flow-empty-state.webp')}
          kind="empty"
          message="Add a Juno-106 instrument, then return here to arrange clips and MIDI."
          onAction={openPerformance}
          title="Start with an instrument"
        />
      );
    }

    return (
      <>
        <StudioPanel style={{ gap: theme.spacing.md }}>
          <View style={{ gap: theme.spacing.xs }}>
            <StudioText accessibilityRole="header" variant="sectionTitle" weight="bold">
              Waveform overview
            </StudioText>
            <StudioText selectable tone="secondary">
              {`${arrangementTrack.name} · ${arrangementTrack.clips.length} clips · ${
                transport
                  ? `${Math.round(transport.bpm)} BPM ${transport.timeSignature}`
                  : 'Transport unavailable'
              }`}
            </StudioText>
          </View>
          <WaveformEditor
            height={adaptive.breakpoint === 'phone' ? 112 : 152}
            playhead={playhead}
            waveform={waveform}
            width={waveformWidth}
          />
          <View style={{ gap: theme.spacing.xs }}>
            <StudioText selectable tone="secondary">
              {`Automation · ${automationSummary}`}
            </StudioText>
            <StudioText
              selectable
              tone={diagnostics.status === 'error' ? 'critical' : 'muted'}
            >
              {diagnosticsSummary}
            </StudioText>
          </View>
        </StudioPanel>

        <StudioPanel style={{ gap: theme.spacing.md }}>
          <View style={{ gap: theme.spacing.xs }}>
            <StudioText accessibilityRole="header" variant="sectionTitle" weight="bold">
              MIDI piano roll
            </StudioText>
            <StudioText selectable tone="secondary">
              {midiNotes.length > 0
                ? `${midiNotes.length} notes across ${totalBars} bars`
                : 'Record or add MIDI in Performance to populate this track.'}
            </StudioText>
          </View>
          {midiNotes.length > 0 ? (
            <MidiPianoRoll
              notes={midiNotes}
              pixelsPerBeat={adaptive.breakpoint === 'phone' ? 48 : 64}
              style={{ height: adaptive.breakpoint === 'phone' ? 280 : 360 }}
              timeSignature={transport?.timeSignature}
              totalBars={totalBars}
            />
          ) : null}
        </StudioPanel>
      </>
    );
  };

  return (
    <ScreenScaffold actions={headerAction} title="Arrangement">
      {status === 'ready' && arrangementTrack ? (
        <TransportBar
          bpm={transport?.bpm}
          compact={adaptive.breakpoint === 'phone'}
          isAvailable={transportControls.isAvailable && tracks.length > 0}
          isPlaying={Boolean(transport?.isPlaying)}
          onPlay={handlePlay}
          onRewind={handleRewind}
          onStop={handleStop}
          positionBeats={transport?.playheadBeats}
          sessionName={sessionName}
          timeSignature={transport?.timeSignature}
        />
      ) : null}

      {pluginAlerts.map((alert) => {
        const label = alert.descriptor?.name ?? alert.instanceId;
        const recovery = alert.recovered ? ' · Recovered' : '';
        return (
          <StudioPanel
            key={`${alert.instanceId}:${alert.timestamp}`}
            accessibilityRole="alert"
            style={{ gap: theme.spacing.xs }}
            variant="critical"
          >
            <StudioText variant="label" tone="critical" weight="bold">
              {`Plugin crash · ${label}`}
            </StudioText>
            <StudioText selectable tone="critical">
              {`${alert.reason}${recovery}`}
            </StudioText>
          </StudioPanel>
        );
      })}

      {renderState()}
    </ScreenScaffold>
  );
};
