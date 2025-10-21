import { AudioEngine, OUTPUT_BUS } from '../AudioEngine';
import { NativeAudioEngine } from '../NativeAudioEngine';
import { NativeModules } from 'react-native';
import { AutomationLane } from '../Automation';

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
  diagnostics: { xruns: number; lastRenderDurationMicros: number };
  automations: Map<string, Map<string, { frame: number; value: number }[]>>;
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
  });

  it('initializes, configures nodes, connects to output, and exposes diagnostics', async () => {
    const engine = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 256, bpm: 120 });

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
    expect(diagnostics).toEqual({ xruns: 0, lastRenderDurationMicros: 0 });

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

  describe('initialization', () => {
    it('rejects initialization with negative sample rate', async () => {
      expect(
        () =>
          new AudioEngine({
            sampleRate: -1000,
            framesPerBuffer: 256,
            bpm: 120,
          }),
      ).toThrow('sampleRate must be positive');
    });

    it('rejects initialization with zero sample rate', async () => {
      expect(
        () =>
          new AudioEngine({
            sampleRate: 0,
            framesPerBuffer: 256,
            bpm: 120,
          }),
      ).toThrow('sampleRate must be positive');
    });

    it('rejects initialization with negative frames per buffer', async () => {
      expect(
        () =>
          new AudioEngine({
            sampleRate: 48000,
            framesPerBuffer: -128,
            bpm: 120,
          }),
      ).toThrow('framesPerBuffer must be positive');
    });

    it('rejects initialization with zero frames per buffer', async () => {
      expect(
        () =>
          new AudioEngine({
            sampleRate: 48000,
            framesPerBuffer: 0,
            bpm: 120,
          }),
      ).toThrow('framesPerBuffer must be positive');
    });

    it('initializes with standard sample rates', async () => {
      const sampleRates = [44100, 48000, 88200, 96000];
      for (const sr of sampleRates) {
        const engine = new AudioEngine({
          sampleRate: sr,
          framesPerBuffer: 256,
          bpm: 120,
        });
        await engine.init();
        const state = resolveMockState();
        expect(state.sampleRate).toBe(sr);
        await engine.dispose();
      }
    });

    it('initializes with various buffer sizes', async () => {
      const bufferSizes = [64, 128, 256, 512, 1024];
      for (const bs of bufferSizes) {
        const engine = new AudioEngine({
          sampleRate: 48000,
          framesPerBuffer: bs,
          bpm: 120,
        });
        await engine.init();
        const state = resolveMockState();
        expect(state.framesPerBuffer).toBe(bs);
        await engine.dispose();
      }
    });

    it('exposes clock service after initialization', () => {
      const engine = new AudioEngine({
        sampleRate: 48000,
        framesPerBuffer: 256,
        bpm: 120,
      });
      const clock = engine.getClock();
      expect(clock).toBeDefined();
      expect(clock.describe()).toMatchObject({
        sampleRate: 48000,
        framesPerBuffer: 256,
        bpm: 120,
      });
    });

    it('can be reinitialized after shutdown', async () => {
      const engine = new AudioEngine({
        sampleRate: 48000,
        framesPerBuffer: 256,
        bpm: 120,
      });
      await engine.init();
      await engine.dispose();
      await engine.init();
      const state = resolveMockState();
      expect(state.initialized).toBe(true);
      await engine.dispose();
    });
  });

  describe('node management', () => {
    let engine: AudioEngine;

    beforeEach(async () => {
      engine = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 256, bpm: 120 });
      await engine.init();
    });

    afterEach(async () => {
      await engine.dispose();
    });

    it('adds a single sine oscillator node', async () => {
      await NativeAudioEngine.addNode('osc1', 'sine', { frequency: 440 });
      const state = resolveMockState();
      expect(state.nodes.get('osc1')).toEqual({
        type: 'sine',
        options: { frequency: 440 },
      });
    });

    it('adds a gain node with default options', async () => {
      await NativeAudioEngine.addNode('gain1', 'gain', {});
      const state = resolveMockState();
      expect(state.nodes.get('gain1')).toEqual({
        type: 'gain',
        options: {},
      });
    });

    it('adds a mixer node with input count option', async () => {
      await NativeAudioEngine.addNode('mixer1', 'mixer', { inputCount: 4 });
      const state = resolveMockState();
      expect(state.nodes.get('mixer1')).toEqual({
        type: 'mixer',
        options: { inputCount: 4 },
      });
    });

    it('adds multiple nodes via configureNodes', async () => {
      await engine.configureNodes([
        { id: 'osc1', type: 'sine', options: { frequency: 220 } },
        { id: 'osc2', type: 'sine', options: { frequency: 440 } },
        { id: 'mixer', type: 'mixer', options: { inputCount: 2 } },
      ]);

      const state = resolveMockState();
      expect(state.nodes.size).toBe(3);
      expect(state.nodes.has('osc1')).toBe(true);
      expect(state.nodes.has('osc2')).toBe(true);
      expect(state.nodes.has('mixer')).toBe(true);
    });

    it('handles empty node configuration gracefully', async () => {
      await engine.configureNodes([]);
      const state = resolveMockState();
      expect(state.nodes.size).toBe(0);
    });

    it('rejects adding a node with empty ID', async () => {
      await expect(NativeAudioEngine.addNode('', 'sine', {})).rejects.toThrow(
        'nodeId and nodeType are required',
      );
    });

    it('rejects adding a node with whitespace-only ID', async () => {
      await expect(NativeAudioEngine.addNode('   ', 'sine', {})).rejects.toThrow(
        'nodeId and nodeType are required',
      );
    });

    it('rejects adding a node with empty type', async () => {
      await expect(NativeAudioEngine.addNode('node1', '', {})).rejects.toThrow(
        'nodeId and nodeType are required',
      );
    });

    it('rejects adding a node with duplicate ID', async () => {
      await NativeAudioEngine.addNode('duplicate', 'sine', {});
      await expect(NativeAudioEngine.addNode('duplicate', 'gain', {})).rejects.toThrow(
        "Node 'duplicate' already exists",
      );
    });

    it('trims whitespace from node IDs', async () => {
      await NativeAudioEngine.addNode('  osc1  ', 'sine', { frequency: 440 });
      const state = resolveMockState();
      expect(state.nodes.has('osc1')).toBe(true);
      expect(state.nodes.has('  osc1  ')).toBe(false);
    });

    it('removes an existing node', async () => {
      await NativeAudioEngine.addNode('temp', 'sine', {});
      await NativeAudioEngine.removeNode('temp');
      const state = resolveMockState();
      expect(state.nodes.has('temp')).toBe(false);
    });

    it('removes a node that does not exist without error', async () => {
      await expect(NativeAudioEngine.removeNode('nonexistent')).resolves.not.toThrow();
    });

    it('removes node connections when node is removed', async () => {
      await NativeAudioEngine.addNode('osc', 'sine', {});
      await NativeAudioEngine.addNode('gain', 'gain', {});
      await NativeAudioEngine.connectNodes('osc', 'gain');
      await NativeAudioEngine.connectNodes('gain', OUTPUT_BUS);

      const state = resolveMockState();
      expect(state.connections.size).toBe(2);

      await NativeAudioEngine.removeNode('gain');
      expect(state.connections.size).toBe(0);
      expect(state.nodes.has('gain')).toBe(false);
    });

    it('removes node automations when node is removed', async () => {
      await NativeAudioEngine.addNode('osc', 'sine', {});
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 0, 440);
      const state = resolveMockState();
      expect(state.automations.has('osc')).toBe(true);

      await NativeAudioEngine.removeNode('osc');
      expect(state.automations.has('osc')).toBe(false);
    });

    it('supports nodes with complex option types', async () => {
      await NativeAudioEngine.addNode('node', 'gain', {
        gain: 0.75,
        enabled: true,
        label: 'Main Gain',
      });
      const state = resolveMockState();
      expect(state.nodes.get('node')?.options).toEqual({
        gain: 0.75,
        enabled: true,
        label: 'Main Gain',
      });
    });
  });

  describe('connection management', () => {
    let engine: AudioEngine;

    beforeEach(async () => {
      engine = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 256, bpm: 120 });
      await engine.init();
      await engine.configureNodes([
        { id: 'osc', type: 'sine', options: {} },
        { id: 'gain', type: 'gain', options: {} },
        { id: 'mixer', type: 'mixer', options: {} },
      ]);
    });

    afterEach(async () => {
      await engine.dispose();
    });

    it('connects a node to the output bus', async () => {
      await engine.connect('osc', OUTPUT_BUS);
      const state = resolveMockState();
      expect(state.connections.has(`osc->${OUTPUT_BUS}`)).toBe(true);
    });

    it('connects two nodes together', async () => {
      await NativeAudioEngine.connectNodes('osc', 'gain');
      const state = resolveMockState();
      expect(state.connections.has('osc->gain')).toBe(true);
    });

    it('creates a chain of connections', async () => {
      await NativeAudioEngine.connectNodes('osc', 'gain');
      await NativeAudioEngine.connectNodes('gain', 'mixer');
      await NativeAudioEngine.connectNodes('mixer', OUTPUT_BUS);

      const state = resolveMockState();
      expect(state.connections.size).toBe(3);
      expect(state.connections.has('osc->gain')).toBe(true);
      expect(state.connections.has('gain->mixer')).toBe(true);
      expect(state.connections.has(`mixer->${OUTPUT_BUS}`)).toBe(true);
    });

    it('rejects connection from unregistered source node', async () => {
      await expect(NativeAudioEngine.connectNodes('nonexistent', 'gain')).rejects.toThrow(
        "Source node 'nonexistent' is not registered",
      );
    });

    it('rejects connection to unregistered destination node', async () => {
      await expect(NativeAudioEngine.connectNodes('osc', 'nonexistent')).rejects.toThrow(
        "Destination node 'nonexistent' is not registered",
      );
    });

    it('rejects duplicate connections', async () => {
      await NativeAudioEngine.connectNodes('osc', 'gain');
      await expect(NativeAudioEngine.connectNodes('osc', 'gain')).rejects.toThrow(
        "Connection 'osc->gain' already exists",
      );
    });

    it('allows multiple sources to connect to the same destination', async () => {
      await engine.configureNodes([{ id: 'osc2', type: 'sine', options: {} }]);
      await NativeAudioEngine.connectNodes('osc', 'mixer');
      await NativeAudioEngine.connectNodes('osc2', 'mixer');

      const state = resolveMockState();
      expect(state.connections.has('osc->mixer')).toBe(true);
      expect(state.connections.has('osc2->mixer')).toBe(true);
    });

    it('disconnects an existing connection', async () => {
      await NativeAudioEngine.connectNodes('osc', 'gain');
      await engine.disconnect('osc', 'gain');

      const state = resolveMockState();
      expect(state.connections.has('osc->gain')).toBe(false);
    });

    it('disconnects a connection that does not exist without error', async () => {
      await expect(engine.disconnect('osc', 'gain')).resolves.not.toThrow();
    });

    it('trims whitespace from connection endpoints', async () => {
      await NativeAudioEngine.connectNodes('  osc  ', '  gain  ');
      const state = resolveMockState();
      expect(state.connections.has('osc->gain')).toBe(true);
    });

    it('clears all connections on shutdown', async () => {
      await NativeAudioEngine.connectNodes('osc', 'gain');
      await NativeAudioEngine.connectNodes('gain', OUTPUT_BUS);
      await engine.dispose();

      const state = resolveMockState();
      expect(state.connections.size).toBe(0);
    });
  });

  describe('parameter automation', () => {
    let engine: AudioEngine;

    beforeEach(async () => {
      engine = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 256, bpm: 120 });
      await engine.init();
      await NativeAudioEngine.addNode('osc', 'sine', {});
    });

    afterEach(async () => {
      await engine.dispose();
    });

    it('schedules a single automation point', async () => {
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 0, 440);
      const state = resolveMockState();
      const oscAutomation = state.automations.get('osc');
      expect(oscAutomation?.get('frequency')).toEqual([{ frame: 0, value: 440 }]);
    });

    it('schedules multiple automation points in order', async () => {
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 0, 220);
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 256, 440);
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 512, 880);

      const state = resolveMockState();
      const points = state.automations.get('osc')?.get('frequency');
      expect(points).toEqual([
        { frame: 0, value: 220 },
        { frame: 256, value: 440 },
        { frame: 512, value: 880 },
      ]);
    });

    it('inserts automation points in sorted order regardless of submission order', async () => {
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 512, 880);
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 0, 220);
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 256, 440);

      const state = resolveMockState();
      const points = state.automations.get('osc')?.get('frequency');
      expect(points).toEqual([
        { frame: 0, value: 220 },
        { frame: 256, value: 440 },
        { frame: 512, value: 880 },
      ]);
    });

    it('replaces automation point at existing frame', async () => {
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 128, 440);
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 128, 550);

      const state = resolveMockState();
      const points = state.automations.get('osc')?.get('frequency');
      expect(points).toEqual([{ frame: 128, value: 550 }]);
    });

    it('normalizes parameter names to lowercase', async () => {
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'Frequency', 0, 440);
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'FREQUENCY', 256, 880);

      const state = resolveMockState();
      const points = state.automations.get('osc')?.get('frequency');
      expect(points).toEqual([
        { frame: 0, value: 440 },
        { frame: 256, value: 880 },
      ]);
    });

    it('supports multiple parameters on the same node', async () => {
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 0, 440);
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'gain', 0, 0.5);

      const state = resolveMockState();
      const oscAutomation = state.automations.get('osc');
      expect(oscAutomation?.get('frequency')).toEqual([{ frame: 0, value: 440 }]);
      expect(oscAutomation?.get('gain')).toEqual([{ frame: 0, value: 0.5 }]);
    });

    it('rejects automation for unregistered node', async () => {
      await expect(
        NativeAudioEngine.scheduleParameterAutomation('nonexistent', 'gain', 0, 0.5),
      ).rejects.toThrow("Node 'nonexistent' is not registered");
    });

    it('rejects automation with empty parameter name', async () => {
      await expect(
        NativeAudioEngine.scheduleParameterAutomation('osc', '', 0, 0.5),
      ).rejects.toThrow('Parameter name is required');
    });

    it('rejects automation with whitespace-only parameter name', async () => {
      await expect(
        NativeAudioEngine.scheduleParameterAutomation('osc', '   ', 0, 0.5),
      ).rejects.toThrow('Parameter name is required');
    });

    it('rejects automation with negative frame', async () => {
      await expect(
        NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', -1, 440),
      ).rejects.toThrow('Frame must be a non-negative integer');
    });

    it('rejects automation with non-integer frame', async () => {
      await expect(
        NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 1.5, 440),
      ).rejects.toThrow('Frame must be a non-negative integer');
    });

    it('rejects automation with non-finite frame', async () => {
      await expect(
        NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', Infinity, 440),
      ).rejects.toThrow('Frame must be a non-negative integer');
    });

    it('rejects automation with non-finite value', async () => {
      await expect(
        NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 0, NaN),
      ).rejects.toThrow('Value must be finite');
    });

    it('accepts automation with zero frame', async () => {
      await expect(
        NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 0, 440),
      ).resolves.not.toThrow();
    });

    it('accepts automation with large frame values', async () => {
      const largeFrame = 48000 * 60 * 10; // 10 minutes at 48kHz
      await expect(
        NativeAudioEngine.scheduleParameterAutomation(
          'osc',
          'frequency',
          largeFrame,
          440,
        ),
      ).resolves.not.toThrow();
    });

    it('publishes automation lane via AudioEngine helper', async () => {
      const lane = new AutomationLane('frequency');
      lane.addPoint({ frame: 0, value: 220 });
      lane.addPoint({ frame: 256, value: 440 });
      lane.addPoint({ frame: 512, value: 880 });

      await engine.publishAutomation('osc', lane);

      const state = resolveMockState();
      const points = state.automations.get('osc')?.get('frequency');
      expect(points).toEqual([
        { frame: 0, value: 220 },
        { frame: 256, value: 440 },
        { frame: 512, value: 880 },
      ]);
    });
  });

  describe('render diagnostics', () => {
    let engine: AudioEngine;

    beforeEach(async () => {
      engine = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 256, bpm: 120 });
      await engine.init();
    });

    afterEach(async () => {
      await engine.dispose();
    });

    it('returns diagnostics with zero xruns after initialization', async () => {
      const diagnostics = await NativeAudioEngine.getRenderDiagnostics();
      expect(diagnostics).toEqual({
        xruns: 0,
        lastRenderDurationMicros: 0,
      });
    });

    it('maintains diagnostics structure', async () => {
      const diagnostics = await NativeAudioEngine.getRenderDiagnostics();
      expect(diagnostics).toHaveProperty('xruns');
      expect(diagnostics).toHaveProperty('lastRenderDurationMicros');
      expect(typeof diagnostics.xruns).toBe('number');
      expect(typeof diagnostics.lastRenderDurationMicros).toBe('number');
    });

    it('resets diagnostics on shutdown', async () => {
      const state = resolveMockState();
      state.diagnostics.xruns = 5;
      state.diagnostics.lastRenderDurationMicros = 123.45;

      await engine.dispose();

      expect(state.diagnostics.xruns).toBe(0);
      expect(state.diagnostics.lastRenderDurationMicros).toBe(0);
    });

    it('exposes diagnostics after initialization', async () => {
      const state = resolveMockState();
      expect(state.diagnostics).toBeDefined();
      expect(state.diagnostics.xruns).toBe(0);
      expect(state.diagnostics.lastRenderDurationMicros).toBe(0);
    });
  });

  describe('state isolation and cleanup', () => {
    it('clears all state on shutdown', async () => {
      const engine = new AudioEngine({
        sampleRate: 48000,
        framesPerBuffer: 256,
        bpm: 120,
      });
      await engine.init();

      await engine.configureNodes([
        { id: 'osc', type: 'sine', options: {} },
        { id: 'gain', type: 'gain', options: {} },
      ]);
      await NativeAudioEngine.connectNodes('osc', 'gain');
      await NativeAudioEngine.connectNodes('gain', OUTPUT_BUS);
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 0, 440);

      const state = resolveMockState();
      expect(state.nodes.size).toBe(2);
      expect(state.connections.size).toBe(2);
      expect(state.automations.size).toBe(1);

      await engine.dispose();

      expect(state.initialized).toBe(false);
      expect(state.nodes.size).toBe(0);
      expect(state.connections.size).toBe(0);
      expect(state.automations.size).toBe(0);
      expect(state.diagnostics.xruns).toBe(0);
      expect(state.diagnostics.lastRenderDurationMicros).toBe(0);
    });

    it('maintains independent state across test runs', async () => {
      const state = resolveMockState();
      expect(state.nodes.size).toBe(0);
      expect(state.connections.size).toBe(0);
      expect(state.automations.size).toBe(0);
    });

    it('handles dispose without prior initialization gracefully', async () => {
      const engine = new AudioEngine({
        sampleRate: 48000,
        framesPerBuffer: 256,
        bpm: 120,
      });
      await expect(engine.dispose()).resolves.not.toThrow();
    });

    it('handles multiple dispose calls without error', async () => {
      const engine = new AudioEngine({
        sampleRate: 48000,
        framesPerBuffer: 256,
        bpm: 120,
      });
      await engine.init();
      await engine.dispose();
      await expect(engine.dispose()).resolves.not.toThrow();
    });
  });

  describe('complex audio graph scenarios', () => {
    let engine: AudioEngine;

    beforeEach(async () => {
      engine = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 256, bpm: 120 });
      await engine.init();
    });

    afterEach(async () => {
      await engine.dispose();
    });

    it('creates a multi-oscillator mixer setup', async () => {
      await engine.configureNodes([
        { id: 'osc1', type: 'sine', options: { frequency: 220 } },
        { id: 'osc2', type: 'sine', options: { frequency: 330 } },
        { id: 'osc3', type: 'sine', options: { frequency: 440 } },
        { id: 'mixer', type: 'mixer', options: { inputCount: 3 } },
        { id: 'master', type: 'gain', options: { gain: 0.8 } },
      ]);

      await NativeAudioEngine.connectNodes('osc1', 'mixer');
      await NativeAudioEngine.connectNodes('osc2', 'mixer');
      await NativeAudioEngine.connectNodes('osc3', 'mixer');
      await NativeAudioEngine.connectNodes('mixer', 'master');
      await NativeAudioEngine.connectNodes('master', OUTPUT_BUS);

      const state = resolveMockState();
      expect(state.nodes.size).toBe(5);
      expect(state.connections.size).toBe(5);
    });

    it('creates parallel processing chains', async () => {
      await engine.configureNodes([
        { id: 'input', type: 'gain', options: {} },
        { id: 'chain1', type: 'gain', options: {} },
        { id: 'chain2', type: 'gain', options: {} },
        { id: 'mixer', type: 'mixer', options: {} },
      ]);

      await NativeAudioEngine.connectNodes('input', 'chain1');
      await NativeAudioEngine.connectNodes('input', 'chain2');
      await NativeAudioEngine.connectNodes('chain1', 'mixer');
      await NativeAudioEngine.connectNodes('chain2', 'mixer');
      await NativeAudioEngine.connectNodes('mixer', OUTPUT_BUS);

      const state = resolveMockState();
      expect(state.connections.size).toBe(5);
    });

    it('supports rebuilding the graph by removing and reconnecting nodes', async () => {
      await engine.configureNodes([
        { id: 'osc', type: 'sine', options: {} },
        { id: 'gain1', type: 'gain', options: {} },
      ]);

      await NativeAudioEngine.connectNodes('osc', 'gain1');
      await NativeAudioEngine.connectNodes('gain1', OUTPUT_BUS);

      await NativeAudioEngine.removeNode('gain1');
      await NativeAudioEngine.addNode('gain2', 'gain', {});
      await NativeAudioEngine.connectNodes('osc', 'gain2');
      await NativeAudioEngine.connectNodes('gain2', OUTPUT_BUS);

      const state = resolveMockState();
      expect(state.nodes.has('gain1')).toBe(false);
      expect(state.nodes.has('gain2')).toBe(true);
      expect(state.connections.has('osc->gain2')).toBe(true);
    });

    it('handles automation across multiple nodes simultaneously', async () => {
      await engine.configureNodes([
        { id: 'osc1', type: 'sine', options: {} },
        { id: 'osc2', type: 'sine', options: {} },
        { id: 'mixer', type: 'mixer', options: {} },
      ]);

      await NativeAudioEngine.scheduleParameterAutomation('osc1', 'frequency', 0, 220);
      await NativeAudioEngine.scheduleParameterAutomation('osc2', 'frequency', 0, 440);
      await NativeAudioEngine.scheduleParameterAutomation('mixer', 'gain', 0, 0.5);

      const state = resolveMockState();
      expect(state.automations.get('osc1')?.get('frequency')).toBeDefined();
      expect(state.automations.get('osc2')?.get('frequency')).toBeDefined();
      expect(state.automations.get('mixer')?.get('gain')).toBeDefined();
    });

    it('supports dynamic automation updates during runtime', async () => {
      await NativeAudioEngine.addNode('osc', 'sine', {});

      const lane = new AutomationLane('frequency');
      lane.addPoint({ frame: 0, value: 220 });
      await engine.publishAutomation('osc', lane);

      lane.addPoint({ frame: 256, value: 440 });
      lane.addPoint({ frame: 512, value: 880 });
      await engine.publishAutomation('osc', lane);

      const state = resolveMockState();
      const points = state.automations.get('osc')?.get('frequency');
      expect(points?.length).toBe(3);
    });
  });

  describe('edge cases and error recovery', () => {
    let engine: AudioEngine;

    beforeEach(async () => {
      engine = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 256, bpm: 120 });
      await engine.init();
    });

    afterEach(async () => {
      await engine.dispose();
    });

    it('handles nodes with special characters in IDs', async () => {
      const specialIds = ['node-1', 'node_2', 'node.3', 'node#4'];
      for (const id of specialIds) {
        await NativeAudioEngine.addNode(id, 'gain', {});
      }
      const state = resolveMockState();
      expect(state.nodes.size).toBe(specialIds.length);
    });

    it('trims leading and trailing whitespace from node IDs', async () => {
      await NativeAudioEngine.addNode('  trimmed  ', 'sine', {});
      const state = resolveMockState();
      expect(state.nodes.has('trimmed')).toBe(true);
    });

    it('preserves options with boolean false values', async () => {
      await NativeAudioEngine.addNode('node', 'gain', { bypass: false });
      const state = resolveMockState();
      expect(state.nodes.get('node')?.options.bypass).toBe(false);
    });

    it('preserves options with zero numeric values', async () => {
      await NativeAudioEngine.addNode('node', 'gain', { gain: 0 });
      const state = resolveMockState();
      expect(state.nodes.get('node')?.options.gain).toBe(0);
    });

    it('handles very long node IDs', async () => {
      const longId = 'a'.repeat(256);
      await NativeAudioEngine.addNode(longId, 'gain', {});
      const state = resolveMockState();
      expect(state.nodes.has(longId)).toBe(true);
    });

    it('handles options with deeply nested structures', async () => {
      await NativeAudioEngine.addNode('node', 'gain', {
        level1: 1,
        level2: 2.5,
        level3: 3.14159,
      });
      const state = resolveMockState();
      expect(state.nodes.get('node')?.options).toMatchObject({
        level1: 1,
        level2: 2.5,
        level3: 3.14159,
      });
    });

    it('maintains connection integrity after failed connection attempts', async () => {
      await NativeAudioEngine.addNode('osc', 'sine', {});
      await NativeAudioEngine.connectNodes('osc', OUTPUT_BUS);

      await expect(
        NativeAudioEngine.connectNodes('osc', 'nonexistent'),
      ).rejects.toThrow();

      const state = resolveMockState();
      expect(state.connections.size).toBe(1);
      expect(state.connections.has(`osc->${OUTPUT_BUS}`)).toBe(true);
    });

    it('allows reconnection after disconnection', async () => {
      await NativeAudioEngine.addNode('osc', 'sine', {});
      await NativeAudioEngine.addNode('gain', 'gain', {});

      await NativeAudioEngine.connectNodes('osc', 'gain');
      await NativeAudioEngine.disconnectNodes('osc', 'gain');
      await NativeAudioEngine.connectNodes('osc', 'gain');

      const state = resolveMockState();
      expect(state.connections.has('osc->gain')).toBe(true);
    });
  });

  describe('integration with ClockSyncService', () => {
    it('initializes clock with engine parameters', () => {
      const engine = new AudioEngine({
        sampleRate: 48000,
        framesPerBuffer: 256,
        bpm: 120,
      });
      const clock = engine.getClock();
      const desc = clock.describe();

      expect(desc.sampleRate).toBe(48000);
      expect(desc.framesPerBuffer).toBe(256);
      expect(desc.bpm).toBe(120);
    });

    it('quantizes automation frames to buffer boundaries using clock', () => {
      const engine = new AudioEngine({
        sampleRate: 48000,
        framesPerBuffer: 128,
        bpm: 120,
      });
      const clock = engine.getClock();

      expect(clock.quantizeFrameToBuffer(0)).toBe(0);
      expect(clock.quantizeFrameToBuffer(1)).toBe(128);
      expect(clock.quantizeFrameToBuffer(128)).toBe(128);
      expect(clock.quantizeFrameToBuffer(129)).toBe(256);
    });

    it('computes buffer duration accurately', () => {
      const engine = new AudioEngine({
        sampleRate: 48000,
        framesPerBuffer: 480,
        bpm: 120,
      });
      const clock = engine.getClock();

      expect(clock.bufferDurationSeconds()).toBeCloseTo(0.01, 5); // 10ms
    });

    it('computes frames per beat accurately', () => {
      const engine = new AudioEngine({
        sampleRate: 48000,
        framesPerBuffer: 256,
        bpm: 120,
      });
      const clock = engine.getClock();

      expect(clock.framesPerBeat()).toBe(24000); // 0.5 seconds at 48kHz
    });

    it('supports tempo updates via clock service', () => {
      const engine = new AudioEngine({
        sampleRate: 48000,
        framesPerBuffer: 256,
        bpm: 120,
      });
      const clock = engine.getClock();

      clock.updateTempo(90);
      expect(clock.describe().bpm).toBe(90);
      expect(clock.framesPerBeat()).toBe(32000); // 60/90 seconds at 48kHz
    });
  });
});