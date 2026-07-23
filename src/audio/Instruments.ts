export enum MidiEventType {
  NoteOn = 0,
  NoteOff = 1,
  ControlChange = 2,
  PitchBend = 3,
  ChannelPressure = 4,
  PolyphonicAftertouch = 5,
}

export enum JunoParameterId {
  PulseWidth = 0x0001,
  SubLevel = 0x0002,
  CutoffHz = 0x0003,
  Resonance = 0x0004,
  AttackSeconds = 0x0005,
  ReleaseSeconds = 0x0006,
  ChorusMode = 0x0007,
  OutputGain = 0x0008,
  LfoRateHz = 0x0009,
  LfoDepth = 0x000a,
}

/** Compact MIDI event payload shared by the JS and native realtime layers. */
export interface MidiEvent {
  /** Absolute transport frame used by clip scheduling. */
  frame: number;
  type: MidiEventType;
  channel: number;
  data1: number;
  data2: number;
}

/** A live event scheduled relative to the graph's current transport frame. */
export type LiveMidiEvent = Omit<MidiEvent, 'frame'> & {
  frameOffset?: number;
};

export interface InstrumentParameterChange {
  parameterId: number;
  value: number;
  frameOffset?: number;
}

export interface InstrumentParameterEvent {
  frame: number;
  parameterId: number;
  value: number;
}

export const midiNoteOn = (
  note: number,
  velocity: number,
  channel = 0,
  frame = 0,
): MidiEvent => ({
  frame,
  type: MidiEventType.NoteOn,
  channel,
  data1: note,
  data2: velocity,
});

export const midiNoteOff = (
  note: number,
  velocity = 0,
  channel = 0,
  frame = 0,
): MidiEvent => ({
  frame,
  type: MidiEventType.NoteOff,
  channel,
  data1: note,
  data2: velocity,
});
