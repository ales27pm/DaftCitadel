import React, { useCallback, useMemo, useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { NeonButton, NeonSurface, NeonText, NeonToolbar } from '../design-system';
import { useAdaptiveLayout } from '../layout';
import { useSessionViewModel } from '../session';
import { useUserPreferences } from '../settings';

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  card: { marginBottom: 16 },
  sectionTitle: { marginBottom: 12 },
  preferenceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
  },
  preferenceCopy: { flex: 1, paddingRight: 16 },
  description: { marginTop: 4 },
  diagnosticsLine: { marginTop: 8 },
  detailsButton: { alignSelf: 'flex-start', marginTop: 16 },
  details: { marginTop: 16 },
});

export const SettingsScreen: React.FC = () => {
  const adaptive = useAdaptiveLayout();
  const { preferences, setPreference } = useUserPreferences();
  const {
    status,
    sessionId,
    sessionName,
    tracks,
    diagnostics,
    error: sessionError,
  } = useSessionViewModel();
  const [detailsVisible, setDetailsVisible] = useState(false);
  const contentStyle = useMemo(
    () => ({ padding: adaptive.breakpoint === 'phone' ? 12 : 32 }),
    [adaptive.breakpoint],
  );
  const diagnosticsAvailable = diagnostics.status === 'ready';
  const diagnosticsSummary =
    diagnostics.status === 'ready'
      ? `${Math.round(diagnostics.renderLoad * 100)}% render load • ${diagnostics.xruns} xruns detected`
      : diagnostics.status === 'error'
        ? diagnostics.error?.message || 'Audio diagnostics failed.'
        : 'Render load: Unavailable • XRun count: Unavailable';
  const toggleDetails = useCallback(() => setDetailsVisible((visible) => !visible), []);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        <NeonToolbar title="Settings" />
        <View style={contentStyle}>
          <NeonSurface style={styles.card}>
            <NeonText variant="title" weight="medium">
              Performance preferences
            </NeonText>
            <View style={styles.preferenceRow}>
              <View style={styles.preferenceCopy}>
                <NeonText variant="bodyLarge" weight="medium">
                  Auto-play scenes
                </NeonText>
                <NeonText variant="body" intent="secondary" style={styles.description}>
                  Start transport when a performance scene is launched.
                </NeonText>
              </View>
              <Switch
                value={preferences.autoPlayScenes}
                onValueChange={(value) => setPreference('autoPlayScenes', value)}
                accessibilityLabel="Auto-play scenes"
              />
            </View>
            <View style={styles.preferenceRow}>
              <View style={styles.preferenceCopy}>
                <NeonText variant="bodyLarge" weight="medium">
                  Show diagnostics
                </NeonText>
                <NeonText variant="body" intent="secondary" style={styles.description}>
                  Display live render load and XRun information during performance.
                </NeonText>
              </View>
              <Switch
                value={preferences.showDiagnostics}
                onValueChange={(value) => setPreference('showDiagnostics', value)}
                accessibilityLabel="Show diagnostics"
              />
            </View>
          </NeonSurface>

          <NeonSurface style={styles.card}>
            <NeonText variant="title" weight="medium" style={styles.sectionTitle}>
              Troubleshooting
            </NeonText>
            <NeonText
              variant="body"
              intent={diagnosticsAvailable ? 'secondary' : 'critical'}
            >
              {diagnosticsSummary}
            </NeonText>
            <NeonText variant="body" intent="secondary" style={styles.diagnosticsLine}>
              Audio session: {status}
            </NeonText>
            <NeonButton
              label={detailsVisible ? 'Hide details' : 'Show details'}
              intent="secondary"
              onPress={toggleDetails}
              style={styles.detailsButton}
            />
            {detailsVisible && (
              <View style={styles.details}>
                <NeonText variant="body" weight="medium">
                  {sessionName || 'Unnamed session'}
                </NeonText>
                <NeonText
                  variant="body"
                  intent="secondary"
                  style={styles.diagnosticsLine}
                >
                  Session ID: {sessionId || 'Unavailable'}
                </NeonText>
                <NeonText variant="body" style={styles.diagnosticsLine}>
                  Tracks: {tracks.length}
                </NeonText>
                <NeonText variant="body" style={styles.diagnosticsLine}>
                  {diagnosticsAvailable
                    ? `${Math.round(diagnostics.renderLoad * 100)}% render load`
                    : 'Render load unavailable'}
                </NeonText>
                <NeonText variant="body" style={styles.diagnosticsLine}>
                  {diagnosticsAvailable
                    ? `${diagnostics.xruns} xruns detected`
                    : 'XRun count unavailable'}
                </NeonText>
                <NeonText variant="body" style={styles.diagnosticsLine}>
                  Screen reader {adaptive.screenReaderEnabled ? 'enabled' : 'disabled'}
                </NeonText>
                <NeonText variant="body" style={styles.diagnosticsLine}>
                  Reduced motion {adaptive.prefersReducedMotion ? 'enabled' : 'disabled'}
                </NeonText>
                {sessionError && (
                  <NeonText
                    variant="body"
                    intent="critical"
                    style={styles.diagnosticsLine}
                  >
                    Session error: {sessionError.message}
                  </NeonText>
                )}
              </View>
            )}
          </NeonSurface>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};
