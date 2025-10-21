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
  audioFile: string;
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

export type RoutingNode =
  | TrackEndpointNode
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
      if (clip.midi) {
        clip.midi.notes.forEach((note) => {
          if (!note.id) {
            throw new Error(`MIDI note requires an id in clip ${clip.id}`);
          }
          if (note.pitch < 0 || note.pitch > 127) {
            throw new Error(`Invalid MIDI pitch ${note.pitch} in clip ${clip.id}`);
          }
          if (note.durationBeats <= 0) {
            throw new Error(`MIDI note duration must be positive in clip ${clip.id}`);
          }
          if (note.velocity < 0 || note.velocity > 127) {
            throw new Error(`Invalid MIDI velocity ${note.velocity} in clip ${clip.id}`);
          }
        });
      }
    });

    if (track.routing.graph) {
      validateRoutingGraph(track.routing.graph);
    }
  });
};

const validateRoutingGraph = (graph: RoutingGraph): void => {
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
      if (node.gain < 0) {
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
  });
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
