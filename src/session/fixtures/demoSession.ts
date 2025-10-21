import {
  AutomationCurve,
  Clip,
  Session,
  Track,
  createDefaultTrackRoutingGraph,
} from '../models';

const BPM = 124;
const TIME_SIGNATURE = '4/4';
const BEATS_PER_BAR = 4;
const MS_PER_BEAT = 60000 / BPM;

const beatToMs = (beats: number) => Math.round(beats * MS_PER_BEAT);
const barsToMs = (bars: number) => beatToMs(bars * BEATS_PER_BAR);

const buildClip = (clip: Clip): Clip => ({
  ...clip,
});

const drumVolumeCurve: AutomationCurve = {
  id: 'curve-drums-volume',
  parameter: 'volume',
  interpolation: 'linear',
  points: [
    { time: 0, value: 0.82 },
    { time: barsToMs(4), value: 0.88 },
    { time: barsToMs(12), value: 0.9 },
  ],
};

const bassVolumeCurve: AutomationCurve = {
  id: 'curve-bass-volume',
  parameter: 'volume',
  interpolation: 'linear',
  points: [
    { time: 0, value: 0.65 },
    { time: barsToMs(8), value: 0.78 },
    { time: barsToMs(12), value: 0.74 },
  ],
};

const leadFilterCurve: AutomationCurve = {
  id: 'curve-lead-filter',
  parameter: 'filter.cutoff',
  interpolation: 'exponential',
  points: [
    { time: 0, value: 0.3 },
    { time: barsToMs(2), value: 0.6 },
    { time: barsToMs(4), value: 0.45 },
    { time: barsToMs(8), value: 0.8 },
  ],
};

const leadVolumeCurve: AutomationCurve = {
  id: 'curve-lead-volume',
  parameter: 'volume',
  interpolation: 'linear',
  points: [
    { time: 0, value: 0.5 },
    { time: barsToMs(4), value: 0.76 },
    { time: barsToMs(8), value: 0.7 },
  ],
};

const padVolumeCurve: AutomationCurve = {
  id: 'curve-pad-volume',
  parameter: 'volume',
  interpolation: 'linear',
  points: [
    { time: 0, value: 0.4 },
    { time: barsToMs(6), value: 0.6 },
    { time: barsToMs(12), value: 0.58 },
  ],
};

const createDrumTrack = (): Track => ({
  id: 'track-drums',
  name: 'Drums',
  color: '#FF6B6B',
  clips: [
    buildClip({
      id: 'clip-drums-intro',
      name: 'Intro Loop',
      start: 0,
      duration: barsToMs(4),
      audioFile: 'loops/drums_intro.wav',
      gain: 1,
      fadeIn: 24,
      fadeOut: 36,
      automationCurveIds: ['curve-drums-volume'],
    }),
    buildClip({
      id: 'clip-drums-groove',
      name: 'Main Groove',
      start: barsToMs(4),
      duration: barsToMs(8),
      audioFile: 'loops/drums_main.wav',
      gain: 1,
      fadeIn: 12,
      fadeOut: 48,
      automationCurveIds: ['curve-drums-volume'],
    }),
  ],
  muted: false,
  solo: false,
  volume: -1.5,
  pan: 0,
  automationCurves: [drumVolumeCurve],
  routing: {
    input: 'bus:drums',
    output: 'bus-master',
    sends: { 'fx-reverb': -6 },
    graph: createDefaultTrackRoutingGraph('track-drums'),
  },
});

const createBassTrack = (): Track => ({
  id: 'track-bass',
  name: 'Bass',
  color: '#50E3C2',
  clips: [
    buildClip({
      id: 'clip-bass-seq',
      name: 'Bass Sequence',
      start: barsToMs(2),
      duration: barsToMs(10),
      audioFile: 'stems/bass_sequence.wav',
      gain: 0.92,
      fadeIn: 32,
      fadeOut: 64,
      automationCurveIds: ['curve-bass-volume'],
    }),
  ],
  muted: false,
  solo: false,
  volume: -4,
  pan: -0.15,
  automationCurves: [bassVolumeCurve],
  routing: {
    input: 'bus:bass',
    output: 'bus-master',
    sends: { 'fx-delay': -9 },
    graph: createDefaultTrackRoutingGraph('track-bass'),
  },
});

const createLeadTrack = (): Track => ({
  id: 'track-lead',
  name: 'Lead Synth',
  color: '#7F6BFF',
  clips: [
    buildClip({
      id: 'clip-lead-phrase',
      name: 'Lead Phrase',
      start: barsToMs(4),
      duration: barsToMs(8),
      audioFile: 'stems/lead_phrase.wav',
      gain: 0.86,
      fadeIn: 18,
      fadeOut: 48,
      automationCurveIds: ['curve-lead-volume', 'curve-lead-filter'],
      midi: {
        pulsesPerQuarter: 480,
        notes: [
          { id: 'note-1', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 96 },
          { id: 'note-2', pitch: 64, startBeat: 1, durationBeats: 1, velocity: 104 },
          { id: 'note-3', pitch: 67, startBeat: 2, durationBeats: 2, velocity: 110 },
          { id: 'note-4', pitch: 72, startBeat: 4, durationBeats: 1.5, velocity: 118 },
          { id: 'note-5', pitch: 76, startBeat: 6, durationBeats: 1, velocity: 105 },
        ],
      },
    }),
  ],
  muted: false,
  solo: false,
  volume: -6,
  pan: 0.18,
  automationCurves: [leadVolumeCurve, leadFilterCurve],
  routing: {
    input: 'bus:lead',
    output: 'bus-master',
    sends: { 'fx-delay': -5, 'fx-reverb': -3 },
    graph: createDefaultTrackRoutingGraph('track-lead'),
  },
});

const createPadTrack = (): Track => ({
  id: 'track-pad',
  name: 'Atmos Pad',
  color: '#4DD6FF',
  clips: [
    buildClip({
      id: 'clip-pad-bed',
      name: 'Pad Bed',
      start: 0,
      duration: barsToMs(12),
      audioFile: 'stems/pad_bed.wav',
      gain: 0.7,
      fadeIn: 64,
      fadeOut: 96,
      automationCurveIds: ['curve-pad-volume'],
      midi: {
        notes: [
          { id: 'pad-1', pitch: 52, startBeat: 0, durationBeats: 4, velocity: 80 },
          { id: 'pad-2', pitch: 55, startBeat: 0, durationBeats: 4, velocity: 78 },
          { id: 'pad-3', pitch: 59, startBeat: 0, durationBeats: 4, velocity: 76 },
        ],
      },
    }),
  ],
  muted: false,
  solo: false,
  volume: -8,
  pan: -0.05,
  automationCurves: [padVolumeCurve],
  routing: {
    input: 'bus:pad',
    output: 'bus-master',
    sends: { 'fx-reverb': -2 },
    graph: createDefaultTrackRoutingGraph('track-pad'),
  },
});

const createdAt = new Date('2024-05-01T12:00:00.000Z').toISOString();

export const demoSession: Session = {
  id: 'demo-session',
  name: 'Demo Performance',
  revision: 0,
  tracks: [createDrumTrack(), createBassTrack(), createLeadTrack(), createPadTrack()],
  metadata: {
    version: 1,
    createdAt,
    updatedAt: createdAt,
    bpm: BPM,
    sampleRate: 48000,
    timeSignature: TIME_SIGNATURE,
  },
};

export const DEMO_SESSION_ID = demoSession.id;
