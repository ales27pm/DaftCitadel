import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { MidiNoteEvent } from '../../session';

import {
  SectionHeader,
  StatusBadge,
  StudioButton,
  StudioIcon,
  StudioPanel,
  StudioText,
  useTheme,
  type StudioIconName,
  type StudioTone,
} from '../design-system';
import { MidiStepSequencer } from '../editors';
import { useAdaptiveLayout } from '../layout';
import {
  type TrackViewModel,
  useInstrumentControls,
  useProjectedTransport,
  useSessionActions,
  useSessionViewModel,
  useTransportControls,
} from '../session';
import { formatAlertTimestamp } from '../utils/date';

const RULER_BAR_COUNT = 4;

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { borderBottomWidth: 1 },
  headerInner: {
    alignItems: 'center',
    alignSelf: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    width: '100%',
  },
  headerCopy: { flex: 1, minWidth: 0 },
  brand: {
    letterSpacing: 3,
  },
  headerStatus: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  statusDot: { borderRadius: 4, height: 8, width: 8 },
  transportBorder: { borderTopWidth: StyleSheet.hairlineWidth },
  transport: {
    alignItems: 'center',
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 8,
    minHeight: 64,
    paddingHorizontal: 12,
    paddingVertical: 8,
    width: '100%',
  },
  transportCompact: {
    flexWrap: 'wrap',
    minHeight: 0,
  },
  transportMetric: {
    alignItems: 'center',
    borderRadius: 6,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 42,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  positionMetric: { minWidth: 74 },
  bpmMetric: { minWidth: 54 },
  transportControls: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    marginLeft: 'auto',
  },
  transportControlsCompact: {
    justifyContent: 'flex-end',
    marginLeft: 0,
    width: '100%',
  },
  transportButton: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  playButton: {
    borderRadius: 24,
    borderWidth: 2,
    height: 48,
    width: 48,
  },
  ruler: { borderBottomWidth: 1, height: 24 },
  rulerInner: {
    alignSelf: 'center',
    flexDirection: 'row',
    height: '100%',
    paddingHorizontal: 76,
    width: '100%',
  },
  rulerInnerCompact: { paddingHorizontal: 12 },
  rulerBeat: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  body: { flex: 1, minHeight: 0 },
  scrollContent: {
    alignSelf: 'center',
    gap: 10,
    paddingBottom: 104,
    paddingTop: 8,
    width: '100%',
  },
  trackList: { gap: 6 },
  trackRow: {
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 64,
    overflow: 'hidden',
  },
  trackSelect: {
    alignItems: 'center',
    alignSelf: 'stretch',
    flex: 1,
    flexDirection: 'row',
    minWidth: 0,
  },
  trackColorBar: { alignSelf: 'stretch', width: 4 },
  trackInfo: {
    flexBasis: 96,
    minWidth: 76,
    paddingLeft: 10,
    paddingRight: 6,
  },
  miniWaveform: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 1.5,
    height: 32,
    minWidth: 0,
    overflow: 'hidden',
  },
  miniWaveformBar: { borderRadius: 1, width: 2.5 },
  emptyWaveform: {
    alignItems: 'center',
    borderRadius: 6,
    borderStyle: 'dashed',
    borderWidth: 1,
    flex: 1,
    height: 32,
    justifyContent: 'center',
  },
  trackControls: {
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 8,
  },
  trackControl: {
    alignItems: 'center',
    borderRadius: 6,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  statePanel: {
    alignItems: 'center',
    gap: 8,
    justifyContent: 'center',
    minHeight: 180,
  },
  stateBadge: { alignSelf: 'center' },
  stateCopy: { maxWidth: 420, textAlign: 'center' },
  timelinePanel: { gap: 14, marginTop: 4, minWidth: 0 },
  clipTabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  editorActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  inspector: { gap: 10 },
  inspectorRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  inspectorCopy: { flex: 1, minWidth: 160 },
  compactButton: { minWidth: 44, paddingHorizontal: 10 },
  emptyTimeline: {
    alignItems: 'center',
    borderRadius: 8,
    borderStyle: 'dashed',
    borderWidth: 1,
    gap: 6,
    justifyContent: 'center',
    minHeight: 122,
    overflow: 'hidden',
    padding: 18,
  },
  emptyTimelineAction: { alignSelf: 'center', marginTop: 4 },
  timelineGrid: {
    bottom: 0,
    flexDirection: 'row',
    gap: 28,
    left: 0,
    opacity: 0.4,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  timelineGridLine: { width: 1 },
  editorStack: { gap: 14, minWidth: 0 },
  midiHeader: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  timelineFooter: {
    borderTopWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
    paddingTop: 10,
  },
  alertPanel: { gap: 4 },
  floatingActions: {
    alignItems: 'center',
    bottom: 12,
    flexDirection: 'row',
    gap: 10,
    position: 'absolute',
    right: 16,
  },
  soloWarning: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  addButton: {
    alignItems: 'center',
    borderRadius: 26,
    height: 52,
    justifyContent: 'center',
    width: 52,
  },
});

const parseTimeSignature = (
  timeSignature: string,
): { denominator: number; numerator: number } => {
  const [rawNumerator, rawDenominator] = timeSignature.split('/');
  const parsedNumerator = Number.parseInt(rawNumerator ?? '', 10);
  const parsedDenominator = Number.parseInt(rawDenominator ?? '', 10);
  return {
    numerator:
      Number.isFinite(parsedNumerator) && parsedNumerator > 0 ? parsedNumerator : 4,
    denominator:
      Number.isFinite(parsedDenominator) && parsedDenominator > 0 ? parsedDenominator : 4,
  };
};

const formatPosition = (positionBeats: number, timeSignature: string): string => {
  const safeBeats = Number.isFinite(positionBeats) ? Math.max(0, positionBeats) : 0;
  const { denominator, numerator } = parseTimeSignature(timeSignature);
  const signatureBeats = safeBeats * (denominator / 4);
  const bar = Math.floor((signatureBeats + Number.EPSILON) / numerator) + 1;
  const beat = Math.floor((signatureBeats + Number.EPSILON) % numerator) + 1;
  const tick = Math.floor((signatureBeats % 1) * 96)
    .toString()
    .padStart(2, '0');
  return `${bar}.${beat}.${tick}`;
};

const MiniWaveform: React.FC<{ track: TrackViewModel }> = ({ track }) => {
  const theme = useTheme();
  const bars = useMemo(() => {
    const pattern = Array.from({ length: 16 }, () => 0);
    track.midiNotes.forEach((note) => {
      const index =
        ((Math.round(note.start * 4) % pattern.length) + pattern.length) % pattern.length;
      pattern[index] = Math.max(pattern[index] ?? 0, note.velocity / 127);
    });
    return pattern;
  }, [track.midiNotes]);
  const barStyles = useMemo(
    () =>
      bars.map(
        (amplitude): ViewStyle => ({
          backgroundColor: track.color ?? theme.colors.waveform,
          height: Math.max(3, amplitude * 28),
          opacity: track.muted ? 0.2 : 0.5 + amplitude * 0.5,
        }),
      ),
    [bars, theme.colors.waveform, track.color, track.muted],
  );

  if (track.clips.length === 0 || track.midiNotes.length === 0) {
    return (
      <View
        accessible={false}
        style={[styles.emptyWaveform, { borderColor: theme.colors.border }]}
      >
        <StudioText variant="caption" tone="muted" weight="bold">
          {track.clips.length === 0
            ? 'NO CLIPS'
            : track.clips.some((clip) => clip.audioFile)
              ? `${track.clips.length} AUDIO ${track.clips.length === 1 ? 'CLIP' : 'CLIPS'}`
              : 'EMPTY PATTERN'}
        </StudioText>
      </View>
    );
  }

  return (
    <View accessible={false} style={styles.miniWaveform}>
      {bars.map((_amplitude, index) => (
        <View key={index} style={[styles.miniWaveformBar, barStyles[index]]} />
      ))}
    </View>
  );
};

interface TransportButtonProps {
  accessibilityLabel: string;
  active?: boolean;
  disabled?: boolean;
  icon: StudioIconName;
  primary?: boolean;
  onPress: () => void;
}

const TransportButton: React.FC<TransportButtonProps> = ({
  accessibilityLabel,
  active = false,
  disabled = false,
  icon,
  primary = false,
  onPress,
}) => {
  const theme = useTheme();
  const foreground = primary
    ? active
      ? theme.colors.accentPrimaryInk
      : theme.colors.accentPrimary
    : active
      ? theme.colors.accentTertiary
      : theme.colors.textSecondary;
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected: active }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.transportButton,
        primary && styles.playButton,
        {
          backgroundColor: primary
            ? active
              ? theme.colors.accentPrimary
              : theme.colors.surfaceElevated
            : active
              ? theme.colors.surfacePressed
              : theme.colors.surfaceElevated,
          borderColor: primary
            ? theme.colors.accentPrimary
            : active
              ? theme.colors.accentTertiary
              : theme.colors.border,
          opacity: disabled ? 0.45 : pressed ? 0.78 : 1,
        },
      ]}
    >
      <StudioIcon color={foreground} name={icon} size={primary ? 21 : 16} />
    </Pressable>
  );
};

interface TrackRowProps {
  onPress: () => void;
  onToggleMute: () => void;
  onToggleSolo: () => void;
  pendingAction?: string;
  selected: boolean;
  track: TrackViewModel;
}

const TrackRow: React.FC<TrackRowProps> = ({
  onPress,
  onToggleMute,
  onToggleSolo,
  pendingAction,
  selected,
  track,
}) => {
  const theme = useTheme();
  const trackPending = pendingAction?.startsWith(`${track.id}:`) === true;

  return (
    <View
      style={[
        styles.trackRow,
        {
          backgroundColor: selected ? theme.colors.surfaceElevated : theme.colors.surface,
          borderColor: selected ? theme.colors.accentPrimary : theme.colors.border,
          opacity: track.muted ? 0.65 : 1,
        },
      ]}
    >
      <View
        accessible={false}
        style={[
          styles.trackColorBar,
          { backgroundColor: track.color ?? theme.colors.accentTertiary },
        ]}
      />
      <Pressable
        accessibilityLabel={`${track.name}, ${track.clips.length} clips`}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onPress={onPress}
        style={({ pressed }) => [styles.trackSelect, { opacity: pressed ? 0.76 : 1 }]}
      >
        <View style={styles.trackInfo}>
          <StudioText variant="caption" weight="bold" numberOfLines={1}>
            {track.name}
          </StudioText>
          <StudioText variant="caption" tone="muted" numberOfLines={1}>
            {track.clips.length} {track.clips.length === 1 ? 'clip' : 'clips'} ·{' '}
            {track.volumeDb.toFixed(1)} dB
          </StudioText>
        </View>
        <MiniWaveform track={track} />
      </Pressable>
      <View style={styles.trackControls}>
        <Pressable
          accessibilityLabel={`${track.muted ? 'Unmute' : 'Mute'} ${track.name}`}
          accessibilityRole="button"
          accessibilityState={{ disabled: trackPending, selected: track.muted }}
          disabled={trackPending}
          onPress={onToggleMute}
          style={({ pressed }) => [
            styles.trackControl,
            {
              backgroundColor: track.muted
                ? theme.colors.surfacePressed
                : theme.colors.surfaceElevated,
              borderColor: track.muted ? theme.colors.statusWarning : theme.colors.border,
              opacity: pressed ? 0.76 : 1,
            },
          ]}
        >
          {pendingAction === `${track.id}:mute` ? (
            <ActivityIndicator color={theme.colors.statusWarning} size="small" />
          ) : (
            <StudioText
              variant="caption"
              weight="bold"
              style={{
                color: track.muted
                  ? theme.colors.statusWarning
                  : theme.colors.textTertiary,
              }}
            >
              M
            </StudioText>
          )}
        </Pressable>
        <Pressable
          accessibilityLabel={`${track.solo ? 'Unsolo' : 'Solo'} ${track.name}`}
          accessibilityRole="button"
          accessibilityState={{ disabled: trackPending, selected: track.solo }}
          disabled={trackPending}
          onPress={onToggleSolo}
          style={({ pressed }) => [
            styles.trackControl,
            {
              backgroundColor: track.solo
                ? theme.colors.surfacePressed
                : theme.colors.surfaceElevated,
              borderColor: track.solo ? theme.colors.accentTertiary : theme.colors.border,
              opacity: pressed ? 0.76 : 1,
            },
          ]}
        >
          {pendingAction === `${track.id}:solo` ? (
            <ActivityIndicator color={theme.colors.accentTertiary} size="small" />
          ) : (
            <StudioText
              variant="caption"
              weight="bold"
              style={{
                color: track.solo
                  ? theme.colors.accentTertiary
                  : theme.colors.textTertiary,
              }}
            >
              S
            </StudioText>
          )}
        </Pressable>
      </View>
    </View>
  );
};

interface EmptyTimelineProps {
  canCreateMidiClip: boolean;
  isCreatingMidiClip: boolean;
  onCreateMidiClip: () => void;
}

const EmptyTimeline: React.FC<EmptyTimelineProps> = ({
  canCreateMidiClip,
  isCreatingMidiClip,
  onCreateMidiClip,
}) => {
  const theme = useTheme();
  return (
    <View
      accessibilityLabel="Empty timeline"
      style={[
        styles.emptyTimeline,
        {
          backgroundColor: theme.colors.surfaceVariant,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <View accessible={false} style={styles.timelineGrid}>
        {Array.from({ length: 14 }, (_unused, index) => (
          <View
            key={index}
            style={[styles.timelineGridLine, { backgroundColor: theme.colors.border }]}
          />
        ))}
      </View>
      <StudioIcon name="waveform" color={theme.colors.textTertiary} size={26} />
      <StudioText variant="label" weight="bold">
        This track has no clips yet
      </StudioText>
      <StudioText variant="caption" tone="secondary" style={styles.stateCopy}>
        {canCreateMidiClip
          ? 'Create an empty one-bar pattern, then tap steps to write a melody.'
          : 'Select a Juno-106 track to create a playable MIDI clip.'}
      </StudioText>
      {canCreateMidiClip ? (
        <StudioButton
          accessibilityHint="Adds an editable one-bar MIDI pattern to this Juno track"
          icon="midi"
          label="Create blank pattern"
          loading={isCreatingMidiClip}
          onPress={onCreateMidiClip}
          style={styles.emptyTimelineAction}
          variant="primary"
        />
      ) : null}
    </View>
  );
};

export const ArrangementScreen: React.FC = () => {
  const theme = useTheme();
  const adaptive = useAdaptiveLayout();
  const { status, sessionName, tracks, transport, diagnostics, pluginAlerts, error } =
    useSessionViewModel();
  const sessionActions = useSessionActions();
  const instrumentControls = useInstrumentControls();
  const transportControls = useTransportControls();
  const effectiveTransport = transportControls.transport ?? transport;
  const { projectedBeats } = useProjectedTransport(effectiveTransport);
  const [selectedTrackId, setSelectedTrackId] = useState<string>();
  const [selectedClipId, setSelectedClipId] = useState<string>();
  const [isAddingTrack, setIsAddingTrack] = useState(false);
  const [isAddingMidiClip, setIsAddingMidiClip] = useState(false);
  const [isEditingMidiClip, setIsEditingMidiClip] = useState(false);
  const [pendingTrackAction, setPendingTrackAction] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  const selectedTrack = useMemo(
    () =>
      tracks.find((track) => track.id === selectedTrackId) ??
      tracks.find((track) => track.instrument) ??
      tracks[0],
    [selectedTrackId, tracks],
  );
  const selectedClip = useMemo(
    () =>
      selectedTrack?.clips.find((clip) => clip.id === selectedClipId) ??
      selectedTrack?.clips.find((clip) => !clip.audioFile),
    [selectedClipId, selectedTrack],
  );
  const timeSignature = effectiveTransport?.timeSignature ?? '4/4';
  const meter = useMemo(() => parseTimeSignature(timeSignature), [timeSignature]);
  const compactTransport = adaptive.width < 520;
  const soloActive = tracks.some((track) => track.solo);
  const position = formatPosition(projectedBeats, timeSignature);
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
  const diagnosticsTone: StudioTone =
    diagnostics.status === 'error'
      ? 'critical'
      : diagnostics.status === 'unavailable'
        ? 'warning'
        : 'secondary';
  const automationSummary = useMemo(() => {
    if (!selectedTrack || selectedTrack.automationCurves.length === 0) {
      return 'No automation lanes';
    }
    return selectedTrack.automationCurves
      .map((curve) => `${curve.parameter} · ${curve.points.length} points`)
      .join('   ');
  }, [selectedTrack]);

  const contentStyle = useMemo<ViewStyle>(
    () => ({
      maxWidth: adaptive.maxContentWidth,
      paddingHorizontal: adaptive.workspaceMode === 'deck' ? 8 : adaptive.contentPadding,
    }),
    [adaptive.contentPadding, adaptive.maxContentWidth, adaptive.workspaceMode],
  );
  const headerContentStyle = useMemo<ViewStyle>(
    () => ({ maxWidth: adaptive.maxContentWidth }),
    [adaptive.maxContentWidth],
  );
  const selectedClipNotes = useMemo<MidiNoteEvent[]>(() => {
    if (!selectedClip) {
      return [];
    }
    const clipStartBeat =
      (selectedClip.startMs / 60000) * (effectiveTransport?.bpm ?? 120);
    const prefix = `${selectedClip.id}:`;
    return selectedClip.midiNotes.map((note, index) => ({
      id: note.id.startsWith(prefix) ? note.id.slice(prefix.length) : `note-${index + 1}`,
      pitch: note.pitch,
      startBeat: Math.max(0, note.start - clipStartBeat),
      durationBeats: note.duration,
      velocity: note.velocity,
    }));
  }, [effectiveTransport?.bpm, selectedClip]);

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
      const withTrack = await sessionActions.addJunoTrack({ name: 'Juno-106' });
      const trackId = withTrack.tracks.at(-1)?.id;
      if (!trackId) {
        throw new Error('The Juno track was not created.');
      }
      const updated = await sessionActions.addEmptyJunoMidiClip(trackId, {
        bars: 1,
        name: 'Pattern 1',
      });
      const clipId = updated.tracks
        .find((track) => track.id === trackId)
        ?.clips.at(-1)?.id;
      setSelectedTrackId(trackId);
      setSelectedClipId(clipId);
    } catch (addError) {
      setActionError(
        addError instanceof Error ? addError.message : 'Unable to add a track',
      );
    } finally {
      setIsAddingTrack(false);
    }
  }, [sessionActions]);

  const handleAddMidiClip = useCallback(async () => {
    if (!selectedTrack?.instrument) {
      return;
    }
    setActionError(undefined);
    setIsAddingMidiClip(true);
    try {
      const updated = await sessionActions.addEmptyJunoMidiClip(selectedTrack.id, {
        bars: 1,
        name: `Pattern ${selectedTrack.clips.length + 1}`,
      });
      setSelectedClipId(
        updated.tracks.find((track) => track.id === selectedTrack.id)?.clips.at(-1)?.id,
      );
    } catch (addError) {
      setActionError(
        addError instanceof Error ? addError.message : 'Unable to create a MIDI clip',
      );
    } finally {
      setIsAddingMidiClip(false);
    }
  }, [selectedTrack, sessionActions]);

  const handleMidiNotesChange = useCallback(
    async (notes: MidiNoteEvent[]) => {
      if (!selectedTrack || !selectedClip || isEditingMidiClip) {
        return;
      }
      setIsEditingMidiClip(true);
      setActionError(undefined);
      try {
        await sessionActions.setMidiClipNotes(selectedTrack.id, selectedClip.id, notes);
      } catch (editError) {
        setActionError(
          editError instanceof Error ? editError.message : 'Unable to edit this pattern',
        );
      } finally {
        setIsEditingMidiClip(false);
      }
    },
    [isEditingMidiClip, selectedClip, selectedTrack, sessionActions],
  );

  const auditionNote = useCallback(
    async (pitch: number, velocity: number, noteOff = false) => {
      const nodeId = selectedTrack?.instrument?.nodeId;
      if (!nodeId || !instrumentControls.isAvailable) {
        return;
      }
      try {
        await instrumentControls.sendInstrumentMidi(nodeId, {
          type: noteOff ? 1 : 0,
          channel: 0,
          data1: pitch,
          data2: noteOff ? 0 : velocity,
        });
      } catch (auditionError) {
        setActionError(
          auditionError instanceof Error
            ? auditionError.message
            : 'Unable to audition this note',
        );
      }
    },
    [instrumentControls, selectedTrack?.instrument?.nodeId],
  );

  const adjustTempo = useCallback(
    async (direction: -1 | 1) => {
      const current = effectiveTransport?.bpm ?? 120;
      try {
        await sessionActions.setTempo(Math.max(20, Math.min(300, current + direction)));
      } catch (tempoError) {
        setActionError(
          tempoError instanceof Error ? tempoError.message : 'Unable to change tempo',
        );
      }
    },
    [effectiveTransport?.bpm, sessionActions],
  );

  const adjustTrackVolume = useCallback(
    async (direction: -1 | 1) => {
      if (!selectedTrack) {
        return;
      }
      try {
        await sessionActions.setTrackVolume(
          selectedTrack.id,
          Math.max(-60, Math.min(12, selectedTrack.volumeDb + direction)),
        );
      } catch (volumeError) {
        setActionError(
          volumeError instanceof Error ? volumeError.message : 'Unable to change level',
        );
      }
    },
    [selectedTrack, sessionActions],
  );

  const handleTrackAction = useCallback(
    async (track: TrackViewModel, action: 'mute' | 'solo') => {
      const key = `${track.id}:${action}`;
      setPendingTrackAction(key);
      setActionError(undefined);
      try {
        if (action === 'mute') {
          await sessionActions.setTrackMuted(track.id, !track.muted);
        } else {
          await sessionActions.setTrackSolo(track.id, !track.solo);
        }
      } catch (trackError) {
        setActionError(
          trackError instanceof Error
            ? trackError.message
            : `Unable to ${action} ${track.name}`,
        );
      } finally {
        setPendingTrackAction((current) => (current === key ? undefined : current));
      }
    },
    [sessionActions],
  );

  const renderTimeline = () => {
    if (!selectedTrack) {
      return null;
    }
    return (
      <StudioPanel style={styles.timelinePanel}>
        <SectionHeader
          title="Timeline overview"
          detail={`${selectedTrack.name} · ${Math.round(effectiveTransport?.bpm ?? 0)} BPM · ${effectiveTransport?.timeSignature ?? '4/4'}`}
          accessory={
            <StatusBadge
              label={
                !transportControls.isAvailable
                  ? 'Offline'
                  : effectiveTransport?.isPlaying
                    ? 'Playing'
                    : 'Ready'
              }
              tone={
                !transportControls.isAvailable
                  ? 'warning'
                  : effectiveTransport?.isPlaying
                    ? 'mint'
                    : 'secondary'
              }
            />
          }
        />
        {!selectedClip ? (
          <EmptyTimeline
            canCreateMidiClip={Boolean(selectedTrack.instrument)}
            isCreatingMidiClip={isAddingMidiClip}
            onCreateMidiClip={() => {
              handleAddMidiClip().catch(() => undefined);
            }}
          />
        ) : (
          <View style={styles.editorStack}>
            <View style={styles.clipTabs}>
              {selectedTrack.clips
                .filter((clip) => !clip.audioFile)
                .map((clip) => (
                  <StudioButton
                    key={clip.id}
                    compact
                    accessibilityState={{ selected: clip.id === selectedClip.id }}
                    label={clip.name}
                    onPress={() => setSelectedClipId(clip.id)}
                    testID="arrangement-clip-tab"
                    variant={clip.id === selectedClip.id ? 'primary' : 'secondary'}
                  />
                ))}
              <StudioButton
                compact
                icon="plus"
                label="Pattern"
                loading={isAddingMidiClip}
                onPress={() => {
                  handleAddMidiClip().catch(() => undefined);
                }}
                testID="add-midi-pattern"
                variant="ghost"
              />
            </View>

            <MidiStepSequencer
              disabled={!selectedTrack.instrument}
              notes={selectedClipNotes}
              onAuditionEnd={(pitch) => {
                auditionNote(pitch, 0, true).catch(() => undefined);
              }}
              onAuditionStart={(pitch, velocity) => {
                auditionNote(pitch, velocity).catch(() => undefined);
              }}
              onChange={(notes) => {
                handleMidiNotesChange(notes).catch(() => undefined);
              }}
              pending={isEditingMidiClip}
            />

            <View style={styles.editorActions}>
              <StudioButton
                compact
                disabled={isEditingMidiClip || selectedClipNotes.length === 0}
                label="Clear pattern"
                onPress={() => {
                  sessionActions
                    .clearMidiClip(selectedTrack.id, selectedClip.id)
                    .catch((clearError) =>
                      setActionError(
                        clearError instanceof Error
                          ? clearError.message
                          : 'Unable to clear pattern',
                      ),
                    );
                }}
                testID="clear-midi-pattern"
                variant="danger"
              />
              <StudioButton
                compact
                label="Undo"
                onPress={() => {
                  sessionActions
                    .undo()
                    .catch((undoError) =>
                      setActionError(
                        undoError instanceof Error ? undoError.message : 'Unable to undo',
                      ),
                    );
                }}
                testID="arrangement-undo"
                variant="ghost"
              />
              <StudioButton
                compact
                label="Redo"
                onPress={() => {
                  sessionActions
                    .redo()
                    .catch((redoError) =>
                      setActionError(
                        redoError instanceof Error ? redoError.message : 'Unable to redo',
                      ),
                    );
                }}
                testID="arrangement-redo"
                variant="ghost"
              />
            </View>

            <StudioPanel padding={12} style={styles.inspector} variant="subtle">
              <View style={styles.inspectorRow}>
                <View style={styles.inspectorCopy}>
                  <StudioText variant="label" weight="bold">
                    Track inspector
                  </StudioText>
                  <StudioText variant="caption" tone="secondary">
                    {selectedTrack.name} · {selectedTrack.volumeDb.toFixed(0)} dB
                  </StudioText>
                </View>
                <StudioButton
                  compact
                  accessibilityLabel="Decrease track level"
                  disabled={selectedTrack.volumeDb <= -60}
                  label="−"
                  onPress={() => {
                    adjustTrackVolume(-1).catch(() => undefined);
                  }}
                  style={styles.compactButton}
                />
                <StudioButton
                  compact
                  accessibilityLabel="Increase track level"
                  disabled={selectedTrack.volumeDb >= 12}
                  label="+"
                  onPress={() => {
                    adjustTrackVolume(1).catch(() => undefined);
                  }}
                  style={styles.compactButton}
                />
              </View>
            </StudioPanel>
          </View>
        )}
        <View style={[styles.timelineFooter, { borderTopColor: theme.colors.border }]}>
          <StudioText variant="caption" tone="secondary">
            {automationSummary}
          </StudioText>
          <StudioText variant="caption" tone={diagnosticsTone}>
            {diagnosticsSummary}
          </StudioText>
        </View>
      </StudioPanel>
    );
  };

  const renderTrackContent = () => {
    if (status === 'loading' || status === 'idle') {
      return (
        <StudioPanel style={styles.statePanel}>
          <ActivityIndicator color={theme.colors.accentPrimary} size="large" />
          <StudioText variant="sectionTitle" weight="bold">
            Preparing arrangement
          </StudioText>
          <StudioText tone="secondary" style={styles.stateCopy}>
            Loading the active session and audio graph.
          </StudioText>
        </StudioPanel>
      );
    }
    if (status === 'error') {
      return (
        <StudioPanel accessibilityRole="alert" style={styles.statePanel}>
          <StudioIcon name="diagnostics" color={theme.colors.statusCritical} size={28} />
          <StudioText variant="sectionTitle" tone="critical" weight="bold">
            Session unavailable
          </StudioText>
          <StudioText selectable tone="secondary" style={styles.stateCopy}>
            {error?.message ?? 'The active session could not be loaded.'}
          </StudioText>
        </StudioPanel>
      );
    }
    if (tracks.length === 0) {
      return (
        <StudioPanel accessibilityLabel="Empty session" style={styles.statePanel}>
          <StudioIcon name="waveform" color={theme.colors.textTertiary} size={40} />
          <StudioText variant="sectionTitle" weight="bold">
            No tracks yet
          </StudioText>
          <StudioText variant="body" tone="secondary" style={styles.stateCopy}>
            Tap + to create a routed Juno track with an editable pattern.
          </StudioText>
          <View style={styles.stateBadge}>
            <StatusBadge
              icon="engine"
              label={
                transportControls.isAvailable
                  ? 'Audio engine ready'
                  : 'Audio engine offline'
              }
              tone={transportControls.isAvailable ? 'mint' : 'warning'}
            />
          </View>
        </StudioPanel>
      );
    }
    return (
      <>
        <View style={styles.trackList}>
          {tracks.map((track) => (
            <TrackRow
              key={track.id}
              onPress={() => setSelectedTrackId(track.id)}
              onToggleMute={() => {
                handleTrackAction(track, 'mute').catch(() => undefined);
              }}
              onToggleSolo={() => {
                handleTrackAction(track, 'solo').catch(() => undefined);
              }}
              pendingAction={pendingTrackAction}
              selected={track.id === selectedTrack?.id}
              track={track}
            />
          ))}
        </View>
        {renderTimeline()}
      </>
    );
  };

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.root, { backgroundColor: theme.colors.background }]}
    >
      <View
        style={[
          styles.header,
          {
            backgroundColor: theme.colors.surface,
            borderBottomColor: theme.colors.border,
          },
        ]}
      >
        <View style={[styles.headerInner, headerContentStyle]}>
          <View style={styles.headerCopy}>
            <StudioText
              variant="body"
              weight="bold"
              style={[styles.brand, { color: theme.colors.accentPrimary }]}
            >
              DAFT CITADEL
            </StudioText>
            <StudioText variant="caption" tone="secondary" numberOfLines={1}>
              {sessionName ?? 'Untitled Session'}
            </StudioText>
          </View>
          <View
            accessible
            accessibilityLabel={
              transportControls.isAvailable
                ? transportControls.isPlaying
                  ? 'Audio engine playing'
                  : 'Audio engine ready'
                : 'Audio engine offline'
            }
            accessibilityRole="summary"
            style={styles.headerStatus}
          >
            <StudioText variant="caption" tone="muted" weight="bold">
              {!transportControls.isAvailable
                ? 'OFFLINE'
                : transportControls.isPlaying
                  ? 'PLAYING'
                  : 'READY'}
            </StudioText>
            <View
              style={[
                styles.statusDot,
                {
                  backgroundColor: transportControls.isPlaying
                    ? theme.colors.accentPrimary
                    : transportControls.isAvailable
                      ? theme.colors.textTertiary
                      : theme.colors.statusWarning,
                },
              ]}
            />
          </View>
        </View>

        <View style={[styles.transportBorder, { borderTopColor: theme.colors.border }]}>
          <View
            accessibilityLabel="Transport controls"
            style={[
              styles.transport,
              compactTransport && styles.transportCompact,
              headerContentStyle,
            ]}
          >
            <View
              accessibilityLabel={`Position ${position}`}
              style={[
                styles.transportMetric,
                styles.positionMetric,
                {
                  backgroundColor: theme.colors.surfaceElevated,
                  borderColor: theme.colors.border,
                },
              ]}
            >
              <StudioText
                variant="label"
                weight="bold"
                style={{ color: theme.colors.accentTertiary }}
              >
                {position}
              </StudioText>
            </View>
            <View
              accessibilityLabel={`${Math.round(effectiveTransport?.bpm ?? 0)} beats per minute`}
              style={[
                styles.transportMetric,
                styles.bpmMetric,
                {
                  backgroundColor: theme.colors.surfaceElevated,
                  borderColor: theme.colors.border,
                },
              ]}
            >
              <StudioText
                variant="body"
                weight="bold"
                style={{ color: theme.colors.accentPrimary }}
              >
                {Math.round(effectiveTransport?.bpm ?? 0)}
              </StudioText>
              <StudioText variant="caption" tone="muted" weight="bold">
                BPM
              </StudioText>
            </View>
            <StudioButton
              compact
              accessibilityLabel="Decrease tempo"
              disabled={(effectiveTransport?.bpm ?? 120) <= 20}
              label="−"
              onPress={() => {
                adjustTempo(-1).catch(() => undefined);
              }}
              style={styles.compactButton}
              testID="tempo-down"
              variant="ghost"
            />
            <StudioButton
              compact
              accessibilityLabel="Increase tempo"
              disabled={(effectiveTransport?.bpm ?? 120) >= 300}
              label="+"
              onPress={() => {
                adjustTempo(1).catch(() => undefined);
              }}
              style={styles.compactButton}
              testID="tempo-up"
              variant="ghost"
            />
            <View
              testID="transport-button-group"
              style={[
                styles.transportControls,
                compactTransport && styles.transportControlsCompact,
              ]}
            >
              <TransportButton
                accessibilityLabel="Rewind"
                disabled={!transportControls.isAvailable}
                icon="rewind"
                onPress={() => {
                  runTransportAction(transportControls.locateStart).catch(
                    () => undefined,
                  );
                }}
              />
              <TransportButton
                accessibilityLabel={transportControls.isPlaying ? 'Playing' : 'Play'}
                active={transportControls.isPlaying}
                disabled={!transportControls.isAvailable || transportControls.isPlaying}
                icon="play"
                primary
                onPress={() => {
                  runTransportAction(transportControls.play).catch(() => undefined);
                }}
              />
              <TransportButton
                accessibilityLabel="Stop"
                disabled={!transportControls.isAvailable || !transportControls.isPlaying}
                icon="stop"
                onPress={() => {
                  runTransportAction(transportControls.stop).catch(() => undefined);
                }}
              />
            </View>
          </View>
        </View>
      </View>

      <View
        accessibilityLabel="Timeline ruler"
        style={[
          styles.ruler,
          {
            backgroundColor: theme.colors.surfaceElevated,
            borderBottomColor: theme.colors.border,
          },
        ]}
      >
        <View
          style={[
            styles.rulerInner,
            compactTransport && styles.rulerInnerCompact,
            headerContentStyle,
          ]}
        >
          {Array.from({ length: meter.numerator * RULER_BAR_COUNT }, (_unused, index) => (
            <View key={index} style={styles.rulerBeat} testID="timeline-ruler-beat">
              <StudioText
                variant="caption"
                style={{
                  color:
                    index % meter.numerator === 0
                      ? theme.colors.textTertiary
                      : theme.colors.border,
                }}
              >
                {index % meter.numerator === 0
                  ? `${Math.floor(index / meter.numerator) + 1}`
                  : '·'}
              </StudioText>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.body}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={[styles.scrollContent, contentStyle]}
          showsVerticalScrollIndicator={false}
        >
          {actionError ? (
            <StudioPanel
              accessibilityLabel="Arrangement action error"
              accessibilityRole="alert"
              padding={12}
              style={styles.alertPanel}
              variant="subtle"
            >
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
              padding={12}
              style={styles.alertPanel}
              variant="subtle"
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
          {renderTrackContent()}
        </ScrollView>

        {status === 'ready' ? (
          <View pointerEvents="box-none" style={styles.floatingActions}>
            {soloActive ? (
              <View
                style={[
                  styles.soloWarning,
                  {
                    backgroundColor: theme.colors.surfaceElevated,
                    borderColor: theme.colors.accentTertiary,
                  },
                ]}
              >
                <StudioText
                  variant="caption"
                  weight="bold"
                  style={{ color: theme.colors.accentTertiary }}
                >
                  SOLO ACTIVE
                </StudioText>
              </View>
            ) : null}
            <Pressable
              accessibilityHint="Adds a routed Juno track with an editable one-bar pattern"
              accessibilityLabel={
                tracks.length === 0 ? 'Create first instrument' : 'Add Juno pattern track'
              }
              accessibilityRole="button"
              accessibilityState={{ disabled: isAddingTrack }}
              disabled={isAddingTrack}
              onPress={() => {
                handleAddTrack().catch(() => undefined);
              }}
              style={({ pressed }) => [
                styles.addButton,
                {
                  backgroundColor: theme.colors.accentPrimary,
                  opacity: isAddingTrack ? 0.45 : pressed ? 0.8 : 1,
                },
              ]}
            >
              {isAddingTrack ? (
                <ActivityIndicator color={theme.colors.accentPrimaryInk} size="small" />
              ) : (
                <StudioIcon color={theme.colors.accentPrimaryInk} name="plus" size={26} />
              )}
            </Pressable>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
};
