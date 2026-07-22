import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  SectionHeader,
  StatusBadge,
  StudioButton,
  StudioHeader,
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
  scrollContent: { paddingBottom: 32 },
  page: { alignSelf: 'center', width: '100%' },
  header: { marginBottom: 14 },
  diagnostics: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  diagnosticMetrics: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 18,
  },
  metric: { minWidth: 72 },
  alerts: { gap: 10, marginBottom: 14 },
  alertActions: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'space-between',
    marginTop: 10,
  },
  errorPanel: { marginBottom: 14 },
  channelGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  channel: { minWidth: 0 },
  channelAccent: { borderRadius: 2, height: 3, marginBottom: 14 },
  channelHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
  },
  channelTitle: { flex: 1, minWidth: 0 },
  channelMeta: { marginTop: 3 },
  meterHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 18,
  },
  meterTrack: {
    borderRadius: 4,
    height: 8,
    marginTop: 7,
    overflow: 'hidden',
    width: '100%',
  },
  meterFill: { borderRadius: 4, height: '100%' },
  channelControls: { flexDirection: 'row', gap: 8, marginTop: 16 },
  pluginSection: { gap: 8, marginTop: 18 },
  pluginRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'space-between',
  },
  statePanel: {
    alignItems: 'center',
    gap: 10,
    justifyContent: 'center',
    minHeight: 190,
  },
  stateCopy: { maxWidth: 420, textAlign: 'center' },
});

const clampLevel = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

const describePan = (pan: number): string => {
  const normalized = Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0;
  if (Math.abs(normalized) < 0.01) {
    return 'Center';
  }
  return `${Math.round(Math.abs(normalized) * 100)}% ${normalized < 0 ? 'L' : 'R'}`;
};

const diagnosticsPresentation = (
  status: ReturnType<typeof useSessionViewModel>['diagnostics']['status'],
  xruns: number,
): { label: string; tone: StudioTone } => {
  if (status === 'error') {
    return { label: 'Engine error', tone: 'critical' };
  }
  if (status === 'unavailable') {
    return { label: 'Metrics unavailable', tone: 'warning' };
  }
  if (status === 'loading') {
    return { label: 'Checking engine', tone: 'secondary' };
  }
  return xruns > 0
    ? { label: 'Engine needs attention', tone: 'warning' }
    : { label: 'Engine ready', tone: 'success' };
};

interface MixerChannelProps {
  track: TrackViewModel;
  pendingAction?: string;
  style: ViewStyle;
  onToggleMute: (track: TrackViewModel) => void;
  onToggleSolo: (track: TrackViewModel) => void;
}

const MixerChannel: React.FC<MixerChannelProps> = ({
  track,
  pendingAction,
  style,
  onToggleMute,
  onToggleSolo,
}) => {
  const theme = useTheme();
  const level = clampLevel(track.meterLevel);
  const trackPending = pendingAction?.startsWith(`${track.id}:`) === true;
  const meterWidth = `${Math.round(level * 100)}%` as `${number}%`;
  const trackStatus = track.muted ? 'Muted' : track.solo ? 'Solo' : 'Active';
  const statusTone: StudioTone = track.muted ? 'muted' : track.solo ? 'magenta' : 'mint';

  return (
    <StudioPanel
      accessibilityLabel={`${track.name} mixer channel`}
      padding={14}
      style={[styles.channel, style]}
    >
      <View
        style={[
          styles.channelAccent,
          { backgroundColor: track.color ?? theme.colors.accentTertiary },
        ]}
      />
      <View style={styles.channelHeader}>
        <View style={styles.channelTitle}>
          <StudioText variant="bodyLarge" weight="bold" numberOfLines={1}>
            {track.name}
          </StudioText>
          <StudioText variant="caption" tone="secondary" style={styles.channelMeta}>
            {track.volumeDb.toFixed(1)} dB · Pan {describePan(track.pan)}
          </StudioText>
        </View>
        <StatusBadge label={trackStatus} tone={statusTone} />
      </View>

      <View style={styles.meterHeader}>
        <StudioText variant="caption" tone="muted" weight="bold">
          LEVEL ESTIMATE
        </StudioText>
        <StudioText variant="caption" tone="secondary">
          {Math.round(level * 100)}%
        </StudioText>
      </View>
      <View
        accessibilityLabel={`${track.name} level estimate ${Math.round(level * 100)} percent`}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(level * 100) }}
        style={[styles.meterTrack, { backgroundColor: theme.colors.surfacePressed }]}
      >
        <View
          style={[
            styles.meterFill,
            { backgroundColor: theme.colors.accentPrimary, width: meterWidth },
          ]}
        />
      </View>

      <View style={styles.channelControls}>
        <StudioButton
          compact
          icon="mute"
          label={track.muted ? 'Unmute' : 'Mute'}
          loading={pendingAction === `${track.id}:mute`}
          disabled={trackPending && pendingAction !== `${track.id}:mute`}
          variant={track.muted ? 'danger' : 'secondary'}
          onPress={() => onToggleMute(track)}
        />
        <StudioButton
          compact
          icon="solo"
          label={track.solo ? 'Unsolo' : 'Solo'}
          loading={pendingAction === `${track.id}:solo`}
          disabled={trackPending && pendingAction !== `${track.id}:solo`}
          variant={track.solo ? 'primary' : 'secondary'}
          onPress={() => onToggleSolo(track)}
        />
      </View>

      {track.plugins.length > 0 ? (
        <View style={styles.pluginSection}>
          <StudioText variant="caption" tone="muted" weight="bold">
            INSERTS
          </StudioText>
          {track.plugins.map((plugin) => {
            const pluginTone: StudioTone =
              plugin.status === 'crashed'
                ? 'critical'
                : plugin.status === 'bypassed' || plugin.status === 'offline'
                  ? 'warning'
                  : 'secondary';
            return (
              <View key={plugin.id} style={styles.pluginRow}>
                <StudioText variant="caption" tone="secondary" numberOfLines={1}>
                  {plugin.label} · {plugin.slot.toUpperCase()}
                </StudioText>
                <StatusBadge label={plugin.status} tone={pluginTone} />
              </View>
            );
          })}
        </View>
      ) : null}
    </StudioPanel>
  );
};

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

export const MixerScreen: React.FC = () => {
  const theme = useTheme();
  const adaptive = useAdaptiveLayout();
  const { status, tracks, diagnostics, pluginAlerts, retryPlugin, sessionName } =
    useSessionViewModel();
  const sessionActions = useSessionActions();
  const [pendingAction, setPendingAction] = useState<string>();
  const [addingTrack, setAddingTrack] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const pageStyle = useMemo<ViewStyle>(
    () => ({
      maxWidth: adaptive.maxContentWidth,
      paddingHorizontal: adaptive.contentPadding,
      paddingTop: adaptive.isLandscape ? 10 : 18,
    }),
    [adaptive.contentPadding, adaptive.isLandscape, adaptive.maxContentWidth],
  );
  const channelStyle = useMemo<ViewStyle>(
    () =>
      adaptive.workspaceMode === 'deck'
        ? { width: '100%' }
        : {
            flexBasis: adaptive.isTablet ? 280 : 240,
            flexGrow: 1,
            maxWidth: adaptive.breakpoint === 'desktop' ? 360 : undefined,
          },
    [adaptive.breakpoint, adaptive.isTablet, adaptive.workspaceMode],
  );
  const diagnosticsState = diagnosticsPresentation(diagnostics.status, diagnostics.xruns);
  const renderLoad = Number.isFinite(diagnostics.renderLoad)
    ? Math.max(0, Math.min(1, diagnostics.renderLoad))
    : 0;

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

  const handleAddTrack = useCallback(async () => {
    setAddingTrack(true);
    setActionError(undefined);
    try {
      await sessionActions.addTrack();
    } catch (error) {
      console.error('Failed to add first mixer track', { sessionName, error });
      setActionError(errorMessage(error, 'Unable to add a track.'));
    } finally {
      setAddingTrack(false);
    }
  }, [sessionActions, sessionName]);

  const handleRetryPlugin = useCallback(
    async (instanceId: string) => {
      setActionError(undefined);
      try {
        await retryPlugin(instanceId);
      } catch (error) {
        console.error('Failed to retry plugin instantiation', { instanceId, error });
        setActionError(errorMessage(error, 'Unable to retry the plugin.'));
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
          <StudioText variant="body" tone="secondary" style={styles.stateCopy}>
            The current session could not be loaded. Reopen the app to retry session
            startup.
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
            Add a routed stereo track to unlock mixer controls and start building this
            session.
          </StudioText>
          <StudioButton
            icon="plus"
            label="Add first track"
            loading={addingTrack}
            variant="primary"
            onPress={() => {
              handleAddTrack().catch(() => undefined);
            }}
          />
        </StudioPanel>
      );
    }
    return (
      <View style={styles.channelGrid}>
        {tracks.map((track) => (
          <MixerChannel
            key={track.id}
            track={track}
            pendingAction={pendingAction}
            style={channelStyle}
            onToggleMute={(selectedTrack) => {
              performTrackAction(selectedTrack, 'mute').catch(() => undefined);
            }}
            onToggleSolo={(selectedTrack) => {
              performTrackAction(selectedTrack, 'solo').catch(() => undefined);
            }}
          />
        ))}
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
        <View style={[styles.page, pageStyle]}>
          <View style={styles.header}>
            <StudioHeader
              compact={adaptive.isLandscape}
              eyebrow="Studio Console"
              title="Mixer"
              detail={sessionName ?? 'Current session'}
              actions={
                <StatusBadge
                  icon="engine"
                  label={diagnosticsState.label}
                  tone={diagnosticsState.tone}
                />
              }
            />
          </View>

          <StudioPanel padding={12} variant="subtle" style={styles.diagnostics}>
            <StudioText variant="label" weight="bold">
              Audio Engine Diagnostics
            </StudioText>
            <View style={styles.diagnosticMetrics}>
              <View style={styles.metric}>
                <StudioText variant="caption" tone="muted">
                  Render load
                </StudioText>
                <StudioText variant="label" weight="bold">
                  {(renderLoad * 100).toFixed(0)}%
                </StudioText>
              </View>
              <View style={styles.metric}>
                <StudioText variant="caption" tone="muted">
                  XRUNS
                </StudioText>
                <StudioText
                  variant="label"
                  weight="bold"
                  tone={diagnostics.xruns > 0 ? 'warning' : 'primary'}
                >
                  {diagnostics.xruns}
                </StudioText>
              </View>
              <View style={styles.metric}>
                <StudioText variant="caption" tone="muted">
                  CHANNELS
                </StudioText>
                <StudioText variant="label" weight="bold">
                  {tracks.length}
                </StudioText>
              </View>
            </View>
          </StudioPanel>

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
                          Retry the existing plugin instance without changing the session.
                        </StudioText>
                        <StudioButton
                          compact
                          label="Retry"
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
            <StudioPanel accessibilityRole="alert" padding={12} style={styles.errorPanel}>
              <StudioText variant="body" tone="critical">
                {actionError}
              </StudioText>
            </StudioPanel>
          ) : null}

          {renderChannels()}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};
