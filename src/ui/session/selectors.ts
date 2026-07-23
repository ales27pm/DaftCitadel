import {
  AutomationCurve,
  PluginRoutingNode,
  RoutingGraph,
  Session,
  SessionMetadata,
  Track,
  type InstrumentRoutingNode,
} from '../../session';
import {
  SessionDiagnosticsView,
  SessionTransportView,
  TrackViewModel,
  TrackPluginViewModel,
  TrackPluginStatus,
  TransportRuntimeState,
  PlayheadReference,
} from './types';
import type { PluginCrashReport } from '../../audio';

const DEFAULT_SAMPLE_COUNT = 2048;
const MIN_SESSION_LENGTH_MS = 1000;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const hashString = (input: string): number => {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33 + input.charCodeAt(i)) % 1_000_003;
  }
  return hash / 1_000_003;
};

const parseTimeSignature = (
  timeSignature: string,
): { numerator: number; denominator: number } => {
  const [rawNumerator, rawDenominator] = timeSignature.split('/');
  const numerator = Number.parseInt(rawNumerator ?? '4', 10);
  const denominator = Number.parseInt(rawDenominator ?? '4', 10);
  return {
    numerator: Number.isFinite(numerator) && numerator > 0 ? numerator : 4,
    denominator: Number.isFinite(denominator) && denominator > 0 ? denominator : 4,
  };
};

const msPerBeat = (metadata: SessionMetadata): number => 60000 / metadata.bpm;

const beatsPerBar = (metadata: SessionMetadata): number => {
  const { numerator, denominator } = parseTimeSignature(metadata.timeSignature);
  return numerator * (4 / denominator);
};

const evaluateAutomation = (curve: AutomationCurve, timeMs: number): number => {
  if (curve.points.length === 0) {
    return 1;
  }
  if (timeMs <= curve.points[0].time) {
    return curve.points[0].value;
  }
  for (let index = 0; index < curve.points.length - 1; index += 1) {
    const start = curve.points[index];
    const end = curve.points[index + 1];
    if (timeMs >= start.time && timeMs <= end.time) {
      const ratio = clamp(
        (timeMs - start.time) / Math.max(1, end.time - start.time),
        0,
        1,
      );
      switch (curve.interpolation) {
        case 'step':
          return start.value;
        case 'exponential':
          return start.value + (end.value - start.value) * ratio * ratio;
        case 'linear':
        default:
          return start.value + (end.value - start.value) * ratio;
      }
    }
  }
  return curve.points[curve.points.length - 1].value;
};

const dbToLinear = (db: number): number => 10 ** (db / 20);

const computeSessionLengthMs = (session: Session): number => {
  const maxClipEnd = session.tracks.reduce((max, track) => {
    const trackEnd = track.clips.reduce(
      (clipMax, clip) => Math.max(clipMax, clip.start + clip.duration),
      0,
    );
    return Math.max(max, trackEnd);
  }, 0);
  return Math.max(maxClipEnd, MIN_SESSION_LENGTH_MS);
};

const generateWaveform = (
  track: Track,
  metadata: SessionMetadata,
  sessionLengthMs: number,
  sampleCount = DEFAULT_SAMPLE_COUNT,
): Float32Array => {
  const waveform = new Float32Array(sampleCount).fill(0);
  const beatDuration = msPerBeat(metadata);
  const trackVolume = dbToLinear(track.volume);
  const normalizedLength = Math.max(sessionLengthMs, MIN_SESSION_LENGTH_MS);
  track.clips.forEach((clip) => {
    const clipStartRatio = clip.start / normalizedLength;
    const clipEndRatio = (clip.start + clip.duration) / normalizedLength;
    const startIndex = Math.floor(clamp(clipStartRatio, 0, 1) * sampleCount);
    const endIndex = Math.min(
      sampleCount,
      Math.ceil(clamp(clipEndRatio, 0, 1) * sampleCount),
    );
    const baseFrequency = 1 + hashString(`${track.id}:${clip.id}`) * 5;
    const phaseOffset = hashString(`${clip.id}:phase`) * Math.PI;
    const fadeInBeats = clip.fadeIn / beatDuration;
    const fadeOutBeats = clip.fadeOut / beatDuration;
    const clipDurationBeats = clip.duration / beatDuration;
    const clipVolumeCurves = clip.automationCurveIds
      .map((id) => track.automationCurves.find((curve) => curve.id === id))
      .filter((curve): curve is AutomationCurve => Boolean(curve));
    for (let sampleIndex = startIndex; sampleIndex < endIndex; sampleIndex += 1) {
      const positionRatio =
        (sampleIndex - startIndex) / Math.max(1, endIndex - startIndex);
      const absoluteTime = normalizedLength * (sampleIndex / sampleCount);
      const fadeInFactor =
        fadeInBeats <= 0
          ? 1
          : clamp(
              (positionRatio * clipDurationBeats) / Math.max(fadeInBeats, 1e-3),
              0,
              1,
            );
      const fadeOutFactor =
        fadeOutBeats <= 0
          ? 1
          : clamp(
              (clipDurationBeats - positionRatio * clipDurationBeats) /
                Math.max(fadeOutBeats, 1e-3),
              0,
              1,
            );
      const automationGain = clipVolumeCurves.reduce((accumulator, curve) => {
        return accumulator * evaluateAutomation(curve, absoluteTime);
      }, 1);
      const amplitude =
        Math.sin(positionRatio * Math.PI * baseFrequency + phaseOffset) *
        trackVolume *
        clip.gain *
        fadeInFactor *
        fadeOutFactor *
        automationGain;
      waveform[sampleIndex] += amplitude;
    }
  });
  for (let index = 0; index < waveform.length; index += 1) {
    waveform[index] = clamp(waveform[index], -1, 1);
  }
  return waveform;
};

const collectMidiNotes = (track: Track, metadata: SessionMetadata) => {
  const beatDuration = msPerBeat(metadata);
  return track.clips.flatMap((clip) => {
    if (!clip.midi) {
      return [];
    }
    const clipStartBeats = clip.start / beatDuration;
    return clip.midi.notes.map((note) => ({
      id: `${clip.id}:${note.id}`,
      pitch: note.pitch,
      start: clipStartBeats + note.startBeat,
      duration: note.durationBeats,
      velocity: note.velocity,
    }));
  });
};

const buildTrackViewModel = (
  track: Track,
  metadata: SessionMetadata,
  sessionLengthMs: number,
  diagnostics: SessionDiagnosticsView,
  soloActive: boolean,
  pluginCrashes?: Map<string, PluginCrashReport>,
): TrackViewModel => {
  const waveform = generateWaveform(track, metadata, sessionLengthMs);
  const midiNotes = collectMidiNotes(track, metadata);
  const clips = track.clips.map((clip) => ({
    id: clip.id,
    name: clip.name,
    startMs: clip.start,
    durationMs: clip.duration,
    audioFile: clip.audioFile,
    automationCurveIds: clip.automationCurveIds,
    midiNotes: midiNotes.filter((note) => note.id.startsWith(`${clip.id}:`)),
  }));
  const hasSolo = soloActive && !track.solo;
  const volumeCurves = track.automationCurves.filter(
    (curve) => curve.parameter === 'volume',
  );
  const peakAutomation = volumeCurves.reduce((peak, curve) => {
    return Math.max(peak, ...curve.points.map((point) => point.value));
  }, 1);
  const renderAttenuation =
    diagnostics.status === 'ready' ? clamp(1 - diagnostics.renderLoad, 0.2, 1) : 0.65;
  const meterLevel =
    hasSolo || track.muted
      ? 0
      : clamp(dbToLinear(track.volume) * peakAutomation * renderAttenuation, 0, 1);
  const plugins = buildPluginChain(track.routing.graph, pluginCrashes);
  const instrumentNode = track.routing.graph?.nodes.find(
    (node): node is InstrumentRoutingNode =>
      node.type === 'instrument' && node.instrumentType === 'juno106',
  );
  return {
    id: track.id,
    name: track.name,
    color: track.color,
    muted: track.muted,
    solo: track.solo,
    volumeDb: track.volume,
    pan: track.pan,
    automationCurves: track.automationCurves,
    clips,
    waveform,
    midiNotes,
    meterLevel,
    plugins,
    instrument: instrumentNode
      ? {
          nodeId: instrumentNode.id,
          instrumentType: instrumentNode.instrumentType,
          label: instrumentNode.label,
          parameters: { ...instrumentNode.parameters },
          preset: instrumentNode.preset ? { ...instrumentNode.preset } : undefined,
        }
      : undefined,
  };
};

const buildPluginChain = (
  graph: RoutingGraph | undefined,
  pluginCrashes?: Map<string, PluginCrashReport>,
): TrackPluginViewModel[] => {
  if (!graph) {
    return [];
  }
  const nodes = graph.nodes.filter(
    (node): node is PluginRoutingNode => node.type === 'plugin',
  );
  const sorted = [...nodes].sort((a, b) => a.order - b.order);
  return sorted.map((node) => {
    const crash = pluginCrashes?.get(node.instanceId);
    let status: TrackPluginStatus = 'active';
    if (crash && !crash.recovered) {
      status = 'crashed';
    } else if (node.bypassed) {
      status = 'bypassed';
    }
    const label = node.label ?? node.instanceId;
    return {
      id: node.id,
      instanceId: node.instanceId,
      slot: node.slot,
      label,
      bypassed: node.bypassed ?? false,
      status,
      accepts: node.accepts,
      emits: node.emits,
    };
  });
};

type RawDiagnosticsSnapshot = {
  status: 'loading' | 'ready' | 'unavailable' | 'error';
  xruns: number;
  renderLoad: number;
  lastRenderDurationMicros?: number;
  clipBufferBytes?: number;
  error?: Error;
  updatedAt?: number;
};

type NativeDiagnosticsPayload = {
  xruns: number;
  lastRenderDurationMicros: number;
  clipBufferBytes: number;
};

type DiagnosticsPayload = RawDiagnosticsSnapshot | NativeDiagnosticsPayload;

const RENDER_LOAD_THRESHOLD = 0.98;

const clampRenderLoad = (value: number | undefined): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return clamp(value as number, 0, 1);
};

const SNAPSHOT_STATUS_VALUES: RawDiagnosticsSnapshot['status'][] = [
  'loading',
  'ready',
  'unavailable',
  'error',
];

const isSnapshotPayload = (
  input: DiagnosticsPayload,
): input is RawDiagnosticsSnapshot => {
  if (!input || typeof input !== 'object') {
    return false;
  }
  const candidate = input as RawDiagnosticsSnapshot;
  return (
    typeof candidate.status === 'string' &&
    SNAPSHOT_STATUS_VALUES.includes(candidate.status) &&
    typeof candidate.renderLoad === 'number'
  );
};

const deriveRenderLoadFromMicros = (
  lastRenderDurationMicros?: number,
): number | undefined => {
  if (!Number.isFinite(lastRenderDurationMicros)) {
    return undefined;
  }
  return (lastRenderDurationMicros as number) / 10_000;
};

const normalizeSnapshotDiagnostics = (
  snapshot: RawDiagnosticsSnapshot,
  previous: SessionDiagnosticsView,
  now: number,
): SessionDiagnosticsView => {
  const safeXruns = Number.isFinite(snapshot.xruns) ? snapshot.xruns : previous.xruns;
  const safeRenderLoad = Number.isFinite(snapshot.renderLoad)
    ? snapshot.renderLoad
    : previous.renderLoad;
  const updatedAt = snapshot.updatedAt ?? now;

  if (snapshot.status === 'ready') {
    const lastRenderDurationMicros = Number.isFinite(snapshot.lastRenderDurationMicros)
      ? snapshot.lastRenderDurationMicros
      : previous.lastRenderDurationMicros;
    const clipBufferBytes = Number.isFinite(snapshot.clipBufferBytes)
      ? snapshot.clipBufferBytes
      : previous.clipBufferBytes;
    // Prefer lastRenderDurationMicros for render load calculation when available.
    // If both lastRenderDurationMicros and renderLoad are present, lastRenderDurationMicros takes precedence
    // because it reflects the most recent render duration directly from the engine.
    const renderLoadSource =
      deriveRenderLoadFromMicros(snapshot.lastRenderDurationMicros) ?? safeRenderLoad;
    return {
      status: 'ready',
      xruns: safeXruns,
      lastRenderDurationMicros,
      clipBufferBytes,
      renderLoad: clampRenderLoad(renderLoadSource),
      updatedAt,
    };
  }

  if (snapshot.status === 'error') {
    return {
      status: 'error',
      xruns: safeXruns,
      renderLoad: clampRenderLoad(safeRenderLoad),
      error: snapshot.error ?? previous.error,
      updatedAt,
    };
  }

  if (snapshot.status === 'unavailable') {
    return {
      status: 'unavailable',
      xruns: safeXruns,
      renderLoad: clampRenderLoad(safeRenderLoad),
      updatedAt,
    };
  }

  return {
    status: 'loading',
    xruns: safeXruns,
    renderLoad: clampRenderLoad(safeRenderLoad),
    lastRenderDurationMicros: previous.lastRenderDurationMicros,
    clipBufferBytes: previous.clipBufferBytes,
    updatedAt,
  };
};

const normalizeNativeDiagnostics = (
  payload: NativeDiagnosticsPayload,
  previous: SessionDiagnosticsView,
  now: number,
): SessionDiagnosticsView => {
  const lastRenderDurationMicros = Number.isFinite(payload.lastRenderDurationMicros)
    ? payload.lastRenderDurationMicros
    : previous.lastRenderDurationMicros;
  const clipBufferBytes = Number.isFinite(payload.clipBufferBytes)
    ? payload.clipBufferBytes
    : previous.clipBufferBytes;
  const xruns = Number.isFinite(payload.xruns) ? payload.xruns : previous.xruns;
  const renderLoadSource =
    deriveRenderLoadFromMicros(payload.lastRenderDurationMicros) ?? previous.renderLoad;

  return {
    status: 'ready',
    xruns,
    lastRenderDurationMicros,
    clipBufferBytes,
    renderLoad: clampRenderLoad(renderLoadSource),
    updatedAt: now,
  };
};

export const buildDiagnosticsView = (
  diagnostics: SessionDiagnosticsView,
  rawDiagnostics?: DiagnosticsPayload,
): SessionDiagnosticsView => {
  if (!rawDiagnostics) {
    return diagnostics;
  }

  const now = Date.now();

  if (isSnapshotPayload(rawDiagnostics)) {
    return normalizeSnapshotDiagnostics(rawDiagnostics, diagnostics, now);
  }

  return normalizeNativeDiagnostics(rawDiagnostics, diagnostics, now);
};

const passesDiagnosticsGate = (diagnostics: SessionDiagnosticsView): boolean => {
  return diagnostics.status === 'ready' && diagnostics.renderLoad < RENDER_LOAD_THRESHOLD;
};

const wrapBeats = (value: number, totalBeats: number): number => {
  if (totalBeats > 0) {
    const normalized = ((value % totalBeats) + totalBeats) % totalBeats;
    return clamp(normalized, 0, totalBeats);
  }
  return Math.max(0, value);
};

const shouldPlay = (
  runtime: TransportRuntimeState | undefined,
  diagnostics: SessionDiagnosticsView,
): boolean => {
  if (runtime) {
    return runtime.isPlaying;
  }
  return passesDiagnosticsGate(diagnostics);
};

const createRuntimePlayheadReference = (
  runtime: TransportRuntimeState,
  totalBeats: number,
  fallbackBpm: number,
): PlayheadReference => {
  const baseBeats = Number.isFinite(runtime.beats) ? runtime.beats : 0;
  const updatedAt = Number.isFinite(runtime.updatedAt) ? runtime.updatedAt : undefined;
  const bpm = runtime.bpm > 0 ? runtime.bpm : fallbackBpm;
  return {
    source: 'runtime',
    beats: wrapBeats(baseBeats, totalBeats),
    bpm,
    updatedAt,
  };
};

const createDiagnosticsPlayheadReference = (
  diagnostics: SessionDiagnosticsView,
  diagnosticsGate: boolean,
  sessionLengthMs: number,
  beatDuration: number,
  totalBeats: number,
  fallbackBpm: number,
): PlayheadReference => {
  const cycleLengthMs = Math.max(sessionLengthMs, MIN_SESSION_LENGTH_MS);
  const updatedAt = Number.isFinite(diagnostics.updatedAt)
    ? diagnostics.updatedAt
    : undefined;
  const playheadMs =
    diagnosticsGate && typeof updatedAt === 'number' ? updatedAt % cycleLengthMs : 0;
  const baseBeats = playheadMs / beatDuration;
  return {
    source: 'diagnostics',
    beats: wrapBeats(baseBeats, totalBeats),
    bpm: fallbackBpm,
    updatedAt,
  };
};

export const buildTracks = (
  session: Session,
  diagnostics: SessionDiagnosticsView,
  pluginCrashes?: Map<string, PluginCrashReport>,
): TrackViewModel[] => {
  const sessionLength = computeSessionLengthMs(session);
  const soloActive = session.tracks.some((track) => track.solo);
  return session.tracks.map((track) =>
    buildTrackViewModel(
      track,
      session.metadata,
      sessionLength,
      diagnostics,
      soloActive,
      pluginCrashes,
    ),
  );
};

export const buildTransport = (
  session: Session,
  diagnostics: SessionDiagnosticsView,
  runtime?: TransportRuntimeState,
  sessionLengthMs?: number,
): SessionTransportView => {
  const length = sessionLengthMs ?? computeSessionLengthMs(session);
  const beatDuration = msPerBeat(session.metadata);
  const totalBeats = length / beatDuration;
  const totalBars = Math.max(1, Math.ceil(totalBeats / beatsPerBar(session.metadata)));

  const diagnosticsGate = passesDiagnosticsGate(diagnostics);
  const isPlaying = shouldPlay(runtime, diagnostics);
  const playheadReference = runtime
    ? createRuntimePlayheadReference(runtime, totalBeats, session.metadata.bpm)
    : createDiagnosticsPlayheadReference(
        diagnostics,
        diagnosticsGate,
        length,
        beatDuration,
        totalBeats,
        session.metadata.bpm,
      );
  const playheadBeats = playheadReference?.beats ?? 0;
  const playheadRatio = totalBeats > 0 ? clamp(playheadBeats / totalBeats, 0, 1) : 0;

  return {
    bpm: session.metadata.bpm,
    timeSignature: session.metadata.timeSignature,
    lengthBeats: totalBeats,
    totalBars,
    playheadBeats,
    playheadRatio,
    isPlaying,
    diagnosticsGate,
    playheadReference,
  };
};
