import { AutomationLane, ClockSyncService, publishAutomationLane } from '../Automation';
import { NativeAudioEngine } from '../NativeAudioEngine';
import { NativeModules } from 'react-native';

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

describe('AutomationLane', () => {
  it('keeps automation points sorted without duplication', () => {
    const lane = new AutomationLane('gain');
    lane.addPoint({ frame: 128, value: 0.5 });
    lane.addPoint({ frame: 64, value: 0.25 });
    lane.addPoint({ frame: 256, value: 0.75 });
    lane.addPoint({ frame: 128, value: 0.6 });

    expect(lane.toPayload()).toEqual({
      parameter: 'gain',
      points: [
        { frame: 64, value: 0.25 },
        { frame: 128, value: 0.6 },
        { frame: 256, value: 0.75 },
      ],
    });
  });

  it('rejects non-integer frames', () => {
    const lane = new AutomationLane('gain');
    expect(() => lane.addPoint({ frame: 1.5, value: 0.25 })).toThrow(
      'Automation frame must be an integer',
    );
  });

  it('rejects negative frames', () => {
    const lane = new AutomationLane('gain');
    expect(() => lane.addPoint({ frame: -10, value: 0.25 })).toThrow(
      'Automation frame cannot be negative',
    );
  });

  it('allows zero frame values', () => {
    const lane = new AutomationLane('gain');
    expect(() => lane.addPoint({ frame: 0, value: 1.0 })).not.toThrow();
    expect(lane.toPayload().points).toHaveLength(1);
  });

  it('preserves insertion order when frames are added in sequence', () => {
    const lane = new AutomationLane('volume');
    lane.addPoint({ frame: 0, value: 0.0 });
    lane.addPoint({ frame: 100, value: 0.3 });
    lane.addPoint({ frame: 200, value: 0.7 });
    lane.addPoint({ frame: 300, value: 1.0 });

    expect(lane.toPayload().points.map(p => p.frame)).toEqual([0, 100, 200, 300]);
  });

  it('maintains correct order when adding at the beginning', () => {
    const lane = new AutomationLane('pan');
    lane.addPoint({ frame: 100, value: 0.5 });
    lane.addPoint({ frame: 50, value: 0.25 });
    lane.addPoint({ frame: 10, value: 0.1 });

    expect(lane.toPayload().points.map(p => p.frame)).toEqual([10, 50, 100]);
  });

  it('maintains correct order when adding at the end', () => {
    const lane = new AutomationLane('frequency');
    lane.addPoint({ frame: 10, value: 220 });
    lane.addPoint({ frame: 50, value: 440 });
    lane.addPoint({ frame: 100, value: 880 });

    expect(lane.toPayload().points.map(p => p.frame)).toEqual([10, 50, 100]);
  });

  it('maintains correct order when adding in the middle', () => {
    const lane = new AutomationLane('cutoff');
    lane.addPoint({ frame: 0, value: 100 });
    lane.addPoint({ frame: 200, value: 500 });
    lane.addPoint({ frame: 100, value: 300 });

    expect(lane.toPayload().points.map(p => p.frame)).toEqual([0, 100, 200]);
  });

  it('clears all points', () => {
    const lane = new AutomationLane('resonance');
    lane.addPoint({ frame: 0, value: 0.1 });
    lane.addPoint({ frame: 100, value: 0.5 });
    lane.addPoint({ frame: 200, value: 0.9 });

    expect(lane.toPayload().points).toHaveLength(3);

    lane.clear();
    expect(lane.toPayload().points).toHaveLength(0);
  });

  it('allows re-adding points after clear', () => {
    const lane = new AutomationLane('amplitude');
    lane.addPoint({ frame: 0, value: 0.5 });
    lane.clear();
    lane.addPoint({ frame: 100, value: 0.8 });

    expect(lane.toPayload().points).toEqual([{ frame: 100, value: 0.8 }]);
  });

  it('accepts very large frame numbers', () => {
    const lane = new AutomationLane('delay');
    const largeFrame = 2147483647;
    lane.addPoint({ frame: largeFrame, value: 1.0 });

    expect(lane.toPayload().points).toEqual([{ frame: largeFrame, value: 1.0 }]);
  });

  it('handles many automation points efficiently', () => {
    const lane = new AutomationLane('modulation');
    const pointCount = 1000;

    for (let i = 0; i < pointCount; i++) {
      lane.addPoint({ frame: i * 10, value: Math.random() });
    }

    expect(lane.toPayload().points).toHaveLength(pointCount);
  });

  it('preserves floating point precision in values', () => {
    const lane = new AutomationLane('precise');
    const preciseValue = 0.123456789012345;
    lane.addPoint({ frame: 0, value: preciseValue });

    expect(lane.toPayload().points[0].value).toBe(preciseValue);
  });

  it('allows negative values', () => {
    const lane = new AutomationLane('bipolar');
    lane.addPoint({ frame: 0, value: -1.0 });
    lane.addPoint({ frame: 100, value: 0.0 });
    lane.addPoint({ frame: 200, value: 1.0 });

    expect(lane.toPayload().points.map(p => p.value)).toEqual([-1.0, 0.0, 1.0]);
  });

  it('includes parameter name in payload', () => {
    const paramName = 'customParameter';
    const lane = new AutomationLane(paramName);
    lane.addPoint({ frame: 0, value: 0.5 });

    expect(lane.toPayload().parameter).toBe(paramName);
  });
});

describe('ClockSyncService', () => {
  it('quantizes automation frame to buffer boundaries deterministically', () => {
    const clock = new ClockSyncService(48000, 128, 120);
    const frames = [1, 128, 129, 255, 256, 257, 4095, 4096];
    const quantized = frames.map((frame) => clock.quantizeFrameToBuffer(frame));

    expect(quantized).toEqual([128, 128, 256, 256, 256, 384, 4096, 4096]);
  });

  it('rejects fractional frames when quantizing', () => {
    const clock = new ClockSyncService(48000, 128, 120);
    expect(() => clock.quantizeFrameToBuffer(1.2)).toThrow('Frame must be an integer');
  });

  it('rejects negative frames when quantizing', () => {
    const clock = new ClockSyncService(48000, 128, 120);
    expect(() => clock.quantizeFrameToBuffer(-100)).toThrow('Frame must be non-negative');
  });

  it('returns zero for zero frame', () => {
    const clock = new ClockSyncService(48000, 128, 120);
    expect(clock.quantizeFrameToBuffer(0)).toBe(0);
  });

  it('updates tempo revision on tempo change', () => {
    const clock = new ClockSyncService(48000, 128, 120);
    expect(clock.describe()).toMatchObject({ tempoRevision: 0 });
    clock.updateTempo(90);
    expect(clock.describe()).toMatchObject({ bpm: 90, tempoRevision: 1 });
  });

  it('bumps revision when the buffer size changes', () => {
    const clock = new ClockSyncService(48000, 128, 120);
    clock.updateBufferSize(256);
    expect(clock.describe()).toMatchObject({ framesPerBuffer: 256, tempoRevision: 1 });
  });

  it('increments revision on multiple changes', () => {
    const clock = new ClockSyncService(48000, 128, 120);
    clock.updateTempo(100);
    expect(clock.describe().tempoRevision).toBe(1);
    clock.updateTempo(110);
    expect(clock.describe().tempoRevision).toBe(2);
    clock.updateBufferSize(256);
    expect(clock.describe().tempoRevision).toBe(3);
  });

  it('computes frames per beat consistently', () => {
    const clock = new ClockSyncService(48000, 256, 60);
    expect(clock.framesPerBeat()).toBeCloseTo(48000);
  });

  it('calculates different frames per beat for different tempos', () => {
    const clock1 = new ClockSyncService(48000, 256, 120);
    const clock2 = new ClockSyncService(48000, 256, 60);
    
    expect(clock1.framesPerBeat()).toBe(24000); // 120 BPM: (48000 * 60) / 120
    expect(clock2.framesPerBeat()).toBe(48000); // 60 BPM: (48000 * 60) / 60
  });

  it('calculates buffer duration correctly', () => {
    const clock = new ClockSyncService(48000, 480, 120);
    expect(clock.bufferDurationSeconds()).toBe(0.01); // 480 / 48000 = 0.01s
  });

  it('calculates buffer duration for different sample rates', () => {
    const clock44k = new ClockSyncService(44100, 441, 120);
    const clock48k = new ClockSyncService(48000, 480, 120);
    
    expect(clock44k.bufferDurationSeconds()).toBe(0.01);
    expect(clock48k.bufferDurationSeconds()).toBe(0.01);
  });

  it('rejects invalid sample rate', () => {
    expect(() => new ClockSyncService(0, 128, 120)).toThrow('Invalid sample rate');
    expect(() => new ClockSyncService(-48000, 128, 120)).toThrow('Invalid sample rate');
  });

  it('rejects invalid buffer size', () => {
    expect(() => new ClockSyncService(48000, 0, 120)).toThrow('Invalid buffer size');
    expect(() => new ClockSyncService(48000, -128, 120)).toThrow('Invalid buffer size');
  });

  it('rejects invalid tempo when updating', () => {
    const clock = new ClockSyncService(48000, 128, 120);
    expect(() => clock.updateTempo(0)).toThrow('Tempo must be positive');
    expect(() => clock.updateTempo(-60)).toThrow('Tempo must be positive');
  });

  it('rejects invalid buffer size when updating', () => {
    const clock = new ClockSyncService(48000, 128, 120);
    expect(() => clock.updateBufferSize(0)).toThrow('Buffer size must be positive');
    expect(() => clock.updateBufferSize(-128)).toThrow('Buffer size must be positive');
  });

  it('preserves state through describe method', () => {
    const clock = new ClockSyncService(44100, 512, 140);
    const described = clock.describe();
    
    expect(described).toEqual({
      sampleRate: 44100,
      framesPerBuffer: 512,
      bpm: 140,
      tempoRevision: 0,
    });
  });

  it('updates frames per beat calculation after tempo change', () => {
    const clock = new ClockSyncService(48000, 256, 120);
    const initialFrames = clock.framesPerBeat();
    
    clock.updateTempo(60);
    const updatedFrames = clock.framesPerBeat();
    
    expect(initialFrames).toBe(24000);
    expect(updatedFrames).toBe(48000);
  });

  it('updates buffer duration after buffer size change', () => {
    const clock = new ClockSyncService(48000, 256, 120);
    const initialDuration = clock.bufferDurationSeconds();
    
    clock.updateBufferSize(512);
    const updatedDuration = clock.bufferDurationSeconds();
    
    expect(initialDuration).toBeCloseTo(256 / 48000);
    expect(updatedDuration).toBeCloseTo(512 / 48000);
  });

  it('handles very high sample rates', () => {
    const clock = new ClockSyncService(192000, 1024, 120);
    expect(clock.framesPerBeat()).toBe(96000);
    expect(clock.bufferDurationSeconds()).toBeCloseTo(1024 / 192000);
  });

  it('handles extreme tempos', () => {
    const slowClock = new ClockSyncService(48000, 256, 20);
    const fastClock = new ClockSyncService(48000, 256, 300);
    
    expect(slowClock.framesPerBeat()).toBe(144000);
    expect(fastClock.framesPerBeat()).toBe(9600);
  });
});

describe('publishAutomationLane', () => {
  beforeEach(async () => {
    const state = resolveMockState();
    state.initialized = false;
    state.sampleRate = 0;
    state.framesPerBuffer = 0;
    state.nodes.clear();
    state.connections.clear();
    state.diagnostics.xruns = 0;
    state.diagnostics.lastRenderDurationMicros = 0;
    state.automations.clear();

    state.initialized = true;
    state.sampleRate = 48000;
    state.framesPerBuffer = 256;
    await NativeAudioEngine.addNode('testNode', 'sine', {});
  });

  it('publishes single automation point', async () => {
    const lane = new AutomationLane('frequency');
    lane.addPoint({ frame: 0, value: 440 });
    
    await publishAutomationLane('testNode', lane);
    
    const state = resolveMockState();
    const automation = state.automations.get('testNode')?.get('frequency');
    expect(automation).toEqual([{ frame: 0, value: 440 }]);
  });

  it('publishes multiple automation points', async () => {
    const lane = new AutomationLane('gain');
    lane.addPoint({ frame: 0, value: 0.0 });
    lane.addPoint({ frame: 100, value: 0.5 });
    lane.addPoint({ frame: 200, value: 1.0 });
    
    await publishAutomationLane('testNode', lane);
    
    const state = resolveMockState();
    const automation = state.automations.get('testNode')?.get('gain');
    expect(automation).toHaveLength(3);
  });

  it('publishes empty lane without error', async () => {
    const lane = new AutomationLane('volume');
    
    await expect(publishAutomationLane('testNode', lane)).resolves.not.toThrow();
    
    const state = resolveMockState();
    const automation = state.automations.get('testNode')?.get('volume');
    expect(automation).toBeUndefined();
  });

  it('rejects publishing to non-existent node', async () => {
    const lane = new AutomationLane('frequency');
    lane.addPoint({ frame: 0, value: 440 });
    
    await expect(publishAutomationLane('nonexistent', lane)).rejects.toThrow();
  });

  it('publishes concurrent automation lanes', async () => {
    const lane1 = new AutomationLane('frequency');
    lane1.addPoint({ frame: 0, value: 440 });
    
    const lane2 = new AutomationLane('gain');
    lane2.addPoint({ frame: 0, value: 0.8 });
    
    await Promise.all([
      publishAutomationLane('testNode', lane1),
      publishAutomationLane('testNode', lane2),
    ]);
    
    const state = resolveMockState();
    expect(state.automations.get('testNode')?.get('frequency')).toBeDefined();
    expect(state.automations.get('testNode')?.get('gain')).toBeDefined();
  });

  it('overwrites existing automation for same parameter', async () => {
    const lane1 = new AutomationLane('frequency');
    lane1.addPoint({ frame: 0, value: 440 });
    await publishAutomationLane('testNode', lane1);
    
    const lane2 = new AutomationLane('frequency');
    lane2.addPoint({ frame: 100, value: 880 });
    await publishAutomationLane('testNode', lane2);
    
    const state = resolveMockState();
    const automation = state.automations.get('testNode')?.get('frequency');
    expect(automation?.map(p => p.frame)).toContain(0);
    expect(automation?.map(p => p.frame)).toContain(100);
  });

  it('publishes large automation lanes efficiently', async () => {
    const lane = new AutomationLane('modulation');
    
    for (let i = 0; i < 1000; i++) {
      lane.addPoint({ frame: i * 10, value: Math.sin(i / 100) });
    }
    
    await expect(publishAutomationLane('testNode', lane)).resolves.not.toThrow();
    
    const state = resolveMockState();
    const automation = state.automations.get('testNode')?.get('modulation');
    expect(automation).toHaveLength(1000);
  });
});