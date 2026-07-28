import React, { useEffect, useMemo, useState } from 'react';
import { SafeAreaView, ScrollView, View } from 'react-native';

import { NeonSurface, NeonText, NeonToolbar } from '../design-system';
import { useAdaptiveLayout } from '../layout';
import { useSessionViewModel, useProjectedTransport } from '../session';
import { JunoPerformancePanel } from './JunoPerformancePanel';

export const PerformanceScreen: React.FC = () => {
  const adaptive = useAdaptiveLayout();
  const { status, transport, tracks, diagnostics, refresh } = useSessionViewModel();
  const { projectedBeats } = useProjectedTransport(transport);
  const [displayBpm, setDisplayBpm] = useState(transport?.bpm ?? 0);
  const safeAreaStyle = useMemo(() => ({ flex: 1 }), []);
  const contentStyle = useMemo(
    () => ({ padding: adaptive.breakpoint === 'phone' ? 12 : 32 }),
    [adaptive.breakpoint],
  );
  const statusCardStyle = useMemo(() => ({ marginBottom: 24 }), []);
  const bpmContainerStyle = useMemo(() => ({ marginTop: 16 }), []);
  const statusTextStyle = useMemo(() => ({ marginTop: 8 }), []);

  useEffect(() => {
    setDisplayBpm(Math.round(transport?.bpm ?? 0));
  }, [transport?.bpm]);

  const bpmStyle = useMemo(
    () => ({
      transform: [
        {
          scale: adaptive.prefersReducedMotion
            ? 1
            : 1 + (1 - diagnostics.renderLoad) * 0.2,
        },
      ],
    }),
    [adaptive.prefersReducedMotion, diagnostics.renderLoad],
  );

  const handleRefresh = () => {
    refresh().catch(() => undefined);
  };

  return (
    <SafeAreaView style={safeAreaStyle}>
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        <NeonToolbar
          title="Performance"
          actions={[{ label: 'Refresh', onPress: handleRefresh, intent: 'secondary' }]}
        />
        <View style={contentStyle}>
          <NeonSurface style={statusCardStyle}>
            <NeonText variant="headline" weight="bold">
              Live Status
            </NeonText>
            <View style={[bpmContainerStyle, bpmStyle]}>
              <NeonText variant="title" weight="medium" intent="tertiary">
                {displayBpm} BPM
              </NeonText>
            </View>
            <NeonText variant="body" style={statusTextStyle}>
              {status === 'ready'
                ? `Time Signature ${transport?.timeSignature ?? '4/4'} • Playhead ${
                    transport ? projectedBeats.toFixed(2) : '0.00'
                  } beats`
                : 'Connecting to transport controller...'}
            </NeonText>
            <NeonText variant="body" intent="secondary" style={statusTextStyle}>
              XRuns: {diagnostics.xruns} • Engine load{' '}
              {(diagnostics.renderLoad * 100).toFixed(0)}%
            </NeonText>
          </NeonSurface>
          <JunoPerformancePanel status={status} tracks={tracks} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};
