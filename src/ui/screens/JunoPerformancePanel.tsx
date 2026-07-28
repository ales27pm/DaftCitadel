import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Slider from '@react-native-community/slider';
import { Image } from 'expo-image';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type DimensionValue,
} from 'react-native';

import type { Juno106ParameterName, Juno106ParameterMap } from '../../session';
import {
  listBuiltInJuno106Presets,
  type Juno106PresetRecord,
} from '../../session/juno106Presets';
import {
  StatusBadge,
  StudioAlertText,
  StudioButton,
  StudioIcon,
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
  compactLabel: string;
  group: 'DCO' | 'LFO' | 'VCF' | 'ENV' | 'OUTPUT';
  label: string;
  maximum: number;
  minimum: number;
  name: ContinuousParameterName;
  step: number;
  format: (value: number) => string;
}

interface KeyboardKey {
  label: string;
  note: number;
  black: boolean;
}

type ContinuousParameterName = Exclude<Juno106ParameterName, 'chorusMode'>;
type ParameterDrafts = Partial<Record<ContinuousParameterName, number>>;
type JunoActionErrorLocation =
  'advanced' | 'empty' | 'keyboard' | 'parameters' | 'preset';

interface JunoActionError {
  location: JunoActionErrorLocation;
  message: string;
}

const PARAMETER_SPECS: ReadonlyArray<ParameterSpec> = [
  {
    compactLabel: 'Pulse',
    group: 'DCO',
    label: 'Pulse width',
    maximum: 0.95,
    minimum: 0.05,
    name: 'pulseWidth',
    step: 0.05,
    format: (value) => `${Math.round(value * 100)}%`,
  },
  {
    compactLabel: 'Rate',
    group: 'LFO',
    label: 'Rate',
    maximum: 20,
    minimum: 0.05,
    name: 'lfoRateHz',
    step: 0.1,
    format: (value) => `${value.toFixed(2)} Hz`,
  },
  {
    compactLabel: 'Depth',
    group: 'LFO',
    label: 'Pitch depth',
    maximum: 1,
    minimum: 0,
    name: 'lfoDepth',
    step: 0.05,
    format: (value) => `${Math.round(value * 100)}%`,
  },
  {
    compactLabel: 'Sub',
    group: 'DCO',
    label: 'Sub level',
    maximum: 1,
    minimum: 0,
    name: 'subLevel',
    step: 0.1,
    format: (value) => `${Math.round(value * 100)}%`,
  },
  {
    compactLabel: 'Cutoff',
    group: 'VCF',
    label: 'Cutoff',
    maximum: 12000,
    minimum: 20,
    name: 'cutoffHz',
    step: 250,
    format: (value) => `${Math.round(value)} Hz`,
  },
  {
    compactLabel: 'Reso',
    group: 'VCF',
    label: 'Resonance',
    maximum: 1.2,
    minimum: 0,
    name: 'resonance',
    step: 0.1,
    format: (value) => value.toFixed(2),
  },
  {
    compactLabel: 'Attack',
    group: 'ENV',
    label: 'Attack',
    maximum: 5,
    minimum: 0.0005,
    name: 'attackSeconds',
    step: 0.05,
    format: (value) => `${value.toFixed(2)} s`,
  },
  {
    compactLabel: 'Release',
    group: 'ENV',
    label: 'Release',
    maximum: 5,
    minimum: 0.0005,
    name: 'releaseSeconds',
    step: 0.1,
    format: (value) => `${value.toFixed(2)} s`,
  },
  {
    compactLabel: 'Output',
    group: 'OUTPUT',
    label: 'Output gain',
    maximum: 2,
    minimum: 0,
    name: 'outputGain',
    step: 0.05,
    format: (value) => value.toFixed(2),
  },
];

const PRIMARY_PARAMETER_SPECS = PARAMETER_SPECS.filter(
  (spec) => spec.name !== 'lfoDepth',
);
const ADVANCED_PARAMETER_SPECS = PARAMETER_SPECS.filter(
  (spec) => spec.name === 'lfoDepth',
);

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

const WHITE_KEYS = KEYBOARD_KEYS.filter((key) => !key.black);
const BLACK_KEYS = KEYBOARD_KEYS.filter((key) => key.black);
const BLACK_KEY_LEFT: Readonly<Record<number, DimensionValue>> = {
  61: '9%',
  63: '21.5%',
  66: '46.5%',
  68: '59%',
  70: '71.5%',
};
const BLACK_KEY_HIT_SLOP = { bottom: 0, left: 8, right: 8, top: 0 } as const;

const styles = StyleSheet.create({
  panel: { gap: 12, overflow: 'hidden' },
  surfaceTexture: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.14,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'space-between',
  },
  headerCopy: { flex: 1, minWidth: 180 },
  detail: { marginTop: 2 },
  emptyState: { alignItems: 'flex-start', gap: 10 },
  unavailable: {
    borderLeftWidth: 2,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  section: {
    borderTopWidth: 1,
    gap: 10,
    paddingTop: 14,
  },
  sectionHeader: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
  },
  presetRow: { flexDirection: 'row', gap: 8 },
  presetButton: {
    alignSelf: 'stretch',
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 6,
  },
  parameterGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  parameterControl: {
    flexGrow: 1,
    gap: 4,
    minWidth: 0,
  },
  parameterControlCompact: {
    alignItems: 'stretch',
  },
  parameterHeader: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'space-between',
  },
  parameterHeaderCompact: {
    alignItems: 'center',
    flexDirection: 'column',
    gap: 0,
  },
  parameterLabelCompact: {
    textAlign: 'center',
  },
  slider: { height: 34, width: '100%' },
  sliderCompact: { height: 42 },
  parameterButtons: { flexDirection: 'row', gap: 6 },
  stepButton: {
    alignSelf: 'stretch',
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 4,
  },
  chorusModes: {
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  chorusMode: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 10,
  },
  chorusDivider: { borderLeftWidth: 1 },
  keyboardHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'space-between',
  },
  keyboardViewport: {
    height: 118,
    width: '100%',
  },
  keyboardContent: {
    flexGrow: 1,
    minWidth: 368,
  },
  keyboard: {
    height: 118,
    position: 'relative',
    width: '100%',
  },
  whiteKeyRow: {
    flexDirection: 'row',
    height: '100%',
    width: '100%',
  },
  whiteKey: {
    alignItems: 'center',
    borderRadius: 5,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'flex-end',
    marginHorizontal: 1,
    minWidth: 44,
    paddingBottom: 9,
  },
  blackKey: {
    alignItems: 'center',
    borderRadius: 4,
    borderWidth: 1,
    height: 72,
    justifyContent: 'flex-end',
    paddingBottom: 7,
    position: 'absolute',
    top: 0,
    width: 28,
    zIndex: 2,
  },
  blackKeyMarker: { borderRadius: 2, height: 3, width: 12 },
  keyDisabled: { opacity: 0.45 },
  diagnosticsToggle: {
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  diagnosticsCopy: { flex: 1 },
  advancedContent: { gap: 12 },
  diagnosticsContent: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
    paddingHorizontal: 12,
  },
  diagnostic: { gap: 2, minWidth: 112 },
  error: {
    borderLeftWidth: 2,
    gap: 3,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
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
  const { fontScale, width: viewportWidth } = useWindowDimensions();
  const sessionActions = useSessionActions();
  const instrumentControls = useInstrumentControls();
  const [adding, setAdding] = useState(false);
  const addInFlightRef = useRef(false);
  const [pendingParameter, setPendingParameter] = useState<Juno106ParameterName>();
  const [pendingPreset, setPendingPreset] = useState<string>();
  const [parameterDrafts, setParameterDrafts] = useState<ParameterDrafts>({});
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  const [actionError, setActionError] = useState<JunoActionError>();
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
  const isCompactPhone = viewportWidth < 600;
  const parameterColumnWidth: DimensionValue = isCompactPhone
    ? fontScale >= 1.3
      ? '47%'
      : '22%'
    : viewportWidth < 900
      ? '47%'
      : '31%';

  useEffect(() => {
    activeNotesRef.current.clear();
    setParameterDrafts({});
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
      setActionError({
        location: 'empty',
        message: errorMessage(error, 'Unable to add a Juno track.'),
      });
    } finally {
      addInFlightRef.current = false;
      setAdding(false);
    }
  }, [sessionActions]);

  const updateParameter = useCallback(
    async (
      parameter: Juno106ParameterName,
      value: number,
      errorLocation: Extract<
        JunoActionErrorLocation,
        'advanced' | 'parameters'
      > = 'parameters',
    ) => {
      if (!junoTrack || !instrument || pendingParameter) {
        return;
      }
      setPendingParameter(parameter);
      setActionError(undefined);
      try {
        await sessionActions.setJunoParameter(junoTrack.id, parameter, value);
      } catch (error) {
        setActionError({
          location: errorLocation,
          message: errorMessage(error, `Unable to update ${parameter}.`),
        });
      } finally {
        setPendingParameter(undefined);
      }
    },
    [instrument, junoTrack, pendingParameter, sessionActions],
  );

  const previewParameter = useCallback((spec: ParameterSpec, value: number) => {
    const next = clampParameter(value, spec.minimum, spec.maximum);
    setParameterDrafts((drafts) => ({ ...drafts, [spec.name]: next }));
  }, []);

  const persistParameterDraft = useCallback(
    async (spec: ParameterSpec, value: number) => {
      const next = clampParameter(value, spec.minimum, spec.maximum);
      setParameterDrafts((drafts) => ({ ...drafts, [spec.name]: next }));
      await updateParameter(spec.name, next);
      setParameterDrafts((drafts) => {
        const nextDrafts = { ...drafts };
        delete nextDrafts[spec.name];
        return nextDrafts;
      });
    },
    [updateParameter],
  );

  const adjustParameter = useCallback(
    async (spec: ParameterSpec, direction: -1 | 1) => {
      if (!instrument) {
        return;
      }
      const current = instrument.parameters[spec.name];
      await persistParameterDraft(spec, current + spec.step * direction);
    },
    [instrument, persistParameterDraft],
  );

  const commitParameter = useCallback(
    async (spec: ParameterSpec, value: number) => {
      await persistParameterDraft(spec, value);
    },
    [persistParameterDraft],
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
        setActionError({
          location: 'keyboard',
          message: errorMessage(error, `Unable to play ${key.label}.`),
        });
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
        setActionError({
          location: 'keyboard',
          message: errorMessage(error, `Unable to release ${key.label}.`),
        });
      }
    },
    [instrumentControls, nodeId, onNoteOff],
  );

  const handleAssistiveKeyActivation = useCallback(
    async (key: KeyboardKey) => {
      await handleNoteOn(key);
      await handleNoteOff(key);
    },
    [handleNoteOff, handleNoteOn],
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
      setActionError({
        location: 'keyboard',
        message: errorMessage(error, 'Unable to release all Juno notes.'),
      });
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
        setActionError({
          location: 'preset',
          message: errorMessage(error, `Unable to load ${preset.name}.`),
        });
      } finally {
        setPendingPreset(undefined);
      }
    },
    [junoTrack, pendingParameter, pendingPreset, sessionActions],
  );

  const renderActionError = (
    location: JunoActionErrorLocation,
  ): React.ReactElement | null => {
    if (!actionError || actionError.location !== location) {
      return null;
    }
    return (
      <View
        style={[
          styles.error,
          {
            backgroundColor: theme.colors.surfaceVariant,
            borderLeftColor: theme.colors.statusCritical,
          },
        ]}
        testID="juno-action-error"
      >
        <StudioText variant="label" tone="critical" weight="bold">
          Juno action failed
        </StudioText>
        <StudioAlertText
          announcement={`Juno action failed. ${actionError.message}`}
          selectable
          testID="juno-action-error-announcement"
          tone="critical"
          variant="caption"
        >
          {actionError.message}
        </StudioAlertText>
      </View>
    );
  };

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
        {renderActionError('empty')}
      </StudioPanel>
    );
  }

  const parameters: Juno106ParameterMap = instrument.parameters;
  const parameterControlsDisabled = pendingParameter !== undefined;
  const renderParameterControl = (spec: ParameterSpec): React.ReactElement => {
    const value = parameterDrafts[spec.name] ?? parameters[spec.name];
    const accessibilityPercent = Math.round(
      ((value - spec.minimum) / (spec.maximum - spec.minimum)) * 100,
    );

    return (
      <View
        key={spec.name}
        accessibilityLabel={`Juno ${spec.label} control`}
        style={[
          styles.parameterControl,
          isCompactPhone && styles.parameterControlCompact,
          { flexBasis: parameterColumnWidth },
        ]}
        testID={`juno-control-${spec.name}`}
      >
        <View
          style={[
            styles.parameterHeader,
            isCompactPhone && styles.parameterHeaderCompact,
          ]}
        >
          <StudioText
            numberOfLines={1}
            variant="caption"
            tone="secondary"
            weight="medium"
            style={isCompactPhone ? styles.parameterLabelCompact : undefined}
          >
            {isCompactPhone ? spec.compactLabel : `${spec.group} · ${spec.label}`}
          </StudioText>
          <StudioText selectable variant="label" weight="bold">
            {spec.format(value)}
          </StudioText>
        </View>
        <Slider
          accessibilityHint={`Adjusts from ${spec.format(
            spec.minimum,
          )} to ${spec.format(spec.maximum)}`}
          accessibilityLabel={`Juno ${spec.label}`}
          accessibilityRole="adjustable"
          accessibilityValue={{
            max: 100,
            min: 0,
            now: accessibilityPercent,
            text: spec.format(value),
          }}
          disabled={parameterControlsDisabled}
          maximumTrackTintColor={theme.colors.border}
          maximumValue={spec.maximum}
          minimumTrackTintColor={theme.colors.accentPrimary}
          minimumValue={spec.minimum}
          onSlidingComplete={(nextValue) => {
            commitParameter(spec, nextValue).catch(() => undefined);
          }}
          onValueChange={(nextValue) => previewParameter(spec, nextValue)}
          step={spec.step}
          style={[styles.slider, isCompactPhone && styles.sliderCompact]}
          tapToSeek
          testID={`juno-${spec.name}-slider`}
          thumbTintColor={theme.colors.accentPrimary}
          value={value}
        />
        {!isCompactPhone ? (
          <View style={styles.parameterButtons}>
            <StudioButton
              compact
              accessibilityLabel={`Decrease Juno ${spec.label}`}
              disabled={parameterControlsDisabled}
              label="Less"
              onPress={() => {
                adjustParameter(spec, -1).catch(() => undefined);
              }}
              style={styles.stepButton}
              testID={`juno-${spec.name}-decrease`}
              variant="ghost"
            />
            <StudioButton
              compact
              accessibilityLabel={`Increase Juno ${spec.label}`}
              disabled={parameterControlsDisabled}
              label="More"
              onPress={() => {
                adjustParameter(spec, 1).catch(() => undefined);
              }}
              style={styles.stepButton}
              testID={`juno-${spec.name}-increase`}
              variant="ghost"
            />
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <StudioPanel padding={16} style={styles.panel} testID="juno-performance-panel">
      <Image
        accessible={false}
        contentFit="cover"
        source={require('../../../assets/ui/studio-surface.webp')}
        style={styles.surfaceTexture}
      />
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <StudioText selectable variant="sectionTitle" weight="bold">
            Juno-106
          </StudioText>
          <StudioText selectable variant="caption" tone="secondary" style={styles.detail}>
            {junoTrack.name} · {instrument.preset?.name ?? 'Custom patch'}
          </StudioText>
        </View>
        <StatusBadge
          icon="midi"
          label={instrumentControls.isAvailable ? 'NATIVE OK' : 'PATCH ONLY'}
          tone={instrumentControls.isAvailable ? 'mint' : 'warning'}
        />
      </View>

      {!instrumentControls.isAvailable ? (
        <View
          accessibilityLabel="Juno live controls unavailable"
          accessibilityRole="alert"
          style={[
            styles.unavailable,
            {
              backgroundColor: theme.colors.surfaceVariant,
              borderLeftColor: theme.colors.statusWarning,
            },
          ]}
        >
          <StudioText variant="caption" tone="secondary">
            Patch edits save normally; live keys require the native audio bridge.
          </StudioText>
        </View>
      ) : null}

      <View
        style={[styles.section, { borderTopColor: theme.colors.border }]}
        testID="juno-preset-section"
      >
        <View style={styles.sectionHeader}>
          <StudioText variant="label" tone="mint" weight="bold">
            PRESET
          </StudioText>
          <StudioText selectable variant="caption" tone="secondary">
            {instrument.preset?.name ?? 'Custom patch'}
          </StudioText>
        </View>
        <View style={styles.presetRow}>
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
                style={styles.presetButton}
                testID={`juno-preset-${preset.id}`}
                variant={selected ? 'primary' : 'secondary'}
              />
            );
          })}
        </View>
        {renderActionError('preset')}
      </View>

      <View
        style={[styles.section, { borderTopColor: theme.colors.border }]}
        testID="juno-parameter-section"
      >
        <View style={styles.sectionHeader}>
          <View>
            <StudioText variant="label" weight="bold">
              SYNTH PARAMETERS
            </StudioText>
            <StudioText variant="caption" tone="secondary">
              Drag to preview · release to save
            </StudioText>
          </View>
          <StudioText
            accessibilityLiveRegion="polite"
            variant="caption"
            tone={pendingParameter ? 'mint' : 'muted'}
          >
            {pendingParameter ? 'Saving patch…' : 'Patch saved'}
          </StudioText>
        </View>

        <View style={styles.parameterGrid}>
          {PRIMARY_PARAMETER_SPECS.map(renderParameterControl)}
        </View>
        {renderActionError('parameters')}
      </View>

      <View
        style={[styles.section, { borderTopColor: theme.colors.border }]}
        testID="juno-keyboard-section"
      >
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
          contentContainerStyle={styles.keyboardContent}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.keyboardViewport}
          testID="juno-keyboard-scroll"
        >
          <View style={styles.keyboard} testID="juno-keyboard">
            <View style={styles.whiteKeyRow}>
              {WHITE_KEYS.map((key) => {
                const active = activeNotes.has(key.note);
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
                    onAccessibilityTap={() => {
                      handleAssistiveKeyActivation(key).catch(() => undefined);
                    }}
                    onPressIn={() => {
                      handleNoteOn(key).catch(() => undefined);
                    }}
                    onPressOut={() => {
                      handleNoteOff(key).catch(() => undefined);
                    }}
                    style={({ pressed }) => [
                      styles.whiteKey,
                      {
                        backgroundColor: active
                          ? theme.colors.accentPrimary
                          : theme.colors.textPrimary,
                        borderColor: active
                          ? theme.colors.accentPrimary
                          : theme.colors.border,
                        opacity: pressed ? 0.84 : 1,
                      },
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
                          : theme.colors.background,
                      }}
                    >
                      {key.label}
                    </StudioText>
                  </Pressable>
                );
              })}
            </View>
            {BLACK_KEYS.map((key) => {
              const active = activeNotes.has(key.note);
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
                  hitSlop={BLACK_KEY_HIT_SLOP}
                  onAccessibilityTap={() => {
                    handleAssistiveKeyActivation(key).catch(() => undefined);
                  }}
                  onPressIn={() => {
                    handleNoteOn(key).catch(() => undefined);
                  }}
                  onPressOut={() => {
                    handleNoteOff(key).catch(() => undefined);
                  }}
                  style={({ pressed }) => [
                    styles.blackKey,
                    {
                      backgroundColor: active
                        ? theme.colors.accentPrimary
                        : theme.colors.background,
                      borderColor: active
                        ? theme.colors.accentPrimary
                        : theme.colors.border,
                      left: BLACK_KEY_LEFT[key.note],
                      opacity: pressed ? 0.84 : 1,
                    },
                    !instrumentControls.isAvailable && styles.keyDisabled,
                  ]}
                  testID={`juno-key-${key.note}`}
                >
                  <View
                    style={[
                      styles.blackKeyMarker,
                      {
                        backgroundColor: active
                          ? theme.colors.accentPrimaryInk
                          : theme.colors.textTertiary,
                      },
                    ]}
                  />
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
        {renderActionError('keyboard')}
      </View>

      <View
        style={[styles.section, { borderTopColor: theme.colors.border }]}
        testID="juno-advanced-section"
      >
        <Pressable
          accessibilityLabel="Advanced controls and diagnostics"
          accessibilityRole="button"
          accessibilityState={{ expanded: diagnosticsExpanded }}
          onPress={() => setDiagnosticsExpanded((expanded) => !expanded)}
          style={({ pressed }) => [
            styles.diagnosticsToggle,
            {
              backgroundColor: theme.colors.surfaceVariant,
              borderColor: theme.colors.border,
              opacity: pressed ? 0.84 : 1,
            },
          ]}
          testID="juno-advanced-toggle"
        >
          <StudioIcon color={theme.colors.textSecondary} name="diagnostics" size={18} />
          <View style={styles.diagnosticsCopy}>
            <StudioText variant="label" weight="medium">
              Advanced controls & diagnostics
            </StudioText>
            <StudioText variant="caption" tone="secondary">
              Engine, routing and patch state
            </StudioText>
          </View>
          <StudioIcon
            color={theme.colors.textSecondary}
            name={diagnosticsExpanded ? 'chevronUp' : 'chevronDown'}
            size={16}
          />
        </Pressable>

        {diagnosticsExpanded ? (
          <View style={styles.advancedContent} testID="juno-advanced-content">
            <View style={styles.parameterGrid}>
              {ADVANCED_PARAMETER_SPECS.map(renderParameterControl)}
            </View>

            <View style={styles.parameterHeader}>
              <StudioText variant="label" tone="magenta" weight="bold">
                CHORUS
              </StudioText>
              <StudioText selectable variant="caption" tone="secondary">
                {parameters.chorusMode === 0
                  ? 'Off'
                  : parameters.chorusMode === 1
                    ? 'Mode I'
                    : 'Mode II'}
              </StudioText>
            </View>
            <View
              accessibilityLabel="Juno chorus mode"
              accessibilityRole="radiogroup"
              style={[
                styles.chorusModes,
                {
                  backgroundColor: theme.colors.surfaceVariant,
                  borderColor: theme.colors.border,
                },
              ]}
            >
              {[
                { label: 'Off', value: 0 },
                { label: 'I', value: 1 },
                { label: 'II', value: 2 },
              ].map((mode, index) => {
                const selected = parameters.chorusMode === mode.value;
                return (
                  <Pressable
                    key={mode.value}
                    accessibilityLabel={`Set Juno chorus ${mode.label}`}
                    accessibilityRole="radio"
                    accessibilityState={{
                      disabled: parameterControlsDisabled,
                      selected,
                    }}
                    disabled={parameterControlsDisabled}
                    onPress={() => {
                      updateParameter('chorusMode', mode.value, 'advanced').catch(
                        () => undefined,
                      );
                    }}
                    style={({ pressed }) => [
                      styles.chorusMode,
                      index > 0 && styles.chorusDivider,
                      index > 0 && { borderLeftColor: theme.colors.border },
                      selected && { backgroundColor: theme.colors.accentPrimary },
                      pressed && { opacity: 0.82 },
                    ]}
                    testID={`juno-chorus-${mode.value}`}
                  >
                    <StudioText
                      selectable={false}
                      variant="label"
                      weight="bold"
                      style={{
                        color: selected
                          ? theme.colors.accentPrimaryInk
                          : theme.colors.textSecondary,
                      }}
                    >
                      {mode.label}
                    </StudioText>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.diagnosticsContent}>
              <View style={styles.diagnostic}>
                <StudioText variant="caption" tone="muted">
                  ENGINE
                </StudioText>
                <StudioText selectable variant="label" weight="bold">
                  {instrumentControls.isAvailable ? 'Native' : 'Patch only'}
                </StudioText>
              </View>
              <View style={styles.diagnostic}>
                <StudioText variant="caption" tone="muted">
                  ROUTING
                </StudioText>
                <StudioText selectable variant="label" weight="bold">
                  {nodeId ? 'Connected' : 'Unavailable'}
                </StudioText>
              </View>
              <View style={styles.diagnostic}>
                <StudioText variant="caption" tone="muted">
                  PATCH
                </StudioText>
                <StudioText selectable variant="label" weight="bold">
                  {pendingParameter || pendingPreset ? 'Saving' : 'Saved'}
                </StudioText>
              </View>
            </View>
          </View>
        ) : null}
        {renderActionError('advanced')}
      </View>
    </StudioPanel>
  );
};
