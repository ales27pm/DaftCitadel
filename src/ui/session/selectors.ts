import { AutomationCurve, Session, SessionMetadata, Track } from '../../session';
import { SessionDiagnosticsView, SessionTransportView, TrackViewModel } from './types';

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
  };
};

export const buildDiagnosticsView = (
  diagnostics: SessionDiagnosticsView,
  rawDiagnostics?: { xruns: number; lastRenderDurationMicros: number },
): SessionDiagnosticsView => {
  if (!rawDiagnostics) {
    return diagnostics;
  }
  const renderLoad = clamp(rawDiagnostics.lastRenderDurationMicros / 10_000, 0, 1);
  return {
    status: 'ready',
    xruns: rawDiagnostics.xruns,
    lastRenderDurationMicros: rawDiagnostics.lastRenderDurationMicros,
    renderLoad,
    updatedAt: Date.now(),
  };
};

export const buildTracks = (
  session: Session,
  diagnostics: SessionDiagnosticsView,
): TrackViewModel[] => {
  const sessionLength = computeSessionLengthMs(session);
  const soloActive = session.tracks.some((track) => track.solo);
  return session.tracks.map((track) =>
    buildTrackViewModel(track, session.metadata, sessionLength, diagnostics, soloActive),
  );
};

export const buildTransport = (
  session: Session,
  diagnostics: SessionDiagnosticsView,
  sessionLengthMs?: number,
): SessionTransportView => {
  const length = sessionLengthMs ?? computeSessionLengthMs(session);
  const beatDuration = msPerBeat(session.metadata);
  const totalBeats = length / beatDuration;
  const totalBars = Math.max(1, Math.ceil(totalBeats / beatsPerBar(session.metadata)));
  const isPlaying = diagnostics.status === 'ready' && diagnostics.renderLoad < 0.98;
  const cycleLengthMs = Math.max(length, MIN_SESSION_LENGTH_MS);
  const referenceTime = diagnostics.updatedAt ?? Date.now();
  const playheadMs = isPlaying ? referenceTime % cycleLengthMs : 0;
  const playheadBeats = playheadMs / beatDuration;
  const playheadRatio = totalBeats > 0 ? clamp(playheadBeats / totalBeats, 0, 1) : 0;
  return {
    bpm: session.metadata.bpm,
    timeSignature: session.metadata.timeSignature,
    lengthBeats: totalBeats,
    totalBars,
    playheadBeats,
    playheadRatio,
    isPlaying,
  };
};
