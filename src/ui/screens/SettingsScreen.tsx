import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Switch, View, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  StatusBadge,
  StudioButton,
  StudioIcon,
  StudioPanel,
  StudioText,
  useTheme,
  type StudioIconName,
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
  header: {
    borderBottomWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  scrollContent: { paddingBottom: 32 },
  page: { alignSelf: 'center', width: '100%' },
  section: { marginBottom: 24 },
  sectionTitle: {
    letterSpacing: 2,
    marginBottom: 8,
    paddingLeft: 4,
    textTransform: 'uppercase',
  },
  sectionBody: { overflow: 'hidden' },
  row: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    minHeight: 58,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  lastRow: { borderBottomWidth: 0 },
  rowIcon: {
    alignItems: 'center',
    borderRadius: 8,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  rowCopy: { flex: 1, minWidth: 0 },
  rowDescription: { marginTop: 2 },
  detailGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  detailCard: { flexBasis: 210, flexGrow: 1, minWidth: 0 },
  detailValue: { marginTop: 4 },
  expandedDetails: { gap: 10, padding: 14 },
  errorMessage: { marginTop: 2 },
});

interface SettingsSectionProps {
  title: string;
  children: React.ReactNode;
}

const SettingsSection: React.FC<SettingsSectionProps> = ({ title, children }) => (
  <View style={styles.section}>
    <StudioText variant="caption" tone="muted" weight="bold" style={styles.sectionTitle}>
      {title}
    </StudioText>
    <StudioPanel padding={0} style={styles.sectionBody}>
      {children}
    </StudioPanel>
  </View>
);

interface SettingsRowProps {
  icon: StudioIconName;
  label: string;
  description?: string;
  value?: string;
  right?: React.ReactNode;
  last?: boolean;
}

const SettingsRow: React.FC<SettingsRowProps> = ({
  icon,
  label,
  description,
  value,
  right,
  last = false,
}) => {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.row,
        { borderBottomColor: theme.colors.border },
        last && styles.lastRow,
      ]}
    >
      <View style={[styles.rowIcon, { backgroundColor: theme.colors.surfaceElevated }]}>
        <StudioIcon name={icon} color={theme.colors.accentTertiary} size={17} />
      </View>
      <View style={styles.rowCopy}>
        <StudioText variant="label" weight="medium" numberOfLines={1}>
          {label}
        </StudioText>
        {description ? (
          <StudioText variant="caption" tone="secondary" style={styles.rowDescription}>
            {description}
          </StudioText>
        ) : null}
      </View>
      {value ? (
        <StudioText selectable variant="caption" tone="secondary">
          {value}
        </StudioText>
      ) : null}
      {right}
    </View>
  );
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
    transport,
    transportRuntime,
    diagnostics,
    error: sessionError,
  } = useSessionViewModel();
  const [troubleshootingExpanded, setTroubleshootingExpanded] = useState(false);

  const pageStyle = useMemo<ViewStyle>(
    () => ({
      maxWidth: Math.min(adaptive.maxContentWidth, 720),
      paddingHorizontal: adaptive.contentPadding,
      paddingTop: adaptive.isLandscape ? 14 : 18,
    }),
    [adaptive.contentPadding, adaptive.isLandscape, adaptive.maxContentWidth],
  );
  const diagnosticsState = diagnosticsPresentation(diagnostics.status, diagnostics.xruns);
  const renderLoad = Number.isFinite(diagnostics.renderLoad)
    ? Math.max(0, Math.min(1, diagnostics.renderLoad))
    : 0;
  const diagnosticsReady = diagnostics.status === 'ready';
  const sessionStatusTone: StudioTone =
    status === 'error' ? 'critical' : status === 'ready' ? 'success' : 'secondary';
  const sampleRate = transportRuntime?.sampleRate;

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.background }]}
    >
      <View
        accessibilityRole="header"
        style={[
          styles.header,
          {
            backgroundColor: theme.colors.surface,
            borderBottomColor: theme.colors.border,
          },
        ]}
      >
        <StudioText variant="screenTitle" tone="mint" weight="bold">
          SETTINGS
        </StudioText>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        contentInsetAdjustmentBehavior="automatic"
      >
        <View style={[styles.page, pageStyle]}>
          <SettingsSection title="Project">
            <SettingsRow
              icon="arrangement"
              label={sessionName ?? 'Session starting'}
              description="Current Daft Citadel session"
              value={status === 'ready' ? 'READY' : status.toUpperCase()}
            />
            <SettingsRow
              icon="mixer"
              label="Tracks"
              value={`${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}`}
            />
            <SettingsRow
              icon="diagnostics"
              label="Tempo"
              value={transport ? `${Math.round(transport.bpm)} BPM` : 'Unavailable'}
              last
            />
          </SettingsSection>

          <SettingsSection title="Performance preferences">
            {SETTINGS.map((setting, index) => (
              <SettingsRow
                key={setting.key}
                icon={setting.key === 'autoPlayScenes' ? 'play' : 'diagnostics'}
                label={setting.label}
                description={setting.description}
                last={index === SETTINGS.length - 1}
                right={
                  <Switch
                    accessibilityLabel={setting.label}
                    ios_backgroundColor={theme.colors.surfacePressed}
                    onValueChange={(value) => setPreference(setting.key, value)}
                    trackColor={{
                      false: theme.colors.surfacePressed,
                      true: theme.colors.accentPrimary,
                    }}
                    value={preferences[setting.key]}
                  />
                }
              />
            ))}
          </SettingsSection>

          <SettingsSection title="Audio engine">
            <SettingsRow
              icon="engine"
              label="Engine status"
              right={
                <StatusBadge
                  label={diagnosticsState.label}
                  tone={diagnosticsState.tone}
                />
              }
            />
            <SettingsRow
              icon="waveform"
              label="Render load"
              value={
                diagnosticsReady ? `${Math.round(renderLoad * 100)}%` : 'Unavailable'
              }
            />
            <SettingsRow
              icon="diagnostics"
              label="Sample rate"
              value={
                sampleRate && sampleRate > 0 ? `${sampleRate} Hz` : 'Runtime managed'
              }
              last
            />
          </SettingsSection>

          <SettingsSection title="About">
            <SettingsRow icon="engine" label="Daft Citadel DAW" value="v1.0.0" />
            <SettingsRow icon="performance" label="Theme" value="Dark / Neon" last />
          </SettingsSection>

          <SettingsSection title="Troubleshooting">
            <SettingsRow
              icon="diagnostics"
              label="Troubleshooting"
              description="Session, audio engine, and accessibility status."
              last={!troubleshootingExpanded}
              right={
                <StudioButton
                  compact
                  accessibilityLabel={`${
                    troubleshootingExpanded ? 'Hide' : 'Show'
                  } troubleshooting details`}
                  icon={troubleshootingExpanded ? 'chevronUp' : 'chevronDown'}
                  label={troubleshootingExpanded ? 'Hide details' : 'Show details'}
                  variant="ghost"
                  onPress={() => setTroubleshootingExpanded((expanded) => !expanded)}
                />
              }
            />

            {troubleshootingExpanded ? (
              <View style={styles.expandedDetails}>
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
                      {diagnosticsReady
                        ? `${(renderLoad * 100).toFixed(0)}% render load`
                        : 'Render load unavailable'}
                    </StudioText>
                    <StudioText variant="caption" tone="secondary">
                      {diagnosticsReady
                        ? `${diagnostics.xruns} ${
                            diagnostics.xruns === 1 ? 'xrun' : 'xruns'
                          } detected`
                        : 'XRun count unavailable'}
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
                    selectable
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
          </SettingsSection>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};
