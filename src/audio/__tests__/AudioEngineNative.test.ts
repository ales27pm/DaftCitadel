import { AudioEngine, OUTPUT_BUS } from '../AudioEngine';
import { NativeAudioEngine } from '../NativeAudioEngine';
import { NativeModules } from 'react-native';
import { AutomationLane, ClockSyncService } from '../Automation';

type AudioEngineMockState = {
  initialized: boolean;
  sampleRate: number;
  framesPerBuffer: number;
  nodes: Map<
    string,
    {
      type: string;
      options: Record<string, number | string | boolean>;
    }
  >;
  connections: Set<string>;
  diagnostics: {
    xruns: number;
    lastRenderDurationMicros: number;
    clipBufferBytes: number;
  };
  automations: Map<string, Map<string, { frame: number; value: number }[]>>;
  clipBuffers: Map<
    string,
    {
      sampleRate: number;
      channels: number;
      frames: number;
      channelData: Float32Array[];
      byteLength: number;
    }
  >;
};

const resolveMockState = (): AudioEngineMockState => {
  return (NativeModules.AudioEngineModule as { __state: AudioEngineMockState }).__state;
};

describe('NativeAudioEngine TurboModule', () => {
  beforeEach(() => {
    const state = resolveMockState();
    state.initialized = false;
    state.sampleRate = 0;
    state.framesPerBuffer = 0;
    state.nodes.clear();
    state.connections.clear();
    state.diagnostics.xruns = 0;
    state.diagnostics.lastRenderDurationMicros = 0;
    state.automations.clear();
    state.clipBuffers.clear();
  });

  describe('Initialization and Lifecycle', () => {
    it('initializes, configures nodes, connects to output, and exposes diagnostics', async () => {
      const engine = new AudioEngine({
        sampleRate: 48000,
        framesPerBuffer: 256,
        bpm: 120,
      });

      await engine.init();
      const state = resolveMockState();
      expect(state.initialized).toBe(true);
      expect(state.sampleRate).toBe(48000);
      expect(state.framesPerBuffer).toBe(256);

      await engine.configureNodes([
        {
          id: 'osc',
          type: 'sine',
          options: { frequency: 220 },
        },
      ]);

      expect(state.nodes.get('osc')).toMatchObject({
        type: 'sine',
        options: { frequency: 220 },
      });

      await engine.connect('osc', OUTPUT_BUS);
      expect(state.connections.has(`osc->${OUTPUT_BUS}`)).toBe(true);

      const diagnostics = await NativeAudioEngine.getRenderDiagnostics();
      expect(diagnostics).toEqual({
        xruns: 0,
        lastRenderDurationMicros: 0,
        clipBufferBytes: 0,
      });

      const gainLane = new AutomationLane('gain');
      gainLane.addPoint({ frame: 0, value: 0.25 });
      gainLane.addPoint({ frame: 128, value: 0.75 });
      await engine.publishAutomation('osc', gainLane);

      const nodeAutomations = state.automations.get('osc');
      expect(nodeAutomations?.get('gain')).toEqual([
        { frame: 0, value: 0.25 },
        { frame: 128, value: 0.75 },
      ]);

      await engine.dispose();
      expect(state.initialized).toBe(false);
      expect(state.nodes.size).toBe(0);
      expect(state.connections.size).toBe(0);
      expect(state.automations.size).toBe(0);
    });

    it('rejects initialization with invalid sample rate', () => {
      expect(
        () => new AudioEngine({ sampleRate: 0, framesPerBuffer: 256, bpm: 120 }),
      ).toThrow('sampleRate must be positive');
      expect(
        () => new AudioEngine({ sampleRate: -1, framesPerBuffer: 256, bpm: 120 }),
      ).toThrow('sampleRate must be positive');
    });

    it('rejects initialization with invalid frames per buffer', () => {
      expect(
        () => new AudioEngine({ sampleRate: 48000, framesPerBuffer: 0, bpm: 120 }),
      ).toThrow('framesPerBuffer must be positive');
      expect(
        () => new AudioEngine({ sampleRate: 48000, framesPerBuffer: -10, bpm: 120 }),
      ).toThrow('framesPerBuffer must be positive');
    });

    it('properly cleans up all state on dispose', async () => {
      const engine = new AudioEngine({
        sampleRate: 48000,
        framesPerBuffer: 256,
        bpm: 120,
      });
      await engine.init();

      await engine.configureNodes([
        { id: 'osc1', type: 'sine', options: { frequency: 440 } },
        { id: 'gain1', type: 'gain', options: { gain: 0.5 } },
      ]);
      await engine.connect('osc1', 'gain1');
      await engine.connect('gain1', OUTPUT_BUS);

      const lane = new AutomationLane('frequency');
      lane.addPoint({ frame: 0, value: 440 });
      await engine.publishAutomation('osc1', lane);

      const state = resolveMockState();
      expect(state.nodes.size).toBe(2);
      expect(state.connections.size).toBe(2);
      expect(state.automations.size).toBe(1);

      await engine.dispose();

      expect(state.initialized).toBe(false);
      expect(state.nodes.size).toBe(0);
      expect(state.connections.size).toBe(0);
      expect(state.automations.size).toBe(0);
    });

    it('allows re-initialization after disposal', async () => {
      const engine = new AudioEngine({
        sampleRate: 44100,
        framesPerBuffer: 512,
        bpm: 100,
      });

      await engine.init();
      let state = resolveMockState();
      expect(state.initialized).toBe(true);
      expect(state.sampleRate).toBe(44100);

      await engine.dispose();
      expect(state.initialized).toBe(false);

      await engine.init();
      state = resolveMockState();
      expect(state.initialized).toBe(true);
      expect(state.sampleRate).toBe(44100);
      expect(state.framesPerBuffer).toBe(512);
    });
  });

  describe('Node Configuration', () => {
    let engine: AudioEngine;

    beforeEach(async () => {
      engine = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 256, bpm: 120 });
      await engine.init();
    });

    afterEach(async () => {
      await engine.dispose();
    });

    it('configures multiple nodes in parallel', async () => {
      await engine.configureNodes([
        { id: 'osc1', type: 'sine', options: { frequency: 220 } },
        { id: 'osc2', type: 'sine', options: { frequency: 440 } },
        { id: 'mixer', type: 'mixer', options: { inputCount: 2 } },
        { id: 'gain', type: 'gain', options: { gain: 0.8 } },
      ]);

      const state = resolveMockState();
      expect(state.nodes.size).toBe(4);
      expect(state.nodes.get('osc1')).toMatchObject({
        type: 'sine',
        options: { frequency: 220 },
      });
      expect(state.nodes.get('osc2')).toMatchObject({
        type: 'sine',
        options: { frequency: 440 },
      });
      expect(state.nodes.get('mixer')).toMatchObject({
        type: 'mixer',
        options: { inputCount: 2 },
      });
      expect(state.nodes.get('gain')).toMatchObject({
        type: 'gain',
        options: { gain: 0.8 },
      });
    });

    it('uploads clip buffers before configuring clip playback nodes', async () => {
      const frames = 128;
      const channel = new Float32Array(frames);
      for (let index = 0; index < frames; index += 1) {
        channel[index] = index / frames;
      }
      const rawBuffer = new ArrayBuffer(frames * Float32Array.BYTES_PER_ELEMENT);
      new Float32Array(rawBuffer).set(channel);

      await engine.uploadClipBuffer('intro', 48000, 1, frames, [rawBuffer]);

      await engine.configureNodes([
        { id: 'clip-player', type: 'clip', options: { bufferKey: 'intro' } },
      ]);

      const state = resolveMockState();
      const registered = state.clipBuffers.get('intro');
      expect(registered).toBeDefined();
      expect(registered?.sampleRate).toBe(48000);
      expect(registered?.frames).toBe(frames);
      expect(registered?.channels).toBe(1);
      expect(registered?.channelData[0][0]).toBeCloseTo(0);
      expect(state.nodes.get('clip-player')).toMatchObject({
        type: 'clip',
        options: { bufferKey: 'intro' },
      });
    });

    it('handles empty node configuration array gracefully', async () => {
      await engine.configureNodes([]);
      const state = resolveMockState();
      expect(state.nodes.size).toBe(0);
    });

    it('trims whitespace from node IDs and types', async () => {
      await NativeAudioEngine.addNode('  osc1  ', '  sine  ', { frequency: 220 });
      const state = resolveMockState();
      expect(state.nodes.has('osc1')).toBe(true);
      expect(state.nodes.get('osc1')?.type).toBe('sine');
    });

    it('rejects empty node IDs', async () => {
      await expect(NativeAudioEngine.addNode('', 'sine', {})).rejects.toThrow(
        'nodeId and nodeType are required',
      );
      await expect(NativeAudioEngine.addNode('   ', 'sine', {})).rejects.toThrow(
        'nodeId and nodeType are required',
      );
    });

    it('rejects empty node types', async () => {
      await expect(NativeAudioEngine.addNode('osc1', '', {})).rejects.toThrow(
        'nodeId and nodeType are required',
      );
      await expect(NativeAudioEngine.addNode('osc1', '   ', {})).rejects.toThrow(
        'nodeId and nodeType are required',
      );
    });

    it('rejects duplicate node IDs', async () => {
      await NativeAudioEngine.addNode('osc1', 'sine', { frequency: 220 });
      await expect(NativeAudioEngine.addNode('osc1', 'gain', {})).rejects.toThrow(
        "Node 'osc1' already exists",
      );
    });

    it('accepts nodes with various option types', async () => {
      await engine.configureNodes([
        {
          id: 'complex',
          type: 'mixer',
          options: {
            gain: 0.5, // number
            enabled: true, // boolean
            mode: 'stereo', // string
            channels: 2,
          },
        },
      ]);

      const state = resolveMockState();
      expect(state.nodes.get('complex')).toBeDefined();
      expect(state.nodes.get('complex')?.options).toEqual({
        gain: 0.5,
        enabled: true,
        mode: 'stereo',
        channels: 2,
      });
    });

    it('handles nodes with empty options', async () => {
      await engine.configureNodes([{ id: 'osc', type: 'sine' }]);
      const state = resolveMockState();
      expect(state.nodes.get('osc')).toBeDefined();
    });

    it('removes nodes and their connections', async () => {
      await engine.configureNodes([
        { id: 'osc1', type: 'sine', options: { frequency: 440 } },
        { id: 'gain1', type: 'gain' },
      ]);
      await engine.connect('osc1', 'gain1');
      await engine.connect('gain1', OUTPUT_BUS);

      const state = resolveMockState();
      expect(state.nodes.size).toBe(2);
      expect(state.connections.size).toBe(2);

      await NativeAudioEngine.removeNode('gain1');

      expect(state.nodes.size).toBe(1);
      expect(state.nodes.has('osc1')).toBe(true);
      expect(state.nodes.has('gain1')).toBe(false);
      // Connections involving removed node should be cleaned up
      expect(state.connections.has('osc1->gain1')).toBe(false);
      expect(state.connections.has('gain1->__output__')).toBe(false);
    });

    it('removes node automations when node is removed', async () => {
      await engine.configureNodes([{ id: 'osc1', type: 'sine' }]);
      const lane = new AutomationLane('frequency');
      lane.addPoint({ frame: 0, value: 440 });
      await engine.publishAutomation('osc1', lane);

      const state = resolveMockState();
      expect(state.automations.has('osc1')).toBe(true);

      await NativeAudioEngine.removeNode('osc1');
      expect(state.automations.has('osc1')).toBe(false);
    });

    it('releases clip buffers and reports reduced diagnostics when unregistered', async () => {
      const frames = 256;
      const sampleRate = 48000;
      const channel = new Float32Array(frames).fill(0.5);

      await engine.uploadClipBuffer('ephemeral', sampleRate, 1, frames, [channel.buffer]);

      let diagnostics = await NativeAudioEngine.getRenderDiagnostics();
      expect(diagnostics.clipBufferBytes).toBe(frames * Float32Array.BYTES_PER_ELEMENT);

      await engine.releaseClipBuffer('ephemeral');
      diagnostics = await NativeAudioEngine.getRenderDiagnostics();
      expect(diagnostics.clipBufferBytes).toBe(0);
    });
  });

  describe('Node Connections', () => {
    let engine: AudioEngine;

    beforeEach(async () => {
      engine = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 256, bpm: 120 });
      await engine.init();
      await engine.configureNodes([
        { id: 'osc1', type: 'sine', options: { frequency: 220 } },
        { id: 'osc2', type: 'sine', options: { frequency: 440 } },
        { id: 'mixer', type: 'mixer' },
        { id: 'gain', type: 'gain' },
      ]);
    });

    afterEach(async () => {
      await engine.dispose();
    });

    it('connects nodes in a simple chain', async () => {
      await engine.connect('osc1', 'gain');
      await engine.connect('gain', OUTPUT_BUS);

      const state = resolveMockState();
      expect(state.connections.has('osc1->gain')).toBe(true);
      expect(state.connections.has('gain->__output__')).toBe(true);
    });

    it('connects multiple sources to a mixer', async () => {
      await engine.connect('osc1', 'mixer');
      await engine.connect('osc2', 'mixer');
      await engine.connect('mixer', OUTPUT_BUS);

      const state = resolveMockState();
      expect(state.connections.size).toBe(3);
      expect(state.connections.has('osc1->mixer')).toBe(true);
      expect(state.connections.has('osc2->mixer')).toBe(true);
      expect(state.connections.has('mixer->__output__')).toBe(true);
    });

    it('connects nodes directly to output bus', async () => {
      await engine.connect('osc1', OUTPUT_BUS);

      const state = resolveMockState();
      expect(state.connections.has('osc1->__output__')).toBe(true);
    });

    it('trims whitespace from connection endpoints', async () => {
      await NativeAudioEngine.connectNodes('  osc1  ', '  gain  ');
      const state = resolveMockState();
      expect(state.connections.has('osc1->gain')).toBe(true);
    });

    it('rejects connections with empty source', async () => {
      await expect(NativeAudioEngine.connectNodes('', 'gain')).rejects.toThrow(
        'source and destination are required',
      );
    });

    it('rejects connections with empty destination', async () => {
      await expect(NativeAudioEngine.connectNodes('osc1', '')).rejects.toThrow(
        'source and destination are required',
      );
    });

    it('rejects connections from non-existent source', async () => {
      await expect(NativeAudioEngine.connectNodes('nonexistent', 'gain')).rejects.toThrow(
        "Source node 'nonexistent' is not registered",
      );
    });

    it('rejects connections to non-existent destination (excluding OUTPUT_BUS)', async () => {
      await expect(NativeAudioEngine.connectNodes('osc1', 'nonexistent')).rejects.toThrow(
        "Destination node 'nonexistent' is not registered",
      );
    });

    it('allows connection to OUTPUT_BUS without registration', async () => {
      await expect(
        NativeAudioEngine.connectNodes('osc1', OUTPUT_BUS),
      ).resolves.not.toThrow();
    });

    it('rejects duplicate connections', async () => {
      await NativeAudioEngine.connectNodes('osc1', 'gain');
      await expect(NativeAudioEngine.connectNodes('osc1', 'gain')).rejects.toThrow(
        "Connection 'osc1->gain' already exists",
      );
    });

    it('disconnects nodes', async () => {
      await engine.connect('osc1', 'gain');
      await engine.connect('gain', OUTPUT_BUS);

      let state = resolveMockState();
      expect(state.connections.size).toBe(2);

      await engine.disconnect('osc1', 'gain');

      state = resolveMockState();
      expect(state.connections.has('osc1->gain')).toBe(false);
      expect(state.connections.has('gain->__output__')).toBe(true);
      expect(state.connections.size).toBe(1);
    });

    it('handles disconnection of non-existent connection gracefully', async () => {
      await expect(engine.disconnect('osc1', 'gain')).resolves.not.toThrow();
      const state = resolveMockState();
      expect(state.connections.size).toBe(0);
    });

    it('builds complex routing graph', async () => {
      // Build: osc1 -> mixer -> gain -> output
      //        osc2 -> mixer
      await engine.connect('osc1', 'mixer');
      await engine.connect('osc2', 'mixer');
      await engine.connect('mixer', 'gain');
      await engine.connect('gain', OUTPUT_BUS);

      const state = resolveMockState();
      expect(state.connections.size).toBe(4);
      expect(state.connections.has('osc1->mixer')).toBe(true);
      expect(state.connections.has('osc2->mixer')).toBe(true);
      expect(state.connections.has('mixer->gain')).toBe(true);
      expect(state.connections.has('gain->__output__')).toBe(true);
    });
  });

  describe('Parameter Automation', () => {
    let engine: AudioEngine;

    beforeEach(async () => {
      engine = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 256, bpm: 120 });
      await engine.init();
      await engine.configureNodes([
        { id: 'osc1', type: 'sine', options: { frequency: 440 } },
        { id: 'gain1', type: 'gain' },
      ]);
    });

    afterEach(async () => {
      await engine.dispose();
    });

    it('schedules single automation point', async () => {
      await NativeAudioEngine.scheduleParameterAutomation('osc1', 'frequency', 0, 440);

      const state = resolveMockState();
      const automations = state.automations.get('osc1');
      expect(automations).toBeDefined();
      expect(automations?.get('frequency')).toEqual([{ frame: 0, value: 440 }]);
    });

    it('schedules multiple automation points in order', async () => {
      const lane = new AutomationLane('frequency');
      lane.addPoint({ frame: 0, value: 220 });
      lane.addPoint({ frame: 256, value: 440 });
      lane.addPoint({ frame: 512, value: 880 });
      await engine.publishAutomation('osc1', lane);

      const state = resolveMockState();
      const automations = state.automations.get('osc1');
      expect(automations?.get('frequency')).toEqual([
        { frame: 0, value: 220 },
        { frame: 256, value: 440 },
        { frame: 512, value: 880 },
      ]);
    });

    it('normalizes parameter names to lowercase', async () => {
      await NativeAudioEngine.scheduleParameterAutomation('osc1', 'FREQUENCY', 0, 440);
      await NativeAudioEngine.scheduleParameterAutomation('osc1', 'Frequency', 128, 880);

      const state = resolveMockState();
      const automations = state.automations.get('osc1');
      expect(automations?.get('frequency')).toEqual([
        { frame: 0, value: 440 },
        { frame: 128, value: 880 },
      ]);
    });

    it('replaces automation point at same frame', async () => {
      await NativeAudioEngine.scheduleParameterAutomation('osc1', 'frequency', 128, 440);
      await NativeAudioEngine.scheduleParameterAutomation('osc1', 'frequency', 128, 880);

      const state = resolveMockState();
      const automations = state.automations.get('osc1');
      expect(automations?.get('frequency')).toEqual([{ frame: 128, value: 880 }]);
    });

    it('maintains separate automation lanes per parameter', async () => {
      await NativeAudioEngine.scheduleParameterAutomation('osc1', 'frequency', 0, 440);
      await NativeAudioEngine.scheduleParameterAutomation('osc1', 'gain', 0, 0.5);

      const state = resolveMockState();
      const automations = state.automations.get('osc1');
      expect(automations?.get('frequency')).toEqual([{ frame: 0, value: 440 }]);
      expect(automations?.get('gain')).toEqual([{ frame: 0, value: 0.5 }]);
    });

    it('maintains separate automation maps per node', async () => {
      await NativeAudioEngine.scheduleParameterAutomation('osc1', 'frequency', 0, 440);
      await NativeAudioEngine.scheduleParameterAutomation('gain1', 'gain', 0, 0.8);

      const state = resolveMockState();
      expect(state.automations.get('osc1')?.get('frequency')).toEqual([
        { frame: 0, value: 440 },
      ]);
      expect(state.automations.get('gain1')?.get('gain')).toEqual([
        { frame: 0, value: 0.8 },
      ]);
    });

    it('rejects automation for non-existent node', async () => {
      await expect(
        NativeAudioEngine.scheduleParameterAutomation('nonexistent', 'frequency', 0, 440),
      ).rejects.toThrow("Node 'nonexistent' is not registered");
    });

    it('rejects empty parameter name', async () => {
      await expect(
        NativeAudioEngine.scheduleParameterAutomation('osc1', '', 0, 440),
      ).rejects.toThrow('Parameter name is required');

      await expect(
        NativeAudioEngine.scheduleParameterAutomation('osc1', '   ', 0, 440),
      ).rejects.toThrow('Parameter name is required');
    });

    it('rejects negative frame values', async () => {
      await expect(
        NativeAudioEngine.scheduleParameterAutomation('osc1', 'frequency', -1, 440),
      ).rejects.toThrow('Frame must be a non-negative integer');
    });

    it('rejects non-integer frame values', async () => {
      await expect(
        NativeAudioEngine.scheduleParameterAutomation('osc1', 'frequency', 1.5, 440),
      ).rejects.toThrow('Frame must be a non-negative integer');
    });

    it('rejects non-finite frame values', async () => {
      await expect(
        NativeAudioEngine.scheduleParameterAutomation('osc1', 'frequency', NaN, 440),
      ).rejects.toThrow('Frame must be a non-negative integer');

      await expect(
        NativeAudioEngine.scheduleParameterAutomation('osc1', 'frequency', Infinity, 440),
      ).rejects.toThrow('Frame must be a non-negative integer');
    });

    it('rejects non-finite parameter values', async () => {
      await expect(
        NativeAudioEngine.scheduleParameterAutomation('osc1', 'frequency', 0, NaN),
      ).rejects.toThrow('Value must be finite');

      await expect(
        NativeAudioEngine.scheduleParameterAutomation('osc1', 'frequency', 0, Infinity),
      ).rejects.toThrow('Value must be finite');
    });

    it('accepts zero as valid automation value', async () => {
      await NativeAudioEngine.scheduleParameterAutomation('osc1', 'frequency', 0, 0);

      const state = resolveMockState();
      const automations = state.automations.get('osc1');
      expect(automations?.get('frequency')).toEqual([{ frame: 0, value: 0 }]);
    });

    it('publishes complex automation curves via AutomationLane', async () => {
      const frequencyLane = new AutomationLane('frequency');
      frequencyLane.addPoint({ frame: 0, value: 220 });
      frequencyLane.addPoint({ frame: 128, value: 440 });
      frequencyLane.addPoint({ frame: 256, value: 880 });
      frequencyLane.addPoint({ frame: 384, value: 440 });

      await engine.publishAutomation('osc1', frequencyLane);

      const state = resolveMockState();
      const automations = state.automations.get('osc1');
      expect(automations?.get('frequency')).toHaveLength(4);
      expect(automations?.get('frequency')).toEqual([
        { frame: 0, value: 220 },
        { frame: 128, value: 440 },
        { frame: 256, value: 880 },
        { frame: 384, value: 440 },
      ]);
    });
  });

  describe('Render Diagnostics', () => {
    let engine: AudioEngine;

    beforeEach(async () => {
      engine = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 256, bpm: 120 });
      await engine.init();
    });

    afterEach(async () => {
      await engine.dispose();
    });

    it('returns initial diagnostics with zeros', async () => {
      const diagnostics = await NativeAudioEngine.getRenderDiagnostics();
      expect(diagnostics).toEqual({
        xruns: 0,
        lastRenderDurationMicros: 0,
        clipBufferBytes: 0,
      });
    });

    it('maintains diagnostics state across operations', async () => {
      await engine.configureNodes([{ id: 'osc1', type: 'sine' }]);
      await engine.connect('osc1', OUTPUT_BUS);

      const diagnostics = await NativeAudioEngine.getRenderDiagnostics();
      expect(diagnostics.xruns).toBe(0);
      expect(diagnostics.lastRenderDurationMicros).toBe(0);
      expect(diagnostics.clipBufferBytes).toBe(0);
    });

    it('can simulate xruns for testing', async () => {
      const state = resolveMockState();
      state.diagnostics.xruns = 5;
      state.diagnostics.lastRenderDurationMicros = 1250.5;
      state.diagnostics.clipBufferBytes = 4096;

      const diagnostics = await NativeAudioEngine.getRenderDiagnostics();
      expect(diagnostics.xruns).toBe(5);
      expect(diagnostics.lastRenderDurationMicros).toBe(1250.5);
      expect(diagnostics.clipBufferBytes).toBe(4096);
    });

    it('resets diagnostics on shutdown', async () => {
      const state = resolveMockState();
      state.diagnostics.xruns = 10;
      state.diagnostics.lastRenderDurationMicros = 2000;
      state.diagnostics.clipBufferBytes = 8192;

      await engine.dispose();

      const diagnostics = await NativeAudioEngine.getRenderDiagnostics();
      expect(diagnostics.xruns).toBe(0);
      expect(diagnostics.lastRenderDurationMicros).toBe(0);
      expect(diagnostics.clipBufferBytes).toBe(0);
    });
  });

  describe('ClockSyncService Integration', () => {
    it('provides clock service from AudioEngine', () => {
      const engine = new AudioEngine({
        sampleRate: 48000,
        framesPerBuffer: 256,
        bpm: 120,
      });
      const clock = engine.getClock();

      expect(clock).toBeInstanceOf(ClockSyncService);
      expect(clock.describe()).toMatchObject({
        sampleRate: 48000,
        framesPerBuffer: 256,
        bpm: 120,
        tempoRevision: 0,
      });
    });

    it('clock computes correct frames per beat', () => {
      const engine = new AudioEngine({
        sampleRate: 48000,
        framesPerBuffer: 256,
        bpm: 120,
      });
      const clock = engine.getClock();

      // At 120 BPM: 60 seconds / 120 beats = 0.5 seconds per beat
      // At 48000 Hz: 0.5 * 48000 = 24000 frames per beat
      expect(clock.framesPerBeat()).toBeCloseTo(24000);
    });

    it('clock quantizes frames to buffer boundaries', () => {
      const engine = new AudioEngine({
        sampleRate: 48000,
        framesPerBuffer: 256,
        bpm: 120,
      });
      const clock = engine.getClock();

      expect(clock.quantizeFrameToBuffer(0)).toBe(0);
      expect(clock.quantizeFrameToBuffer(1)).toBe(256);
      expect(clock.quantizeFrameToBuffer(256)).toBe(256);
      expect(clock.quantizeFrameToBuffer(257)).toBe(512);
      expect(clock.quantizeFrameToBuffer(512)).toBe(512);
    });

    it('clock tracks tempo changes', () => {
      const engine = new AudioEngine({
        sampleRate: 48000,
        framesPerBuffer: 256,
        bpm: 120,
      });
      const clock = engine.getClock();

      expect(clock.describe().tempoRevision).toBe(0);

      clock.updateTempo(140);
      expect(clock.describe().bpm).toBe(140);
      expect(clock.describe().tempoRevision).toBe(1);

      clock.updateTempo(100);
      expect(clock.describe().tempoRevision).toBe(2);
    });
  });

  describe('Complex Integration Scenarios', () => {
    let engine: AudioEngine;

    beforeEach(async () => {
      engine = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 256, bpm: 120 });
      await engine.init();
    });

    afterEach(async () => {
      await engine.dispose();
    });

    it('builds and tears down multi-node processing graph', async () => {
      // Build: osc1, osc2 -> mixer -> reverb -> gain -> output
      await engine.configureNodes([
        { id: 'osc1', type: 'sine', options: { frequency: 220 } },
        { id: 'osc2', type: 'sine', options: { frequency: 330 } },
        { id: 'mixer', type: 'mixer', options: { inputCount: 2 } },
        { id: 'reverb', type: 'gain', options: { gain: 0.3 } }, // Placeholder
        { id: 'gain', type: 'gain', options: { gain: 0.8 } },
      ]);

      await engine.connect('osc1', 'mixer');
      await engine.connect('osc2', 'mixer');
      await engine.connect('mixer', 'reverb');
      await engine.connect('reverb', 'gain');
      await engine.connect('gain', OUTPUT_BUS);

      const state = resolveMockState();
      expect(state.nodes.size).toBe(5);
      expect(state.connections.size).toBe(5);

      // Remove reverb and rewire
      await NativeAudioEngine.removeNode('reverb');
      expect(state.nodes.size).toBe(4);

      // Reconnect mixer directly to gain
      await engine.connect('mixer', 'gain');
      expect(state.connections.has('mixer->gain')).toBe(true);
    });

    it('handles batch node addition and connection', async () => {
      const nodeConfigs = Array.from({ length: 10 }, (_, i) => ({
        id: `osc${i}`,
        type: 'sine',
        options: { frequency: 220 + i * 110 },
      }));

      await engine.configureNodes(nodeConfigs);

      const state = resolveMockState();
      expect(state.nodes.size).toBe(10);

      for (let i = 0; i < 10; i++) {
        expect(state.nodes.get(`osc${i}`)).toMatchObject({
          type: 'sine',
          options: { frequency: 220 + i * 110 },
        });
      }
    });

    it('schedules complex automation across multiple nodes', async () => {
      await engine.configureNodes([
        { id: 'osc1', type: 'sine' },
        { id: 'osc2', type: 'sine' },
        { id: 'gain1', type: 'gain' },
      ]);

      // Schedule automation for multiple parameters across nodes
      const freqLane1 = new AutomationLane('frequency');
      freqLane1.addPoint({ frame: 0, value: 220 });
      freqLane1.addPoint({ frame: 512, value: 440 });

      const freqLane2 = new AutomationLane('frequency');
      freqLane2.addPoint({ frame: 0, value: 330 });
      freqLane2.addPoint({ frame: 512, value: 660 });

      const gainLane = new AutomationLane('gain');
      gainLane.addPoint({ frame: 0, value: 0.5 });
      gainLane.addPoint({ frame: 256, value: 0.8 });
      gainLane.addPoint({ frame: 512, value: 0.3 });

      await engine.publishAutomation('osc1', freqLane1);
      await engine.publishAutomation('osc2', freqLane2);
      await engine.publishAutomation('gain1', gainLane);

      const state = resolveMockState();
      expect(state.automations.size).toBe(3);
      expect(state.automations.get('osc1')?.get('frequency')).toHaveLength(2);
      expect(state.automations.get('osc2')?.get('frequency')).toHaveLength(2);
      expect(state.automations.get('gain1')?.get('gain')).toHaveLength(3);
    });

    it('handles rapid connection/disconnection cycles', async () => {
      await engine.configureNodes([
        { id: 'source', type: 'sine' },
        { id: 'dest', type: 'gain' },
      ]);

      for (let i = 0; i < 5; i++) {
        await engine.connect('source', 'dest');
        const state = resolveMockState();
        expect(state.connections.has('source->dest')).toBe(true);

        await engine.disconnect('source', 'dest');
        expect(state.connections.has('source->dest')).toBe(false);
      }
    });

    it('maintains state consistency after partial failures', async () => {
      await engine.configureNodes([{ id: 'osc1', type: 'sine' }]);

      // Try to connect to non-existent node
      await expect(engine.connect('osc1', 'nonexistent')).rejects.toThrow();

      // Verify state is still consistent
      const state = resolveMockState();
      expect(state.nodes.has('osc1')).toBe(true);
      expect(state.connections.size).toBe(0);

      // Subsequent valid operations should work
      await engine.configureNodes([{ id: 'gain1', type: 'gain' }]);
      await engine.connect('osc1', 'gain1');
      expect(state.connections.has('osc1->gain1')).toBe(true);
    });
  });

  describe('Edge Cases and Boundary Conditions', () => {
    it('handles very large frame numbers in automation', async () => {
      const engine = new AudioEngine({
        sampleRate: 48000,
        framesPerBuffer: 256,
        bpm: 120,
      });
      await engine.init();
      await engine.configureNodes([{ id: 'osc1', type: 'sine' }]);

      const largeFrame = 48000 * 3600; // 1 hour at 48kHz
      await NativeAudioEngine.scheduleParameterAutomation(
        'osc1',
        'frequency',
        largeFrame,
        880,
      );

      const state = resolveMockState();
      const automations = state.automations.get('osc1');
      expect(automations?.get('frequency')).toEqual([{ frame: largeFrame, value: 880 }]);

      await engine.dispose();
    });

    it('handles extreme parameter values', async () => {
      const engine = new AudioEngine({
        sampleRate: 48000,
        framesPerBuffer: 256,
        bpm: 120,
      });
      await engine.init();
      await engine.configureNodes([{ id: 'osc1', type: 'sine' }]);

      await NativeAudioEngine.scheduleParameterAutomation('osc1', 'frequency', 0, 0.0001);
      await NativeAudioEngine.scheduleParameterAutomation('osc1', 'frequency', 1, 20000);
      await NativeAudioEngine.scheduleParameterAutomation('osc1', 'frequency', 2, -1000);

      const state = resolveMockState();
      const automations = state.automations.get('osc1');
      expect(automations?.get('frequency')).toEqual([
        { frame: 0, value: 0.0001 },
        { frame: 1, value: 20000 },
        { frame: 2, value: -1000 },
      ]);

      await engine.dispose();
    });

    it('handles node IDs with special characters', async () => {
      const engine = new AudioEngine({
        sampleRate: 48000,
        framesPerBuffer: 256,
        bpm: 120,
      });
      await engine.init();

      await engine.configureNodes([
        { id: 'osc-1', type: 'sine' },
        { id: 'gain_1', type: 'gain' },
        { id: 'mixer.main', type: 'mixer' },
      ]);

      const state = resolveMockState();
      expect(state.nodes.has('osc-1')).toBe(true);
      expect(state.nodes.has('gain_1')).toBe(true);
      expect(state.nodes.has('mixer.main')).toBe(true);

      await engine.connect('osc-1', 'gain_1');
      expect(state.connections.has('osc-1->gain_1')).toBe(true);

      await engine.dispose();
    });

    it('handles many connections to single node', async () => {
      const engine = new AudioEngine({
        sampleRate: 48000,
        framesPerBuffer: 256,
        bpm: 120,
      });
      await engine.init();

      const sources = Array.from({ length: 20 }, (_, i) => `source${i}`);
      await engine.configureNodes([
        ...sources.map((id) => ({ id, type: 'sine' })),
        { id: 'mixer', type: 'mixer' },
      ]);

      for (const source of sources) {
        await engine.connect(source, 'mixer');
      }

      const state = resolveMockState();
      expect(state.connections.size).toBe(20);
      for (const source of sources) {
        expect(state.connections.has(`${source}->mixer`)).toBe(true);
      }

      await engine.dispose();
    });
  });
});
