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
});
