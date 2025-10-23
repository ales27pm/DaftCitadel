import React, { useCallback, useEffect, useMemo } from 'react';
import { SafeAreaView, ScrollView, View } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';

import { MidiPianoRoll, WaveformEditor } from '../editors';
import {
  NeonSurface,
  NeonText,
  NeonToolbar,
  type NeonToolbarProps,
} from '../design-system';
import { useAdaptiveLayout } from '../layout';
import { useSessionViewModel, useTransportControls } from '../session';

export const ArrangementScreen: React.FC = () => {
  const adaptive = useAdaptiveLayout();
  const { status, tracks, transport, refresh, diagnostics, pluginAlerts } =
    useSessionViewModel();
  const transportControls = useTransportControls();
  const arrangementTrack = useMemo(
    () => tracks.find((track) => track.waveform.length > 0) ?? tracks[0],
    [tracks],
  );
  const midiSourceTrack = useMemo(
    () => tracks.find((track) => track.midiNotes.length > 0) ?? arrangementTrack,
    [arrangementTrack, tracks],
  );
  const waveform = arrangementTrack?.waveform ?? new Float32Array(0);
  const playhead = useSharedValue(0.25);
  const safeAreaStyle = useMemo(() => ({ flex: 1 }), []);
  const contentHorizontalPadding = adaptive.breakpoint === 'phone' ? 16 : 32;
  const contentStyle = useMemo(
    () => ({
      paddingHorizontal: contentHorizontalPadding,
      paddingBottom: adaptive.breakpoint === 'desktop' ? 48 : 24,
    }),
    [adaptive.breakpoint, contentHorizontalPadding],
  );
  const alertsContainerStyle = useMemo(
    () => ({
      paddingHorizontal: contentHorizontalPadding,
      marginBottom: 12,
    }),
    [contentHorizontalPadding],
  );
  const waveformCardStyle = useMemo(() => ({ marginBottom: 24 }), []);
  const summaryStyle = useMemo(() => ({ marginTop: 12 }), []);
  const automationStyle = useMemo(() => ({ marginTop: 8 }), []);
  const diagnosticsStyle = useMemo(() => ({ marginTop: 12 }), []);
  const alertSurfaceStyle = useMemo(() => ({ marginBottom: 12 }), []);
  const diagnosticsSummary = useMemo(() => {
    if (diagnostics.status === 'ready') {
      const renderPercent = Number.isFinite(diagnostics.renderLoad)
        ? `${Math.round(diagnostics.renderLoad * 100)}%`
        : '0%';
      const clipBytes = diagnostics.clipBufferBytes ?? 0;
      const clipInfo =
        clipBytes > 0 ? ` • Clip buffers: ${(clipBytes / 1024).toFixed(0)} KB` : '';
      return `XRuns: ${diagnostics.xruns} • Render load: ${renderPercent}${clipInfo}`;
    }
    if (diagnostics.status === 'error') {
      return `Diagnostics error: ${diagnostics.error?.message ?? 'Unknown failure.'}`;
    }
    if (diagnostics.status === 'unavailable') {
      return 'Audio diagnostics unavailable.';
    }
    return 'Gathering audio diagnostics...';
  }, [diagnostics]);
  const diagnosticsIntent =
    diagnostics.status === 'error' ? 'critical' : ('secondary' as const);
  const pluginAlertViews = useMemo(
    () =>
      pluginAlerts.map((alert) => {
        const label = alert.descriptor?.name ?? alert.instanceId;
        const timestamp = new Date(alert.timestamp).toLocaleString();
        const recoveryNote = alert.recovered ? ' • Recovered' : '';
        return (
          <NeonSurface
            key={`${alert.instanceId}:${alert.timestamp}`}
            intent="critical"
            style={alertSurfaceStyle}
          >
            <NeonText variant="body" weight="medium" intent="critical">
              Plugin crash: {label}
            </NeonText>
            <NeonText variant="caption" intent="secondary">
              {timestamp} • {alert.reason}
              {recoveryNote}
            </NeonText>
          </NeonSurface>
        );
      }),
    [alertSurfaceStyle, pluginAlerts],
  );
  const totalBars = transport?.totalBars ?? 4;
  const midiNotes = midiSourceTrack?.midiNotes ?? [];
  const automationSummary = useMemo(() => {
    if (!arrangementTrack) {
      return 'No automation lanes in this session yet.';
    }
    if (arrangementTrack.automationCurves.length === 0) {
      return 'Automation curves are not configured for this track.';
    }
    return arrangementTrack.automationCurves
      .map((curve) => `${curve.parameter} (${curve.points.length} pts)`)
      .join(' • ');
  }, [arrangementTrack]);

  useEffect(() => {
    if (transport) {
      playhead.value = transport.playheadRatio;
    }
  }, [playhead, transport]);

  const handlePlay = useCallback(() => {
    transportControls.play().catch((error) => {
      console.error('Failed to start transport playback', error);
    });
  }, [transportControls]);

  const handleStop = useCallback(() => {
    transportControls.stop().catch((error) => {
      console.error('Failed to stop transport playback', error);
    });
  }, [transportControls]);

  const handleRewind = useCallback(() => {
    transportControls.locateStart().catch((error) => {
      console.error('Failed to rewind transport', error);
    });
  }, [transportControls]);

  const handleRefresh = useCallback(() => {
    refresh().catch((error) => {
      console.error('Failed to refresh session data', error);
    });
  }, [refresh]);

  const toolbarActions = useMemo<NonNullable<NeonToolbarProps['actions']>>(
    () => [
      {
        label: 'Play',
        onPress: handlePlay,
        intent: 'primary',
        disabled: !transportControls.isAvailable || transport?.isPlaying,
      },
      {
        label: 'Stop',
        onPress: handleStop,
        intent: 'secondary',
        disabled: !transportControls.isAvailable || !transport?.isPlaying,
      },
      {
        label: 'Rewind',
        onPress: handleRewind,
        intent: 'secondary',
        disabled: !transportControls.isAvailable,
      },
      {
        label: 'Refresh',
        onPress: handleRefresh,
        intent: 'secondary',
      },
    ],
    [
      handlePlay,
      handleRefresh,
      handleRewind,
      handleStop,
      transport?.isPlaying,
      transportControls.isAvailable,
    ],
  );

  const renderContent = () => {
    if (status === 'loading' || status === 'idle') {
      return (
        <NeonSurface>
          <NeonText variant="body">Loading arrangement...</NeonText>
        </NeonSurface>
      );
    }
    if (status === 'error') {
      return (
        <NeonSurface>
          <NeonText variant="body" intent="critical">
            Failed to load session data.
          </NeonText>
        </NeonSurface>
      );
    }
    if (!arrangementTrack) {
      return (
        <NeonSurface>
          <NeonText variant="body">No tracks available in this session.</NeonText>
        </NeonSurface>
      );
    }

    return (
      <View style={contentStyle}>
        <NeonSurface style={waveformCardStyle}>
          <NeonText variant="headline" weight="bold">
            Waveform Overview
          </NeonText>
          <NeonText variant="body" intent="secondary" style={summaryStyle}>
            {`${arrangementTrack.name} • ${arrangementTrack.clips.length} clips • ${transport?.bpm ?? 0} BPM ${transport?.timeSignature ?? ''}`}
          </NeonText>
          <WaveformEditor
            waveform={waveform}
            width={adaptive.breakpoint === 'phone' ? 320 : 640}
            playhead={playhead}
          />
          <NeonText variant="body" style={automationStyle}>
            Automation: {automationSummary}
          </NeonText>
          <NeonText variant="body" intent={diagnosticsIntent} style={diagnosticsStyle}>
            {diagnosticsSummary}
          </NeonText>
        </NeonSurface>
        <NeonSurface>
          <NeonText variant="title" weight="medium">
            MIDI Piano Roll
          </NeonText>
          <MidiPianoRoll
            notes={midiNotes}
            totalBars={totalBars}
            pixelsPerBeat={adaptive.breakpoint === 'phone' ? 48 : 64}
          />
        </NeonSurface>
      </View>
    );
  };

  return (
    <SafeAreaView style={safeAreaStyle}>
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        <NeonToolbar title="Arrangement" actions={toolbarActions} />
        {pluginAlertViews.length > 0 && (
          <View style={alertsContainerStyle}>{pluginAlertViews}</View>
        )}
        <View accessibilityRole="summary">{renderContent()}</View>
      </ScrollView>
    </SafeAreaView>
  );
};
