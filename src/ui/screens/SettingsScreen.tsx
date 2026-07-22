import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Switch, View, type ViewStyle } from 'react-native';
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
import { useSessionViewModel } from '../session';
import { useUserPreferences, type UserPreferences } from '../settings';

const SETTINGS: ReadonlyArray<{
  key: keyof UserPreferences;
  label: string;
  description: string;
}> = [
  {
    key: 'autoPlayScenes',
    label: 'Auto-play scenes',
    description: 'Start transport immediately after locating a scene.',
  },
  {
    key: 'showDiagnostics',
    label: 'Show performance diagnostics',
    description: 'Display audio load and xrun metrics on performance surfaces.',
  },
];

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  scrollContent: { paddingBottom: 32 },
  page: { alignSelf: 'center', width: '100%' },
  header: { marginBottom: 18 },
  group: { marginBottom: 14 },
  preferenceList: { gap: 10, marginTop: 16 },
  preferenceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    justifyContent: 'space-between',
  },
  preferenceCopy: { flex: 1, minWidth: 0 },
  description: { marginTop: 3 },
  disclosureHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  disclosureTitle: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 10,
    minWidth: 0,
  },
  disclosureCopy: { flex: 1, minWidth: 0 },
  details: { gap: 10, marginTop: 16 },
  detailGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  detailCard: { flexBasis: 220, flexGrow: 1, minWidth: 0 },
  detailValue: { marginTop: 4 },
  errorMessage: { marginTop: 10 },
});

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
    ? { label: 'Attention recommended', tone: 'warning' }
    : { label: 'Engine ready', tone: 'success' };
};

export const SettingsScreen: React.FC = () => {
  const theme = useTheme();
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
  const [troubleshootingExpanded, setTroubleshootingExpanded] = useState(false);
  const compactDisclosure = adaptive.workspaceMode === 'deck';
  const disclosureButtonLabel = compactDisclosure
    ? troubleshootingExpanded
      ? 'Hide'
      : 'Details'
    : troubleshootingExpanded
      ? 'Hide details'
      : 'Show details';

  const pageStyle = useMemo<ViewStyle>(
    () => ({
      maxWidth: Math.min(adaptive.maxContentWidth, 720),
      paddingHorizontal: adaptive.contentPadding,
      paddingTop: adaptive.isLandscape ? 10 : 18,
    }),
    [adaptive.contentPadding, adaptive.isLandscape, adaptive.maxContentWidth],
  );
  const diagnosticsState = diagnosticsPresentation(diagnostics.status, diagnostics.xruns);
  const renderLoad = Number.isFinite(diagnostics.renderLoad)
    ? Math.max(0, Math.min(1, diagnostics.renderLoad))
    : 0;
  const sessionStatusTone: StudioTone =
    status === 'error' ? 'critical' : status === 'ready' ? 'success' : 'secondary';

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
              eyebrow="Daft Citadel"
              title="Settings"
              detail="Performance behavior and support information"
            />
          </View>

          <StudioPanel style={styles.group}>
            <SectionHeader
              title="Performance preferences"
              detail="Choose how live controls behave without changing session content."
            />
            <View style={styles.preferenceList}>
              {SETTINGS.map((setting) => {
                const enabled = preferences[setting.key];
                return (
                  <StudioPanel
                    key={setting.key}
                    padding={12}
                    variant="subtle"
                    style={styles.preferenceRow}
                  >
                    <View style={styles.preferenceCopy}>
                      <StudioText variant="label" weight="bold">
                        {setting.label}
                      </StudioText>
                      <StudioText
                        variant="caption"
                        tone="secondary"
                        style={styles.description}
                      >
                        {setting.description}
                      </StudioText>
                    </View>
                    <Switch
                      accessibilityLabel={setting.label}
                      ios_backgroundColor={theme.colors.surfacePressed}
                      onValueChange={(value) => setPreference(setting.key, value)}
                      trackColor={{
                        false: theme.colors.surfacePressed,
                        true: theme.colors.accentPrimary,
                      }}
                      value={enabled}
                    />
                  </StudioPanel>
                );
              })}
            </View>
          </StudioPanel>

          <StudioPanel style={styles.group}>
            <View style={styles.disclosureHeader}>
              <View style={styles.disclosureTitle}>
                <StudioIcon name="diagnostics" size={22} />
                <View style={styles.disclosureCopy}>
                  <StudioText variant="sectionTitle" weight="bold">
                    Troubleshooting
                  </StudioText>
                  <StudioText variant="caption" tone="secondary">
                    Session, audio engine, and accessibility status.
                  </StudioText>
                </View>
              </View>
              <StudioButton
                compact
                accessibilityLabel={`${
                  troubleshootingExpanded ? 'Hide' : 'Show'
                } troubleshooting details`}
                icon={troubleshootingExpanded ? 'chevronUp' : 'chevronDown'}
                label={disclosureButtonLabel}
                variant="ghost"
                onPress={() => setTroubleshootingExpanded((expanded) => !expanded)}
              />
            </View>

            {troubleshootingExpanded ? (
              <View style={styles.details}>
                <View style={styles.detailGrid}>
                  <StudioPanel
                    accessibilityLabel="Session status"
                    padding={12}
                    variant="subtle"
                    style={styles.detailCard}
                  >
                    <StudioText variant="caption" tone="muted" weight="bold">
                      SESSION
                    </StudioText>
                    <StudioText variant="label" weight="bold" style={styles.detailValue}>
                      {sessionName ?? 'Session starting'}
                    </StudioText>
                    <StudioText variant="caption" tone="secondary">
                      Session ID: {sessionId ?? 'Pending'} · {tracks.length}{' '}
                      {tracks.length === 1 ? 'track' : 'tracks'}
                    </StudioText>
                    <StatusBadge
                      label={status === 'ready' ? 'Session ready' : `Session ${status}`}
                      tone={sessionStatusTone}
                    />
                  </StudioPanel>

                  <StudioPanel
                    accessibilityLabel="Audio engine diagnostics"
                    padding={12}
                    variant="subtle"
                    style={styles.detailCard}
                  >
                    <StudioText variant="caption" tone="muted" weight="bold">
                      AUDIO ENGINE
                    </StudioText>
                    <StudioText variant="label" weight="bold" style={styles.detailValue}>
                      {(renderLoad * 100).toFixed(0)}% render load
                    </StudioText>
                    <StudioText variant="caption" tone="secondary">
                      {diagnostics.xruns} {diagnostics.xruns === 1 ? 'xrun' : 'xruns'}{' '}
                      detected
                    </StudioText>
                    <StatusBadge
                      icon="engine"
                      label={diagnosticsState.label}
                      tone={diagnosticsState.tone}
                    />
                  </StudioPanel>

                  <StudioPanel
                    accessibilityLabel="Accessibility status"
                    padding={12}
                    variant="subtle"
                    style={styles.detailCard}
                  >
                    <StudioText variant="caption" tone="muted" weight="bold">
                      ACCESSIBILITY
                    </StudioText>
                    <StudioText variant="label" weight="bold" style={styles.detailValue}>
                      Screen reader {adaptive.screenReaderEnabled ? 'on' : 'off'}
                    </StudioText>
                    <StudioText variant="caption" tone="secondary">
                      Reduced motion {adaptive.prefersReducedMotion ? 'on' : 'off'}
                    </StudioText>
                  </StudioPanel>
                </View>

                {sessionError || diagnostics.error ? (
                  <StudioText
                    accessibilityRole="alert"
                    variant="body"
                    tone="critical"
                    style={styles.errorMessage}
                  >
                    {sessionError?.message ??
                      diagnostics.error?.message ??
                      'Runtime diagnostics failed.'}
                  </StudioText>
                ) : null}
              </View>
            ) : null}
          </StudioPanel>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};
