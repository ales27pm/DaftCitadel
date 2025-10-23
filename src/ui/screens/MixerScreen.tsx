import React, { useCallback, useEffect, useMemo } from 'react';
import { SafeAreaView, ScrollView, View, StyleSheet, ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import {
  NeonButton,
  NeonSurface,
  NeonText,
  NeonToolbar,
  ThemeIntent,
} from '../design-system';
import { useAdaptiveLayout } from '../layout';
import { TrackViewModel, useSessionViewModel } from '../session';

const channelStyles = StyleSheet.create({
  container: { margin: 12, flexBasis: '45%' },
  meterShell: {
    marginTop: 16,
    height: 180,
    width: 24,
    borderRadius: 12,
    backgroundColor: '#1C1F2E',
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  meterFill: {
    width: '100%',
    borderRadius: 12,
    backgroundColor: '#50E3C2',
  },
  pluginRow: {
    marginTop: 12,
    borderRadius: 8,
    backgroundColor: '#16182A',
    padding: 8,
  },
  pluginPill: {
    marginTop: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: '#20233B',
  },
});

const screenStyles = StyleSheet.create({
  safeArea: { flex: 1 },
  alertContainer: {
    marginHorizontal: 16,
    marginTop: 12,
    gap: 12,
  },
  retryButton: {
    marginTop: 8,
    alignSelf: 'flex-start',
  },
});

const MixerChannel: React.FC<{ track: TrackViewModel }> = ({ track }) => {
  const level = useSharedValue(track.meterLevel);

  useEffect(() => {
    level.value = withTiming(track.meterLevel, { duration: 220 });
  }, [level, track.meterLevel]);

  const animatedStyle = useAnimatedStyle(() => ({
    height: 180 * level.value,
  }));

  const statusLabel = useMemo(() => {
    if (track.muted) {
      return 'Muted';
    }
    if (track.solo) {
      return 'Solo';
    }
    return 'Live';
  }, [track.muted, track.solo]);

  const pluginBadges = useMemo(() => {
    if (track.plugins.length === 0) {
      return null;
    }
    return (
      <View style={channelStyles.pluginRow}>
        <NeonText variant="body" intent="secondary" weight="medium">
          Inserts
        </NeonText>
        {track.plugins.map((plugin) => {
          let intent: ThemeIntent = 'secondary';
          let statusText = plugin.status;
          if (plugin.status === 'crashed') {
            intent = 'critical';
            statusText = 'crashed';
          } else if (plugin.status === 'bypassed') {
            intent = 'warning';
            statusText = 'bypassed';
          }
          return (
            <View key={plugin.id} style={channelStyles.pluginPill}>
              <NeonText variant="body" weight="medium">
                {plugin.label} • {plugin.slot.toUpperCase()}
              </NeonText>
              <NeonText variant="caption" intent={intent}>
                {statusText}
              </NeonText>
            </View>
          );
        })}
      </View>
    );
  }, [track.plugins]);

  return (
    <NeonSurface style={channelStyles.container}>
      <NeonText variant="title" weight="medium">
        {track.name}
      </NeonText>
      <NeonText variant="body" intent="secondary">
        {statusLabel} • {track.volumeDb.toFixed(1)} dB • Pan {track.pan.toFixed(2)}
      </NeonText>
      <View accessibilityLabel={`${track.name} level`} style={channelStyles.meterShell}>
        <Animated.View style={[channelStyles.meterFill, animatedStyle]} />
      </View>
      {pluginBadges}
    </NeonSurface>
  );
};

export const MixerScreen: React.FC = () => {
  const adaptive = useAdaptiveLayout();
  const { status, tracks, diagnostics, refresh, pluginAlerts, retryPlugin } =
    useSessionViewModel();
  const channelListStyle = useMemo<ViewStyle>(
    () => ({
      paddingHorizontal: adaptive.breakpoint === 'phone' ? 12 : 32,
      flexDirection: 'row',
      flexWrap: 'wrap',
    }),
    [adaptive.breakpoint],
  );
  const diagnosticsCardStyle = useMemo(() => ({ margin: 16 }), []);
  const statusTextStyle = useMemo(() => ({ marginTop: 8 }), []);
  const alertContainerStyle = useMemo(
    () => [
      screenStyles.alertContainer,
      { paddingHorizontal: adaptive.breakpoint === 'phone' ? 16 : 32 },
    ],
    [adaptive.breakpoint],
  );

  const handleRefresh = useCallback(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  const handleRetryPlugin = useCallback(
    (instanceId: string) => {
      retryPlugin(instanceId).catch((error) => {
        console.error('Failed to retry plugin instantiation', error);
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
      const intent: ThemeIntent = recovered ? 'success' : 'critical';
      const actionLabel = recovered ? 'Recovered' : 'Retry';
      return (
        <NeonSurface
          key={`${alert.instanceId}:${alert.timestamp}`}
          intent={intent}
          accessibilityRole="alert"
        >
          <NeonText variant="body" weight="medium">
            {title}
          </NeonText>
          <NeonText variant="caption" intent="secondary">
            {timestamp} • {alert.reason}
          </NeonText>
          <NeonButton
            label={actionLabel}
            intent={recovered ? 'secondary' : 'primary'}
            disabled={recovered}
            onPress={() => handleRetryPlugin(alert.instanceId)}
            accessibilityHint={
              recovered
                ? 'Plugin already recovered'
                : 'Retry instantiating the crashed plugin'
            }
            style={screenStyles.retryButton}
          />
        </NeonSurface>
      );
    });
  }, [handleRetryPlugin, pluginAlerts]);

  const renderChannels = () => {
    if (status === 'loading' || status === 'idle') {
      return (
        <NeonSurface style={diagnosticsCardStyle}>
          <NeonText variant="body">Preparing mixer channels...</NeonText>
        </NeonSurface>
      );
    }
    if (status === 'error') {
      return (
        <NeonSurface style={diagnosticsCardStyle}>
          <NeonText variant="body" intent="critical">
            Mixer data unavailable.
          </NeonText>
        </NeonSurface>
      );
    }
    if (tracks.length === 0) {
      return (
        <NeonSurface style={diagnosticsCardStyle}>
          <NeonText variant="body">No tracks routed to the mixer yet.</NeonText>
        </NeonSurface>
      );
    }
    return (
      <View style={channelListStyle}>
        {tracks.map((track) => (
          <MixerChannel key={track.id} track={track} />
        ))}
      </View>
    );
  };

  return (
    <SafeAreaView style={screenStyles.safeArea}>
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        <NeonToolbar
          title="Mixer"
          actions={[{ label: 'Refresh', onPress: handleRefresh, intent: 'secondary' }]}
        />
        {pluginAlertToasts && (
          <View style={alertContainerStyle}>{pluginAlertToasts}</View>
        )}
        <NeonSurface style={diagnosticsCardStyle}>
          <NeonText variant="title" weight="medium">
            Audio Engine Diagnostics
          </NeonText>
          <NeonText variant="body" style={statusTextStyle}>
            XRuns detected: {diagnostics.xruns}
          </NeonText>
          <NeonText variant="body" intent="secondary">
            Render load: {(diagnostics.renderLoad * 100).toFixed(0)}% • Status:{' '}
            {diagnostics.status}
          </NeonText>
        </NeonSurface>
        {renderChannels()}
      </ScrollView>
    </SafeAreaView>
  );
};
