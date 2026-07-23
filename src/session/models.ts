import { deepFreeze } from './util';

export type SessionID = string;
export type TrackID = string;
export type ClipID = string;
export type AutomationCurveID = string;

export interface MidiNoteEvent {
  id: string;
  /** MIDI note number (0-127) */
  pitch: number;
  /** Beat offset relative to the beginning of the clip */
  startBeat: number;
  /** Beat length */
  durationBeats: number;
  /** MIDI velocity (0-127) */
  velocity: number;
}

export interface MidiClipData {
  /** Optional PPQ resolution for precise scheduling */
  pulsesPerQuarter?: number;
  notes: MidiNoteEvent[];
}

export interface Clip {
  id: ClipID;
  name: string;
  start: number; // milliseconds
  duration: number; // milliseconds
  audioFile?: string;
  gain: number; // linear amplitude multiplier
  fadeIn: number; // milliseconds
  fadeOut: number; // milliseconds
  automationCurveIds: AutomationCurveID[];
  midi?: MidiClipData;
}

export type AutomationInterpolation = 'linear' | 'step' | 'exponential';

export interface AutomationPoint {
  time: number; // milliseconds relative to clip or track
  value: number;
}

export interface AutomationCurve {
  id: AutomationCurveID;
  parameter: string; // e.g. volume, pan, filter cutoff
  interpolation: AutomationInterpolation;
  points: AutomationPoint[];
}

export type RoutingSignalType = 'audio' | 'midi' | 'sidechain';

export type RoutingNodeID = string;
export type RoutingConnectionID = string;
export type PluginInstanceID = string;
export type PluginSlotType = 'insert' | 'send' | 'return' | 'sidechain' | 'midiFx';

export interface PluginAutomationTarget {
  parameterId: string;
  curveId: AutomationCurveID;
}

export interface RoutingNodeBase {
  id: RoutingNodeID;
  label?: string;
  bypassed?: boolean;
}

export interface TrackEndpointNode extends RoutingNodeBase {
  type: 'trackInput' | 'trackOutput';
  ioId: string;
  channelCount: number;
}

export interface PluginRoutingNode extends RoutingNodeBase {
  type: 'plugin';
  slot: PluginSlotType;
  instanceId: PluginInstanceID;
  order: number;
  automation?: PluginAutomationTarget[];
  accepts: RoutingSignalType[];
  emits: RoutingSignalType[];
}

export interface SendRoutingNode extends RoutingNodeBase {
  type: 'send' | 'return';
  busId: string;
  preFader: boolean;
  gain: number;
  targetTrackId?: TrackID;
}

export interface SidechainRoutingNode extends RoutingNodeBase {
  type: 'sidechainTap';
  sourceTrackId: TrackID;
  busId: string;
}

export const JUNO106_PARAMETER_NAMES = [
  'pulseWidth',
  'subLevel',
  'cutoffHz',
  'resonance',
  'attackSeconds',
  'releaseSeconds',
  'chorusMode',
  'outputGain',
  'lfoRateHz',
  'lfoDepth',
] as const;

export type Juno106ParameterName = (typeof JUNO106_PARAMETER_NAMES)[number];
export type Juno106ParameterMap = Record<Juno106ParameterName, number>;

export const JUNO106_MINIMUM_LFO_RATE_HZ = 0.05;
export const JUNO106_MAXIMUM_LFO_RATE_HZ = 20;
export const JUNO106_DEFAULT_LFO_RATE_HZ = 0.8;
export const JUNO106_MINIMUM_LFO_DEPTH = 0;
export const JUNO106_MAXIMUM_LFO_DEPTH = 1;
export const JUNO106_DEFAULT_LFO_DEPTH = 0;

export const JUNO106_DEFAULT_PARAMETERS: Readonly<Juno106ParameterMap> = Object.freeze({
  pulseWidth: 0.5,
  subLevel: 0,
  cutoffHz: 1000,
  resonance: 0.1,
  attackSeconds: 0.01,
  releaseSeconds: 0.5,
  chorusMode: 1,
  outputGain: 0.2,
  lfoRateHz: JUNO106_DEFAULT_LFO_RATE_HZ,
  lfoDepth: JUNO106_DEFAULT_LFO_DEPTH,
});

const JUNO106_PARAMETER_NAME_SET = new Set<string>(JUNO106_PARAMETER_NAMES);

export interface InstrumentPresetMetadata {
  id: string;
  version: number;
  name?: string;
}

export interface InstrumentRoutingNode extends RoutingNodeBase {
  type: 'instrument';
  instrumentType: 'juno106';
  parameters: Juno106ParameterMap;
  preset?: InstrumentPresetMetadata;
}

export type RoutingNode =
  | TrackEndpointNode
  | PluginRoutingNode
  | SendRoutingNode
  | SidechainRoutingNode
  | InstrumentRoutingNode;

export interface RoutingEndpointRef {
  nodeId: RoutingNodeID;
  port?: string;
}

export interface RoutingConnection {
  id: RoutingConnectionID;
  from: RoutingEndpointRef;
  to: RoutingEndpointRef;
  signal: RoutingSignalType;
  gain?: number;
  enabled: boolean;
}

export interface RoutingGraph {
  version: number;
  nodes: RoutingNode[];
  connections: RoutingConnection[];
}

export interface TrackRouting {
  input?: string;
  output?: string;
  sends?: Record<string, number>;
  sidechainSource?: string;
  graph?: RoutingGraph;
}

export interface Track {
  id: TrackID;
  name: string;
  color?: string;
  clips: Clip[];
  muted: boolean;
  solo: boolean;
  volume: number; // dB
  pan: number; // -1 to 1
  automationCurves: AutomationCurve[];
  routing: TrackRouting;
}

export interface JunoInstrumentOptions {
  parameters?: Partial<Juno106ParameterMap>;
  preset?: InstrumentPresetMetadata;
}

export interface CreateJunoTrackOptions extends JunoInstrumentOptions {
  name?: string;
}

export interface SessionMetadata {
  version: number;
  createdAt: string;
  updatedAt: string;
  sampleRate: number;
  bpm: number;
  timeSignature: string;
}

export const createDefaultTrackRoutingGraph = (trackId: TrackID): RoutingGraph => {
  const trackInputNode: TrackEndpointNode = {
    id: `${trackId}:input:main`,
    type: 'trackInput',
    ioId: 'input:main',
    channelCount: 2,
    label: 'Track Input',
  };
  const trackOutputNode: TrackEndpointNode = {
    id: `${trackId}:output:main`,
    type: 'trackOutput',
    ioId: 'output:main',
    channelCount: 2,
    label: 'Track Output',
  };
  const graph: RoutingGraph = {
    version: 1,
    nodes: [trackInputNode, trackOutputNode],
    connections: [
      {
        id: `${trackId}:connection:direct`,
        from: { nodeId: trackInputNode.id },
        to: { nodeId: trackOutputNode.id },
        signal: 'audio',
        enabled: true,
      },
    ],
  };
  return graph;
};

export const createJunoRoutingGraph = (
  trackId: TrackID,
  options: JunoInstrumentOptions = {},
): RoutingGraph => {
  const trackInputNode: TrackEndpointNode = {
    id: `${trackId}:input:midi`,
    type: 'trackInput',
    ioId: 'input:midi',
    channelCount: 1,
    label: 'MIDI Input',
  };
  const instrumentNode: InstrumentRoutingNode = {
    id: `${trackId}:instrument:juno106`,
    type: 'instrument',
    instrumentType: 'juno106',
    label: 'Juno-106',
    parameters: {
      ...JUNO106_DEFAULT_PARAMETERS,
      ...options.parameters,
    },
    ...(options.preset ? { preset: { ...options.preset } } : {}),
  };
  const trackOutputNode: TrackEndpointNode = {
    id: `${trackId}:output:main`,
    type: 'trackOutput',
    ioId: 'output:main',
    channelCount: 2,
    label: 'Track Output',
  };

  return {
    version: 1,
    nodes: [trackInputNode, instrumentNode, trackOutputNode],
    connections: [
      {
        id: `${trackId}:connection:midi-to-juno`,
        from: { nodeId: trackInputNode.id },
        to: { nodeId: instrumentNode.id },
        signal: 'midi',
        enabled: true,
      },
      {
        id: `${trackId}:connection:juno-to-output`,
        from: { nodeId: instrumentNode.id },
        to: { nodeId: trackOutputNode.id },
        signal: 'audio',
        enabled: true,
      },
    ],
  };
};

export const createDefaultJunoTrack = (
  trackId: TrackID,
  options: CreateJunoTrackOptions = {},
): Track => ({
  id: trackId,
  name: options.name?.trim() || 'Juno-106',
  clips: [],
  muted: false,
  solo: false,
  volume: 0,
  pan: 0,
  automationCurves: [],
  routing: {
    graph: createJunoRoutingGraph(trackId, options),
  },
});

export interface Session {
  id: SessionID;
  name: string;
  tracks: Track[];
  metadata: SessionMetadata;
  revision: number;
}

export const createEmptySession = (id: SessionID, name: string): Session => {
  const now = new Date().toISOString();
  const session: Session = {
    id,
    name,
    revision: 0,
    tracks: [],
    metadata: {
      version: 1,
      createdAt: now,
      updatedAt: now,
      bpm: 120,
      sampleRate: 48000,
      timeSignature: '4/4',
    },
  };
  return deepFreeze(session);
};

export const updateSessionTimestamp = (session: Session): Session => ({
  ...session,
  metadata: {
    ...session.metadata,
    updatedAt: new Date().toISOString(),
  },
});

export const sortAutomationPoints = (curve: AutomationCurve): AutomationCurve => ({
  ...curve,
  points: [...curve.points].sort((a, b) => a.time - b.time),
});

export const normalizeTrack = (track: Track): Track => ({
  ...track,
  clips: track.clips
    .map((clip) => ({
      ...clip,
      midi: clip.midi
        ? {
            ...clip.midi,
            notes: [...clip.midi.notes].sort((lhs, rhs) => lhs.startBeat - rhs.startBeat),
          }
        : undefined,
    }))
    .sort((a, b) => a.start - b.start),
  automationCurves: track.automationCurves.map(sortAutomationPoints),
  routing: normalizeTrackRouting(track.id, track.routing),
});

export const normalizeSession = (session: Session): Session => ({
  ...session,
  tracks: session.tracks.map(normalizeTrack),
});

export const validateSession = (session: Session): void => {
  if (!session.id) {
    throw new Error('Session id is required');
  }
  if (!Number.isFinite(session.metadata.sampleRate) || session.metadata.sampleRate <= 0) {
    throw new Error('Session sample rate must be positive and finite');
  }
  if (!Number.isFinite(session.metadata.bpm) || session.metadata.bpm <= 0) {
    throw new Error('Session BPM must be positive and finite');
  }

  session.tracks.forEach((track) => {
    if (!track.id) {
      throw new Error('Track id is required');
    }

    const clipIds = new Set<ClipID>();
    track.clips.forEach((clip) => {
      if (!clip.id) {
        throw new Error('Clip id is required');
      }
      if (clipIds.has(clip.id)) {
        throw new Error(`Duplicate clip id detected: ${clip.id}`);
      }
      clipIds.add(clip.id);
      if (clip.duration <= 0) {
        throw new Error('Clip duration must be positive');
      }
      const hasAudio =
        typeof clip.audioFile === 'string' && clip.audioFile.trim().length > 0;
      if (!hasAudio && !clip.midi) {
        throw new Error(`Clip ${clip.id} must contain audio or MIDI data`);
      }
      if (clip.midi) {
        if (
          clip.midi.pulsesPerQuarter !== undefined &&
          (!Number.isInteger(clip.midi.pulsesPerQuarter) ||
            clip.midi.pulsesPerQuarter <= 0)
        ) {
          throw new Error(
            `MIDI pulsesPerQuarter must be a positive integer in clip ${clip.id}`,
          );
        }
        clip.midi.notes.forEach((note) => {
          if (!note.id) {
            throw new Error(`MIDI note requires an id in clip ${clip.id}`);
          }
          if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) {
            throw new Error(`Invalid MIDI pitch ${note.pitch} in clip ${clip.id}`);
          }
          if (!Number.isFinite(note.startBeat) || note.startBeat < 0) {
            throw new Error(`MIDI note start must be non-negative in clip ${clip.id}`);
          }
          if (!Number.isFinite(note.durationBeats) || note.durationBeats <= 0) {
            throw new Error(`MIDI note duration must be positive in clip ${clip.id}`);
          }
          if (
            !Number.isInteger(note.velocity) ||
            note.velocity < 0 ||
            note.velocity > 127
          ) {
            throw new Error(`Invalid MIDI velocity ${note.velocity} in clip ${clip.id}`);
          }
        });
      }
    });

    if (track.routing.graph) {
      validateRoutingGraph(track.routing.graph, session.metadata.sampleRate);
    }
  });
};

const validateRoutingGraph = (graph: RoutingGraph, sampleRate: number): void => {
  if (graph.version <= 0) {
    throw new Error('Routing graph version must be positive');
  }
  const nodeIds = new Set<string>();
  graph.nodes.forEach((node) => {
    if (nodeIds.has(node.id)) {
      throw new Error(`Duplicate routing node id detected: ${node.id}`);
    }
    nodeIds.add(node.id);
    if (node.type === 'plugin') {
      if (!node.instanceId) {
        throw new Error(`Plugin node ${node.id} missing instance id`);
      }
      if (node.order < 0) {
        throw new Error(`Plugin node ${node.id} has invalid order`);
      }
    }
    if (node.type === 'send' || node.type === 'return') {
      if (!Number.isFinite(node.gain) || node.gain < 0) {
        throw new Error(`Send/return node ${node.id} must have non-negative gain`);
      }
    }
    if (node.type === 'instrument') {
      if (node.instrumentType !== 'juno106') {
        throw new Error(`Instrument node ${node.id} has unsupported instrument type`);
      }
      if (
        !node.parameters ||
        typeof node.parameters !== 'object' ||
        Array.isArray(node.parameters)
      ) {
        throw new Error(`Instrument node ${node.id} requires a parameter map`);
      }
      Object.entries(node.parameters).forEach(([parameter, value]) => {
        if (!JUNO106_PARAMETER_NAME_SET.has(parameter)) {
          throw new Error(
            `Instrument node ${node.id} has unsupported parameter ${parameter}`,
          );
        }
        if (!Number.isFinite(value)) {
          throw new Error(
            `Instrument node ${node.id} parameter ${parameter} must be finite`,
          );
        }
      });
      JUNO106_PARAMETER_NAMES.forEach((parameter) => {
        if (!Object.prototype.hasOwnProperty.call(node.parameters, parameter)) {
          throw new Error(`Instrument node ${node.id} missing parameter ${parameter}`);
        }
      });
      if (
        !Number.isInteger(node.parameters.chorusMode) ||
        node.parameters.chorusMode < 0 ||
        node.parameters.chorusMode > 2
      ) {
        throw new Error(
          `Instrument node ${node.id} parameter chorusMode must be 0, 1, or 2`,
        );
      }
      if (
        node.parameters.lfoRateHz < JUNO106_MINIMUM_LFO_RATE_HZ ||
        node.parameters.lfoRateHz > JUNO106_MAXIMUM_LFO_RATE_HZ
      ) {
        throw new Error(
          `Instrument node ${node.id} parameter lfoRateHz must be between 0.05 and 20 Hz`,
        );
      }
      if (
        node.parameters.lfoDepth < JUNO106_MINIMUM_LFO_DEPTH ||
        node.parameters.lfoDepth > JUNO106_MAXIMUM_LFO_DEPTH
      ) {
        throw new Error(
          `Instrument node ${node.id} parameter lfoDepth must be between 0 and 1`,
        );
      }
      const boundedParameters: ReadonlyArray<
        readonly [Juno106ParameterName, number, number]
      > = [
        ['pulseWidth', 0.05, 0.95],
        ['subLevel', 0, 1],
        ['cutoffHz', 20, sampleRate * 0.45],
        ['resonance', 0, 1.2],
        ['attackSeconds', 0.0005, 30],
        ['releaseSeconds', 0.0005, 30],
        ['outputGain', 0, 2],
      ];
      boundedParameters.forEach(([parameter, minimum, maximum]) => {
        const value = node.parameters[parameter];
        if (value < minimum || value > maximum) {
          throw new Error(
            `Instrument node ${node.id} parameter ${parameter} must be between ${minimum} and ${maximum}`,
          );
        }
      });
      if (node.preset) {
        if (!node.preset.id?.trim()) {
          throw new Error(`Instrument node ${node.id} preset id is required`);
        }
        if (!Number.isInteger(node.preset.version) || node.preset.version <= 0) {
          throw new Error(
            `Instrument node ${node.id} preset version must be a positive integer`,
          );
        }
      }
    }
  });

  const connectionIds = new Set<string>();
  const audioAdjacency = new Map<string, string[]>();
  const audioIndegree = new Map<string, number>();
  nodeIds.forEach((nodeId) => {
    audioAdjacency.set(nodeId, []);
    audioIndegree.set(nodeId, 0);
  });

  graph.connections.forEach((connection) => {
    if (connectionIds.has(connection.id)) {
      throw new Error(`Duplicate routing connection id: ${connection.id}`);
    }
    connectionIds.add(connection.id);
    if (!nodeIds.has(connection.from.nodeId)) {
      throw new Error(`Connection ${connection.id} references missing source node`);
    }
    if (!nodeIds.has(connection.to.nodeId)) {
      throw new Error(`Connection ${connection.id} references missing destination node`);
    }
    if (connection.gain !== undefined && !Number.isFinite(connection.gain)) {
      throw new Error(`Connection ${connection.id} has invalid gain`);
    }
    if (connection.enabled && connection.signal === 'audio') {
      audioAdjacency.get(connection.from.nodeId)?.push(connection.to.nodeId);
      audioIndegree.set(
        connection.to.nodeId,
        (audioIndegree.get(connection.to.nodeId) ?? 0) + 1,
      );
    }
  });

  const ready = Array.from(audioIndegree.entries())
    .filter(([, degree]) => degree === 0)
    .map(([nodeId]) => nodeId);
  let visited = 0;
  for (let index = 0; index < ready.length; index += 1) {
    const nodeId = ready[index];
    visited += 1;
    audioAdjacency.get(nodeId)?.forEach((destinationId) => {
      const nextDegree = (audioIndegree.get(destinationId) ?? 0) - 1;
      audioIndegree.set(destinationId, nextDegree);
      if (nextDegree === 0) {
        ready.push(destinationId);
      }
    });
  }
  if (visited !== nodeIds.size) {
    throw new Error('Enabled audio routing connections must form an acyclic graph');
  }
};

const normalizeTrackRouting = (trackId: TrackID, routing: TrackRouting): TrackRouting => {
  const graph = routing.graph ?? createDefaultTrackRoutingGraph(trackId);
  const pluginNodes = graph.nodes.filter(
    (node): node is PluginRoutingNode => node.type === 'plugin',
  );
  const sortedPluginIds = [...pluginNodes]
    .sort((a, b) => a.order - b.order)
    .map((plugin) => plugin.id);
  const normalizedNodes = graph.nodes.map((node) => {
    if (node.type === 'instrument') {
      return {
        ...node,
        parameters: {
          ...JUNO106_DEFAULT_PARAMETERS,
          ...node.parameters,
        },
        ...(node.preset ? { preset: { ...node.preset } } : {}),
      };
    }
    if (node.type !== 'plugin') {
      return node;
    }
    const order = sortedPluginIds.indexOf(node.id);
    return {
      ...node,
      order: order >= 0 ? order : node.order,
    };
  });
  const seenConnectionIds = new Set<string>();
  const normalizedConnections = graph.connections.filter((connection) => {
    if (seenConnectionIds.has(connection.id)) {
      return false;
    }
    seenConnectionIds.add(connection.id);
    return true;
  });
  return {
    ...routing,
    graph: {
      ...graph,
      nodes: normalizedNodes,
      connections: normalizedConnections,
    },
  };
};
