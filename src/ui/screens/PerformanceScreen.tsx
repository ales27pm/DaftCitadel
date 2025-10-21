import React, { useEffect, useMemo, useState } from 'react';
import { SafeAreaView, ScrollView, View } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { NeonButton, NeonSurface, NeonText, NeonToolbar } from '../design-system';
import { useAdaptiveLayout } from '../layout';

const SCENES = ['Intro', 'Verse', 'Chorus', 'Bridge', 'Outro'];

export const PerformanceScreen: React.FC = () => {
  const adaptive = useAdaptiveLayout();
  const bpm = useSharedValue(128);
  const bpmDisplay = useDerivedValue(() => bpm.value);
  const [displayBpm, setDisplayBpm] = useState(128);
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

  useEffect(() => {
    bpm.value = withRepeat(withTiming(132, { duration: 2000 }), -1, true);
  }, [bpm]);

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
          adaptive.prefersReducedMotion ? 1 : 1 + (bpm.value - 128) / 256,
          { duration: 150 },
        ),
      },
    ],
  }));

  return (
    <SafeAreaView style={safeAreaStyle}>
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        <NeonToolbar
          title="Performance"
          actions={[{ label: 'Record', onPress: () => undefined, intent: 'critical' }]}
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
              {adaptive.platform === 'ios'
                ? 'Using CoreMIDI with NetworkSession for wireless sync.'
                : 'Android MIDI over Bluetooth is active.'}
            </NeonText>
          </NeonSurface>
          <NeonSurface>
            <NeonText variant="title" weight="medium">
              Scene Launcher
            </NeonText>
            <View style={sceneRowStyle}>
              {SCENES.map((scene) => (
                <View key={scene} style={sceneButtonStyle}>
                  <NeonButton
                    label={scene}
                    onPress={() => undefined}
                    intent="secondary"
                  />
                </View>
              ))}
            </View>
          </NeonSurface>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};
