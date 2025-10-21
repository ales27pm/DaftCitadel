import React, { useCallback, useEffect, useMemo } from 'react';
import { SafeAreaView, ScrollView, View } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';

import { MidiPianoRoll, WaveformEditor } from '../editors';
import { NeonSurface, NeonText, NeonToolbar } from '../design-system';
import { useAdaptiveLayout } from '../layout';
import { useSessionViewModel } from '../session';

export const ArrangementScreen: React.FC = () => {
  const adaptive = useAdaptiveLayout();
  const { status, tracks, transport, refresh, diagnostics } = useSessionViewModel();
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
  const contentStyle = useMemo(
    () => ({
      paddingHorizontal: adaptive.breakpoint === 'phone' ? 16 : 32,
      paddingBottom: adaptive.breakpoint === 'desktop' ? 48 : 24,
    }),
    [adaptive.breakpoint],
  );
  const waveformCardStyle = useMemo(() => ({ marginBottom: 24 }), []);
  const summaryStyle = useMemo(() => ({ marginTop: 12 }), []);
  const automationStyle = useMemo(() => ({ marginTop: 8 }), []);
  const diagnosticsStyle = useMemo(() => ({ marginTop: 12 }), []);
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

  const handleRefresh = useCallback(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

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
          <NeonText variant="body" intent="secondary" style={diagnosticsStyle}>
            XRuns: {diagnostics.xruns} • Render load:{' '}
            {(diagnostics.renderLoad * 100).toFixed(0)}%
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
        <NeonToolbar
          title="Arrangement"
          actions={[{ label: 'Refresh', onPress: handleRefresh, intent: 'secondary' }]}
        />
        <View accessibilityRole="summary">{renderContent()}</View>
      </ScrollView>
    </SafeAreaView>
  );
};
