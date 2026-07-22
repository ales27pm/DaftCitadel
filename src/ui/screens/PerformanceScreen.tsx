import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  SectionHeader,
  StatusBadge,
  StudioButton,
  StudioHeader,
  StudioPanel,
  StudioText,
  TransportBar,
  useTheme,
  type StudioTone,
} from '../design-system';
import { useAdaptiveLayout } from '../layout';
import {
  useSessionViewModel,
  useProjectedTransport,
  useTransportControls,
} from '../session';
import { useUserPreferences } from '../settings';

interface PerformanceScene {
  name: string;
  startMs: number;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  content: {
    alignSelf: 'center',
    gap: 16,
    width: '100%',
  },
  deck: {
    alignItems: 'stretch',
    gap: 16,
  },
  heroPanel: {
    gap: 12,
    minWidth: 0,
  },
  heroHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'space-between',
  },
  tempoRow: {
    alignItems: 'flex-end',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 8,
    maxWidth: '100%',
  },
  tempoUnit: { marginBottom: 5 },
  metricRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
  },
  scenePanel: {
    gap: 16,
    minWidth: 0,
  },
  sceneGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  sceneButton: {
    alignSelf: 'stretch',
    minHeight: 52,
    width: '100%',
  },
  emptyState: { gap: 4 },
  diagnostics: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  errorPanel: { gap: 4 },
});

export const PerformanceScreen: React.FC = () => {
  const theme = useTheme();
  const adaptive = useAdaptiveLayout();
  const { status, sessionName, transport, tracks, diagnostics } = useSessionViewModel();
  const transportControls = useTransportControls();
  const activeTransport = transportControls.transport ?? transport;
  const { preferences } = useUserPreferences();
  const { projectedBeats } = useProjectedTransport(activeTransport);
  const [activeScene, setActiveScene] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  const isWideDeck =
    adaptive.workspaceMode === 'studio' && adaptive.isLandscape && adaptive.width >= 700;
  const bpm = Math.round(activeTransport?.bpm ?? 0);
  const timeSignature = activeTransport?.timeSignature ?? '4/4';

  const contentStyle = useMemo<ViewStyle>(
    () => ({
      maxWidth: adaptive.maxContentWidth,
      padding: adaptive.contentPadding,
    }),
    [adaptive.contentPadding, adaptive.maxContentWidth],
  );
  const deckStyle = useMemo<ViewStyle>(
    () => ({
      flexDirection: isWideDeck ? 'row' : 'column',
    }),
    [isWideDeck],
  );
  const heroPanelStyle = useMemo<ViewStyle>(
    () => ({
      flexBasis: isWideDeck ? 292 : undefined,
      flexGrow: isWideDeck ? 0 : 1,
      width: isWideDeck ? 292 : '100%',
    }),
    [isWideDeck],
  );
  const sceneTileStyle = useMemo<ViewStyle>(
    () => ({
      flexBasis: isWideDeck ? 176 : 140,
      flexGrow: 1,
      maxWidth: isWideDeck ? 260 : undefined,
      minWidth: 0,
    }),
    [isWideDeck],
  );
  const scenePanelStyle = useMemo<ViewStyle>(
    () => ({ flex: isWideDeck ? 1 : undefined }),
    [isWideDeck],
  );

  const scenes = useMemo<PerformanceScene[]>(() => {
    const byName = new Map<string, PerformanceScene>();
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

  const readiness = useMemo<{
    label: string;
    tone: StudioTone;
  }>(() => {
    if (status !== 'ready') {
      return { label: 'Connecting', tone: 'secondary' };
    }
    if (!transportControls.isAvailable) {
      return { label: 'Transport unavailable', tone: 'warning' };
    }
    if (transportControls.isPlaying) {
      return { label: 'Playing', tone: 'mint' };
    }
    return { label: 'Ready', tone: 'cyan' };
  }, [status, transportControls.isAvailable, transportControls.isPlaying]);

  const diagnosticsSummary = useMemo(() => {
    if (diagnostics.status === 'error') {
      return diagnostics.error?.message
        ? `Diagnostics error: ${diagnostics.error.message}`
        : 'Diagnostics unavailable due to an error.';
    }
    if (diagnostics.status === 'unavailable') {
      return 'Audio diagnostics unavailable.';
    }
    if (diagnostics.status !== 'ready') {
      return 'Gathering audio diagnostics…';
    }
    const renderLoad = Number.isFinite(diagnostics.renderLoad)
      ? Math.round(Math.max(0, Math.min(1, diagnostics.renderLoad)) * 100)
      : 0;
    return `${diagnostics.xruns} XRuns • ${renderLoad}% load`;
  }, [diagnostics]);

  const diagnosticsTone: StudioTone =
    diagnostics.status === 'error'
      ? 'critical'
      : diagnostics.status === 'unavailable'
        ? 'warning'
        : 'secondary';

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

  const handleRewind = useCallback(() => {
    setActionError(undefined);
    transportControls.locateStart().catch((error) => {
      setActionError(
        error instanceof Error ? error.message : 'Unable to rewind transport',
      );
    });
  }, [transportControls]);

  const handleSceneLaunch = useCallback(
    async (scene: PerformanceScene) => {
      const bpmValue = activeTransport?.bpm ?? 120;
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
    [activeTransport?.bpm, preferences.autoPlayScenes, transportControls],
  );

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.background }]}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        contentInsetAdjustmentBehavior="automatic"
      >
        <View style={[styles.content, contentStyle]}>
          <StudioHeader
            compact={adaptive.isLandscape}
            eyebrow={sessionName ?? 'Live session'}
            title="Performance"
            detail="Launch the current session’s clip-derived scenes."
          />

          <TransportBar
            bpm={activeTransport?.bpm ?? 0}
            compact={adaptive.breakpoint === 'phone'}
            isAvailable={transportControls.isAvailable}
            isPlaying={transportControls.isPlaying}
            onPlay={handlePlay}
            onRewind={handleRewind}
            onStop={handleStop}
            positionBeats={projectedBeats}
            sessionName={sessionName}
            timeSignature={timeSignature}
          />

          <View style={[styles.deck, deckStyle]}>
            <StudioPanel style={[styles.heroPanel, heroPanelStyle]}>
              <View style={styles.heroHeader}>
                <StudioText variant="label" tone="secondary" weight="bold">
                  LIVE STATUS
                </StudioText>
                <StatusBadge
                  icon="engine"
                  label={readiness.label}
                  tone={readiness.tone}
                />
              </View>

              <View
                accessibilityLabel={`${bpm} beats per minute`}
                style={styles.tempoRow}
              >
                <StudioText
                  adjustsFontSizeToFit
                  minimumFontScale={0.8}
                  numberOfLines={1}
                  variant="metric"
                  tone="cyan"
                  weight="bold"
                >
                  {bpm}
                </StudioText>
                <StudioText
                  variant="label"
                  tone="secondary"
                  weight="bold"
                  style={styles.tempoUnit}
                >
                  BPM
                </StudioText>
              </View>

              <View style={styles.metricRow}>
                <View>
                  <StudioText variant="caption" tone="muted">
                    POSITION
                  </StudioText>
                  <StudioText selectable variant="label" weight="bold">
                    {projectedBeats.toFixed(2)} beats
                  </StudioText>
                </View>
                <View>
                  <StudioText variant="caption" tone="muted">
                    METER
                  </StudioText>
                  <StudioText selectable variant="label" weight="bold">
                    {timeSignature}
                  </StudioText>
                </View>
              </View>

              {preferences.showDiagnostics ? (
                <View accessibilityLabel="Audio diagnostics" style={styles.diagnostics}>
                  <StatusBadge
                    icon="diagnostics"
                    label="Diagnostics"
                    tone={diagnosticsTone}
                  />
                  <StudioText variant="caption" tone={diagnosticsTone}>
                    {diagnosticsSummary}
                  </StudioText>
                </View>
              ) : null}
            </StudioPanel>

            <StudioPanel style={[styles.scenePanel, scenePanelStyle]}>
              <SectionHeader
                title="Scenes"
                detail="Pads are created from clips in the current session."
              />
              {scenes.length === 0 ? (
                <StudioPanel
                  accessibilityLabel="No launchable scenes"
                  padding={14}
                  style={styles.emptyState}
                  variant="subtle"
                >
                  <StudioText variant="body" weight="medium">
                    No launchable clips in this session.
                  </StudioText>
                  <StudioText variant="caption" tone="secondary">
                    Scene pads appear here when the current session contains clips.
                  </StudioText>
                </StudioPanel>
              ) : (
                <View accessibilityRole="menu" style={styles.sceneGrid}>
                  {scenes.map((scene) => {
                    const selected = activeScene === scene.name;
                    return (
                      <View key={scene.name} style={sceneTileStyle}>
                        <StudioButton
                          accessibilityHint={`Locates the transport to ${scene.name}${
                            preferences.autoPlayScenes ? ' and starts playback' : ''
                          }`}
                          accessibilityLabel={scene.name}
                          accessibilityState={{
                            disabled: !transportControls.isAvailable,
                            selected,
                          }}
                          disabled={!transportControls.isAvailable}
                          label={scene.name}
                          onPress={() => {
                            handleSceneLaunch(scene).catch(() => undefined);
                          }}
                          style={styles.sceneButton}
                          variant={selected ? 'primary' : 'secondary'}
                        />
                      </View>
                    );
                  })}
                </View>
              )}
            </StudioPanel>
          </View>

          {actionError ? (
            <StudioPanel
              accessibilityLabel="Transport error"
              accessibilityRole="alert"
              padding={12}
              style={styles.errorPanel}
              variant="subtle"
            >
              <StudioText variant="label" tone="critical" weight="bold">
                Transport action failed
              </StudioText>
              <StudioText variant="caption" tone="critical" selectable>
                {actionError}
              </StudioText>
            </StudioPanel>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};
