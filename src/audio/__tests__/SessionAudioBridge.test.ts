import {
  SessionAudioBridge,
  AudioFileLoader,
  AudioFileData,
} from '../SessionAudioBridge';
import { AudioEngine } from '../AudioEngine';
import { ClockSyncService } from '../Automation';
import {
  Clip,
  Session,
  Track,
  createDefaultTrackRoutingGraph,
  AutomationCurve,
  PluginRoutingNode,
  RoutingGraph,
} from '../../session/models';

const createLoader = (
  sampleRate: number,
  frames: number,
): { loader: AudioFileLoader; loadMock: jest.Mock } => {
  const audioData: AudioFileData = {
    sampleRate,
    channels: 1,
    frames,
    data: [Float32Array.from({ length: frames }, (_, index) => Math.sin(index / 10))],
  };
  const loadMock = jest.fn(async () => audioData);
  const loader: AudioFileLoader = {
    load: loadMock,
  };
  return { loader, loadMock };
};

const createMockEngine = (
  clock: ClockSyncService,
): {
  engine: AudioEngine;
  configureNodes: jest.Mock;
  connect: jest.Mock;
  disconnect: jest.Mock;
  publishAutomation: jest.Mock;
  removeNodes: jest.Mock;
} => {
  const configureNodes = jest.fn(async () => undefined);
  const connect = jest.fn(async () => undefined);
  const disconnect = jest.fn(async () => undefined);
  const publishAutomation = jest.fn(async () => undefined);
  const removeNodes = jest.fn(async () => undefined);
  const engine: Partial<AudioEngine> = {
    getClock: () => clock,
    configureNodes,
    connect,
    disconnect,
    publishAutomation,
    removeNodes,
  };
  return {
    engine: engine as AudioEngine,
    configureNodes,
    connect,
    disconnect,
    publishAutomation,
    removeNodes,
  };
};

const createClip = (overrides: Partial<Clip> = {}): Clip => ({
  id: 'clip-1',
  name: 'Clip 1',
  start: 0,
  duration: 1000,
  audioFile: 'clip.wav',
  gain: 1,
  fadeIn: 0,
  fadeOut: 0,
  automationCurveIds: [],
  ...overrides,
});

const createTrack = (overrides: Partial<Track> = {}): Track => {
  const graph = overrides.routing?.graph ?? createDefaultTrackRoutingGraph('track-1');
  return {
    id: 'track-1',
    name: 'Track 1',
    color: '#ffffff',
    clips: [createClip()],
    muted: false,
    solo: false,
    volume: 0,
    pan: 0,
    automationCurves: [],
    routing: { graph },
    ...overrides,
  };
};

const createSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'session-1',
  name: 'Fixture Session',
  revision: 1,
  tracks: [createTrack()],
  metadata: {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bpm: 120,
    sampleRate: 48000,
    timeSignature: '4/4',
  },
  ...overrides,
});

describe('SessionAudioBridge', () => {
  const sampleRate = 48000;
  const framesPerBuffer = 256;
  const frames = sampleRate;

  it('rebuilds routing graph and schedules clip playback when session revisions advance', async () => {
    const { loader, loadMock } = createLoader(sampleRate, frames);
    const clock = new ClockSyncService(sampleRate, framesPerBuffer, 120);
    const {
      engine,
      configureNodes,
      connect,
      disconnect,
      publishAutomation,
      removeNodes,
    } = createMockEngine(clock);

    const bridge = new SessionAudioBridge(engine, { fileLoader: loader });
    const session = createSession();

    await bridge.applySessionUpdate({ ...session, revision: 1 });

    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(configureNodes).toHaveBeenCalledTimes(1);
    const initialNodes = configureNodes.mock.calls[0][0];
    expect(initialNodes).toHaveLength(3);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(disconnect).not.toHaveBeenCalled();
    expect(removeNodes).not.toHaveBeenCalled();
    expect(publishAutomation).toHaveBeenCalledTimes(1);

    configureNodes.mockClear();
    connect.mockClear();
    disconnect.mockClear();
    publishAutomation.mockClear();

    const graph = createDefaultTrackRoutingGraph('track-1');
    const trackInput = graph.nodes.find((node) => node.type === 'trackInput');
    const trackOutput = graph.nodes.find((node) => node.type === 'trackOutput');
    if (!trackInput || !trackOutput) {
      throw new Error('Fixture graph missing endpoints');
    }
    const pluginNodeId = 'track-1:plugin:compressor';
    const pluginNode: PluginRoutingNode = {
      id: pluginNodeId,
      type: 'plugin',
      slot: 'insert',
      instanceId: 'compressor',
      order: 0,
      accepts: ['audio'],
      emits: ['audio'],
    };
    const pluginGraph: RoutingGraph = {
      ...graph,
      nodes: [...graph.nodes, pluginNode],
      connections: [
        {
          id: 'c1',
          from: { nodeId: trackInput.id },
          to: { nodeId: pluginNodeId },
          signal: 'audio',
          enabled: true,
        },
        {
          id: 'c2',
          from: { nodeId: pluginNodeId },
          to: { nodeId: trackOutput.id },
          signal: 'audio',
          enabled: true,
        },
      ],
    };

    const sessionWithPlugin = createSession({
      revision: 2,
      tracks: [
        createTrack({
          routing: { graph: pluginGraph },
        }),
      ],
    });

    await bridge.applySessionUpdate(sessionWithPlugin);

    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith(trackInput.id, trackOutput.id);
    expect(configureNodes).toHaveBeenCalledTimes(1);
    const pluginNodes = configureNodes.mock.calls[0][0];
    expect(pluginNodes).toHaveLength(1);
    expect(pluginNodes[0].id).toBe(pluginNodeId);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(removeNodes).not.toHaveBeenCalled();
  });

  it('quantizes automation frames using the audio engine clock', async () => {
    const { loader } = createLoader(sampleRate, frames);
    const clock = new ClockSyncService(sampleRate, framesPerBuffer, 120);
    const { engine, publishAutomation } = createMockEngine(clock);
    const bridge = new SessionAudioBridge(engine, { fileLoader: loader });

    const automationCurve: AutomationCurve = {
      id: 'curve-1',
      parameter: 'volume',
      interpolation: 'linear',
      points: [
        { time: 10, value: 0.1 },
        { time: 230, value: 0.9 },
      ],
    };

    const session = createSession({
      revision: 5,
      tracks: [
        createTrack({
          automationCurves: [automationCurve],
        }),
      ],
    });

    await bridge.applySessionUpdate(session);

    const trackOutputId = 'track-1:output:main';
    const automationCall = publishAutomation.mock.calls.find(
      ([nodeId]) => nodeId === trackOutputId,
    );
    expect(automationCall).toBeDefined();
    const [, lane] = automationCall!;
    const payload = lane.toPayload();
    expect(
      payload.points.map((point: { frame: number; value: number }) => point.frame),
    ).toEqual([512, 11264]);
    expect(
      payload.points.map((point: { frame: number; value: number }) => point.value),
    ).toEqual([0.1, 0.9]);
  });

  it('tears down clip nodes when clips are removed from a track', async () => {
    const { loader } = createLoader(sampleRate, frames);
    const clock = new ClockSyncService(sampleRate, framesPerBuffer, 120);
    const { engine, connect, disconnect, removeNodes } = createMockEngine(clock);
    const bridge = new SessionAudioBridge(engine, { fileLoader: loader });

    const sessionWithClip = createSession({ revision: 3 });
    await bridge.applySessionUpdate(sessionWithClip);

    expect(connect).toHaveBeenCalledTimes(3);
    expect(removeNodes).not.toHaveBeenCalled();

    connect.mockClear();
    disconnect.mockClear();
    removeNodes.mockClear();

    const sessionWithoutClip = createSession({
      revision: 4,
      tracks: [
        createTrack({
          clips: [],
        }),
      ],
    });

    await bridge.applySessionUpdate(sessionWithoutClip);

    expect(disconnect).toHaveBeenCalledWith('clip:clip-1', 'track-1:input:main');
    expect(removeNodes).toHaveBeenCalledTimes(1);
    expect(removeNodes.mock.calls[0][0]).toContain('clip:clip-1');
  });
});
