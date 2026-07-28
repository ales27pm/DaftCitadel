import type {
  NativeGraphApplyRequest,
  NativeGraphDescription,
} from '../NativeAudioEngine';

jest.mock('../webAudioSupport', () => ({
  createWebAudioContext: jest.fn(),
  isWebAudioEngineAvailable: jest.fn(() => true),
}));

import { AudioEngine, OUTPUT_BUS } from '../AudioEngine.web';
import { createWebAudioContext } from '../webAudioSupport';

class FakeAudioParam {
  public value = 1;
  public readonly events: Array<{ kind: string; value?: number; time: number }> = [];

  public cancelScheduledValues(time: number): void {
    this.events.push({ kind: 'cancel', time });
  }

  public setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ kind: 'set', time, value });
  }

  public linearRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ kind: 'ramp', time, value });
  }
}

class FakeAudioNode {
  public readonly connections = new Set<unknown>();
  public disconnectCount = 0;

  public connect(destination: unknown): unknown {
    this.connections.add(destination);
    return destination;
  }

  public disconnect(destination?: unknown): void {
    this.disconnectCount += 1;
    if (destination === undefined) {
      this.connections.clear();
      return;
    }
    this.connections.delete(destination);
  }
}

class FakeGainNode extends FakeAudioNode {
  public readonly gain = new FakeAudioParam();
}

class FakeBufferSourceNode extends FakeAudioNode {
  public buffer: AudioBuffer | null = null;
  public startCount = 0;
  public stopCount = 0;

  public start(): void {
    this.startCount += 1;
  }

  public stop(): void {
    this.stopCount += 1;
  }
}

class FakeAudioContext {
  public state: AudioContextState = 'suspended';
  public currentTime = 0;
  public readonly destination = new FakeAudioNode();
  public readonly gainNodes: FakeGainNode[] = [];
  public readonly bufferSources: FakeBufferSourceNode[] = [];

  public createGain(): GainNode {
    const node = new FakeGainNode();
    this.gainNodes.push(node);
    return node as unknown as GainNode;
  }

  public createBufferSource(): AudioBufferSourceNode {
    const source = new FakeBufferSourceNode();
    this.bufferSources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  public async resume(): Promise<void> {
    this.state = 'running';
  }

  public async close(): Promise<void> {
    this.state = 'closed';
  }
}

type RequestGraph = {
  nodes: Array<{
    id: string;
    type: string;
    options?: Record<string, number | string | boolean>;
  }>;
  connections: Array<{ source: string; destination: string }>;
};

const requestFor = (
  transactionId: string,
  description: NativeGraphDescription,
  graph: RequestGraph,
): NativeGraphApplyRequest =>
  ({
    transactionId,
    expectedGeneration: description.generation,
    expectedRouteEpoch: description.routeEpoch,
    expectedEngineInstance: description.engineInstance,
    baseGeneration: description.generation,
    baseRouteEpoch: description.routeEpoch,
    baseEngineInstance: description.engineInstance,
    nodes: graph.nodes,
    connections: graph.connections,
  }) as unknown as NativeGraphApplyRequest;

const playableGraph: RequestGraph = {
  nodes: [
    { id: 'osc', type: 'sine', options: { gain: 0.5 } },
    { id: 'master', type: 'gain', options: { gain: 0.8 } },
  ],
  connections: [
    { source: 'osc', destination: 'master' },
    { source: 'master', destination: OUTPUT_BUS },
  ],
};

describe('Web AudioEngine graph transactions', () => {
  let context: FakeAudioContext;
  let engine: AudioEngine;

  beforeEach(async () => {
    context = new FakeAudioContext();
    (createWebAudioContext as jest.Mock).mockReturnValue(
      context as unknown as AudioContext,
    );
    engine = new AudioEngine({
      sampleRate: 48000,
      framesPerBuffer: 256,
      bpm: 120,
    });
    await engine.init();
  });

  afterEach(async () => {
    await engine.dispose();
    jest.clearAllMocks();
  });

  it('describes the initialized empty graph with complete identity', async () => {
    const description = await engine.describeGraph();

    expect(description).toMatchObject({
      generation: 0,
      nodeIds: [],
      routeEpoch: 0,
    });
    expect(description.graphHash).toMatch(/^web-[0-9a-f]{16}$/);
    expect(Number.isSafeInteger(description.engineInstance)).toBe(true);
    expect(description.engineInstance).toBeGreaterThan(0);
  });

  it('prepares and commits a complete replacement graph', async () => {
    const baseline = await engine.describeGraph();
    const result = await engine.applyGraph(
      requestFor('web-commit-1', baseline, playableGraph),
    );

    expect(result.status).toBe('committed');
    expect(result.failure).toBeUndefined();
    expect(result.graph.generation).toBe(baseline.generation + 1);
    expect(result.graph.nodeIds).toEqual(['master', 'osc']);
    expect(result.graph.graphHash).not.toBe(baseline.graphHash);
    expect(context.gainNodes[0].disconnectCount).toBeGreaterThan(0);
  });

  it('returns the same result when a transaction id is replayed', async () => {
    const baseline = await engine.describeGraph();
    const request = requestFor('web-idempotent', baseline, playableGraph);
    const first = await engine.applyGraph(request);
    const second = await engine.applyGraph(request);

    expect(second).toEqual(first);
    expect((await engine.describeGraph()).generation).toBe(first.graph.generation);
  });

  it('rejects a stale generation without modifying the active graph', async () => {
    const baseline = await engine.describeGraph();
    const committed = await engine.applyGraph(
      requestFor('web-current', baseline, playableGraph),
    );
    const staleRequest = requestFor('web-stale', baseline, {
      nodes: [{ id: 'replacement', type: 'gain' }],
      connections: [{ source: 'replacement', destination: OUTPUT_BUS }],
    });
    const stale = await engine.applyGraph(staleRequest);

    expect(stale.status).toBe('stale');
    expect(stale.failure).toMatchObject({
      stage: 'validate',
      code: 'stale_generation',
    });
    expect(stale.graph).toEqual(committed.graph);
    expect(await engine.describeGraph()).toEqual(committed.graph);
  });

  it('rejects an invalid endpoint and preserves graph identity', async () => {
    const baseline = await engine.describeGraph();
    const rejected = await engine.applyGraph(
      requestFor('web-invalid-endpoint', baseline, {
        nodes: [{ id: 'source', type: 'gain' }],
        connections: [{ source: 'source', destination: 'missing' }],
      }),
    );

    expect(rejected.status).toBe('rejected');
    expect(rejected.failure).toMatchObject({
      stage: 'prepare',
      code: 'invalid_request',
    });
    expect(await engine.describeGraph()).toEqual(baseline);
  });

  it('rejects cyclic graphs before activating any prepared nodes', async () => {
    const baseline = await engine.describeGraph();
    const rejected = await engine.applyGraph(
      requestFor('web-cycle', baseline, {
        nodes: [
          { id: 'left', type: 'gain' },
          { id: 'right', type: 'gain' },
        ],
        connections: [
          { source: 'left', destination: 'right' },
          { source: 'right', destination: 'left' },
        ],
      }),
    );

    expect(rejected.status).toBe('rejected');
    expect(rejected.failure?.detail).toContain('cycle');
    expect(await engine.describeGraph()).toEqual(baseline);
  });

  it('commits a canonical no-op without advancing generation', async () => {
    const baseline = await engine.describeGraph();
    const first = await engine.applyGraph(
      requestFor('web-first', baseline, playableGraph),
    );
    const second = await engine.applyGraph(
      requestFor('web-no-op', first.graph, {
        nodes: [...playableGraph.nodes].reverse(),
        connections: [...playableGraph.connections].reverse(),
      }),
    );

    expect(second.status).toBe('committed');
    expect(second.graph).toEqual(first.graph);
  });
});
