import {
  SessionAudioBridge,
  AudioFileLoader,
  AudioFileData,
} from '../SessionAudioBridge';
import { AudioEngine } from '../AudioEngine';
import { AutomationLane, ClockSyncService } from '../Automation';
import {
  AutomationCurve,
  Clip,
  RoutingGraph,
  Session,
  Track,
  createDefaultTrackRoutingGraph,
  PluginRoutingNode,
} from '../../session/models';
import type { PluginDescriptor } from '../plugins/types';
import type { PluginHost } from '../plugins/PluginHost';

type LoaderFactoryOptions = Partial<AudioFileData> & {
  throwError?: Error;
};

const createLoader = (
  sampleRate: number,
  frames: number,
  options: LoaderFactoryOptions = {},
): { loader: AudioFileLoader; loadMock: jest.Mock } => {
  const {
    throwError,
    data,
    channels = 1,
    sampleRate: loaderSampleRate = sampleRate,
    frames: loaderFrames = frames,
  } = options;

  const channelData =
    data ??
    (channels > 0
      ? Array.from({ length: channels }, () =>
          Float32Array.from({ length: loaderFrames }, (_, index) => Math.sin(index / 10)),
        )
      : []);

  const audioData: AudioFileData = {
    sampleRate: loaderSampleRate,
    channels,
    frames: loaderFrames,
    data: channelData,
  };

  const loadMock = jest.fn(async () => {
    if (throwError) {
      throw throwError;
    }
    return audioData;
  });
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
  uploadClipBuffer: jest.Mock;
} => {
  const configureNodes = jest.fn(async () => undefined);
  const connect = jest.fn(async () => undefined);
  const disconnect = jest.fn(async () => undefined);
  const publishAutomation = jest.fn(async () => undefined);
  const removeNodes = jest.fn(async () => undefined);
  const uploadClipBuffer = jest.fn(async () => undefined);
  const engine: Partial<AudioEngine> = {
    getClock: () => clock,
    configureNodes,
    connect,
    disconnect,
    publishAutomation,
    removeNodes,
    uploadClipBuffer,
  };
  return {
    engine: engine as AudioEngine,
    configureNodes,
    connect,
    disconnect,
    publishAutomation,
    removeNodes,
    uploadClipBuffer,
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
  const trackId = overrides.id ?? 'track-1';
  const graph = overrides.routing?.graph ?? createDefaultTrackRoutingGraph(trackId);
  const routing = overrides.routing ? { ...overrides.routing } : {};
  if (!routing.graph) {
    routing.graph = graph;
  }
  const clips = overrides.clips ?? [createClip({ id: `${trackId}-clip` })];
  return {
    id: trackId,
    name: 'Track 1',
    color: '#ffffff',
    clips,
    muted: false,
    solo: false,
    volume: 0,
    pan: 0,
    automationCurves: [],
    routing: routing as Track['routing'],
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

const createPluginHostMock = () => {
  const loadPlugin = jest.fn(async () => ({
    instanceId: 'native-instance',
    descriptor: mockDescriptor,
    cpuLoadPercent: 12,
    latencySamples: 32,
  }));
  const releasePlugin = jest.fn(async () => undefined);
  const scheduleAutomation = jest.fn(async () => undefined);
  const onCrash = jest.fn();
  const host = {
    loadPlugin,
    releasePlugin,
    scheduleAutomation,
    onCrash,
  } as unknown as PluginHost;
  return { host, loadPlugin, releasePlugin, scheduleAutomation };
};

const mockDescriptor: PluginDescriptor = {
  identifier: 'com.acme.Plugin',
  name: 'Fixture Plugin',
  format: 'auv3',
  manufacturer: 'Acme',
  version: '1.0.0',
  supportsSandbox: true,
  audioInputChannels: 2,
  audioOutputChannels: 2,
  midiInput: false,
  midiOutput: false,
  parameters: [],
};

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
      uploadClipBuffer,
    } = createMockEngine(clock);

    const bridge = new SessionAudioBridge(engine, { fileLoader: loader });
    const session = createSession();

    await bridge.applySessionUpdate({ ...session, revision: 1 });

    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(uploadClipBuffer).toHaveBeenCalledWith(
      expect.any(String),
      sampleRate,
      1,
      frames,
      expect.any(Array),
    );
    expect(configureNodes).toHaveBeenCalledTimes(1);
    const initialNodes = configureNodes.mock.calls[0][0];
    expect(initialNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: expect.stringContaining('track-1:input') }),
        expect.objectContaining({ id: expect.stringContaining('track-1:output') }),
        expect.objectContaining({ type: 'clipPlayer' }),
      ]),
    );
    expect(connect).toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(removeNodes).not.toHaveBeenCalled();
    expect(publishAutomation).toHaveBeenCalledTimes(1);

    configureNodes.mockClear();
    connect.mockClear();

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
    expect(disconnect).toHaveBeenCalledWith(trackInput.id, trackOutput.id);
    expect(configureNodes).toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith(pluginNodeId, trackOutput.id);
  });

  it('throws when a track is missing a routing graph', async () => {
    const { loader } = createLoader(sampleRate, frames);
    const clock = new ClockSyncService(sampleRate, framesPerBuffer, 120);
    const { engine } = createMockEngine(clock);
    const bridge = new SessionAudioBridge(engine, { fileLoader: loader });

    const trackWithoutGraph = {
      id: 'track-missing',
      name: 'Track Missing Graph',
      color: '#abcdef',
      clips: [createClip({ id: 'missing-clip' })],
      muted: false,
      solo: false,
      volume: 0,
      pan: 0,
      automationCurves: [],
      routing: {} as Track['routing'],
    } as Track;
    const sessionWithoutGraph = createSession({
      revision: 2,
      tracks: [trackWithoutGraph],
    });

    await expect(bridge.applySessionUpdate(sessionWithoutGraph)).rejects.toThrow(
      /missing a routing graph/,
    );
  });

  it('logs errors when audio files fail to load or are invalid', async () => {
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const { loader: failingLoader } = createLoader(sampleRate, frames, {
      throwError: new Error('load failed'),
    });
    const clock = new ClockSyncService(sampleRate, framesPerBuffer, 120);
    const { engine, configureNodes, uploadClipBuffer, publishAutomation } =
      createMockEngine(clock);

    const bridge = new SessionAudioBridge(engine, { fileLoader: failingLoader, logger });

    await bridge.applySessionUpdate(createSession({ revision: 3 }));

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to prepare clip node',
      expect.objectContaining({
        clipId: expect.stringContaining('clip'),
        error: expect.any(Error),
      }),
    );
    expect(uploadClipBuffer).not.toHaveBeenCalled();
    expect(configureNodes).toHaveBeenCalledTimes(1);
    expect(publishAutomation).not.toHaveBeenCalled();

    const { loader: zeroChannelLoader } = createLoader(sampleRate, frames, {
      channels: 0,
    });
    const bridgeWithZeroChannel = new SessionAudioBridge(engine, {
      fileLoader: zeroChannelLoader,
      logger,
    });

    await bridgeWithZeroChannel.applySessionUpdate(createSession({ revision: 4 }));

    expect(logger.error).toHaveBeenLastCalledWith(
      'Failed to prepare clip node',
      expect.objectContaining({ clipId: expect.stringContaining('clip') }),
    );
  });

  it('quantizes automation frames for multiple tracks and parameters', async () => {
    const { loader } = createLoader(sampleRate, frames);
    const clock = new ClockSyncService(sampleRate, framesPerBuffer, 120);
    const { engine, publishAutomation } = createMockEngine(clock);
    const bridge = new SessionAudioBridge(engine, { fileLoader: loader });

    const automationCurveA: AutomationCurve = {
      id: 'curve-1',
      parameter: 'volume',
      interpolation: 'linear',
      points: [
        { time: 10, value: 0.1 },
        { time: 230, value: 0.9 },
      ],
    };

    const automationCurveB: AutomationCurve = {
      id: 'curve-2',
      parameter: 'pan',
      interpolation: 'linear',
      points: [
        { time: 15, value: -0.5 },
        { time: 250, value: 0.5 },
      ],
    };

    const session = createSession({
      revision: 5,
      tracks: [
        createTrack({
          id: 'track-1',
          automationCurves: [automationCurveA],
        }),
        createTrack({
          id: 'track-2',
          automationCurves: [automationCurveB],
        }),
      ],
    });

    await bridge.applySessionUpdate(session);

    expect(publishAutomation).toHaveBeenCalledTimes(4);
    type LanePayload = ReturnType<AutomationLane['toPayload']>;
    const lanePayloads = publishAutomation.mock.calls.map(([, lane]) =>
      lane.toPayload(),
    ) as LanePayload[];
    expect(lanePayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ parameter: 'volume' }),
        expect.objectContaining({ parameter: 'pan' }),
        expect.objectContaining({ parameter: 'gain' }),
      ]),
    );
    const allFrames = lanePayloads.flatMap((payload) =>
      payload.points.map((pt) => pt.frame),
    );
    expect(allFrames.every((frame) => frame % framesPerBuffer === 0)).toBe(true);
  });

  it('tears down nodes when clips or tracks are removed', async () => {
    const { loader } = createLoader(sampleRate, frames);
    const clock = new ClockSyncService(sampleRate, framesPerBuffer, 120);
    const { engine, connect, disconnect, removeNodes } = createMockEngine(clock);
    const bridge = new SessionAudioBridge(engine, { fileLoader: loader });

    const sessionWithClip = createSession({ revision: 6 });
    await bridge.applySessionUpdate(sessionWithClip);

    connect.mockClear();
    disconnect.mockClear();
    removeNodes.mockClear();

    const sessionWithoutClip = createSession({
      revision: 7,
      tracks: [
        createTrack({
          clips: [],
        }),
      ],
    });

    await bridge.applySessionUpdate(sessionWithoutClip);
    expect(removeNodes).toHaveBeenCalled();

    const emptySession: Session = {
      ...sessionWithoutClip,
      revision: 8,
      tracks: [],
    };

    await bridge.applySessionUpdate(emptySession);

    expect(removeNodes).toHaveBeenCalledTimes(2);
  });

  it('publishes clearing automation when curves are removed', async () => {
    const { loader } = createLoader(sampleRate, frames);
    const clock = new ClockSyncService(sampleRate, framesPerBuffer, 120);
    const { engine, publishAutomation } = createMockEngine(clock);
    const bridge = new SessionAudioBridge(engine, { fileLoader: loader });

    const automationCurve: AutomationCurve = {
      id: 'curve-clear',
      parameter: 'volume',
      interpolation: 'linear',
      points: [
        { time: 0, value: 0.25 },
        { time: 128, value: 0.75 },
      ],
    };

    await bridge.applySessionUpdate(
      createSession({
        revision: 9,
        tracks: [
          createTrack({
            id: 'track-automation',
            automationCurves: [automationCurve],
          }),
        ],
      }),
    );

    publishAutomation.mockClear();

    await bridge.applySessionUpdate(
      createSession({
        revision: 10,
        tracks: [
          createTrack({
            id: 'track-automation',
            automationCurves: [],
          }),
        ],
      }),
    );

    expect(publishAutomation).toHaveBeenCalledTimes(1);
    const [nodeId, lane] = publishAutomation.mock.calls[0];
    expect(nodeId).toContain('track-automation:output');
    const payload = lane.toPayload();
    expect(payload.parameter).toBe('volume');
    expect(payload.points).toEqual([{ frame: 0, value: 0.75 }]);
  });

  it('resamples audio when loader sample rate differs from engine sample rate', async () => {
    const mismatchRate = 44100;
    const loaderFrames = Math.floor((frames * mismatchRate) / sampleRate);
    const { loader, loadMock } = createLoader(sampleRate, frames, {
      sampleRate: mismatchRate,
      frames: loaderFrames,
    });
    const clock = new ClockSyncService(sampleRate, framesPerBuffer, 120);
    const { engine, uploadClipBuffer } = createMockEngine(clock);
    const bridge = new SessionAudioBridge(engine, { fileLoader: loader });

    await bridge.applySessionUpdate(createSession({ revision: 9 }));

    expect(loadMock).toHaveBeenCalled();
    expect(uploadClipBuffer).toHaveBeenCalledWith(
      expect.any(String),
      sampleRate,
      1,
      expect.any(Number),
      expect.any(Array),
    );
    const [, , , resampledFrames] = uploadClipBuffer.mock.calls[0];
    const expectedFrames = Math.max(
      1,
      Math.round(loaderFrames * (sampleRate / mismatchRate)),
    );
    expect(resampledFrames).toBe(expectedFrames);
  });

  it('loads plugin instances and releases them as the routing graph mutates', async () => {
    const { loader } = createLoader(sampleRate, frames);
    const clock = new ClockSyncService(sampleRate, framesPerBuffer, 120);
    const { engine, configureNodes } = createMockEngine(clock);
    const { host, loadPlugin, releasePlugin } = createPluginHostMock();
    const descriptorResolver = jest.fn().mockResolvedValue(mockDescriptor);
    const bridge = new SessionAudioBridge(engine, {
      fileLoader: loader,
      pluginHost: host,
      resolvePluginDescriptor: descriptorResolver,
    });

    const baseGraph = createDefaultTrackRoutingGraph('track-plugin');
    const trackInput = baseGraph.nodes.find((node) => node.type === 'trackInput');
    const trackOutput = baseGraph.nodes.find((node) => node.type === 'trackOutput');
    if (!trackInput || !trackOutput) {
      throw new Error('missing endpoints');
    }

    const pluginNode: PluginRoutingNode = {
      id: 'track-plugin:slot:1',
      type: 'plugin',
      slot: 'insert',
      instanceId: 'session-plugin-1',
      order: 0,
      accepts: ['audio'],
      emits: ['audio'],
      automation: [],
    };

    const graphWithPlugin: RoutingGraph = {
      ...baseGraph,
      nodes: [...baseGraph.nodes, pluginNode],
      connections: [
        {
          id: 'conn-in-plugin',
          from: { nodeId: trackInput.id },
          to: { nodeId: pluginNode.id },
          signal: 'audio',
          enabled: true,
        },
        {
          id: 'conn-plugin-out',
          from: { nodeId: pluginNode.id },
          to: { nodeId: trackOutput.id },
          signal: 'audio',
          enabled: true,
        },
      ],
    };

    await bridge.applySessionUpdate(
      createSession({
        revision: 2,
        tracks: [
          createTrack({
            id: 'track-plugin',
            routing: { graph: graphWithPlugin },
          }),
        ],
      }),
    );

    expect(loadPlugin).toHaveBeenCalledWith(mockDescriptor, {
      sandboxIdentifier: 'session-plugin-1',
      automationBindings: [],
    });
    const configuredNodes = configureNodes.mock.calls.flatMap((call) => call[0]);
    const pluginConfig = configuredNodes.find((config) => config.id === pluginNode.id);
    expect(pluginConfig?.options).toEqual(
      expect.objectContaining({
        hostInstanceId: 'native-instance',
        acceptsAudio: true,
        emitsAudio: true,
      }),
    );

    await bridge.applySessionUpdate(
      createSession({
        revision: 3,
        tracks: [
          createTrack({
            id: 'track-plugin',
            routing: { graph: baseGraph },
          }),
        ],
      }),
    );

    expect(releasePlugin).toHaveBeenCalledWith('native-instance');
  });

  it('schedules plugin automation envelopes via the PluginHost facade', async () => {
    const { loader } = createLoader(sampleRate, frames);
    const clock = new ClockSyncService(sampleRate, framesPerBuffer, 120);
    const { engine } = createMockEngine(clock);
    const { host, scheduleAutomation } = createPluginHostMock();
    const descriptorResolver = jest.fn().mockResolvedValue(mockDescriptor);
    const bridge = new SessionAudioBridge(engine, {
      fileLoader: loader,
      pluginHost: host,
      resolvePluginDescriptor: descriptorResolver,
    });

    const baseGraph = createDefaultTrackRoutingGraph('track-automation');
    const trackInput = baseGraph.nodes.find((node) => node.type === 'trackInput');
    const trackOutput = baseGraph.nodes.find((node) => node.type === 'trackOutput');
    if (!trackInput || !trackOutput) {
      throw new Error('missing endpoints');
    }

    const pluginNode: PluginRoutingNode = {
      id: 'track-automation:plugin:fx',
      type: 'plugin',
      slot: 'insert',
      instanceId: 'session-plugin-automation',
      order: 0,
      accepts: ['audio'],
      emits: ['audio'],
      automation: [
        {
          parameterId: 'cutoff',
          curveId: 'curve-cutoff',
        },
      ],
    };

    const automationCurve: AutomationCurve = {
      id: 'curve-cutoff',
      parameter: 'cutoff',
      interpolation: 'linear',
      points: [
        { time: 0, value: 0.1 },
        { time: 250, value: 0.6 },
        { time: 125, value: 0.4 },
      ],
    };

    const graphWithPlugin: RoutingGraph = {
      ...baseGraph,
      nodes: [...baseGraph.nodes, pluginNode],
      connections: [
        {
          id: 'conn-in-plugin',
          from: { nodeId: trackInput.id },
          to: { nodeId: pluginNode.id },
          signal: 'audio',
          enabled: true,
        },
        {
          id: 'conn-plugin-out',
          from: { nodeId: pluginNode.id },
          to: { nodeId: trackOutput.id },
          signal: 'audio',
          enabled: true,
        },
      ],
    };

    const session = createSession({
      revision: 2,
      tracks: [
        createTrack({
          id: 'track-automation',
          routing: { graph: graphWithPlugin },
          automationCurves: [automationCurve],
        }),
      ],
    });

    await bridge.applySessionUpdate(session);

    expect(scheduleAutomation).toHaveBeenCalledWith('native-instance', 'cutoff', [
      { time: 0, value: 0.1 },
      { time: 125, value: 0.4 },
      { time: 250, value: 0.6 },
    ]);

    scheduleAutomation.mockClear();

    await bridge.applySessionUpdate({ ...session, revision: 3 });

    expect(scheduleAutomation).toHaveBeenCalledTimes(1);
  });
});
