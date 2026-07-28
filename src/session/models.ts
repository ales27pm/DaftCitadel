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

export type Juno106ParameterName =
  | 'pulseWidth'
  | 'subLevel'
  | 'cutoffHz'
  | 'resonance'
  | 'attackSeconds'
  | 'releaseSeconds'
  | 'chorusMode'
  | 'outputGain'
  | 'lfoRateHz'
  | 'lfoDepth';

export type Juno106ParameterMap = Record<Juno106ParameterName, number>;

export const JUNO106_PARAMETER_NAMES: readonly Juno106ParameterName[] = Object.freeze([
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
]);

const JUNO106_PARAMETER_NAME_SET = new Set<string>(JUNO106_PARAMETER_NAMES);

export const JUNO106_DEFAULT_PARAMETERS: Readonly<Juno106ParameterMap> = Object.freeze({
  pulseWidth: 0.5,
  subLevel: 0.35,
  cutoffHz: 2400,
  resonance: 0.15,
  attackSeconds: 0.01,
  releaseSeconds: 0.45,
  chorusMode: 1,
  outputGain: 0.2,
  lfoRateHz: 0.8,
  lfoDepth: 0,
});

export interface Juno106PresetSnapshot {
  id: string;
  version: number;
  name?: string;
}

export interface InstrumentRoutingNode extends RoutingNodeBase {
  type: 'instrument';
  instrumentType: 'juno106';
  parameters: Juno106ParameterMap;
  preset?: Juno106PresetSnapshot;
  polyphony?: number;
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

export type RoutingNode =
  | TrackEndpointNode
  | InstrumentRoutingNode
  | PluginRoutingNode
  | SendRoutingNode
  | SidechainRoutingNode;

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

export interface CreateJunoTrackOptions {
  name?: string;
  color?: string;
  parameters?: Partial<Juno106ParameterMap>;
  preset?: Juno106PresetSnapshot;
  polyphony?: number;
}

const cloneJunoParameters = (
  overrides: Partial<Juno106ParameterMap> = {},
): Juno106ParameterMap => ({
  ...JUNO106_DEFAULT_PARAMETERS,
  ...overrides,
});

export const createJunoRoutingGraph = (
  trackId: TrackID,
  options: CreateJunoTrackOptions = {},
): RoutingGraph => {
  const trackInputNode: TrackEndpointNode = {
    id: `${trackId}:input:midi`,
    type: 'trackInput',
    ioId: 'input:midi',
    channelCount: 2,
    label: 'Track Input',
  };
  const instrumentNode: InstrumentRoutingNode = {
    id: `${trackId}:instrument:juno106`,
    type: 'instrument',
    instrumentType: 'juno106',
    parameters: cloneJunoParameters(options.parameters),
    ...(options.preset ? { preset: { ...options.preset } } : {}),
    ...(options.polyphony ? { polyphony: options.polyphony } : {}),
    accepts: ['midi'],
    emits: ['audio'],
    label: 'Juno-106',
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
  color: options.color ?? '#50E3C2',
  clips: [],
  muted: false,
  solo: false,
  volume: -6,
  pan: 0,
  automationCurves: [],
  routing: {
    graph: createJunoRoutingGraph(trackId, options),
  },
});

export const updateSessionTimestamp = (session: Session): Session => ({
  ...session,
  metadata: {
    ...session.metadata,
    updatedAt: new Date().toISOString(),
  },
});

const ROUTING_SIGNAL_TYPES: readonly RoutingSignalType[] = ['audio', 'midi', 'sidechain'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const finiteNumberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const normalizeRoutingSignals = (
  value: unknown,
  fallback: readonly RoutingSignalType[],
): RoutingSignalType[] => {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const signals = value.filter(
    (candidate): candidate is RoutingSignalType =>
      typeof candidate === 'string' &&
      ROUTING_SIGNAL_TYPES.includes(candidate as RoutingSignalType),
  );
  return signals.length > 0 ? signals : [...fallback];
};

const normalizeRoutingNode = (node: RoutingNode): RoutingNode => {
  if (node.type === 'plugin') {
    const defaultSignals: RoutingSignalType[] =
      node.slot === 'midiFx' ? ['midi'] : ['audio'];
    return {
      ...node,
      order: Number.isInteger(node.order) && node.order >= 0 ? node.order : 0,
      accepts: normalizeRoutingSignals(node.accepts, defaultSignals),
      emits: normalizeRoutingSignals(node.emits, defaultSignals),
      automation: Array.isArray(node.automation) ? node.automation : [],
    };
  }
  if (node.type === 'instrument') {
    const parameters = { ...JUNO106_DEFAULT_PARAMETERS };
    if (isRecord(node.parameters)) {
      JUNO106_PARAMETER_NAMES.forEach((parameter) => {
        const value = node.parameters[parameter];
        if (typeof value === 'number' && Number.isFinite(value)) {
          parameters[parameter] = value;
        }
      });
    }
    return {
      ...node,
      parameters,
      accepts: normalizeRoutingSignals(node.accepts, ['midi']),
      emits: normalizeRoutingSignals(node.emits, ['audio']),
    };
  }
  return node;
};

export const sortAutomationPoints = (curve: AutomationCurve): AutomationCurve => ({
  ...curve,
  points: (Array.isArray(curve.points) ? [...curve.points] : []).sort(
    (a, b) => a.time - b.time,
  ),
});

export const normalizeTrack = (track: Track): Track => {
  const rawClips = Array.isArray(track.clips) ? track.clips : [];
  const rawAutomationCurves = Array.isArray(track.automationCurves)
    ? track.automationCurves
    : [];
  return {
    ...track,
    muted: typeof track.muted === 'boolean' ? track.muted : false,
    solo: typeof track.solo === 'boolean' ? track.solo : false,
    volume: finiteNumberOr(track.volume, 0),
    pan: finiteNumberOr(track.pan, 0),
    clips: rawClips
      .filter((candidate): candidate is Clip => isRecord(candidate))
      .map((clip) => {
        const midi = isRecord(clip.midi)
          ? (clip.midi as unknown as MidiClipData)
          : undefined;
        return {
          ...clip,
          automationCurveIds: Array.isArray(clip.automationCurveIds)
            ? clip.automationCurveIds.filter(
                (curveId): curveId is string => typeof curveId === 'string',
              )
            : [],
          midi: midi
            ? {
                ...midi,
                notes: (Array.isArray(midi.notes) ? [...midi.notes] : []).sort(
                  (lhs, rhs) => lhs.startBeat - rhs.startBeat,
                ),
              }
            : undefined,
        };
      })
      .sort((a, b) => a.start - b.start),
    automationCurves: rawAutomationCurves
      .filter((candidate): candidate is AutomationCurve => isRecord(candidate))
      .map(sortAutomationPoints),
    routing: normalizeTrackRouting(
      track.id,
      isRecord(track.routing) ? track.routing : undefined,
    ),
  };
};

export const normalizeSession = (session: Session): Session => {
  const now = new Date().toISOString();
  const metadata: Record<string, unknown> = isRecord(session.metadata)
    ? session.metadata
    : {};
  const tracks = Array.isArray(session.tracks) ? session.tracks : [];
  return {
    ...session,
    revision: Math.max(0, Math.floor(finiteNumberOr(session.revision, 0))),
    tracks: tracks
      .filter((candidate): candidate is Track => isRecord(candidate))
      .map(normalizeTrack),
    metadata: {
      version: Math.max(1, Math.floor(finiteNumberOr(metadata.version, 1))),
      createdAt: typeof metadata.createdAt === 'string' ? metadata.createdAt : now,
      updatedAt: typeof metadata.updatedAt === 'string' ? metadata.updatedAt : now,
      sampleRate: finiteNumberOr(metadata.sampleRate, 48000),
      bpm: finiteNumberOr(metadata.bpm, 120),
      timeSignature:
        typeof metadata.timeSignature === 'string' ? metadata.timeSignature : '4/4',
    },
  };
};

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
      const hasAudioFile =
        typeof clip.audioFile === 'string' && clip.audioFile.trim().length > 0;
      if (!hasAudioFile && !clip.midi) {
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
    if (node.type === 'instrument') {
      if (node.instrumentType !== 'juno106') {
        throw new Error(`Instrument node ${node.id} has unsupported instrument type`);
      }
      if (!isRecord(node.parameters) || Array.isArray(node.parameters)) {
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
      if (node.parameters.lfoRateHz < 0.05 || node.parameters.lfoRateHz > 20) {
        throw new Error(
          `Instrument node ${node.id} parameter lfoRateHz must be between 0.05 and 20 Hz`,
        );
      }
      if (node.parameters.lfoDepth < 0 || node.parameters.lfoDepth > 1) {
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
      if (
        node.polyphony !== undefined &&
        (!Number.isInteger(node.polyphony) || node.polyphony <= 0)
      ) {
        throw new Error(`Instrument node ${node.id} polyphony must be positive`);
      }
    }
    if (node.type === 'send' || node.type === 'return') {
      if (!Number.isFinite(node.gain) || node.gain < 0) {
        throw new Error(`Send/return node ${node.id} must have non-negative gain`);
      }
    }
  });

  const connectionIds = new Set<string>();
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
  });
};

const normalizeTrackRouting = (
  trackId: TrackID,
  routing: TrackRouting | undefined,
): TrackRouting => {
  const normalizedRouting = routing ?? {};
  const defaultGraph = createDefaultTrackRoutingGraph(trackId);
  const graph = isRecord(normalizedRouting.graph)
    ? normalizedRouting.graph
    : defaultGraph;
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : defaultGraph.nodes;
  const rawConnections = Array.isArray(graph.connections)
    ? graph.connections
    : defaultGraph.connections;
  const normalizedGraphNodes = rawNodes
    .filter((candidate): candidate is RoutingNode => isRecord(candidate))
    .map(normalizeRoutingNode);
  const normalizedGraphConnections = rawConnections.filter(
    (candidate): candidate is RoutingConnection => isRecord(candidate),
  );
  const graphNodes =
    normalizedGraphNodes.length > 0 ? normalizedGraphNodes : defaultGraph.nodes;
  const pluginNodes = graphNodes.filter(
    (node): node is PluginRoutingNode => node.type === 'plugin',
  );
  const sortedPluginIds = [...pluginNodes]
    .sort((a, b) => a.order - b.order)
    .map((plugin) => plugin.id);
  const normalizedNodes = graphNodes.map((node) => {
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
  const normalizedConnections = normalizedGraphConnections.filter((connection) => {
    if (seenConnectionIds.has(connection.id)) {
      return false;
    }
    seenConnectionIds.add(connection.id);
    return true;
  });
  return {
    ...normalizedRouting,
    graph: {
      ...graph,
      version: Math.max(1, Math.floor(finiteNumberOr(graph.version, 1))),
      nodes: normalizedNodes,
      connections: normalizedConnections,
    },
  };
};
