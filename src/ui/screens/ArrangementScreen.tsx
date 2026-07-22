import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  SectionHeader,
  StatusBadge,
  StudioButton,
  StudioHeader,
  StudioIcon,
  StudioPanel,
  StudioText,
  TransportBar,
  useTheme,
} from '../design-system';
import { MidiPianoRoll, WaveformEditor } from '../editors';
import { useAdaptiveLayout } from '../layout';
import {
  type TrackViewModel,
  useProjectedTransport,
  useSessionActions,
  useSessionViewModel,
  useTransportControls,
} from '../session';
import { formatAlertTimestamp } from '../utils/date';

const EmptyTimeline: React.FC = () => {
  const theme = useTheme();
  return (
    <View
      accessibilityLabel="Empty timeline"
      style={{
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceVariant,
        borderColor: theme.colors.border,
        borderCurve: 'continuous',
        borderRadius: theme.radii.md,
        borderWidth: 1,
        gap: 8,
        justifyContent: 'center',
        minHeight: 156,
        overflow: 'hidden',
        padding: 20,
      }}
    >
      <View
        accessible={false}
        style={{
          bottom: 0,
          flexDirection: 'row',
          gap: 28,
          left: 0,
          opacity: 0.4,
          position: 'absolute',
          right: 0,
          top: 0,
        }}
      >
        {Array.from({ length: 14 }, (_, index) => (
          <View key={index} style={{ backgroundColor: theme.colors.border, width: 1 }} />
        ))}
      </View>
      <StudioIcon name="waveform" color={theme.colors.textTertiary} size={28} />
      <StudioText variant="label" weight="bold">
        This track has no clips yet
      </StudioText>
      <StudioText variant="caption" tone="secondary" style={{ textAlign: 'center' }}>
        The channel and routing are ready. Clip editing will appear here when content is
        available.
      </StudioText>
    </View>
  );
};

const TrackRailItem: React.FC<{
  track: TrackViewModel;
  selected: boolean;
  onPress: () => void;
}> = ({ track, selected, onPress }) => {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${track.name}, ${track.clips.length} clips`}
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: selected
          ? theme.colors.surfaceElevated
          : pressed
            ? theme.colors.surfacePressed
            : 'transparent',
        borderColor: selected ? theme.colors.accentPrimary : 'transparent',
        borderCurve: 'continuous',
        borderRadius: theme.radii.md,
        borderWidth: 1,
        gap: 4,
        minHeight: 64,
        paddingHorizontal: 12,
        paddingVertical: 9,
      })}
    >
      <View style={{ alignItems: 'center', flexDirection: 'row', gap: 8 }}>
        <View
          style={{
            backgroundColor: track.color ?? theme.colors.accentTertiary,
            borderRadius: theme.radii.pill,
            height: 8,
            width: 8,
          }}
        />
        <StudioText variant="label" weight="bold" numberOfLines={1}>
          {track.name}
        </StudioText>
      </View>
      <StudioText variant="caption" tone="secondary">
        {track.clips.length} {track.clips.length === 1 ? 'clip' : 'clips'} ·{' '}
        {track.volumeDb.toFixed(1)} dB
      </StudioText>
    </Pressable>
  );
};

export const ArrangementScreen: React.FC = () => {
  const theme = useTheme();
  const adaptive = useAdaptiveLayout();
  const { status, sessionName, tracks, transport, diagnostics, pluginAlerts, error } =
    useSessionViewModel();
  const sessionActions = useSessionActions();
  const transportControls = useTransportControls();
  const effectiveTransport = transportControls.transport ?? transport;
  const { projectedBeats, projectedRatio } = useProjectedTransport(effectiveTransport);
  const [selectedTrackId, setSelectedTrackId] = useState<string>();
  const [isAddingTrack, setIsAddingTrack] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const selectedTrack = useMemo(
    () => tracks.find((track) => track.id === selectedTrackId) ?? tracks[0],
    [selectedTrackId, tracks],
  );

  const diagnosticsSummary = useMemo(() => {
    if (diagnostics.status === 'ready') {
      return `Engine ${Math.round(diagnostics.renderLoad * 100)}% · ${diagnostics.xruns} xruns`;
    }
    if (diagnostics.status === 'error') {
      return diagnostics.error?.message ?? 'Audio diagnostics failed';
    }
    if (diagnostics.status === 'unavailable') {
      return 'Audio diagnostics unavailable';
    }
    return 'Checking audio engine';
  }, [diagnostics]);

  const automationSummary = useMemo(() => {
    if (!selectedTrack || selectedTrack.automationCurves.length === 0) {
      return 'No automation lanes';
    }
    return selectedTrack.automationCurves
      .map((curve) => `${curve.parameter} · ${curve.points.length} points`)
      .join('   ');
  }, [selectedTrack]);

  const runTransportAction = useCallback(async (action: () => Promise<void>) => {
    setActionError(undefined);
    try {
      await action();
    } catch (transportError) {
      setActionError(
        transportError instanceof Error
          ? transportError.message
          : 'Transport action failed',
      );
    }
  }, []);

  const handleAddTrack = useCallback(async () => {
    setActionError(undefined);
    setIsAddingTrack(true);
    try {
      const updated = await sessionActions.addTrack();
      setSelectedTrackId(updated.tracks[updated.tracks.length - 1]?.id);
    } catch (addError) {
      setActionError(
        addError instanceof Error ? addError.message : 'Unable to add a track',
      );
    } finally {
      setIsAddingTrack(false);
    }
  }, [sessionActions]);

  const timelineWidth = Math.max(
    280,
    Math.min(
      adaptive.workspaceMode === 'studio'
        ? adaptive.width - adaptive.contentPadding * 2 - 320
        : adaptive.width - adaptive.contentPadding * 2 - 34,
      820,
    ),
  );

  const renderEmptyState = () => (
    <StudioPanel
      accessibilityLabel="Empty session"
      style={{ alignItems: 'flex-start', gap: 14, minHeight: 232 }}
    >
      <View
        style={{
          alignItems: 'center',
          backgroundColor: theme.colors.surfaceVariant,
          borderRadius: theme.radii.md,
          height: 46,
          justifyContent: 'center',
          width: 46,
        }}
      >
        <StudioIcon name="waveform" color={theme.colors.accentTertiary} size={24} />
      </View>
      <View style={{ gap: 6, maxWidth: 520 }}>
        <StudioText variant="sectionTitle" weight="bold">
          Shape your first track
        </StudioText>
        <StudioText variant="body" tone="secondary">
          Add a routed channel to begin arranging this session. Your transport and audio
          engine are already prepared.
        </StudioText>
      </View>
      <StudioButton
        label="Add first track"
        icon="plus"
        variant="primary"
        loading={isAddingTrack}
        onPress={() => {
          handleAddTrack().catch(() => undefined);
        }}
      />
      <StatusBadge
        icon="engine"
        label={
          transportControls.isAvailable ? 'Audio engine ready' : 'Audio engine offline'
        }
        tone={transportControls.isAvailable ? 'mint' : 'warning'}
      />
    </StudioPanel>
  );

  const renderTrackRail = () => (
    <StudioPanel
      style={{
        flexBasis: adaptive.workspaceMode === 'studio' ? 272 : undefined,
        flexGrow: 0,
        gap: 12,
        minWidth: adaptive.workspaceMode === 'studio' ? 252 : 0,
      }}
    >
      <SectionHeader
        title="Tracks"
        detail={`${tracks.length} ${tracks.length === 1 ? 'channel' : 'channels'}`}
        accessory={
          <StudioButton
            compact
            label="Add track"
            icon="plus"
            variant="ghost"
            loading={isAddingTrack}
            onPress={() => {
              handleAddTrack().catch(() => undefined);
            }}
          />
        }
      />
      <View style={{ gap: 6 }}>
        {tracks.map((track) => (
          <TrackRailItem
            key={track.id}
            track={track}
            selected={track.id === selectedTrack?.id}
            onPress={() => setSelectedTrackId(track.id)}
          />
        ))}
      </View>
    </StudioPanel>
  );

  const renderTimeline = () => {
    if (!selectedTrack) {
      return null;
    }
    return (
      <StudioPanel style={{ flex: 1, gap: 16, minWidth: 0 }}>
        <SectionHeader
          title="Timeline overview"
          detail={`${selectedTrack.name} · ${Math.round(effectiveTransport?.bpm ?? 0)} BPM · ${effectiveTransport?.timeSignature ?? '4/4'}`}
          accessory={
            <StatusBadge
              label={effectiveTransport?.isPlaying ? 'Playing' : 'Ready'}
              tone={effectiveTransport?.isPlaying ? 'mint' : 'secondary'}
            />
          }
        />
        {selectedTrack.clips.length === 0 ? (
          <EmptyTimeline />
        ) : (
          <View style={{ gap: 14 }}>
            <WaveformEditor
              waveform={selectedTrack.waveform}
              width={timelineWidth}
              playhead={projectedRatio}
            />
            {selectedTrack.midiNotes.length > 0 ? (
              <View style={{ gap: 8 }}>
                <View style={{ alignItems: 'center', flexDirection: 'row', gap: 8 }}>
                  <StudioIcon
                    name="midi"
                    color={theme.colors.accentSecondary}
                    size={17}
                  />
                  <StudioText variant="label" weight="bold">
                    MIDI overview
                  </StudioText>
                </View>
                <MidiPianoRoll
                  notes={selectedTrack.midiNotes}
                  totalBars={effectiveTransport?.totalBars ?? 4}
                  pixelsPerBeat={adaptive.workspaceMode === 'studio' ? 56 : 44}
                  style={{ height: adaptive.workspaceMode === 'studio' ? 280 : 220 }}
                />
              </View>
            ) : null}
          </View>
        )}
        <View
          style={{
            borderTopColor: theme.colors.border,
            borderTopWidth: 1,
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 14,
            paddingTop: 12,
          }}
        >
          <StudioText variant="caption" tone="secondary">
            {automationSummary}
          </StudioText>
          <StudioText
            variant="caption"
            tone={diagnostics.status === 'error' ? 'critical' : 'muted'}
          >
            {diagnosticsSummary}
          </StudioText>
        </View>
      </StudioPanel>
    );
  };

  const renderContent = () => {
    if (status === 'loading' || status === 'idle') {
      return (
        <StudioPanel style={{ gap: 8 }}>
          <StudioText variant="sectionTitle" weight="bold">
            Preparing arrangement
          </StudioText>
          <StudioText tone="secondary">
            Loading the active session and audio graph.
          </StudioText>
        </StudioPanel>
      );
    }
    if (status === 'error') {
      return (
        <StudioPanel accessibilityRole="alert" style={{ gap: 10 }}>
          <StudioText variant="sectionTitle" tone="critical" weight="bold">
            Session unavailable
          </StudioText>
          <StudioText selectable tone="secondary">
            {error?.message ?? 'The active session could not be loaded.'}
          </StudioText>
        </StudioPanel>
      );
    }
    if (tracks.length === 0) {
      return renderEmptyState();
    }
    return (
      <View
        style={{
          alignItems: 'stretch',
          flexDirection: adaptive.workspaceMode === 'studio' ? 'row' : 'column',
          gap: 16,
          minWidth: 0,
        }}
      >
        {renderTrackRail()}
        {renderTimeline()}
      </View>
    );
  };

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={{ flex: 1, backgroundColor: theme.colors.background }}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          alignSelf: 'center',
          gap: 16,
          maxWidth: adaptive.maxContentWidth,
          padding: adaptive.contentPadding,
          paddingBottom: 28,
          width: '100%',
        }}
      >
        <StudioHeader
          compact={adaptive.isLandscape}
          eyebrow="Studio Console"
          title="Arrangement"
          detail={sessionName ?? 'Untitled Session'}
        />
        <TransportBar
          compact={adaptive.workspaceMode === 'deck'}
          sessionName={sessionName}
          bpm={effectiveTransport?.bpm ?? 0}
          timeSignature={effectiveTransport?.timeSignature ?? '4/4'}
          positionBeats={projectedBeats}
          isPlaying={transportControls.isPlaying}
          isAvailable={transportControls.isAvailable}
          onPlay={() => {
            runTransportAction(transportControls.play).catch(() => undefined);
          }}
          onStop={() => {
            runTransportAction(transportControls.stop).catch(() => undefined);
          }}
          onRewind={() => {
            runTransportAction(transportControls.locateStart).catch(() => undefined);
          }}
        />
        {actionError ? (
          <StudioPanel accessibilityRole="alert" variant="subtle" style={{ gap: 4 }}>
            <StudioText variant="label" tone="critical" weight="bold">
              Action failed
            </StudioText>
            <StudioText selectable variant="caption" tone="secondary">
              {actionError}
            </StudioText>
          </StudioPanel>
        ) : null}
        {pluginAlerts.map((alert) => (
          <StudioPanel
            key={`${alert.instanceId}:${alert.timestamp}`}
            accessibilityRole="alert"
            variant="subtle"
            style={{ gap: 4 }}
          >
            <StudioText
              variant="label"
              tone={alert.recovered ? 'success' : 'critical'}
              weight="bold"
            >
              {alert.recovered ? 'Plugin recovered' : 'Plugin needs attention'} ·{' '}
              {alert.descriptor?.name ?? alert.instanceId}
            </StudioText>
            <StudioText selectable variant="caption" tone="secondary">
              {formatAlertTimestamp(alert.timestamp)} · {alert.reason}
            </StudioText>
          </StudioPanel>
        ))}
        {renderContent()}
      </ScrollView>
    </SafeAreaView>
  );
};
