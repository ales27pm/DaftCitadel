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

  describe('initialization and teardown', () => {
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

    it('initializes with different sample rates and buffer sizes', async () => {
      const engine = new AudioEngine({ sampleRate: 44100, framesPerBuffer: 512, bpm: 140 });
      await engine.init();
      
      const state = resolveMockState();
      expect(state.sampleRate).toBe(44100);
      expect(state.framesPerBuffer).toBe(512);
      
      await engine.dispose();
    });

    it('rejects invalid sample rates', () => {
      expect(() => new AudioEngine({ sampleRate: 0, framesPerBuffer: 256, bpm: 120 }))
        .toThrow('sampleRate must be positive');
      expect(() => new AudioEngine({ sampleRate: -48000, framesPerBuffer: 256, bpm: 120 }))
        .toThrow('sampleRate must be positive');
    });

    it('rejects invalid buffer sizes', () => {
      expect(() => new AudioEngine({ sampleRate: 48000, framesPerBuffer: 0, bpm: 120 }))
        .toThrow('framesPerBuffer must be positive');
      expect(() => new AudioEngine({ sampleRate: 48000, framesPerBuffer: -256, bpm: 120 }))
        .toThrow('framesPerBuffer must be positive');
    });

    it('cleans up all state on shutdown', async () => {
      const engine = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 256, bpm: 120 });
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

    it('adds multiple nodes with different types', async () => {
      await engine.configureNodes([
        { id: 'osc', type: 'sine', options: { frequency: 220 } },
        { id: 'gain', type: 'gain', options: { gain: 0.8 } },
        { id: 'mixer', type: 'mixer', options: { inputCount: 4 } },
      ]);

      const state = resolveMockState();
      expect(state.nodes.size).toBe(3);
      expect(state.nodes.get('osc')?.type).toBe('sine');
      expect(state.nodes.get('gain')?.type).toBe('gain');
      expect(state.nodes.get('mixer')?.type).toBe('mixer');
    });

    it('rejects adding duplicate node IDs', async () => {
      await engine.configureNodes([{ id: 'osc', type: 'sine' }]);
      
      await expect(NativeAudioEngine.addNode('osc', 'gain', {}))
        .rejects.toThrow(`Node 'osc' already exists`);
    });

    it('rejects adding nodes with empty IDs', async () => {
      await expect(NativeAudioEngine.addNode('', 'sine', {}))
        .rejects.toThrow('nodeId and nodeType are required');
      await expect(NativeAudioEngine.addNode('  ', 'sine', {}))
        .rejects.toThrow('nodeId and nodeType are required');
    });

    it('rejects adding nodes with empty types', async () => {
      await expect(NativeAudioEngine.addNode('osc', '', {}))
        .rejects.toThrow('nodeId and nodeType are required');
      await expect(NativeAudioEngine.addNode('osc', '  ', {}))
        .rejects.toThrow('nodeId and nodeType are required');
    });

    it('preserves node options during configuration', async () => {
      await engine.configureNodes([
        { 
          id: 'osc', 
          type: 'sine', 
          options: { 
            frequency: 440, 
            phase: 0.5,
            amplitude: 0.8
          } 
        },
      ]);

      const state = resolveMockState();
      const node = state.nodes.get('osc');
      expect(node?.options).toEqual({
        frequency: 440,
        phase: 0.5,
        amplitude: 0.8,
      });
    });

    it('removes nodes and cleans up connections', async () => {
      await engine.configureNodes([
        { id: 'osc', type: 'sine' },
        { id: 'gain', type: 'gain' },
      ]);
      await engine.connect('osc', 'gain');
      await engine.connect('gain', OUTPUT_BUS);

      const state = resolveMockState();
      expect(state.nodes.size).toBe(2);
      expect(state.connections.size).toBe(2);

      await NativeAudioEngine.removeNode('osc');
      expect(state.nodes.size).toBe(1);
      expect(state.connections.has('osc->gain')).toBe(false);
      expect(state.connections.has('gain->__output__')).toBe(true);
    });

    it('removes nodes and cleans up automation', async () => {
      await engine.configureNodes([{ id: 'osc', type: 'sine' }]);
      
      const lane = new AutomationLane('frequency');
      lane.addPoint({ frame: 0, value: 440 });
      await engine.publishAutomation('osc', lane);

      const state = resolveMockState();
      expect(state.automations.has('osc')).toBe(true);

      await NativeAudioEngine.removeNode('osc');
      expect(state.automations.has('osc')).toBe(false);
    });

    it('handles removing non-existent nodes gracefully', async () => {
      await expect(NativeAudioEngine.removeNode('nonexistent')).resolves.not.toThrow();
      
      const state = resolveMockState();
      expect(state.nodes.size).toBe(0);
    });

    it('trims whitespace from node IDs', async () => {
      await NativeAudioEngine.addNode('  osc  ', 'sine', {});
      
      const state = resolveMockState();
      expect(state.nodes.has('osc')).toBe(true);
      expect(state.nodes.has('  osc  ')).toBe(false);
    });
  });

  describe('connection management', () => {
    let engine: AudioEngine;

    beforeEach(async () => {
      engine = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 256, bpm: 120 });
      await engine.init();
      await engine.configureNodes([
        { id: 'osc1', type: 'sine' },
        { id: 'osc2', type: 'sine' },
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
      expect(state.connections.has('osc1->mixer')).toBe(true);
      expect(state.connections.has('osc2->mixer')).toBe(true);
      expect(state.connections.has('mixer->__output__')).toBe(true);
    });

    it('rejects connections from non-existent source nodes', async () => {
      await expect(engine.connect('nonexistent', 'gain'))
        .rejects.toThrow(`Source node 'nonexistent' is not registered`);
    });

    it('rejects connections to non-existent destination nodes', async () => {
      await expect(engine.connect('osc1', 'nonexistent'))
        .rejects.toThrow(`Destination node 'nonexistent' is not registered`);
    });

    it('allows connections to OUTPUT_BUS without registration', async () => {
      await expect(engine.connect('osc1', OUTPUT_BUS)).resolves.not.toThrow();
      
      const state = resolveMockState();
      expect(state.connections.has(`osc1->${OUTPUT_BUS}`)).toBe(true);
    });

    it('rejects duplicate connections', async () => {
      await engine.connect('osc1', 'gain');
      
      await expect(engine.connect('osc1', 'gain'))
        .rejects.toThrow(`Connection 'osc1->gain' already exists`);
    });

    it('disconnects nodes', async () => {
      await engine.connect('osc1', 'gain');
      await engine.connect('gain', OUTPUT_BUS);

      const state = resolveMockState();
      expect(state.connections.size).toBe(2);

      await engine.disconnect('osc1', 'gain');
      expect(state.connections.has('osc1->gain')).toBe(false);
      expect(state.connections.has('gain->__output__')).toBe(true);
      expect(state.connections.size).toBe(1);
    });

    it('handles disconnecting non-existent connections gracefully', async () => {
      await expect(engine.disconnect('osc1', 'gain')).resolves.not.toThrow();
      
      const state = resolveMockState();
      expect(state.connections.size).toBe(0);
    });

    it('trims whitespace from connection endpoints', async () => {
      await engine.connect('  osc1  ', '  gain  ');
      
      const state = resolveMockState();
      expect(state.connections.has('osc1->gain')).toBe(true);
    });
  });

  describe('parameter automation', () => {
    let engine: AudioEngine;

    beforeEach(async () => {
      engine = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 256, bpm: 120 });
      await engine.init();
      await engine.configureNodes([{ id: 'osc', type: 'sine' }]);
    });

    afterEach(async () => {
      await engine.dispose();
    });

    it('schedules single automation point', async () => {
      const lane = new AutomationLane('frequency');
      lane.addPoint({ frame: 0, value: 440 });
      await engine.publishAutomation('osc', lane);

      const state = resolveMockState();
      const automation = state.automations.get('osc')?.get('frequency');
      expect(automation).toEqual([{ frame: 0, value: 440 }]);
    });

    it('schedules multiple automation points in order', async () => {
      const lane = new AutomationLane('gain');
      lane.addPoint({ frame: 0, value: 0.0 });
      lane.addPoint({ frame: 100, value: 0.5 });
      lane.addPoint({ frame: 200, value: 1.0 });
      await engine.publishAutomation('osc', lane);

      const state = resolveMockState();
      const automation = state.automations.get('osc')?.get('gain');
      expect(automation).toEqual([
        { frame: 0, value: 0.0 },
        { frame: 100, value: 0.5 },
        { frame: 200, value: 1.0 },
      ]);
    });

    it('replaces automation points at the same frame', async () => {
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 100, 440);
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 100, 880);

      const state = resolveMockState();
      const automation = state.automations.get('osc')?.get('frequency');
      expect(automation).toEqual([{ frame: 100, value: 880 }]);
    });

    it('maintains sorted order when adding out-of-order points', async () => {
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 200, 880);
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 50, 440);
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 100, 660);

      const state = resolveMockState();
      const automation = state.automations.get('osc')?.get('frequency');
      expect(automation?.map(p => p.frame)).toEqual([50, 100, 200]);
    });

    it('handles multiple parameters on the same node', async () => {
      const freqLane = new AutomationLane('frequency');
      freqLane.addPoint({ frame: 0, value: 440 });
      await engine.publishAutomation('osc', freqLane);

      const gainLane = new AutomationLane('gain');
      gainLane.addPoint({ frame: 0, value: 0.8 });
      await engine.publishAutomation('osc', gainLane);

      const state = resolveMockState();
      const nodeAutomation = state.automations.get('osc');
      expect(nodeAutomation?.get('frequency')).toEqual([{ frame: 0, value: 440 }]);
      expect(nodeAutomation?.get('gain')).toEqual([{ frame: 0, value: 0.8 }]);
    });

    it('normalizes parameter names to lowercase', async () => {
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'FREQUENCY', 0, 440);
      await NativeAudioEngine.scheduleParameterAutomation('osc', 'Frequency', 100, 880);

      const state = resolveMockState();
      const automation = state.automations.get('osc')?.get('frequency');
      expect(automation).toEqual([
        { frame: 0, value: 440 },
        { frame: 100, value: 880 },
      ]);
    });

    it('rejects automation for non-existent nodes', async () => {
      await expect(NativeAudioEngine.scheduleParameterAutomation('nonexistent', 'gain', 0, 1.0))
        .rejects.toThrow(`Node 'nonexistent' is not registered`);
    });

    it('rejects automation with negative frame numbers', async () => {
      await expect(NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', -1, 440))
        .rejects.toThrow('Frame must be a non-negative integer');
    });

    it('rejects automation with non-integer frame numbers', async () => {
      await expect(NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 100.5, 440))
        .rejects.toThrow('Frame must be a non-negative integer');
    });

    it('rejects automation with non-finite values', async () => {
      await expect(NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 0, NaN))
        .rejects.toThrow('Value must be finite');
      await expect(NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 0, Infinity))
        .rejects.toThrow('Value must be finite');
      await expect(NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 0, -Infinity))
        .rejects.toThrow('Value must be finite');
    });

    it('rejects automation with empty parameter names', async () => {
      await expect(NativeAudioEngine.scheduleParameterAutomation('osc', '', 0, 440))
        .rejects.toThrow('Parameter name is required');
      await expect(NativeAudioEngine.scheduleParameterAutomation('osc', '  ', 0, 440))
        .rejects.toThrow('Parameter name is required');
    });

    it('accepts very large frame numbers', async () => {
      const largeFrame = 2147483647; // Max 32-bit signed int
      await expect(NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', largeFrame, 440))
        .resolves.not.toThrow();

      const state = resolveMockState();
      const automation = state.automations.get('osc')?.get('frequency');
      expect(automation).toEqual([{ frame: largeFrame, value: 440 }]);
    });
  });

  describe('diagnostics', () => {
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
      });
    });

    it('maintains diagnostic state across operations', async () => {
      await engine.configureNodes([{ id: 'osc', type: 'sine' }]);
      await engine.connect('osc', OUTPUT_BUS);

      const diagnostics = await NativeAudioEngine.getRenderDiagnostics();
      expect(diagnostics).toEqual({
        xruns: 0,
        lastRenderDurationMicros: 0,
      });
    });

    it('resets diagnostics on shutdown', async () => {
      const state = resolveMockState();
      state.diagnostics.xruns = 5;
      state.diagnostics.lastRenderDurationMicros = 123.45;

      await engine.dispose();

      expect(state.diagnostics.xruns).toBe(0);
      expect(state.diagnostics.lastRenderDurationMicros).toBe(0);
    });
  });

  describe('clock service integration', () => {
    it('provides access to clock service', () => {
      const engine = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 256, bpm: 120 });
      const clock = engine.getClock();
      
      expect(clock).toBeDefined();
      expect(clock.describe()).toEqual({
        sampleRate: 48000,
        framesPerBuffer: 256,
        bpm: 120,
        tempoRevision: 0,
      });
    });

    it('calculates correct frames per beat', () => {
      const engine = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 256, bpm: 120 });
      const clock = engine.getClock();
      
      // At 120 BPM and 48000 Hz: (48000 * 60) / 120 = 24000 frames per beat
      expect(clock.framesPerBeat()).toBe(24000);
    });

    it('calculates correct buffer duration', () => {
      const engine = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 256, bpm: 120 });
      const clock = engine.getClock();
      
      // 256 frames at 48000 Hz = 256/48000 ≈ 0.00533 seconds
      expect(clock.bufferDurationSeconds()).toBeCloseTo(0.00533, 5);
    });

    it('quantizes frames to buffer boundaries', () => {
      const engine = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 256, bpm: 120 });
      const clock = engine.getClock();
      
      expect(clock.quantizeFrameToBuffer(0)).toBe(0);
      expect(clock.quantizeFrameToBuffer(100)).toBe(256);
      expect(clock.quantizeFrameToBuffer(256)).toBe(256);
      expect(clock.quantizeFrameToBuffer(300)).toBe(512);
      expect(clock.quantizeFrameToBuffer(512)).toBe(512);
    });
  });

  describe('edge cases and concurrent operations', () => {
    let engine: AudioEngine;

    beforeEach(async () => {
      engine = new AudioEngine({ sampleRate: 48000, framesPerBuffer: 256, bpm: 120 });
      await engine.init();
    });

    afterEach(async () => {
      await engine.dispose();
    });

    it('handles concurrent node additions', async () => {
      const promises = [
        engine.configureNodes([{ id: 'osc1', type: 'sine' }]),
        engine.configureNodes([{ id: 'osc2', type: 'sine' }]),
        engine.configureNodes([{ id: 'gain1', type: 'gain' }]),
      ];

      await Promise.all(promises);

      const state = resolveMockState();
      expect(state.nodes.size).toBe(3);
    });

    it('handles concurrent automation scheduling', async () => {
      await engine.configureNodes([{ id: 'osc', type: 'sine' }]);

      const promises = [
        NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 0, 220),
        NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 100, 440),
        NativeAudioEngine.scheduleParameterAutomation('osc', 'frequency', 200, 880),
      ];

      await Promise.all(promises);

      const state = resolveMockState();
      const automation = state.automations.get('osc')?.get('frequency');
      expect(automation?.length).toBe(3);
    });

    it('handles configuring empty node array', async () => {
      await expect(engine.configureNodes([])).resolves.not.toThrow();
      
      const state = resolveMockState();
      expect(state.nodes.size).toBe(0);
    });

    it('handles very long node IDs', async () => {
      const longId = 'x'.repeat(1000);
      await expect(engine.configureNodes([{ id: longId, type: 'sine' }]))
        .resolves.not.toThrow();
      
      const state = resolveMockState();
      expect(state.nodes.has(longId)).toBe(true);
    });

    it('handles special characters in node IDs', async () => {
      const specialId = 'osc-1_main.channel@2';
      await expect(engine.configureNodes([{ id: specialId, type: 'sine' }]))
        .resolves.not.toThrow();
      
      const state = resolveMockState();
      expect(state.nodes.has(specialId)).toBe(true);
    });

    it('handles publishing empty automation lane', async () => {
      await engine.configureNodes([{ id: 'osc', type: 'sine' }]);
      
      const emptyLane = new AutomationLane('frequency');
      await expect(engine.publishAutomation('osc', emptyLane)).resolves.not.toThrow();
      
      const state = resolveMockState();
      const automation = state.automations.get('osc')?.get('frequency');
      expect(automation).toBeUndefined();
    });
  });
});