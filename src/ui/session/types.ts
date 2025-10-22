import {
  AutomationCurve,
  AutomationCurveID,
  ClipID,
  SessionID,
  TrackID,
  PluginSlotType,
  RoutingSignalType,
} from '../../session';
import type { PluginCrashReport } from '../../audio';

export interface MidiNoteViewModel {
  id: string;
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
}

export interface ClipViewModel {
  id: ClipID;
  name: string;
  startMs: number;
  durationMs: number;
  audioFile: string;
  automationCurveIds: AutomationCurveID[];
  midiNotes: MidiNoteViewModel[];
}

export type TrackPluginStatus = 'active' | 'bypassed' | 'crashed' | 'offline';

export interface TrackPluginViewModel {
  id: string;
  instanceId: string;
  slot: PluginSlotType;
  label: string;
  bypassed: boolean;
  status: TrackPluginStatus;
  accepts: RoutingSignalType[];
  emits: RoutingSignalType[];
}

export interface TrackViewModel {
  id: TrackID;
  name: string;
  color?: string;
  muted: boolean;
  solo: boolean;
  volumeDb: number;
  pan: number;
  automationCurves: AutomationCurve[];
  clips: ClipViewModel[];
  waveform: Float32Array;
  midiNotes: MidiNoteViewModel[];
  meterLevel: number;
  plugins: TrackPluginViewModel[];
}

export interface SessionTransportView {
  bpm: number;
  timeSignature: string;
  lengthBeats: number;
  totalBars: number;
  playheadBeats: number;
  playheadRatio: number;
  isPlaying: boolean;
}

export type DiagnosticsStatus = 'loading' | 'ready' | 'unavailable' | 'error';

export interface SessionDiagnosticsView {
  status: DiagnosticsStatus;
  xruns: number;
  renderLoad: number;
  lastRenderDurationMicros?: number;
  clipBufferBytes?: number;
  error?: Error;
  updatedAt?: number;
}

export interface SessionViewModelState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  sessionId?: SessionID;
  sessionName?: string;
  tracks: TrackViewModel[];
  transport: SessionTransportView | null;
  diagnostics: SessionDiagnosticsView;
  error?: Error;
  pluginAlerts: PluginCrashReport[];
}
