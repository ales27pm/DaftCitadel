import React, { useEffect, useMemo, useState } from 'react';
import { SafeAreaView, ScrollView, View } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { NeonButton, NeonSurface, NeonText, NeonToolbar } from '../design-system';
import { useAdaptiveLayout } from '../layout';
import { useSessionViewModel } from '../session';

export const PerformanceScreen: React.FC = () => {
  const adaptive = useAdaptiveLayout();
  const { status, transport, tracks, diagnostics, refresh } = useSessionViewModel();
  const bpm = useSharedValue(transport?.bpm ?? 0);
  const renderLoad = useSharedValue(diagnostics.renderLoad);
  const bpmDisplay = useDerivedValue(() => bpm.value);
  const [displayBpm, setDisplayBpm] = useState(transport?.bpm ?? 0);
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
    const names = new Set<string>();
    tracks.forEach((track) => {
      track.clips.forEach((clip) => names.add(clip.name));
    });
    return Array.from(names);
  }, [tracks]);

  useEffect(() => {
    if (transport) {
      bpm.value = withTiming(transport.bpm, { duration: 300 });
    }
  }, [bpm, transport]);

  useEffect(() => {
    renderLoad.value = withTiming(diagnostics.renderLoad, { duration: 220 });
  }, [diagnostics.renderLoad, renderLoad]);

  useAnimatedReaction(
    () => bpmDisplay.value,
    (value) => {
      runOnJS(setDisplayBpm)(Math.round(value));
    },
    [bpmDisplay],
  );

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

  const handleRefresh = () => {
    refresh().catch(() => undefined);
  };

  return (
    <SafeAreaView style={safeAreaStyle}>
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        <NeonToolbar
          title="Performance"
          actions={[
            { label: 'Record', onPress: () => undefined, intent: 'critical' },
            { label: 'Refresh', onPress: handleRefresh, intent: 'secondary' },
          ]}
        />
        <View style={contentStyle}>
          <NeonSurface style={statusCardStyle}>
            <NeonText variant="headline" weight="bold">
              Live Status
            </NeonText>
            <Animated.View style={[bpmContainerStyle, bpmStyle]}>
              <NeonText variant="title" weight="medium" intent="tertiary">
                {displayBpm} BPM
              </NeonText>
            </Animated.View>
            <NeonText variant="body" style={statusTextStyle}>
              {status === 'ready'
                ? `Time Signature ${transport?.timeSignature ?? '4/4'} • Playhead ${
                    transport ? transport.playheadBeats.toFixed(2) : '0.00'
                  } beats`
                : 'Connecting to transport controller...'}
            </NeonText>
            <NeonText variant="body" intent="secondary" style={statusTextStyle}>
              XRuns: {diagnostics.xruns} • Engine load{' '}
              {(diagnostics.renderLoad * 100).toFixed(0)}%
            </NeonText>
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
                  <View key={scene} style={sceneButtonStyle}>
                    <NeonButton
                      label={scene}
                      onPress={() => undefined}
                      intent="secondary"
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
