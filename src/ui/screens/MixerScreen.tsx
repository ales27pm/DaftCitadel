import React, { useEffect, useMemo } from 'react';
import { SafeAreaView, ScrollView, View, StyleSheet, ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { NeonSurface, NeonText, NeonToolbar } from '../design-system';
import { useAdaptiveLayout } from '../layout';

const MIXER_CHANNELS = ['Drums', 'Bass', 'Lead', 'Pad', 'FX'];

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
});

const screenStyles = StyleSheet.create({
  safeArea: { flex: 1 },
});

const MixerChannel: React.FC<{ name: string }> = ({ name }) => {
  const level = useSharedValue(Math.random());

  useEffect(() => {
    level.value = withRepeat(withTiming(Math.random(), { duration: 1500 }), -1, true);
  }, [level]);

  const animatedStyle = useAnimatedStyle(() => ({
    height: 180 * level.value,
  }));

  return (
    <NeonSurface style={channelStyles.container}>
      <NeonText variant="title" weight="medium">
        {name}
      </NeonText>
      <View accessibilityLabel={`${name} level`} style={channelStyles.meterShell}>
        <Animated.View style={[channelStyles.meterFill, animatedStyle]} />
      </View>
    </NeonSurface>
  );
};

export const MixerScreen: React.FC = () => {
  const adaptive = useAdaptiveLayout();
  const channelListStyle = useMemo<ViewStyle>(
    () => ({
      paddingHorizontal: adaptive.breakpoint === 'phone' ? 12 : 32,
      flexDirection: 'row',
      flexWrap: 'wrap',
    }),
    [adaptive.breakpoint],
  );

  return (
    <SafeAreaView style={screenStyles.safeArea}>
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        <NeonToolbar title="Mixer" />
        <View style={channelListStyle}>
          {MIXER_CHANNELS.map((channel) => (
            <MixerChannel key={channel} name={channel} />
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};
