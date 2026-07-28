import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type ViewStyle } from 'react-native';

import {
  ScreenScaffold,
  ScreenState,
  StatusBadge,
  StudioButton,
  StudioPanel,
  StudioText,
  type StudioTone,
  useTheme,
} from '../design-system';
import { type LayoutBreakpoint, useAdaptiveLayout } from '../layout';
import { type TrackViewModel, useSessionActions, useSessionViewModel } from '../session';

const MIN_TRACK_VOLUME_DB = -60;
const MAX_TRACK_VOLUME_DB = 12;
const TRACK_VOLUME_STEP_DB = 1;
const MIN_TRACK_PAN = -1;
const MAX_TRACK_PAN = 1;
const TRACK_PAN_STEP = 0.1;

type MixerActions = Pick<
  ReturnType<typeof useSessionActions>,
  'setTrackMuted' | 'setTrackPan' | 'setTrackSolo' | 'setTrackVolume'
>;

interface ParameterControlProps {
  accessibilityLabel: string;
  disabled: boolean;
  label: string;
  maximum: number;
  minimum: number;
  onChange: (value: number) => Promise<void>;
  step: number;
  testID: string;
  value: number;
  valueText: string;
}

interface MixerChannelProps {
  actions: MixerActions;
  track: TrackViewModel;
  width: ViewStyle['width'];
}

interface MixerWidthInput {
  columns: number;
  contentWidth: number;
  gap: number;
}

const styles = StyleSheet.create({
  alertHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  channelBody: {
    alignItems: 'stretch',
    flexDirection: 'row',
  },
  channelControls: {
    flex: 1,
    minWidth: 0,
  },
  channelHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  fill: {
    width: '100%',
  },
  flexContent: {
    flex: 1,
    minWidth: 0,
  },
  meterColumn: {
    alignItems: 'center',
  },
  meterShell: {
    borderWidth: 1,
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  parameterRow: {
    alignItems: 'stretch',
    flexDirection: 'row',
  },
  safeContent: {
    alignSelf: 'stretch',
  },
  toggleButton: {
    alignSelf: 'stretch',
    flex: 1,
  },
  toggleRow: {
    flexDirection: 'row',
  },
});

const clampFinite = (
  value: number,
  minimum: number,
  maximum: number,
  fallback: number,
): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, value));
};

const clampAndRound = (value: number, minimum: number, maximum: number): number =>
  Number(clampFinite(value, minimum, maximum, minimum).toFixed(2));

export const clampMixerMeterLevel = (value: number): number =>
  clampFinite(value, 0, 1, 0);

export const resolveMixerColumnCount = (breakpoint: LayoutBreakpoint): number => {
  if (breakpoint === 'desktop') {
    return 3;
  }
  if (breakpoint === 'tablet') {
    return 2;
  }
  return 1;
};

export const resolveMixerChannelWidth = ({
  columns,
  contentWidth,
  gap,
}: MixerWidthInput): number => {
  const availableWidth = Math.max(0, contentWidth - gap * Math.max(0, columns - 1));
  return availableWidth / Math.max(1, columns);
};

const formatPan = (pan: number): string => {
  if (Math.abs(pan) < 0.005) {
    return 'Center';
  }
  const direction = pan < 0 ? 'left' : 'right';
  return `${Math.round(Math.abs(pan) * 100)}% ${direction}`;
};

const describeError = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim() ? error.message : fallback;

const ParameterControl: React.FC<ParameterControlProps> = ({
  accessibilityLabel,
  disabled,
  label,
  maximum,
  minimum,
  onChange,
  step,
  testID,
  value,
  valueText,
}) => {
  const theme = useTheme();
  const safeValue = clampFinite(value, minimum, maximum, minimum);
  const accessibilityPercent = Math.round(
    ((safeValue - minimum) / (maximum - minimum)) * 100,
  );
  const minimumTouchWidth = theme.spacing.xxl + theme.spacing.xs;
  const adjust = useCallback(
    (direction: -1 | 1) => {
      if (disabled) {
        return;
      }
      const nextValue = clampAndRound(safeValue + direction * step, minimum, maximum);
      onChange(nextValue).catch(() => undefined);
    },
    [disabled, maximum, minimum, onChange, safeValue, step],
  );
  const decrementDisabled = disabled || safeValue <= minimum;
  const incrementDisabled = disabled || safeValue >= maximum;
  const buttonStyle = useMemo<ViewStyle>(
    () => ({
      alignSelf: 'stretch',
      minWidth: minimumTouchWidth,
      paddingHorizontal: theme.spacing.sm,
    }),
    [minimumTouchWidth, theme.spacing.sm],
  );
  const valueStyle = useMemo<ViewStyle>(
    () => ({
      alignItems: 'center',
      backgroundColor: theme.colors.surfaceVariant,
      borderColor: theme.colors.border,
      borderRadius: theme.radii.md,
      borderWidth: 1,
      flex: 1,
      justifyContent: 'center',
      minHeight: minimumTouchWidth,
      paddingHorizontal: theme.spacing.sm,
    }),
    [
      minimumTouchWidth,
      theme.colors.border,
      theme.colors.surfaceVariant,
      theme.radii.md,
      theme.spacing.sm,
    ],
  );

  return (
    <View style={{ gap: theme.spacing.xs }}>
      <StudioText variant="caption" tone="muted" weight="bold">
        {label.toUpperCase()}
      </StudioText>
      <View style={[styles.parameterRow, { gap: theme.spacing.sm }]}>
        <StudioButton
          compact
          label="−"
          variant="secondary"
          accessibilityLabel={`Decrease ${accessibilityLabel}`}
          accessibilityHint={`Decreases ${label.toLowerCase()} by ${step}.`}
          disabled={decrementDisabled}
          onPress={() => adjust(-1)}
          style={buttonStyle}
        />
        <View
          accessible
          accessibilityActions={[{ name: 'decrement' }, { name: 'increment' }]}
          accessibilityHint="Swipe up or down to adjust, or use the adjacent buttons."
          accessibilityLabel={accessibilityLabel}
          accessibilityRole="adjustable"
          accessibilityState={{ disabled }}
          accessibilityValue={{
            min: 0,
            max: 100,
            now: accessibilityPercent,
            text: valueText,
          }}
          onAccessibilityAction={({ nativeEvent }) => {
            if (nativeEvent.actionName === 'decrement') {
              adjust(-1);
            } else if (nativeEvent.actionName === 'increment') {
              adjust(1);
            }
          }}
          style={valueStyle}
          testID={testID}
        >
          <StudioText variant="label" weight="bold">
            {valueText}
          </StudioText>
        </View>
        <StudioButton
          compact
          label="+"
          variant="secondary"
          accessibilityLabel={`Increase ${accessibilityLabel}`}
          accessibilityHint={`Increases ${label.toLowerCase()} by ${step}.`}
          disabled={incrementDisabled}
          onPress={() => adjust(1)}
          style={buttonStyle}
        />
      </View>
    </View>
  );
};

const MixerChannel: React.FC<MixerChannelProps> = ({ actions, track, width }) => {
  const theme = useTheme();
  const [actionError, setActionError] = useState<string>();
  const [isUpdating, setIsUpdating] = useState(false);
  const meterLevel = clampMixerMeterLevel(track.meterLevel);
  const meterPercent = Math.round(meterLevel * 100);
  const volumeDb = clampFinite(
    track.volumeDb,
    MIN_TRACK_VOLUME_DB,
    MAX_TRACK_VOLUME_DB,
    0,
  );
  const pan = clampFinite(track.pan, MIN_TRACK_PAN, MAX_TRACK_PAN, 0);
  const meterHeight = theme.spacing.xxl * 4;
  const meterWidth = theme.spacing.lg;

  const runAction = useCallback(
    async (fallbackMessage: string, operation: () => Promise<unknown>) => {
      setActionError(undefined);
      setIsUpdating(true);
      try {
        await operation();
      } catch (error) {
        console.error('Failed to update mixer track', {
          error,
          trackId: track.id,
        });
        setActionError(describeError(error, fallbackMessage));
      } finally {
        setIsUpdating(false);
      }
    },
    [track.id],
  );

  const setVolume = useCallback(
    (nextVolumeDb: number) =>
      runAction('Unable to update track volume.', () =>
        actions.setTrackVolume(
          track.id,
          clampAndRound(nextVolumeDb, MIN_TRACK_VOLUME_DB, MAX_TRACK_VOLUME_DB),
        ),
      ),
    [actions, runAction, track.id],
  );
  const setPan = useCallback(
    (nextPan: number) =>
      runAction('Unable to update track pan.', () =>
        actions.setTrackPan(
          track.id,
          clampAndRound(nextPan, MIN_TRACK_PAN, MAX_TRACK_PAN),
        ),
      ),
    [actions, runAction, track.id],
  );
  const toggleMuted = useCallback(
    () =>
      runAction('Unable to update track mute.', () =>
        actions.setTrackMuted(track.id, !track.muted),
      ),
    [actions, runAction, track.id, track.muted],
  );
  const toggleSolo = useCallback(
    () =>
      runAction('Unable to update track solo.', () =>
        actions.setTrackSolo(track.id, !track.solo),
      ),
    [actions, runAction, track.id, track.solo],
  );

  const status = useMemo<{
    icon: 'engine' | 'mute' | 'solo';
    label: string;
    tone: StudioTone;
  }>(() => {
    if (track.muted) {
      return { icon: 'mute', label: 'Muted', tone: 'warning' };
    }
    if (track.solo) {
      return { icon: 'solo', label: 'Solo', tone: 'magenta' };
    }
    return { icon: 'engine', label: 'Live', tone: 'mint' };
  }, [track.muted, track.solo]);

  const pluginBadges = useMemo(() => {
    if (track.plugins.length === 0) {
      return null;
    }
    return (
      <View
        style={{
          backgroundColor: theme.colors.surfaceVariant,
          borderRadius: theme.radii.md,
          gap: theme.spacing.sm,
          padding: theme.spacing.sm,
        }}
      >
        <StudioText variant="caption" tone="muted" weight="bold">
          INSERTS
        </StudioText>
        {track.plugins.map((plugin) => {
          let tone: StudioTone = 'secondary';
          if (plugin.status === 'active') {
            tone = 'success';
          } else if (plugin.status === 'crashed') {
            tone = 'critical';
          } else if (plugin.status === 'bypassed') {
            tone = 'warning';
          }
          return (
            <View
              key={plugin.id}
              style={[
                styles.alertHeader,
                {
                  backgroundColor: theme.colors.surfaceElevated,
                  borderRadius: theme.radii.sm,
                  gap: theme.spacing.sm,
                  minHeight: theme.spacing.xxl,
                  paddingHorizontal: theme.spacing.md,
                  paddingVertical: theme.spacing.sm,
                },
              ]}
            >
              <View style={styles.flexContent}>
                <StudioText variant="label" weight="medium" numberOfLines={1}>
                  {plugin.label}
                </StudioText>
                <StudioText variant="caption" tone="secondary">
                  {plugin.slot.toUpperCase()}
                </StudioText>
              </View>
              <StatusBadge label={plugin.status} tone={tone} />
            </View>
          );
        })}
      </View>
    );
  }, [
    theme.colors.surfaceElevated,
    theme.colors.surfaceVariant,
    theme.radii.md,
    theme.radii.sm,
    theme.spacing.md,
    theme.spacing.sm,
    theme.spacing.xxl,
    track.plugins,
  ]);

  return (
    <StudioPanel
      accessibilityLabel={`${track.name} mixer channel`}
      style={{ gap: theme.spacing.lg, width }}
      testID={`mixer-channel-${track.id}`}
    >
      <View style={[styles.channelHeader, { gap: theme.spacing.md }]}>
        <View style={styles.flexContent}>
          <StudioText variant="sectionTitle" weight="bold" numberOfLines={1}>
            {track.name}
          </StudioText>
          <StudioText variant="caption" tone="secondary">
            {volumeDb.toFixed(1)} dB · Pan {formatPan(pan)}
          </StudioText>
        </View>
        <StatusBadge icon={status.icon} label={status.label} tone={status.tone} />
      </View>

      <View style={[styles.channelBody, { gap: theme.spacing.lg }]}>
        <View style={[styles.meterColumn, { gap: theme.spacing.xs }]}>
          <StudioText variant="caption" tone="muted" weight="bold">
            LEVEL
          </StudioText>
          <View
            accessible
            accessibilityLabel={`${track.name} level meter`}
            accessibilityRole="progressbar"
            accessibilityValue={{
              min: 0,
              max: 100,
              now: meterPercent,
              text: `${meterPercent}%`,
            }}
            style={[
              styles.meterShell,
              {
                backgroundColor: theme.colors.surfaceVariant,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.pill,
                height: meterHeight,
                width: meterWidth,
              },
            ]}
            testID={`mixer-meter-${track.id}`}
          >
            <View
              importantForAccessibility="no-hide-descendants"
              style={[
                styles.fill,
                {
                  backgroundColor: theme.colors.accentPrimary,
                  borderRadius: theme.radii.pill,
                  height: meterHeight * meterLevel,
                },
              ]}
            />
          </View>
          <StudioText variant="caption" tone="mint" weight="bold">
            {meterPercent}%
          </StudioText>
        </View>

        <View style={[styles.channelControls, { gap: theme.spacing.md }]}>
          <ParameterControl
            accessibilityLabel={`${track.name} volume`}
            disabled={isUpdating}
            label="Volume"
            maximum={MAX_TRACK_VOLUME_DB}
            minimum={MIN_TRACK_VOLUME_DB}
            onChange={setVolume}
            step={TRACK_VOLUME_STEP_DB}
            testID={`mixer-volume-${track.id}`}
            value={volumeDb}
            valueText={`${volumeDb.toFixed(1)} dB`}
          />
          <ParameterControl
            accessibilityLabel={`${track.name} pan`}
            disabled={isUpdating}
            label="Pan"
            maximum={MAX_TRACK_PAN}
            minimum={MIN_TRACK_PAN}
            onChange={setPan}
            step={TRACK_PAN_STEP}
            testID={`mixer-pan-${track.id}`}
            value={pan}
            valueText={formatPan(pan)}
          />
          <View style={[styles.toggleRow, { gap: theme.spacing.sm }]}>
            <StudioButton
              compact
              label={track.muted ? 'Unmute' : 'Mute'}
              icon="mute"
              variant={track.muted ? 'primary' : 'secondary'}
              accessibilityHint={
                track.muted ? 'Restores this track to the mix.' : 'Silences this track.'
              }
              accessibilityLabel={`${track.name} mute`}
              accessibilityState={{ disabled: isUpdating, selected: track.muted }}
              disabled={isUpdating}
              onPress={() => {
                toggleMuted().catch(() => undefined);
              }}
              style={styles.toggleButton}
            />
            <StudioButton
              compact
              label={track.solo ? 'Unsolo' : 'Solo'}
              icon="solo"
              variant={track.solo ? 'primary' : 'secondary'}
              accessibilityHint={
                track.solo
                  ? 'Returns this track to the normal mix.'
                  : 'Auditions this track on its own.'
              }
              accessibilityLabel={`${track.name} solo`}
              accessibilityState={{ disabled: isUpdating, selected: track.solo }}
              disabled={isUpdating}
              onPress={() => {
                toggleSolo().catch(() => undefined);
              }}
              style={styles.toggleButton}
            />
          </View>
        </View>
      </View>

      {actionError ? (
        <StudioText accessibilityRole="alert" variant="caption" tone="critical">
          {actionError}
        </StudioText>
      ) : null}
      {pluginBadges}
    </StudioPanel>
  );
};

export const MixerScreen: React.FC = () => {
  const adaptive = useAdaptiveLayout();
  const theme = useTheme();
  const [safeContentWidth, setSafeContentWidth] = useState<number>();
  const sessionActions = useSessionActions();
  const { status, tracks, diagnostics, refresh, pluginAlerts, retryPlugin } =
    useSessionViewModel();
  const columns = resolveMixerColumnCount(adaptive.breakpoint);
  const channelGap = theme.spacing.lg;
  const channelWidth: ViewStyle['width'] =
    safeContentWidth === undefined
      ? '100%'
      : resolveMixerChannelWidth({
          columns,
          contentWidth: safeContentWidth,
          gap: channelGap,
        });
  const safeRenderLoad = clampMixerMeterLevel(diagnostics.renderLoad);
  const renderLoadPercent = Math.round(safeRenderLoad * 100);
  const safeXRuns = Number.isFinite(diagnostics.xruns)
    ? Math.max(0, Math.round(diagnostics.xruns))
    : 0;
  const diagnosticsTone: StudioTone =
    diagnostics.status === 'ready'
      ? 'mint'
      : diagnostics.status === 'error'
        ? 'critical'
        : diagnostics.status === 'unavailable'
          ? 'warning'
          : 'secondary';

  const channelListStyle = useMemo<ViewStyle>(
    () => ({
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: channelGap,
    }),
    [channelGap],
  );
  const handleSafeContentLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = Math.max(0, event.nativeEvent.layout.width);
    setSafeContentWidth((currentWidth) =>
      currentWidth === nextWidth ? currentWidth : nextWidth,
    );
  }, []);

  const handleRefresh = useCallback(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  const handleRetryPlugin = useCallback(
    (instanceId: string) => {
      retryPlugin(instanceId).catch((error) => {
        console.error('Failed to retry plugin instantiation', {
          error,
          instanceId,
        });
      });
    },
    [retryPlugin],
  );

  const pluginAlertToasts = useMemo(() => {
    if (pluginAlerts.length === 0) {
      return null;
    }
    return pluginAlerts.map((alert) => {
      const timestamp = new Date(alert.timestamp).toLocaleTimeString();
      const title = alert.descriptor?.name ?? alert.instanceId;
      const recovered = alert.recovered === true;
      const tone: StudioTone = recovered ? 'success' : 'critical';
      const actionLabel = recovered ? 'Recovered' : 'Retry';
      return (
        <StudioPanel
          key={`${alert.instanceId}:${alert.timestamp}`}
          accessibilityRole="alert"
          style={{
            borderColor: recovered
              ? theme.colors.statusSuccess
              : theme.colors.statusCritical,
            gap: theme.spacing.sm,
          }}
          variant="raised"
        >
          <View style={[styles.alertHeader, { gap: theme.spacing.sm }]}>
            <StudioText variant="body" weight="bold">
              {title}
            </StudioText>
            <StatusBadge label={recovered ? 'Recovered' : 'Plugin alert'} tone={tone} />
          </View>
          <StudioText variant="caption" tone="secondary">
            {timestamp} · {alert.reason}
          </StudioText>
          <StudioButton
            compact
            label={actionLabel}
            variant={recovered ? 'secondary' : 'primary'}
            disabled={recovered}
            onPress={() => handleRetryPlugin(alert.instanceId)}
            accessibilityHint={
              recovered
                ? 'Plugin already recovered'
                : 'Retry instantiating the crashed plugin'
            }
          />
        </StudioPanel>
      );
    });
  }, [
    handleRetryPlugin,
    pluginAlerts,
    theme.colors.statusCritical,
    theme.colors.statusSuccess,
    theme.spacing.sm,
  ]);

  const renderChannels = () => {
    if (status === 'loading' || status === 'idle') {
      return (
        <StudioPanel>
          <StudioText variant="body">Preparing mixer channels...</StudioText>
        </StudioPanel>
      );
    }
    if (status === 'error') {
      return (
        <StudioPanel>
          <StudioText accessibilityRole="alert" variant="body" tone="critical">
            Mixer data unavailable.
          </StudioText>
        </StudioPanel>
      );
    }
    if (tracks.length === 0) {
      return (
        <ScreenState
          illustrationSource={require('../../../assets/ui/mixer-routing-empty.webp')}
          kind="empty"
          message="Add an instrument in Performance to route its output into the mixer."
          title="No tracks routed to the mixer yet."
        />
      );
    }
    return (
      <View style={channelListStyle} testID="mixer-channel-list">
        {tracks.map((track) => (
          <MixerChannel
            key={track.id}
            actions={sessionActions}
            track={track}
            width={channelWidth}
          />
        ))}
      </View>
    );
  };

  return (
    <ScreenScaffold
      actions={
        <StudioButton
          compact
          label="Refresh"
          variant="secondary"
          onPress={handleRefresh}
        />
      }
      contentContainerStyle={{ gap: theme.spacing.lg }}
      detail={`${tracks.length} ${tracks.length === 1 ? 'channel' : 'channels'}`}
      title="Mixer"
    >
      <View
        onLayout={handleSafeContentLayout}
        style={[styles.safeContent, { gap: theme.spacing.lg }]}
        testID="mixer-safe-content"
      >
        {pluginAlertToasts ? (
          <View style={{ gap: theme.spacing.md }}>{pluginAlertToasts}</View>
        ) : null}
        {diagnostics.status !== 'unavailable' ? (
          <StudioPanel
            accessibilityLabel="Audio engine diagnostics"
            style={{ gap: theme.spacing.sm }}
            variant="subtle"
          >
            <View style={[styles.alertHeader, { gap: theme.spacing.md }]}>
              <StudioText accessibilityRole="header" variant="sectionTitle" weight="bold">
                Audio Engine Diagnostics
              </StudioText>
              <StatusBadge label={diagnostics.status} tone={diagnosticsTone} />
            </View>
            <StudioText variant="body">XRuns detected: {safeXRuns}</StudioText>
            <StudioText variant="body" tone="secondary">
              Render load: {renderLoadPercent}% · Status: {diagnostics.status}
            </StudioText>
          </StudioPanel>
        ) : null}
        {renderChannels()}
      </View>
    </ScreenScaffold>
  );
};
