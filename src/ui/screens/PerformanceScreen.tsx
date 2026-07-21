import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { NeonButton, NeonSurface, NeonText, NeonToolbar } from '../design-system';
import { useAdaptiveLayout } from '../layout';
import {
  useSessionViewModel,
  useProjectedTransport,
  useTransportControls,
} from '../session';
import { useUserPreferences } from '../settings';

const MotionView = Platform.OS === 'web' ? View : Animated.View;

export const PerformanceScreen: React.FC = () => {
  const adaptive = useAdaptiveLayout();
  const { status, transport, tracks, diagnostics, refresh } = useSessionViewModel();
  const transportControls = useTransportControls();
  const { preferences } = useUserPreferences();
  const { projectedBeats } = useProjectedTransport(transport);
  const bpm = useSharedValue(transport?.bpm ?? 0);
  const renderLoad = useSharedValue(diagnostics.renderLoad);
  const [activeScene, setActiveScene] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const safeAreaStyle = useMemo(() => ({ flex: 1 }), []);
  const contentStyle = useMemo(
    () => ({ padding: adaptive.breakpoint === 'phone' ? 12 : 32 }),
    [adaptive.breakpoint],
  );
  const statusCardStyle = useMemo(() => ({ marginBottom: 24 }), []);
  const bpmContainerStyle = useMemo(() => ({ marginTop: 16 }), []);
  const statusTextStyle = useMemo(() => ({ marginTop: 8 }), []);
  const sceneRowStyle = useMemo(
    () => ({ flexDirection: 'row' as const, flexWrap: 'wrap' as const, marginTop: 12 }),
    [],
  );
  const sceneButtonStyle = useMemo(() => ({ margin: 6, minWidth: 120 }), []);
  const scenes = useMemo(() => {
    const byName = new Map<string, { name: string; startMs: number }>();
    tracks.forEach((track) => {
      track.clips.forEach((clip) => {
        const current = byName.get(clip.name);
        if (!current || clip.startMs < current.startMs) {
          byName.set(clip.name, { name: clip.name, startMs: clip.startMs });
        }
      });
    });
    return Array.from(byName.values()).sort(
      (left, right) => left.startMs - right.startMs,
    );
  }, [tracks]);

  useEffect(() => {
    if (transport) {
      bpm.value = withTiming(transport.bpm, { duration: 300 });
    }
  }, [bpm, transport]);

  useEffect(() => {
    renderLoad.value = withTiming(diagnostics.renderLoad, { duration: 220 });
  }, [diagnostics.renderLoad, renderLoad]);

  const bpmStyle = useAnimatedStyle(() => ({
    transform: [
      {
        scale: withTiming(
          adaptive.prefersReducedMotion ? 1 : 1 + (1 - renderLoad.value) * 0.2,
          { duration: 150 },
        ),
      },
    ],
  }));

  const handleRefresh = useCallback(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  const handlePlay = useCallback(() => {
    setActionError(undefined);
    transportControls.play().catch((error) => {
      setActionError(
        error instanceof Error ? error.message : 'Unable to start transport',
      );
    });
  }, [transportControls]);

  const handleStop = useCallback(() => {
    setActionError(undefined);
    transportControls.stop().catch((error) => {
      setActionError(error instanceof Error ? error.message : 'Unable to stop transport');
    });
  }, [transportControls]);

  const handleSceneLaunch = useCallback(
    async (scene: { name: string; startMs: number }) => {
      const bpmValue = transport?.bpm ?? 120;
      const beats = (scene.startMs / 60000) * bpmValue;
      setActionError(undefined);
      try {
        await transportControls.locateBeats(beats);
        if (preferences.autoPlayScenes && !transportControls.isPlaying) {
          await transportControls.play();
        }
        setActiveScene(scene.name);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : 'Unable to launch scene');
      }
    },
    [preferences.autoPlayScenes, transport?.bpm, transportControls],
  );

  return (
    <SafeAreaView style={safeAreaStyle}>
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        <NeonToolbar
          title="Performance"
          actions={[
            {
              label: 'Play',
              onPress: handlePlay,
              intent: 'primary',
              disabled: !transportControls.isAvailable || transportControls.isPlaying,
            },
            {
              label: 'Stop',
              onPress: handleStop,
              intent: 'secondary',
              disabled: !transportControls.isAvailable || !transportControls.isPlaying,
            },
            { label: 'Refresh', onPress: handleRefresh, intent: 'secondary' },
          ]}
        />
        <View style={contentStyle}>
          <NeonSurface style={statusCardStyle}>
            <NeonText variant="headline" weight="bold">
              Live Status
            </NeonText>
            <MotionView style={[bpmContainerStyle, bpmStyle]}>
              <NeonText variant="title" weight="medium" intent="tertiary">
                {Math.round(transport?.bpm ?? 0)} BPM
              </NeonText>
            </MotionView>
            <NeonText variant="body" style={statusTextStyle}>
              {status === 'ready'
                ? `Time Signature ${transport?.timeSignature ?? '4/4'} • Playhead ${
                    transport ? projectedBeats.toFixed(2) : '0.00'
                  } beats`
                : 'Connecting to transport controller...'}
            </NeonText>
            {preferences.showDiagnostics && (
              <NeonText variant="body" intent="secondary" style={statusTextStyle}>
                XRuns: {diagnostics.xruns} • Engine load{' '}
                {(diagnostics.renderLoad * 100).toFixed(0)}%
              </NeonText>
            )}
            {actionError && (
              <NeonText variant="body" intent="critical" style={statusTextStyle}>
                {actionError}
              </NeonText>
            )}
          </NeonSurface>
          <NeonSurface>
            <NeonText variant="title" weight="medium">
              Scene Launcher
            </NeonText>
            <View style={sceneRowStyle}>
              {scenes.length === 0 ? (
                <NeonText variant="body">No scenes detected in current session.</NeonText>
              ) : (
                scenes.map((scene) => (
                  <View key={scene.name} style={sceneButtonStyle}>
                    <NeonButton
                      label={scene.name}
                      onPress={() => {
                        handleSceneLaunch(scene).catch(() => undefined);
                      }}
                      intent={activeScene === scene.name ? 'success' : 'secondary'}
                      disabled={!transportControls.isAvailable}
                    />
                  </View>
                ))
              )}
            </View>
          </NeonSurface>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};
