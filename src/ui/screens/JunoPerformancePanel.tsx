import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';

import type { Juno106ParameterName, Juno106ParameterMap } from '../../session';
import {
  listBuiltInJuno106Presets,
  type Juno106PresetRecord,
} from '../../session/juno106Presets';
import {
  StatusBadge,
  StudioButton,
  StudioPanel,
  StudioText,
  useTheme,
} from '../design-system';
import {
  useInstrumentControls,
  useSessionActions,
  type TrackViewModel,
} from '../session';

interface JunoPerformancePanelProps {
  activeTrackId?: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  tracks: TrackViewModel[];
  onNoteOn?: (note: number, velocity: number, occurredAtMs: number) => void;
  onNoteOff?: (note: number, occurredAtMs: number) => void;
}

interface ParameterSpec {
  group: 'DCO' | 'LFO' | 'VCF' | 'ENV' | 'OUTPUT';
  label: string;
  maximum: number;
  minimum: number;
  name: Exclude<Juno106ParameterName, 'chorusMode'>;
  step: number;
  format: (value: number) => string;
}

interface KeyboardKey {
  label: string;
  note: number;
  black: boolean;
}

const PARAMETER_SPECS: ReadonlyArray<ParameterSpec> = [
  {
    group: 'DCO',
    label: 'Pulse width',
    maximum: 0.95,
    minimum: 0.05,
    name: 'pulseWidth',
    step: 0.05,
    format: (value) => `${Math.round(value * 100)}%`,
  },
  {
    group: 'LFO',
    label: 'Rate',
    maximum: 20,
    minimum: 0.05,
    name: 'lfoRateHz',
    step: 0.1,
    format: (value) => `${value.toFixed(2)} Hz`,
  },
  {
    group: 'LFO',
    label: 'Pitch depth',
    maximum: 1,
    minimum: 0,
    name: 'lfoDepth',
    step: 0.05,
    format: (value) => `${Math.round(value * 100)}%`,
  },
  {
    group: 'DCO',
    label: 'Sub level',
    maximum: 1,
    minimum: 0,
    name: 'subLevel',
    step: 0.1,
    format: (value) => `${Math.round(value * 100)}%`,
  },
  {
    group: 'VCF',
    label: 'Cutoff',
    maximum: 12000,
    minimum: 20,
    name: 'cutoffHz',
    step: 250,
    format: (value) => `${Math.round(value)} Hz`,
  },
  {
    group: 'VCF',
    label: 'Resonance',
    maximum: 1.2,
    minimum: 0,
    name: 'resonance',
    step: 0.1,
    format: (value) => value.toFixed(2),
  },
  {
    group: 'ENV',
    label: 'Attack',
    maximum: 5,
    minimum: 0.0005,
    name: 'attackSeconds',
    step: 0.05,
    format: (value) => `${value.toFixed(2)} s`,
  },
  {
    group: 'ENV',
    label: 'Release',
    maximum: 5,
    minimum: 0.0005,
    name: 'releaseSeconds',
    step: 0.1,
    format: (value) => `${value.toFixed(2)} s`,
  },
  {
    group: 'OUTPUT',
    label: 'Output gain',
    maximum: 2,
    minimum: 0,
    name: 'outputGain',
    step: 0.05,
    format: (value) => value.toFixed(2),
  },
];

const PARAMETER_GROUPS = ['DCO', 'LFO', 'VCF', 'ENV', 'OUTPUT'] as const;
const BUILT_IN_PRESETS = listBuiltInJuno106Presets();

const KEYBOARD_KEYS: ReadonlyArray<KeyboardKey> = [
  { note: 60, label: 'C4', black: false },
  { note: 61, label: 'C sharp 4', black: true },
  { note: 62, label: 'D4', black: false },
  { note: 63, label: 'D sharp 4', black: true },
  { note: 64, label: 'E4', black: false },
  { note: 65, label: 'F4', black: false },
  { note: 66, label: 'F sharp 4', black: true },
  { note: 67, label: 'G4', black: false },
  { note: 68, label: 'G sharp 4', black: true },
  { note: 69, label: 'A4', black: false },
  { note: 70, label: 'A sharp 4', black: true },
  { note: 71, label: 'B4', black: false },
  { note: 72, label: 'C5', black: false },
];

const styles = StyleSheet.create({
  panel: { gap: 14 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'space-between',
  },
  headerCopy: { flex: 1, minWidth: 180 },
  detail: { marginTop: 2 },
  emptyState: { alignItems: 'flex-start', gap: 8 },
  unavailable: { gap: 3 },
  controlGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  controlGroup: { flexGrow: 1, gap: 8, minWidth: 210 },
  parameterRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
  },
  parameterCopy: { flex: 1, minWidth: 86 },
  parameterButtons: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  stepButton: { minWidth: 44, paddingHorizontal: 10 },
  chorusModes: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  keyboardHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'space-between',
  },
  keyboardContent: { gap: 4, paddingVertical: 2 },
  key: {
    alignItems: 'center',
    borderRadius: 7,
    borderWidth: 1,
    height: 82,
    justifyContent: 'flex-end',
    paddingBottom: 8,
    width: 48,
  },
  keyDisabled: { opacity: 0.45 },
  error: { gap: 3 },
});

const clampParameter = (value: number, minimum: number, maximum: number): number =>
  Number(Math.max(minimum, Math.min(maximum, value)).toFixed(4));

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

export const JunoPerformancePanel: React.FC<JunoPerformancePanelProps> = ({
  activeTrackId,
  status,
  tracks,
  onNoteOn,
  onNoteOff,
}) => {
  const theme = useTheme();
  const sessionActions = useSessionActions();
  const instrumentControls = useInstrumentControls();
  const [adding, setAdding] = useState(false);
  const addInFlightRef = useRef(false);
  const [pendingParameter, setPendingParameter] = useState<Juno106ParameterName>();
  const [pendingPreset, setPendingPreset] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const activeNotesRef = useRef(new Set<number>());
  const [activeNotes, setActiveNotes] = useState<Set<number>>(() => new Set());

  const junoTrack = useMemo(
    () =>
      tracks.find(
        (track) =>
          track.id === activeTrackId && track.instrument?.instrumentType === 'juno106',
      ) ?? tracks.find((track) => track.instrument?.instrumentType === 'juno106'),
    [activeTrackId, tracks],
  );
  const instrument = junoTrack?.instrument;
  const nodeId = status === 'ready' ? instrument?.nodeId : undefined;

  useEffect(() => {
    activeNotesRef.current.clear();
    setActiveNotes(new Set());
    const pressedNotes = activeNotesRef.current;
    return () => {
      pressedNotes.clear();
      if (nodeId && instrumentControls.isAvailable) {
        instrumentControls.allNotesOff(nodeId).catch((error) => {
          console.error('Failed to release Juno notes during cleanup', {
            nodeId,
            error,
          });
        });
      }
    };
  }, [instrumentControls, nodeId]);

  const handleAddJuno = useCallback(async () => {
    if (addInFlightRef.current) {
      return;
    }
    addInFlightRef.current = true;
    setAdding(true);
    setActionError(undefined);
    try {
      await sessionActions.addJunoTrack();
    } catch (error) {
      setActionError(errorMessage(error, 'Unable to add a Juno track.'));
    } finally {
      addInFlightRef.current = false;
      setAdding(false);
    }
  }, [sessionActions]);

  const updateParameter = useCallback(
    async (parameter: Juno106ParameterName, value: number) => {
      if (!junoTrack || !instrument || pendingParameter) {
        return;
      }
      setPendingParameter(parameter);
      setActionError(undefined);
      try {
        await sessionActions.setJunoParameter(junoTrack.id, parameter, value);
      } catch (error) {
        setActionError(errorMessage(error, `Unable to update ${parameter}.`));
      } finally {
        setPendingParameter(undefined);
      }
    },
    [instrument, junoTrack, pendingParameter, sessionActions],
  );

  const adjustParameter = useCallback(
    (spec: ParameterSpec, direction: -1 | 1) => {
      if (!instrument) {
        return;
      }
      const current = instrument.parameters[spec.name];
      const next = clampParameter(
        current + spec.step * direction,
        spec.minimum,
        spec.maximum,
      );
      updateParameter(spec.name, next).catch(() => undefined);
    },
    [instrument, updateParameter],
  );

  const handleNoteOn = useCallback(
    async (key: KeyboardKey) => {
      if (
        !nodeId ||
        !instrumentControls.isAvailable ||
        activeNotesRef.current.has(key.note)
      ) {
        return;
      }
      activeNotesRef.current.add(key.note);
      setActiveNotes(new Set(activeNotesRef.current));
      setActionError(undefined);
      onNoteOn?.(key.note, 100, Date.now());
      try {
        await instrumentControls.sendInstrumentMidi(nodeId, {
          type: 0,
          channel: 0,
          data1: key.note,
          data2: 100,
        });
      } catch (error) {
        activeNotesRef.current.delete(key.note);
        setActiveNotes(new Set(activeNotesRef.current));
        setActionError(errorMessage(error, `Unable to play ${key.label}.`));
      }
    },
    [instrumentControls, nodeId, onNoteOn],
  );

  const handleNoteOff = useCallback(
    async (key: KeyboardKey) => {
      if (!nodeId || !activeNotesRef.current.has(key.note)) {
        return;
      }
      activeNotesRef.current.delete(key.note);
      setActiveNotes(new Set(activeNotesRef.current));
      onNoteOff?.(key.note, Date.now());
      if (!instrumentControls.isAvailable) {
        return;
      }
      try {
        await instrumentControls.sendInstrumentMidi(nodeId, {
          type: 1,
          channel: 0,
          data1: key.note,
          data2: 0,
        });
      } catch (error) {
        setActionError(errorMessage(error, `Unable to release ${key.label}.`));
      }
    },
    [instrumentControls, nodeId, onNoteOff],
  );

  const handleAllNotesOff = useCallback(async () => {
    if (!nodeId || !instrumentControls.isAvailable) {
      return;
    }
    activeNotesRef.current.clear();
    setActiveNotes(new Set());
    setActionError(undefined);
    try {
      await instrumentControls.allNotesOff(nodeId);
    } catch (error) {
      setActionError(errorMessage(error, 'Unable to release all Juno notes.'));
    }
  }, [instrumentControls, nodeId]);

  const applyPreset = useCallback(
    async (preset: Juno106PresetRecord) => {
      if (!junoTrack || pendingParameter || pendingPreset) {
        return;
      }
      setPendingPreset(preset.id);
      setActionError(undefined);
      try {
        await sessionActions.applyJunoPreset(junoTrack.id, preset);
      } catch (error) {
        setActionError(errorMessage(error, `Unable to load ${preset.name}.`));
      } finally {
        setPendingPreset(undefined);
      }
    },
    [junoTrack, pendingParameter, pendingPreset, sessionActions],
  );

  if (status !== 'ready') {
    return null;
  }

  if (!junoTrack || !instrument) {
    return (
      <StudioPanel
        padding={14}
        style={[styles.panel, styles.emptyState]}
        testID="juno-performance-panel"
      >
        <StudioText variant="sectionTitle" tone="mint" weight="bold">
          Juno-106
        </StudioText>
        <StudioText variant="body" tone="secondary">
          Add a playable Juno track with a persisted patch and touch keyboard.
        </StudioText>
        <StudioButton
          accessibilityHint="Adds a routed Juno-106 instrument track to this session"
          accessibilityLabel="Add Juno"
          icon="plus"
          label="Add Juno"
          loading={adding}
          onPress={() => {
            handleAddJuno().catch(() => undefined);
          }}
          testID="add-juno-button"
          variant="primary"
        />
        {actionError ? (
          <StudioText accessibilityRole="alert" selectable tone="critical">
            {actionError}
          </StudioText>
        ) : null}
      </StudioPanel>
    );
  }

  const parameters: Juno106ParameterMap = instrument.parameters;
  const parameterControlsDisabled = pendingParameter !== undefined;

  return (
    <StudioPanel padding={14} style={styles.panel} testID="juno-performance-panel">
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <StudioText variant="sectionTitle" tone="mint" weight="bold">
            Juno-106
          </StudioText>
          <StudioText variant="caption" tone="secondary" style={styles.detail}>
            {junoTrack.name} · {instrument.preset?.name ?? 'Custom patch'}
          </StudioText>
        </View>
        <StatusBadge
          icon="midi"
          label={instrumentControls.isAvailable ? 'LIVE CONTROLS' : 'NATIVE UNAVAILABLE'}
          tone={instrumentControls.isAvailable ? 'mint' : 'warning'}
        />
      </View>

      {!instrumentControls.isAvailable ? (
        <StudioPanel
          accessibilityLabel="Juno live controls unavailable"
          accessibilityRole="alert"
          padding={10}
          style={styles.unavailable}
          variant="subtle"
        >
          <StudioText variant="label" tone="warning" weight="bold">
            Live Juno controls unavailable
          </StudioText>
          <StudioText variant="caption" tone="secondary">
            Patch edits are saved, but the keyboard requires the native audio bridge.
          </StudioText>
        </StudioPanel>
      ) : null}

      <View style={styles.controlGrid}>
        <StudioPanel padding={10} style={styles.controlGroup} variant="subtle">
          <StudioText variant="label" tone="mint" weight="bold">
            PRESETS
          </StudioText>
          <View style={styles.chorusModes}>
            {BUILT_IN_PRESETS.map((preset) => {
              const selected = instrument.preset?.id === preset.id;
              return (
                <StudioButton
                  key={preset.id}
                  compact
                  accessibilityLabel={`Load Juno preset ${preset.name}`}
                  accessibilityState={{
                    disabled: parameterControlsDisabled || pendingPreset !== undefined,
                    selected,
                  }}
                  disabled={parameterControlsDisabled || pendingPreset !== undefined}
                  label={preset.name}
                  loading={pendingPreset === preset.id}
                  onPress={() => {
                    applyPreset(preset).catch(() => undefined);
                  }}
                  testID={`juno-preset-${preset.id}`}
                  variant={selected ? 'primary' : 'secondary'}
                />
              );
            })}
          </View>
        </StudioPanel>
        {PARAMETER_GROUPS.map((group) => (
          <StudioPanel
            key={group}
            padding={10}
            style={styles.controlGroup}
            variant="subtle"
          >
            <StudioText variant="label" tone="cyan" weight="bold">
              {group}
            </StudioText>
            {PARAMETER_SPECS.filter((spec) => spec.group === group).map((spec) => (
              <View
                key={spec.name}
                accessibilityLabel={`Juno ${spec.label} control`}
                style={styles.parameterRow}
                testID={`juno-control-${spec.name}`}
              >
                <View style={styles.parameterCopy}>
                  <StudioText variant="caption" tone="secondary">
                    {spec.label}
                  </StudioText>
                  <StudioText selectable variant="label" weight="bold">
                    {spec.format(parameters[spec.name])}
                  </StudioText>
                </View>
                <View style={styles.parameterButtons}>
                  <StudioButton
                    compact
                    accessibilityLabel={`Decrease Juno ${spec.label}`}
                    disabled={parameterControlsDisabled}
                    label="−"
                    onPress={() => adjustParameter(spec, -1)}
                    style={styles.stepButton}
                    testID={`juno-${spec.name}-decrease`}
                    variant="ghost"
                  />
                  <StudioButton
                    compact
                    accessibilityLabel={`Increase Juno ${spec.label}`}
                    disabled={parameterControlsDisabled}
                    label="+"
                    onPress={() => adjustParameter(spec, 1)}
                    style={styles.stepButton}
                    testID={`juno-${spec.name}-increase`}
                    variant="ghost"
                  />
                </View>
              </View>
            ))}
          </StudioPanel>
        ))}

        <StudioPanel padding={10} style={styles.controlGroup} variant="subtle">
          <StudioText variant="label" tone="magenta" weight="bold">
            CHORUS
          </StudioText>
          <View style={styles.chorusModes}>
            {[
              { label: 'Off', value: 0 },
              { label: 'I', value: 1 },
              { label: 'II', value: 2 },
            ].map((mode) => {
              const selected = parameters.chorusMode === mode.value;
              return (
                <StudioButton
                  key={mode.value}
                  compact
                  accessibilityLabel={`Set Juno chorus ${mode.label}`}
                  accessibilityState={{
                    disabled: parameterControlsDisabled,
                    selected,
                  }}
                  disabled={parameterControlsDisabled}
                  label={mode.label}
                  onPress={() => {
                    updateParameter('chorusMode', mode.value).catch(() => undefined);
                  }}
                  testID={`juno-chorus-${mode.value}`}
                  variant={selected ? 'primary' : 'secondary'}
                />
              );
            })}
          </View>
        </StudioPanel>
      </View>

      <View style={styles.keyboardHeader}>
        <View>
          <StudioText variant="label" weight="bold">
            TOUCH KEYBOARD
          </StudioText>
          <StudioText variant="caption" tone="secondary">
            Hold a key to play · release to stop
          </StudioText>
        </View>
        <StudioButton
          compact
          accessibilityLabel="All Juno notes off"
          disabled={!instrumentControls.isAvailable}
          label="All notes off"
          onPress={() => {
            handleAllNotesOff().catch(() => undefined);
          }}
          testID="juno-all-notes-off"
          variant="ghost"
        />
      </View>

      <ScrollView
        horizontal
        contentContainerStyle={styles.keyboardContent}
        showsHorizontalScrollIndicator={false}
        testID="juno-keyboard"
      >
        {KEYBOARD_KEYS.map((key) => {
          const active = activeNotes.has(key.note);
          const keyStyle: ViewStyle = {
            backgroundColor: active
              ? theme.colors.accentPrimary
              : key.black
                ? theme.colors.background
                : theme.colors.surfaceElevated,
            borderColor: active ? theme.colors.accentPrimary : theme.colors.border,
          };
          return (
            <Pressable
              key={key.note}
              accessibilityHint="Sends note on while held and note off when released"
              accessibilityLabel={`Play Juno ${key.label}`}
              accessibilityRole="button"
              accessibilityState={{
                disabled: !instrumentControls.isAvailable,
                selected: active,
              }}
              disabled={!instrumentControls.isAvailable}
              onPressIn={() => {
                handleNoteOn(key).catch(() => undefined);
              }}
              onPressOut={() => {
                handleNoteOff(key).catch(() => undefined);
              }}
              style={[
                styles.key,
                keyStyle,
                !instrumentControls.isAvailable && styles.keyDisabled,
              ]}
              testID={`juno-key-${key.note}`}
            >
              <StudioText
                selectable={false}
                variant="caption"
                weight="bold"
                style={{
                  color: active
                    ? theme.colors.accentPrimaryInk
                    : theme.colors.textPrimary,
                }}
              >
                {key.label.replace(' sharp ', '♯')}
              </StudioText>
            </Pressable>
          );
        })}
      </ScrollView>

      {actionError ? (
        <StudioPanel
          accessibilityLabel="Juno action error"
          accessibilityRole="alert"
          padding={10}
          style={styles.error}
          variant="subtle"
        >
          <StudioText variant="label" tone="critical" weight="bold">
            Juno action failed
          </StudioText>
          <StudioText selectable variant="caption" tone="critical">
            {actionError}
          </StudioText>
        </StudioPanel>
      ) : null}
    </StudioPanel>
  );
};
