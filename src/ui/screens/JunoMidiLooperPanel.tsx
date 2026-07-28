import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image } from 'expo-image';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';

import type { MidiNoteEvent, Session } from '../../session';
import {
  StatusBadge,
  StudioAlertText,
  StudioButton,
  StudioIcon,
  StudioPanel,
  StudioText,
  useTheme,
} from '../design-system';
import { useAdaptiveLayout } from '../layout';
import { useSessionActions, useTransportControls, type TrackViewModel } from '../session';
import { JunoPerformancePanel } from './JunoPerformancePanel';

interface JunoMidiLooperPanelProps {
  autoPlayScenes: boolean;
  bpm: number;
  status: 'idle' | 'loading' | 'ready' | 'error';
  timeSignature: string;
  tracks: TrackViewModel[];
}

interface LoopPart {
  clipId: string;
  durationMs: number;
  id: string;
  name: string;
  notes: TrackViewModel['clips'][number]['midiNotes'];
  startMs: number;
  track: TrackViewModel;
}

interface LoopScene {
  durationMs: number;
  id: string;
  name: string;
  parts: LoopPart[];
  startMs: number;
}

interface PendingNote {
  pitch: number;
  startBeat: number;
  startedAtMs: number;
  velocity: number;
}

type TakeMode = 'idle' | 'armed-record' | 'armed-overdub' | 'recording' | 'overdubbing';
type LooperActionErrorLocation = 'grid' | 'selection';

interface LooperActionError {
  location: LooperActionErrorLocation;
  message: string;
}

type PadState =
  | 'ADD SCENE'
  | 'ARMED'
  | 'LOOP'
  | 'MUTED'
  | 'OVERDUB'
  | 'PLAYING'
  | 'STARTING'
  | 'RECORDING';

const PAD_COUNT = 16;
const GRID_COLUMNS = 4;
const STEPS_PER_BEAT = 4;
const DEFAULT_LOOP_BARS = 1;

const styles = StyleSheet.create({
  panel: { gap: 14 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'space-between',
  },
  headerCopy: { flex: 1, minWidth: 190 },
  detail: { marginTop: 2 },
  grid: {
    alignSelf: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  pad: {
    borderCurve: 'continuous',
    borderRadius: 11,
    borderWidth: 1,
    justifyContent: 'space-between',
    minHeight: 58,
    padding: 8,
  },
  padTop: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  padName: { fontSize: 11, lineHeight: 13, textAlign: 'center' },
  padState: { fontSize: 9, lineHeight: 11, textAlign: 'center' },
  selectedPanel: { gap: 12 },
  selectedHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'space-between',
  },
  selectedCopy: { flex: 1, minWidth: 180 },
  partTabs: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  controlRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  levelGroup: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  levelButton: { minWidth: 44, paddingHorizontal: 10 },
  error: { gap: 4 },
  unavailable: { gap: 6 },
  emptyIllustration: {
    alignSelf: 'stretch',
    aspectRatio: 16 / 9,
    borderRadius: 10,
    maxHeight: 180,
  },
});

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

const parseBeatsPerBar = (timeSignature: string | undefined): number => {
  const [numeratorText, denominatorText] = (timeSignature ?? '4/4').split('/');
  const numerator = Number.parseInt(numeratorText ?? '', 10);
  const denominator = Number.parseInt(denominatorText ?? '', 10);
  if (!Number.isFinite(numerator) || numerator <= 0) {
    return 4;
  }
  if (!Number.isFinite(denominator) || denominator <= 0) {
    return numerator;
  }
  return (numerator * 4) / denominator;
};

const formatError = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

const sceneIdForTiming = (startMs: number, durationMs: number): string =>
  `${startMs}:${durationMs}`;

const sessionJunoParts = (
  session: Session,
): Array<{ clipId: string; durationMs: number; startMs: number; trackId: string }> =>
  session.tracks.flatMap((track) => {
    const hasJuno =
      track.routing.graph?.nodes.some(
        (node) => node.type === 'instrument' && node.instrumentType === 'juno106',
      ) ?? false;
    if (!hasJuno) {
      return [];
    }
    return track.clips
      .filter((clip) => Boolean(clip.midi) && !clip.audioFile)
      .map((clip) => ({
        clipId: clip.id,
        durationMs: clip.duration,
        startMs: clip.start,
        trackId: track.id,
      }));
  });

const relativeNotesForLoop = (loop: LoopPart, bpm: number): MidiNoteEvent[] => {
  const clipStartBeat = (loop.startMs / 60000) * bpm;
  const prefix = `${loop.clipId}:`;
  return loop.notes.map((note, index) => ({
    id: note.id.startsWith(prefix) ? note.id.slice(prefix.length) : `note-${index + 1}`,
    pitch: note.pitch,
    startBeat: Math.max(0, note.start - clipStartBeat),
    durationBeats: note.duration,
    velocity: note.velocity,
  }));
};

const resolvePadState = (
  scene: LoopScene | null,
  selected: boolean,
  launching: boolean,
  mode: TakeMode,
  isPlaying: boolean,
): PadState => {
  if (!scene) {
    return 'ADD SCENE';
  }
  if (launching) {
    return 'STARTING';
  }
  if (selected && mode.startsWith('armed')) {
    return 'ARMED';
  }
  if (selected && mode === 'recording') {
    return 'RECORDING';
  }
  if (selected && mode === 'overdubbing') {
    return 'OVERDUB';
  }
  if (scene.parts.every((part) => part.track.muted)) {
    return 'MUTED';
  }
  if (selected && isPlaying) {
    return 'PLAYING';
  }
  return 'LOOP';
};

export const JunoMidiLooperPanel: React.FC<JunoMidiLooperPanelProps> = ({
  autoPlayScenes,
  bpm,
  status,
  timeSignature,
  tracks,
}) => {
  const theme = useTheme();
  const adaptive = useAdaptiveLayout();
  const sessionActions = useSessionActions();
  const transportControls = useTransportControls();
  const [selectedSceneId, setSelectedSceneId] = useState<string>();
  const [selectedLoopId, setSelectedLoopId] = useState<string>();
  const [launchingSceneId, setLaunchingSceneId] = useState<string>();
  const [takeMode, setTakeMode] = useState<TakeMode>('idle');
  const [takeNoteCount, setTakeNoteCount] = useState(0);
  const [actionError, setActionError] = useState<LooperActionError>();
  const [isAddingScene, setIsAddingScene] = useState(false);
  const [isAddingPart, setIsAddingPart] = useState(false);
  const [isDuplicatingScene, setIsDuplicatingScene] = useState(false);
  const recordingStartedAtRef = useRef(0);
  const activeNotesRef = useRef(new Map<number, PendingNote>());
  const takeNotesRef = useRef<MidiNoteEvent[]>([]);
  const takeOrdinalRef = useRef(0);
  const allocatedNoteIdsRef = useRef(new Set<string>());
  const previousLayerRef = useRef<{ loopId: string; notes: MidiNoteEvent[] } | null>(
    null,
  );

  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const beatsPerBar = parseBeatsPerBar(timeSignature);

  const loops = useMemo<LoopPart[]>(() => {
    const parts: LoopPart[] = [];
    tracks.forEach((track) => {
      if (!track.id || track.instrument?.instrumentType !== 'juno106') {
        return;
      }
      track.clips.forEach((clip) => {
        if (clip.audioFile) {
          return;
        }
        parts.push({
          clipId: clip.id,
          durationMs: clip.durationMs,
          id: `${track.id}:${clip.id}`,
          name: clip.name,
          notes: clip.midiNotes,
          startMs: clip.startMs,
          track,
        });
      });
    });
    return parts.sort(
      (left, right) =>
        left.startMs - right.startMs || left.track.name.localeCompare(right.track.name),
    );
  }, [tracks]);

  const scenes = useMemo<LoopScene[]>(() => {
    const grouped = new Map<string, Omit<LoopScene, 'name'>>();
    loops.forEach((part) => {
      const id = sceneIdForTiming(part.startMs, part.durationMs);
      const existing = grouped.get(id);
      if (existing) {
        existing.parts.push(part);
      } else {
        grouped.set(id, {
          durationMs: part.durationMs,
          id,
          parts: [part],
          startMs: part.startMs,
        });
      }
    });
    return Array.from(grouped.values())
      .sort((left, right) => left.startMs - right.startMs)
      .map((scene, index) => ({ ...scene, name: `Scene ${index + 1}` }));
  }, [loops]);

  useEffect(() => {
    if (selectedSceneId && scenes.some((scene) => scene.id === selectedSceneId)) {
      return;
    }
    setSelectedSceneId(scenes[0]?.id);
  }, [scenes, selectedSceneId]);

  const selectedScene = useMemo(
    () => scenes.find((scene) => scene.id === selectedSceneId),
    [scenes, selectedSceneId],
  );

  useEffect(() => {
    if (selectedScene?.parts.some((part) => part.id === selectedLoopId)) {
      return;
    }
    setSelectedLoopId(selectedScene?.parts[0]?.id);
  }, [selectedLoopId, selectedScene]);

  const selectedLoop = useMemo(
    () => selectedScene?.parts.find((part) => part.id === selectedLoopId),
    [selectedLoopId, selectedScene],
  );

  const padSlots = useMemo<Array<LoopScene | null>>(
    () => Array.from({ length: PAD_COUNT }, (_, index) => scenes[index] ?? null),
    [scenes],
  );

  const gridMetrics = useMemo(() => {
    const gap = adaptive.width < 360 ? 6 : 8;
    const panelPadding = adaptive.width < 360 ? 12 : 16;
    const cappedWidth = Math.min(adaptive.width, adaptive.maxContentWidth, 760);
    const available = Math.max(
      0,
      cappedWidth - adaptive.contentPadding * 2 - panelPadding * 2,
    );
    const size = Math.max(
      52,
      Math.min(124, Math.floor((available - gap * (GRID_COLUMNS - 1)) / GRID_COLUMNS)),
    );
    return {
      gap,
      size,
      width: size * GRID_COLUMNS + gap * (GRID_COLUMNS - 1),
    };
  }, [adaptive.contentPadding, adaptive.maxContentWidth, adaptive.width]);

  const loopRangeBeats = useCallback(
    (loop: LoopScene): { end: number; length: number; start: number } => {
      const start = (loop.startMs / 60000) * safeBpm;
      const length = Math.max(
        1 / STEPS_PER_BEAT,
        (Math.max(1, loop.durationMs) / 60000) * safeBpm,
      );
      return { start, end: start + length, length };
    },
    [safeBpm],
  );

  const configureAndPlayScene = useCallback(
    async (scene: LoopScene) => {
      if (!transportControls.isLoopAvailable) {
        throw new Error(
          'Native loop transport is unavailable. Install the current development build to play loops.',
        );
      }
      const range = loopRangeBeats(scene);
      await transportControls.setLoopBeats(range.start, range.end, true);
      await transportControls.locateBeats(range.start);
      if (!transportControls.isPlaying) {
        await transportControls.play();
      }
    },
    [loopRangeBeats, transportControls],
  );

  const handleSceneLaunch = useCallback(
    async (
      scene: LoopScene,
      forcePlay = false,
      errorLocation: LooperActionErrorLocation = 'grid',
    ) => {
      if (takeMode !== 'idle') {
        return;
      }
      setSelectedSceneId(scene.id);
      if (!scene.parts.some((part) => part.id === selectedLoopId)) {
        setSelectedLoopId(scene.parts[0]?.id);
      }
      if (!autoPlayScenes && !forcePlay) {
        return;
      }
      setLaunchingSceneId(scene.id);
      setActionError(undefined);
      try {
        await configureAndPlayScene(scene);
      } catch (error) {
        setActionError({
          location: errorLocation,
          message: formatError(error, 'Unable to launch this scene.'),
        });
      } finally {
        setLaunchingSceneId(undefined);
      }
    },
    [autoPlayScenes, configureAndPlayScene, selectedLoopId, takeMode],
  );

  const handleAddScene = useCallback(async () => {
    if (isAddingScene || scenes.length >= PAD_COUNT || takeMode !== 'idle') {
      return;
    }
    setIsAddingScene(true);
    setActionError(undefined);
    try {
      const updated = await sessionActions.createJunoMidiScene({
        bars: DEFAULT_LOOP_BARS,
        name: `Scene ${scenes.length + 1} · Part 1`,
        trackName: 'Juno Part 1',
      });
      const newest = sessionJunoParts(updated).sort(
        (left, right) => right.startMs - left.startMs,
      )[0];
      if (newest) {
        setSelectedSceneId(sceneIdForTiming(newest.startMs, newest.durationMs));
        setSelectedLoopId(`${newest.trackId}:${newest.clipId}`);
      }
    } catch (error) {
      setActionError({
        location: 'grid',
        message: formatError(error, 'Unable to add a scene.'),
      });
    } finally {
      setIsAddingScene(false);
    }
  }, [isAddingScene, scenes.length, sessionActions, takeMode]);

  const handleAddPart = useCallback(async () => {
    if (!selectedScene || isAddingPart || takeMode !== 'idle') {
      return;
    }
    setIsAddingPart(true);
    setActionError(undefined);
    try {
      const partOrdinal = selectedScene.parts.length + 1;
      const updated = await sessionActions.addJunoScenePart({
        durationMs: selectedScene.durationMs,
        name: `${selectedScene.name} · Part ${partOrdinal}`,
        startMs: selectedScene.startMs,
        trackName: `Juno Part ${partOrdinal}`,
      });
      const aligned = sessionJunoParts(updated).filter(
        (part) =>
          part.startMs === selectedScene.startMs &&
          part.durationMs === selectedScene.durationMs,
      );
      const newPart = aligned.find(
        (part) =>
          !selectedScene.parts.some((current) => current.track.id === part.trackId),
      );
      if (newPart) {
        setSelectedLoopId(`${newPart.trackId}:${newPart.clipId}`);
      }
    } catch (error) {
      setActionError({
        location: 'selection',
        message: formatError(error, 'Unable to add a part to this scene.'),
      });
    } finally {
      setIsAddingPart(false);
    }
  }, [isAddingPart, selectedScene, sessionActions, takeMode]);

  const handleDuplicateScene = useCallback(async () => {
    if (
      !selectedScene ||
      isDuplicatingScene ||
      scenes.length >= PAD_COUNT ||
      takeMode !== 'idle'
    ) {
      return;
    }
    setIsDuplicatingScene(true);
    setActionError(undefined);
    try {
      const updated = await sessionActions.duplicateJunoMidiScene({
        durationMs: selectedScene.durationMs,
        startMs: selectedScene.startMs,
      });
      const newestStart = Math.max(
        ...sessionJunoParts(updated).map((part) => part.startMs),
      );
      const newest = sessionJunoParts(updated).find(
        (part) => part.startMs === newestStart,
      );
      if (newest) {
        setSelectedSceneId(sceneIdForTiming(newest.startMs, newest.durationMs));
        setSelectedLoopId(`${newest.trackId}:${newest.clipId}`);
      }
    } catch (error) {
      setActionError({
        location: 'selection',
        message: formatError(error, 'Unable to duplicate this scene.'),
      });
    } finally {
      setIsDuplicatingScene(false);
    }
  }, [isDuplicatingScene, scenes.length, selectedScene, sessionActions, takeMode]);

  const startTake = useCallback(
    async (overdub: boolean) => {
      if (!selectedLoop || !selectedScene || takeMode !== 'idle') {
        return;
      }
      const armedMode: TakeMode = overdub ? 'armed-overdub' : 'armed-record';
      setTakeMode(armedMode);
      setActionError(undefined);
      try {
        await configureAndPlayScene(selectedScene);
        const previousNotes = relativeNotesForLoop(selectedLoop, safeBpm);
        previousLayerRef.current = { loopId: selectedLoop.id, notes: previousNotes };
        takeNotesRef.current = [];
        allocatedNoteIdsRef.current = new Set(previousNotes.map((note) => note.id));
        activeNotesRef.current.clear();
        takeOrdinalRef.current += 1;
        recordingStartedAtRef.current = Date.now();
        setTakeNoteCount(0);
        setTakeMode(overdub ? 'overdubbing' : 'recording');
      } catch (error) {
        setTakeMode('idle');
        setActionError({
          location: 'selection',
          message: formatError(error, 'Unable to arm loop recording.'),
        });
      }
    },
    [configureAndPlayScene, safeBpm, selectedLoop, selectedScene, takeMode],
  );

  const captureNoteOn = useCallback(
    (pitch: number, velocity: number, occurredAtMs: number) => {
      if (
        !selectedLoop ||
        !selectedScene ||
        (takeMode !== 'recording' && takeMode !== 'overdubbing')
      ) {
        return;
      }
      const range = loopRangeBeats(selectedScene);
      const loopDurationMs = (range.length * 60000) / safeBpm;
      const elapsedMs = Math.max(0, occurredAtMs - recordingStartedAtRef.current);
      const elapsedBeats = ((elapsedMs % loopDurationMs) * safeBpm) / 60000;
      const quantizedStart = Math.round(elapsedBeats * STEPS_PER_BEAT) / STEPS_PER_BEAT;
      activeNotesRef.current.set(pitch, {
        pitch,
        startBeat: quantizedStart >= range.length ? 0 : quantizedStart,
        startedAtMs: occurredAtMs,
        velocity,
      });
    },
    [loopRangeBeats, safeBpm, selectedLoop, selectedScene, takeMode],
  );

  const captureNoteOff = useCallback(
    (pitch: number, occurredAtMs: number) => {
      if (
        !selectedLoop ||
        !selectedScene ||
        (takeMode !== 'recording' && takeMode !== 'overdubbing')
      ) {
        return;
      }
      const pending = activeNotesRef.current.get(pitch);
      if (!pending) {
        return;
      }
      activeNotesRef.current.delete(pitch);
      const loopLength = loopRangeBeats(selectedScene).length;
      const heldBeats = ((occurredAtMs - pending.startedAtMs) * safeBpm) / 60000;
      const quantizedDuration = Math.max(
        1 / STEPS_PER_BEAT,
        Math.round(heldBeats * STEPS_PER_BEAT) / STEPS_PER_BEAT,
      );
      const durationBeats = Math.min(
        quantizedDuration,
        Math.max(1 / STEPS_PER_BEAT, loopLength - pending.startBeat),
      );
      let noteOrdinal = takeNotesRef.current.length + 1;
      let noteId = `take-${takeOrdinalRef.current}-${noteOrdinal}`;
      while (allocatedNoteIdsRef.current.has(noteId)) {
        noteOrdinal += 1;
        noteId = `take-${takeOrdinalRef.current}-${noteOrdinal}`;
      }
      allocatedNoteIdsRef.current.add(noteId);
      const note: MidiNoteEvent = {
        id: noteId,
        pitch: pending.pitch,
        startBeat: pending.startBeat,
        durationBeats,
        velocity: pending.velocity,
      };
      takeNotesRef.current = [...takeNotesRef.current, note];
      setTakeNoteCount(takeNotesRef.current.length);
    },
    [loopRangeBeats, safeBpm, selectedLoop, selectedScene, takeMode],
  );

  const finishTake = useCallback(async () => {
    if (
      !selectedLoop ||
      !selectedScene ||
      (takeMode !== 'recording' && takeMode !== 'overdubbing')
    ) {
      return;
    }
    const now = Date.now();
    Array.from(activeNotesRef.current.keys()).forEach((pitch) => {
      captureNoteOff(pitch, now);
    });
    const previousNotes = relativeNotesForLoop(selectedLoop, safeBpm);
    const nextNotes =
      takeMode === 'overdubbing'
        ? [...previousNotes, ...takeNotesRef.current]
        : [...takeNotesRef.current];
    setActionError(undefined);
    try {
      await sessionActions.setMidiClipNotes(
        selectedLoop.track.id,
        selectedLoop.clipId,
        nextNotes,
      );
      setTakeMode('idle');
      activeNotesRef.current.clear();
      await configureAndPlayScene(selectedScene);
    } catch (error) {
      setActionError({
        location: 'selection',
        message: formatError(error, 'Unable to save this loop take.'),
      });
    }
  }, [
    captureNoteOff,
    configureAndPlayScene,
    safeBpm,
    selectedLoop,
    selectedScene,
    sessionActions,
    takeMode,
  ]);

  const undoLayer = useCallback(async () => {
    if (
      !selectedLoop ||
      previousLayerRef.current?.loopId !== selectedLoop.id ||
      takeMode !== 'idle'
    ) {
      return;
    }
    setActionError(undefined);
    try {
      await sessionActions.setMidiClipNotes(
        selectedLoop.track.id,
        selectedLoop.clipId,
        previousLayerRef.current.notes,
      );
      previousLayerRef.current = null;
    } catch (error) {
      setActionError({
        location: 'selection',
        message: formatError(error, 'Unable to undo the last loop layer.'),
      });
    }
  }, [selectedLoop, sessionActions, takeMode]);

  const clearLoop = useCallback(async () => {
    if (!selectedLoop || takeMode !== 'idle') {
      return;
    }
    setActionError(undefined);
    previousLayerRef.current = {
      loopId: selectedLoop.id,
      notes: relativeNotesForLoop(selectedLoop, safeBpm),
    };
    try {
      await sessionActions.clearMidiClip(selectedLoop.track.id, selectedLoop.clipId);
    } catch (error) {
      setActionError({
        location: 'selection',
        message: formatError(error, 'Unable to clear this loop.'),
      });
    }
  }, [safeBpm, selectedLoop, sessionActions, takeMode]);

  const adjustLevel = useCallback(
    async (direction: -1 | 1) => {
      if (!selectedLoop) {
        return;
      }
      setActionError(undefined);
      try {
        await sessionActions.setTrackVolume(
          selectedLoop.track.id,
          clamp(selectedLoop.track.volumeDb + direction, -60, 12),
        );
      } catch (error) {
        setActionError({
          location: 'selection',
          message: formatError(error, 'Unable to change part level.'),
        });
      }
    },
    [selectedLoop, sessionActions],
  );

  const padPalette = [
    theme.colors.accentPrimary,
    theme.colors.accentTertiary,
    theme.colors.accentSecondary,
    theme.colors.statusWarning,
  ];
  const gridStyle: ViewStyle = {
    gap: gridMetrics.gap,
    width: gridMetrics.width,
  };
  const sceneActionPending =
    isAddingScene || isAddingPart || isDuplicatingScene || launchingSceneId !== undefined;

  const renderActionError = (
    location: LooperActionErrorLocation,
  ): React.ReactElement | null => {
    if (!actionError || actionError.location !== location) {
      return null;
    }
    return (
      <StudioPanel
        padding={12}
        style={styles.error}
        testID={`looper-${location}-action-error`}
        variant="subtle"
      >
        <StudioText variant="label" tone="critical" weight="bold">
          Looper action failed
        </StudioText>
        <StudioAlertText
          announcement={`Looper action failed. ${actionError.message}`}
          selectable
          testID={`looper-${location}-action-error-announcement`}
          tone="critical"
          variant="caption"
        >
          {actionError.message}
        </StudioAlertText>
      </StudioPanel>
    );
  };

  if (status !== 'ready') {
    return null;
  }

  return (
    <>
      <StudioPanel padding={adaptive.width < 360 ? 12 : 16} style={styles.panel}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <StudioText variant="sectionTitle" weight="bold">
              Juno scene launcher
            </StudioText>
            <StudioText variant="caption" tone="secondary" style={styles.detail}>
              Layer Juno parts, duplicate variations, and launch each persisted scene.
            </StudioText>
          </View>
          <StatusBadge
            icon="engine"
            label={
              transportControls.isLoopAvailable
                ? 'Native loop ready'
                : 'Dev build required'
            }
            tone={transportControls.isLoopAvailable ? 'mint' : 'warning'}
          />
        </View>

        <View
          accessibilityLabel="Juno scene pad grid"
          role="group"
          style={[styles.grid, gridStyle]}
          testID="juno-scene-pad-grid"
        >
          {padSlots.map((scene, index) => {
            const selected = scene?.id === selectedScene?.id;
            const state = resolvePadState(
              scene,
              selected,
              scene?.id === launchingSceneId,
              takeMode,
              transportControls.isPlaying,
            );
            const color =
              padPalette[Math.floor(index / GRID_COLUMNS) % padPalette.length];
            const active =
              selected &&
              (state === 'PLAYING' || state === 'RECORDING' || state === 'OVERDUB');
            const nativeAutoPlayUnavailable =
              Boolean(scene) && autoPlayScenes && !transportControls.isLoopAvailable;
            const disabled =
              sceneActionPending || takeMode !== 'idle' || nativeAutoPlayUnavailable;
            return (
              <Pressable
                key={scene?.id ?? `empty-scene-${index}`}
                accessibilityHint={
                  scene
                    ? nativeAutoPlayUnavailable
                      ? 'Unavailable while Auto-play scenes requires native loop transport'
                      : autoPlayScenes
                        ? 'Selects this scene and starts its native transport loop'
                        : 'Selects this scene; use Launch to start its native transport loop'
                    : 'Creates a new one-bar Juno scene'
                }
                accessibilityLabel={
                  scene
                    ? `${scene.name}, ${scene.parts.length} ${
                        scene.parts.length === 1 ? 'part' : 'parts'
                      }, ${state.toLowerCase()}`
                    : `Add scene ${index + 1}`
                }
                accessibilityRole="button"
                accessibilityState={{ disabled, selected }}
                disabled={disabled}
                onPress={() => {
                  if (scene) {
                    handleSceneLaunch(scene).catch(() => undefined);
                  } else {
                    handleAddScene().catch(() => undefined);
                  }
                }}
                style={({ pressed }) => [
                  styles.pad,
                  {
                    backgroundColor: active ? color : `${color}18`,
                    borderColor: selected ? color : `${color}70`,
                    height: gridMetrics.size,
                    opacity: disabled ? 0.5 : pressed ? 0.78 : 1,
                    width: gridMetrics.size,
                  },
                ]}
                testID={scene ? 'juno-scene-pad' : 'juno-add-scene-pad'}
              >
                <View style={styles.padTop}>
                  <StudioText
                    selectable={false}
                    variant="caption"
                    weight="bold"
                    style={{ color: active ? theme.colors.background : color }}
                  >
                    {String(index + 1).padStart(2, '0')}
                  </StudioText>
                  <StudioIcon
                    color={active ? theme.colors.background : color}
                    name={scene ? 'play' : 'plus'}
                    size={11}
                  />
                </View>
                <StudioText
                  adjustsFontSizeToFit
                  minimumFontScale={0.7}
                  numberOfLines={2}
                  selectable={false}
                  variant="label"
                  weight="bold"
                  style={[
                    styles.padName,
                    {
                      color: active ? theme.colors.background : theme.colors.textPrimary,
                    },
                  ]}
                >
                  {scene?.name.toUpperCase() ?? 'ADD'}
                </StudioText>
                <StudioText
                  selectable={false}
                  variant="caption"
                  weight="bold"
                  style={[
                    styles.padState,
                    { color: active ? theme.colors.background : color },
                  ]}
                >
                  {scene ? `${scene.parts.length}P · ${state}` : state}
                </StudioText>
              </Pressable>
            );
          })}
        </View>
        {renderActionError('grid')}

        {selectedScene && selectedLoop ? (
          <StudioPanel padding={12} style={styles.selectedPanel} variant="subtle">
            <View style={styles.selectedHeader}>
              <View style={styles.selectedCopy}>
                <StudioText variant="label" weight="bold">
                  {selectedScene.name}
                </StudioText>
                <StudioText variant="caption" tone="secondary">
                  {selectedScene.parts.length}{' '}
                  {selectedScene.parts.length === 1 ? 'part' : 'parts'} ·{' '}
                  {Math.max(
                    1,
                    Math.round(loopRangeBeats(selectedScene).length / beatsPerBar),
                  )}{' '}
                  {Math.round(loopRangeBeats(selectedScene).length / beatsPerBar) === 1
                    ? 'bar'
                    : 'bars'}
                </StudioText>
              </View>
              <StatusBadge
                label={resolvePadState(
                  selectedScene,
                  true,
                  selectedScene.id === launchingSceneId,
                  takeMode,
                  transportControls.isPlaying,
                )}
                tone={
                  takeMode === 'recording'
                    ? 'critical'
                    : takeMode === 'overdubbing'
                      ? 'magenta'
                      : 'cyan'
                }
              />
            </View>

            <View style={styles.controlRow}>
              <StudioButton
                compact
                accessibilityHint="Loops every aligned part in this scene"
                disabled={!transportControls.isLoopAvailable || sceneActionPending}
                icon="play"
                label="Launch scene"
                onPress={() => {
                  handleSceneLaunch(selectedScene, true, 'selection').catch(
                    () => undefined,
                  );
                }}
                testID="launch-juno-scene"
                variant="primary"
              />
              <StudioButton
                compact
                accessibilityHint="Copies every part into a new aligned variation"
                disabled={sceneActionPending || scenes.length >= PAD_COUNT}
                label="Duplicate"
                loading={isDuplicatingScene}
                onPress={() => {
                  handleDuplicateScene().catch(() => undefined);
                }}
                testID="duplicate-juno-scene"
              />
              <StudioButton
                compact
                accessibilityHint="Adds another independently mixed Juno instrument to this scene"
                disabled={sceneActionPending}
                icon="plus"
                label="Add part"
                loading={isAddingPart}
                onPress={() => {
                  handleAddPart().catch(() => undefined);
                }}
                testID="add-juno-scene-part"
                variant="secondary"
              />
            </View>

            <View accessibilityLabel="Scene parts" style={styles.partTabs}>
              {selectedScene.parts.map((part, index) => (
                <StudioButton
                  key={part.id}
                  compact
                  accessibilityLabel={`Edit ${part.track.name} in ${selectedScene.name}`}
                  accessibilityState={{ selected: part.id === selectedLoop.id }}
                  disabled={takeMode !== 'idle'}
                  label={`${index + 1}. ${part.track.name}`}
                  onPress={() => setSelectedLoopId(part.id)}
                  testID="juno-scene-part"
                  variant={part.id === selectedLoop.id ? 'primary' : 'secondary'}
                />
              ))}
            </View>

            <View style={styles.selectedCopy}>
              <StudioText variant="label" tone="cyan" weight="bold">
                Editing {selectedLoop.track.name}
              </StudioText>
              <StudioText variant="caption" tone="secondary">
                {selectedLoop.name} · {selectedLoop.notes.length} notes
              </StudioText>
            </View>

            <View style={styles.controlRow}>
              {takeMode === 'recording' || takeMode === 'overdubbing' ? (
                <StudioButton
                  accessibilityHint="Saves the captured notes and keeps the loop playing"
                  label={`Finish take (${takeNoteCount})`}
                  onPress={() => {
                    finishTake().catch(() => undefined);
                  }}
                  testID="finish-loop-take"
                  variant="primary"
                />
              ) : (
                <>
                  <StudioButton
                    accessibilityHint="Replaces this loop with a new touch-keyboard take"
                    disabled={!transportControls.isLoopAvailable}
                    label="Record"
                    onPress={() => {
                      startTake(false).catch(() => undefined);
                    }}
                    testID="record-loop"
                    variant="primary"
                  />
                  <StudioButton
                    accessibilityHint="Adds a new touch-keyboard layer without clearing existing notes"
                    disabled={!transportControls.isLoopAvailable}
                    label="Overdub"
                    onPress={() => {
                      startTake(true).catch(() => undefined);
                    }}
                    testID="overdub-loop"
                  />
                </>
              )}
              <StudioButton
                compact
                disabled={
                  previousLayerRef.current?.loopId !== selectedLoop.id ||
                  takeMode !== 'idle'
                }
                label="Undo layer"
                onPress={() => {
                  undoLayer().catch(() => undefined);
                }}
                testID="undo-loop-layer"
                variant="ghost"
              />
              <StudioButton
                compact
                disabled={takeMode !== 'idle'}
                label="Clear"
                onPress={() => {
                  clearLoop().catch(() => undefined);
                }}
                testID="clear-loop"
                variant="danger"
              />
            </View>

            <View style={styles.controlRow}>
              <StudioButton
                compact
                accessibilityLabel={
                  selectedLoop.track.muted ? 'Unmute selected part' : 'Mute selected part'
                }
                label={selectedLoop.track.muted ? 'Unmute part' : 'Mute part'}
                onPress={() => {
                  setActionError(undefined);
                  sessionActions
                    .setTrackMuted(selectedLoop.track.id, !selectedLoop.track.muted)
                    .catch((error) => {
                      setActionError({
                        location: 'selection',
                        message: formatError(error, 'Unable to update mute.'),
                      });
                    });
                }}
                testID="loop-mute"
                variant={selectedLoop.track.muted ? 'primary' : 'secondary'}
              />
              <StudioButton
                compact
                accessibilityLabel={
                  selectedLoop.track.solo ? 'Unsolo selected part' : 'Solo selected part'
                }
                label={selectedLoop.track.solo ? 'Unsolo part' : 'Solo part'}
                onPress={() => {
                  setActionError(undefined);
                  sessionActions
                    .setTrackSolo(selectedLoop.track.id, !selectedLoop.track.solo)
                    .catch((error) => {
                      setActionError({
                        location: 'selection',
                        message: formatError(error, 'Unable to update solo.'),
                      });
                    });
                }}
                testID="loop-solo"
                variant={selectedLoop.track.solo ? 'primary' : 'secondary'}
              />
              <View accessibilityLabel="Selected part level" style={styles.levelGroup}>
                <StudioButton
                  compact
                  accessibilityLabel="Decrease selected part level"
                  label="−"
                  onPress={() => {
                    adjustLevel(-1).catch(() => undefined);
                  }}
                  style={styles.levelButton}
                />
                <StudioText selectable variant="label" tone="secondary">
                  {selectedLoop.track.volumeDb.toFixed(0)} dB
                </StudioText>
                <StudioButton
                  compact
                  accessibilityLabel="Increase selected part level"
                  label="+"
                  onPress={() => {
                    adjustLevel(1).catch(() => undefined);
                  }}
                  style={styles.levelButton}
                />
              </View>
            </View>
            {renderActionError('selection')}
          </StudioPanel>
        ) : scenes.length === 0 ? (
          <StudioPanel
            padding={12}
            style={styles.unavailable}
            testID="juno-scene-launcher-empty"
            variant="subtle"
          >
            <Image
              accessible={false}
              contentFit="contain"
              source={require('../../../assets/ui/scene-launcher-empty.webp')}
              style={styles.emptyIllustration}
              testID="juno-scene-launcher-empty-illustration"
            />
            <StudioText variant="label" weight="bold">
              Tap an Add Scene pad to start.
            </StudioText>
            <StudioText variant="caption" tone="secondary">
              Daft Citadel will create a routed Juno part and a persisted one-bar scene.
            </StudioText>
          </StudioPanel>
        ) : (
          <StudioPanel padding={12} style={styles.unavailable} variant="subtle">
            <StudioText variant="label" weight="bold">
              Selecting scene…
            </StudioText>
          </StudioPanel>
        )}
      </StudioPanel>

      <JunoPerformancePanel
        activeTrackId={selectedLoop?.track.id}
        onNoteOff={captureNoteOff}
        onNoteOn={captureNoteOn}
        status={status}
        tracks={tracks}
      />
    </>
  );
};
