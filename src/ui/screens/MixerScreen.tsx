import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  SectionHeader,
  StatusBadge,
  StudioButton,
  StudioIcon,
  StudioPanel,
  StudioText,
  useTheme,
  type StudioTone,
} from '../design-system';
import { useAdaptiveLayout } from '../layout';
import { type TrackViewModel, useSessionActions, useSessionViewModel } from '../session';
import { formatAlertTimestamp } from '../utils/date';

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  scrollContent: { paddingBottom: 24 },
  page: { alignSelf: 'center', width: '100%' },
  header: {
    alignItems: 'center',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    paddingBottom: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  headerCopy: { flex: 1, minWidth: 0 },
  headerTitle: { fontSize: 18, letterSpacing: 2, lineHeight: 22 },
  headerDetail: { marginTop: 2 },
  diagnostics: {
    alignItems: 'center',
    borderBottomWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  diagnosticsTitle: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  diagnosticsHeading: { textTransform: 'uppercase' },
  diagnosticMetrics: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
  },
  metric: { minWidth: 54 },
  content: { gap: 12, paddingTop: 12 },
  alerts: { gap: 10 },
  alertActions: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'space-between',
    marginTop: 10,
  },
  channelViewport: { minHeight: 320 },
  channelScrollContent: {
    alignItems: 'stretch',
    gap: 8,
    paddingHorizontal: 2,
    paddingVertical: 2,
  },
  channel: {
    alignItems: 'center',
    borderRadius: 12,
    minHeight: 314,
    overflow: 'hidden',
    paddingBottom: 10,
  },
  channelMuted: { opacity: 0.68 },
  masterChannel: { borderWidth: 1.5 },
  channelAccent: { height: 4, width: '100%' },
  channelName: {
    fontSize: 10,
    letterSpacing: 0.5,
    lineHeight: 13,
    minHeight: 34,
    paddingHorizontal: 6,
    paddingTop: 8,
    textAlign: 'center',
    width: '100%',
  },
  meterContainer: {
    borderRadius: 5,
    borderWidth: 1,
    justifyContent: 'flex-end',
    overflow: 'hidden',
    position: 'relative',
    width: 30,
  },
  meterFill: { borderRadius: 4, width: '100%' },
  clipIndicator: {
    height: 3,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  volumeLabel: { marginTop: 7 },
  panLabel: { marginTop: 1 },
  channelControls: { flexDirection: 'row', gap: 5, marginTop: 9 },
  valueControls: { gap: 5, marginTop: 7 },
  valueRow: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  valueButton: {
    alignItems: 'center',
    borderRadius: 7,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  channelToggle: {
    alignItems: 'center',
    borderRadius: 7,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  pluginSection: {
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 5,
    marginTop: 10,
    paddingHorizontal: 7,
    paddingTop: 8,
    width: '100%',
  },
  pluginRow: { gap: 2, minWidth: 0 },
  pluginStatus: { alignItems: 'center', flexDirection: 'row', gap: 4 },
  pluginStatusDot: { borderRadius: 3, height: 6, width: 6 },
  pluginStatusText: { fontSize: 9 },
  masterMeta: { alignItems: 'center', gap: 4, marginTop: 13 },
  statePanel: {
    alignItems: 'center',
    gap: 10,
    justifyContent: 'center',
    minHeight: 230,
  },
  stateCopy: { maxWidth: 420, textAlign: 'center' },
  stateAction: { alignSelf: 'center' },
  hintBar: {
    alignItems: 'center',
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 7,
    marginTop: 10,
    paddingHorizontal: 12,
    paddingTop: 9,
  },
});

const clampLevel = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

const describePan = (pan: number): string => {
  const normalized = Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0;
  if (Math.abs(normalized) < 0.01) {
    return 'C';
  }
  return `${Math.round(Math.abs(normalized) * 100)}${normalized < 0 ? 'L' : 'R'}`;
};

const diagnosticsPresentation = (
  status: ReturnType<typeof useSessionViewModel>['diagnostics']['status'],
  xruns: number,
): { label: string; tone: StudioTone } => {
  if (status === 'error') {
    return { label: 'ENGINE ERROR', tone: 'critical' };
  }
  if (status === 'unavailable') {
    return { label: 'METRICS OFFLINE', tone: 'warning' };
  }
  if (status === 'loading') {
    return { label: 'CHECKING', tone: 'secondary' };
  }
  return xruns > 0
    ? { label: 'ATTENTION', tone: 'warning' }
    : { label: 'READY', tone: 'success' };
};

const formatVolume = (track: TrackViewModel): string => {
  if (track.muted) {
    return 'MUTE';
  }
  return Number.isFinite(track.volumeDb) ? `${track.volumeDb.toFixed(1)} dB` : '-∞ dB';
};

interface ChannelToggleProps {
  active: boolean;
  activeColor: string;
  accessibilityLabel: string;
  disabled: boolean;
  label: 'M' | 'S';
  loading: boolean;
  onPress: () => void;
}

const ChannelToggle: React.FC<ChannelToggleProps> = ({
  active,
  activeColor,
  accessibilityLabel,
  disabled,
  label,
  loading,
  onPress,
}) => {
  const theme = useTheme();
  const isDisabled = disabled || loading;
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ busy: loading, disabled: isDisabled, selected: active }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.channelToggle,
        {
          backgroundColor: active ? `${activeColor}22` : theme.colors.surfaceElevated,
          borderColor: active ? activeColor : theme.colors.border,
          opacity: isDisabled ? 0.5 : pressed ? 0.78 : 1,
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator
          color={active ? activeColor : theme.colors.textSecondary}
          size="small"
        />
      ) : (
        <StudioText
          variant="caption"
          weight="bold"
          style={{ color: active ? activeColor : theme.colors.textSecondary }}
        >
          {label}
        </StudioText>
      )}
    </Pressable>
  );
};

interface MixerChannelProps {
  meterHeight: number;
  pendingAction?: string;
  track: TrackViewModel;
  width: number;
  onAdjustPan: (track: TrackViewModel, direction: -1 | 1) => void;
  onAdjustVolume: (track: TrackViewModel, direction: -1 | 1) => void;
  onToggleMute: (track: TrackViewModel) => void;
  onToggleSolo: (track: TrackViewModel) => void;
}

const MixerChannel: React.FC<MixerChannelProps> = ({
  meterHeight,
  pendingAction,
  track,
  width,
  onAdjustPan,
  onAdjustVolume,
  onToggleMute,
  onToggleSolo,
}) => {
  const theme = useTheme();
  const level = clampLevel(track.meterLevel);
  const trackPending = pendingAction?.startsWith(`${track.id}:`) === true;
  const trackColor = track.color ?? theme.colors.accentTertiary;
  const meterColor = track.muted
    ? theme.colors.textTertiary
    : level > 0.9
      ? theme.colors.statusCritical
      : level > 0.75
        ? theme.colors.statusWarning
        : trackColor;

  return (
    <StudioPanel
      accessibilityLabel={`${track.name} mixer channel`}
      padding={0}
      style={[styles.channel, track.muted && styles.channelMuted, { width }]}
    >
      <View style={[styles.channelAccent, { backgroundColor: trackColor }]} />
      <StudioText
        variant="caption"
        weight="bold"
        numberOfLines={2}
        style={styles.channelName}
      >
        {track.name.toUpperCase()}
      </StudioText>

      <View
        accessibilityHint="LEVEL ESTIMATE"
        accessibilityLabel={`${track.name} level estimate ${Math.round(level * 100)} percent`}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(level * 100) }}
        style={[
          styles.meterContainer,
          {
            backgroundColor: theme.colors.surfaceElevated,
            borderColor: theme.colors.border,
            height: meterHeight,
          },
        ]}
      >
        <View
          style={[
            styles.meterFill,
            { backgroundColor: meterColor, height: Math.round(level * meterHeight) },
          ]}
        />
        <View
          style={[
            styles.clipIndicator,
            {
              backgroundColor:
                level > 0.95 ? theme.colors.statusCritical : theme.colors.surfaceElevated,
            },
          ]}
        />
      </View>

      <StudioText
        selectable
        variant="caption"
        weight="bold"
        style={[
          styles.volumeLabel,
          {
            color: track.muted ? theme.colors.textTertiary : theme.colors.accentPrimary,
            fontVariant: ['tabular-nums'],
          },
        ]}
      >
        {formatVolume(track)}
      </StudioText>
      <StudioText selectable variant="caption" tone="muted" style={styles.panLabel}>
        PAN {describePan(track.pan)}
      </StudioText>

      <View style={styles.valueControls}>
        <View style={styles.valueRow}>
          <Pressable
            accessibilityLabel={`Decrease ${track.name} level`}
            accessibilityRole="button"
            accessibilityState={{ disabled: trackPending || track.volumeDb <= -60 }}
            disabled={trackPending || track.volumeDb <= -60}
            onPress={() => onAdjustVolume(track, -1)}
            style={({ pressed }) => [
              styles.valueButton,
              {
                backgroundColor: theme.colors.surfaceElevated,
                borderColor: theme.colors.border,
                opacity:
                  trackPending || track.volumeDb <= -60 ? 0.45 : pressed ? 0.76 : 1,
              },
            ]}
          >
            <StudioText selectable={false} variant="label" weight="bold">
              −
            </StudioText>
          </Pressable>
          <Pressable
            accessibilityLabel={`Increase ${track.name} level`}
            accessibilityRole="button"
            accessibilityState={{ disabled: trackPending || track.volumeDb >= 12 }}
            disabled={trackPending || track.volumeDb >= 12}
            onPress={() => onAdjustVolume(track, 1)}
            style={({ pressed }) => [
              styles.valueButton,
              {
                backgroundColor: theme.colors.surfaceElevated,
                borderColor: theme.colors.border,
                opacity: trackPending || track.volumeDb >= 12 ? 0.45 : pressed ? 0.76 : 1,
              },
            ]}
          >
            <StudioText selectable={false} variant="label" weight="bold">
              +
            </StudioText>
          </Pressable>
        </View>
        <View style={styles.valueRow}>
          <Pressable
            accessibilityLabel={`Pan ${track.name} left`}
            accessibilityRole="button"
            accessibilityState={{ disabled: trackPending || track.pan <= -1 }}
            disabled={trackPending || track.pan <= -1}
            onPress={() => onAdjustPan(track, -1)}
            style={({ pressed }) => [
              styles.valueButton,
              {
                backgroundColor: theme.colors.surfaceElevated,
                borderColor: theme.colors.border,
                opacity: trackPending || track.pan <= -1 ? 0.45 : pressed ? 0.76 : 1,
              },
            ]}
          >
            <StudioText selectable={false} variant="caption" weight="bold">
              L
            </StudioText>
          </Pressable>
          <Pressable
            accessibilityLabel={`Pan ${track.name} right`}
            accessibilityRole="button"
            accessibilityState={{ disabled: trackPending || track.pan >= 1 }}
            disabled={trackPending || track.pan >= 1}
            onPress={() => onAdjustPan(track, 1)}
            style={({ pressed }) => [
              styles.valueButton,
              {
                backgroundColor: theme.colors.surfaceElevated,
                borderColor: theme.colors.border,
                opacity: trackPending || track.pan >= 1 ? 0.45 : pressed ? 0.76 : 1,
              },
            ]}
          >
            <StudioText selectable={false} variant="caption" weight="bold">
              R
            </StudioText>
          </Pressable>
        </View>
      </View>

      <View style={styles.channelControls}>
        <ChannelToggle
          active={track.muted}
          activeColor={theme.colors.statusWarning}
          accessibilityLabel={`${track.muted ? 'Unmute' : 'Mute'} ${track.name}`}
          disabled={trackPending && pendingAction !== `${track.id}:mute`}
          label="M"
          loading={pendingAction === `${track.id}:mute`}
          onPress={() => onToggleMute(track)}
        />
        <ChannelToggle
          active={track.solo}
          activeColor={theme.colors.accentTertiary}
          accessibilityLabel={`${track.solo ? 'Unsolo' : 'Solo'} ${track.name}`}
          disabled={trackPending && pendingAction !== `${track.id}:solo`}
          label="S"
          loading={pendingAction === `${track.id}:solo`}
          onPress={() => onToggleSolo(track)}
        />
      </View>

      {track.plugins.length > 0 ? (
        <View style={[styles.pluginSection, { borderTopColor: theme.colors.border }]}>
          <StudioText variant="caption" tone="muted" weight="bold">
            INSERTS
          </StudioText>
          {track.plugins.map((plugin) => {
            const statusColor =
              plugin.status === 'crashed'
                ? theme.colors.statusCritical
                : plugin.status === 'bypassed' || plugin.status === 'offline'
                  ? theme.colors.statusWarning
                  : theme.colors.statusSuccess;
            return (
              <View key={plugin.id} style={styles.pluginRow}>
                <StudioText variant="caption" tone="secondary" numberOfLines={1}>
                  {plugin.label}
                </StudioText>
                <View style={styles.pluginStatus}>
                  <View
                    style={[styles.pluginStatusDot, { backgroundColor: statusColor }]}
                  />
                  <StudioText
                    variant="caption"
                    weight="bold"
                    numberOfLines={1}
                    style={[styles.pluginStatusText, { color: statusColor }]}
                  >
                    {plugin.status.toUpperCase()}
                  </StudioText>
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </StudioPanel>
  );
};

interface MasterChannelProps {
  level: number;
  meterHeight: number;
  width: number;
}

const MasterChannel: React.FC<MasterChannelProps> = ({ level, meterHeight, width }) => {
  const theme = useTheme();
  const normalizedLevel = clampLevel(level);
  const meterColor =
    normalizedLevel > 0.9
      ? theme.colors.statusCritical
      : normalizedLevel > 0.75
        ? theme.colors.statusWarning
        : theme.colors.accentPrimary;

  return (
    <StudioPanel
      accessibilityLabel="Master mixer channel"
      padding={0}
      variant="raised"
      style={[
        styles.channel,
        styles.masterChannel,
        { borderColor: theme.colors.accentPrimary, width },
      ]}
    >
      <View
        style={[styles.channelAccent, { backgroundColor: theme.colors.accentPrimary }]}
      />
      <StudioText
        variant="caption"
        weight="bold"
        style={[styles.channelName, { color: theme.colors.accentPrimary }]}
      >
        MASTER
      </StudioText>
      <View
        accessibilityLabel={`Master level estimate ${Math.round(normalizedLevel * 100)} percent`}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(normalizedLevel * 100) }}
        style={[
          styles.meterContainer,
          {
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
            height: meterHeight,
          },
        ]}
      >
        <View
          style={[
            styles.meterFill,
            {
              backgroundColor: meterColor,
              height: Math.round(normalizedLevel * meterHeight),
            },
          ]}
        />
        <View
          style={[
            styles.clipIndicator,
            {
              backgroundColor:
                normalizedLevel > 0.95
                  ? theme.colors.statusCritical
                  : theme.colors.surface,
            },
          ]}
        />
      </View>
      <View style={styles.masterMeta}>
        <StudioText
          selectable
          variant="caption"
          weight="bold"
          style={{ color: theme.colors.accentPrimary, fontVariant: ['tabular-nums'] }}
        >
          0.0 dB
        </StudioText>
        <StatusBadge icon="engine" label="BUS" tone="mint" />
      </View>
    </StudioPanel>
  );
};

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

export const MixerScreen: React.FC = () => {
  const theme = useTheme();
  const adaptive = useAdaptiveLayout();
  const {
    status,
    tracks,
    diagnostics,
    pluginAlerts,
    retryPlugin,
    sessionName,
    error: sessionError,
  } = useSessionViewModel();
  const sessionActions = useSessionActions();
  const [pendingAction, setPendingAction] = useState<string>();
  const pendingPluginRetryRef = useRef<string | undefined>(undefined);
  const [pendingPluginRetry, setPendingPluginRetry] = useState<string>();
  const [addingTrack, setAddingTrack] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const pageStyle = useMemo<ViewStyle>(
    () => ({
      maxWidth: adaptive.maxContentWidth,
      paddingHorizontal: adaptive.contentPadding,
    }),
    [adaptive.contentPadding, adaptive.maxContentWidth],
  );
  const channelDimensions = useMemo(() => {
    if (adaptive.breakpoint === 'desktop') {
      return { meterHeight: 190, width: 118 };
    }
    if (adaptive.isTablet) {
      return { meterHeight: 172, width: 110 };
    }
    return { meterHeight: 146, width: 96 };
  }, [adaptive.breakpoint, adaptive.isTablet]);
  const diagnosticsState = diagnosticsPresentation(diagnostics.status, diagnostics.xruns);
  const renderLoad = Number.isFinite(diagnostics.renderLoad)
    ? Math.max(0, Math.min(1, diagnostics.renderLoad))
    : 0;
  const diagnosticsReady = diagnostics.status === 'ready';
  const renderLoadLabel = diagnosticsReady ? `${(renderLoad * 100).toFixed(0)}%` : '—';
  const xrunsLabel = diagnosticsReady ? diagnostics.xruns.toString() : '—';
  const mutedCount = tracks.filter((track) => track.muted).length;
  const soloCount = tracks.filter((track) => track.solo).length;
  const masterLevel = useMemo(() => {
    const soloActive = tracks.some((track) => track.solo && !track.muted);
    const audibleTracks = tracks.filter(
      (track) => !track.muted && (!soloActive || track.solo),
    );
    return audibleTracks.reduce(
      (highest, track) => Math.max(highest, clampLevel(track.meterLevel)),
      0,
    );
  }, [tracks]);

  const performTrackAction = useCallback(
    async (track: TrackViewModel, action: 'mute' | 'solo') => {
      const key = `${track.id}:${action}`;
      setPendingAction(key);
      setActionError(undefined);
      try {
        if (action === 'mute') {
          await sessionActions.setTrackMuted(track.id, !track.muted);
        } else {
          await sessionActions.setTrackSolo(track.id, !track.solo);
        }
      } catch (error) {
        console.error('Mixer track action failed', { action, trackId: track.id, error });
        setActionError(errorMessage(error, `Unable to ${action} ${track.name}.`));
      } finally {
        setPendingAction((current) => (current === key ? undefined : current));
      }
    },
    [sessionActions],
  );

  const adjustTrackValue = useCallback(
    async (track: TrackViewModel, value: 'pan' | 'volume', direction: -1 | 1) => {
      const key = `${track.id}:${value}`;
      setPendingAction(key);
      setActionError(undefined);
      try {
        if (value === 'volume') {
          await sessionActions.setTrackVolume(
            track.id,
            Math.max(-60, Math.min(12, track.volumeDb + direction)),
          );
        } else {
          await sessionActions.setTrackPan(
            track.id,
            Number(Math.max(-1, Math.min(1, track.pan + direction * 0.1)).toFixed(1)),
          );
        }
      } catch (error) {
        console.error('Mixer track value action failed', {
          direction,
          trackId: track.id,
          value,
          error,
        });
        setActionError(errorMessage(error, `Unable to change ${track.name} ${value}.`));
      } finally {
        setPendingAction((current) => (current === key ? undefined : current));
      }
    },
    [sessionActions],
  );

  const handleAddTrack = useCallback(async () => {
    setAddingTrack(true);
    setActionError(undefined);
    try {
      const withTrack = await sessionActions.addJunoTrack({ name: 'Juno-106' });
      const trackId = withTrack.tracks.at(-1)?.id;
      if (!trackId) {
        throw new Error('The Juno track was not created.');
      }
      await sessionActions.addEmptyJunoMidiClip(trackId, {
        bars: 1,
        name: 'Pattern 1',
      });
    } catch (error) {
      console.error('Failed to add first mixer track', { sessionName, error });
      setActionError(errorMessage(error, 'Unable to add a track.'));
    } finally {
      setAddingTrack(false);
    }
  }, [sessionActions, sessionName]);

  const handleRetryPlugin = useCallback(
    async (instanceId: string) => {
      if (pendingPluginRetryRef.current) {
        return;
      }
      pendingPluginRetryRef.current = instanceId;
      setPendingPluginRetry(instanceId);
      setActionError(undefined);
      try {
        const recovered = await retryPlugin(instanceId);
        if (!recovered) {
          console.warn('Plugin retry did not recover the instance', { instanceId });
          setActionError(
            'The plugin could not be retried. Its retry limit may have been reached.',
          );
        }
      } catch (error) {
        console.error('Failed to retry plugin instantiation', { instanceId, error });
        setActionError(errorMessage(error, 'Unable to retry the plugin.'));
      } finally {
        pendingPluginRetryRef.current = undefined;
        setPendingPluginRetry((current) =>
          current === instanceId ? undefined : current,
        );
      }
    },
    [retryPlugin],
  );

  const renderChannels = () => {
    if (status === 'loading' || status === 'idle') {
      return (
        <StudioPanel style={styles.statePanel}>
          <StudioIcon name="mixer" size={28} />
          <StudioText variant="body" tone="secondary">
            Preparing mixer channels…
          </StudioText>
        </StudioPanel>
      );
    }
    if (status === 'error') {
      return (
        <StudioPanel accessibilityRole="alert" style={styles.statePanel}>
          <StudioIcon name="diagnostics" size={28} />
          <StudioText variant="bodyLarge" tone="critical" weight="bold">
            Mixer unavailable
          </StudioText>
          <StudioText selectable variant="body" tone="secondary" style={styles.stateCopy}>
            {sessionError?.message ?? 'The current session could not be loaded.'}
          </StudioText>
        </StudioPanel>
      );
    }
    if (tracks.length === 0) {
      return (
        <StudioPanel style={styles.statePanel}>
          <StudioIcon name="waveform" size={30} />
          <StudioText variant="sectionTitle" weight="bold">
            Shape your first track
          </StudioText>
          <StudioText variant="body" tone="secondary" style={styles.stateCopy}>
            Create a routed Juno channel and blank pattern, then shape its level and
            stereo position here.
          </StudioText>
          <StudioButton
            icon="plus"
            label="Create first instrument"
            loading={addingTrack}
            style={styles.stateAction}
            variant="primary"
            onPress={() => {
              handleAddTrack().catch(() => undefined);
            }}
          />
        </StudioPanel>
      );
    }
    return (
      <View style={styles.channelViewport}>
        <ScrollView
          accessibilityLabel="Mixer channels"
          contentContainerStyle={styles.channelScrollContent}
          horizontal
          nestedScrollEnabled
          showsHorizontalScrollIndicator={false}
        >
          {tracks.map((track) => (
            <MixerChannel
              key={track.id}
              meterHeight={channelDimensions.meterHeight}
              pendingAction={pendingAction}
              track={track}
              width={channelDimensions.width}
              onAdjustPan={(selectedTrack, direction) => {
                adjustTrackValue(selectedTrack, 'pan', direction).catch(() => undefined);
              }}
              onAdjustVolume={(selectedTrack, direction) => {
                adjustTrackValue(selectedTrack, 'volume', direction).catch(
                  () => undefined,
                );
              }}
              onToggleMute={(selectedTrack) => {
                performTrackAction(selectedTrack, 'mute').catch(() => undefined);
              }}
              onToggleSolo={(selectedTrack) => {
                performTrackAction(selectedTrack, 'solo').catch(() => undefined);
              }}
            />
          ))}
          <MasterChannel
            level={masterLevel}
            meterHeight={channelDimensions.meterHeight}
            width={channelDimensions.width}
          />
        </ScrollView>
        <View style={[styles.hintBar, { borderTopColor: theme.colors.border }]}>
          <StudioIcon name="diagnostics" color={theme.colors.textTertiary} size={12} />
          <StudioText variant="caption" tone="muted">
            Scroll horizontally to see all channels
          </StudioText>
        </View>
      </View>
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
        <View
          style={[
            styles.header,
            {
              backgroundColor: theme.colors.surface,
              borderBottomColor: theme.colors.border,
            },
          ]}
        >
          <View style={styles.headerCopy}>
            <StudioText
              selectable
              variant="bodyLarge"
              weight="bold"
              style={[styles.headerTitle, { color: theme.colors.accentPrimary }]}
            >
              MIXER
            </StudioText>
            <StudioText
              selectable
              variant="caption"
              tone="muted"
              style={styles.headerDetail}
            >
              {tracks.length} {tracks.length === 1 ? 'channel' : 'channels'}
              {mutedCount > 0 ? ` · ${mutedCount} muted` : ''}
              {soloCount > 0 ? ` · ${soloCount} solo` : ''}
              {sessionName ? ` · ${sessionName}` : ''}
            </StudioText>
          </View>
          <StatusBadge
            icon="engine"
            label={diagnosticsState.label}
            tone={diagnosticsState.tone}
          />
        </View>

        <View
          style={[
            styles.diagnostics,
            {
              backgroundColor: theme.colors.surfaceVariant,
              borderBottomColor: theme.colors.border,
            },
          ]}
        >
          <View style={styles.diagnosticsTitle}>
            <StudioIcon
              name="diagnostics"
              color={theme.colors.accentTertiary}
              size={15}
            />
            <StudioText variant="caption" weight="bold" style={styles.diagnosticsHeading}>
              Audio Engine Diagnostics
            </StudioText>
          </View>
          <View style={styles.diagnosticMetrics}>
            <View style={styles.metric}>
              <StudioText variant="caption" tone="muted">
                LOAD
              </StudioText>
              <StudioText
                selectable
                variant="caption"
                weight="bold"
                style={{ fontVariant: ['tabular-nums'] }}
              >
                {renderLoadLabel}
              </StudioText>
            </View>
            <View style={styles.metric}>
              <StudioText variant="caption" tone="muted">
                XRUNS
              </StudioText>
              <StudioText
                selectable
                variant="caption"
                weight="bold"
                tone={diagnosticsReady && diagnostics.xruns > 0 ? 'warning' : 'primary'}
                style={{ fontVariant: ['tabular-nums'] }}
              >
                {xrunsLabel}
              </StudioText>
            </View>
          </View>
        </View>

        <View style={[styles.page, pageStyle]}>
          <View style={styles.content}>
            {pluginAlerts.length > 0 ? (
              <View style={styles.alerts}>
                {pluginAlerts.map((alert) => {
                  const recovered = alert.recovered === true;
                  const title = alert.descriptor?.name ?? alert.instanceId;
                  return (
                    <StudioPanel
                      accessibilityRole="alert"
                      key={`${alert.instanceId}:${alert.timestamp}`}
                      variant="raised"
                    >
                      <SectionHeader
                        title={title}
                        detail={`${formatAlertTimestamp(alert.timestamp)} · ${alert.reason}`}
                        accessory={
                          <StatusBadge
                            label={recovered ? 'Recovered' : 'Plugin interrupted'}
                            tone={recovered ? 'success' : 'critical'}
                          />
                        }
                      />
                      {!recovered ? (
                        <View style={styles.alertActions}>
                          <StudioText variant="caption" tone="secondary">
                            Retry the existing plugin instance without changing the
                            session.
                          </StudioText>
                          <StudioButton
                            compact
                            disabled={pendingPluginRetry !== undefined}
                            label="Retry"
                            loading={pendingPluginRetry === alert.instanceId}
                            onPress={() => {
                              handleRetryPlugin(alert.instanceId).catch(() => undefined);
                            }}
                          />
                        </View>
                      ) : null}
                    </StudioPanel>
                  );
                })}
              </View>
            ) : null}

            {actionError ? (
              <StudioPanel
                accessibilityLabel="Mixer action error"
                accessibilityRole="alert"
                padding={12}
              >
                <StudioText selectable variant="body" tone="critical">
                  {actionError}
                </StudioText>
              </StudioPanel>
            ) : null}

            {renderChannels()}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};
