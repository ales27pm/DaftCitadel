import { OUTPUT_BUS, type AudioEngine } from '../AudioEngine';
import type {
  NativeGraphApplyRequest,
  NativeGraphApplyResult,
  NativeGraphDescription,
} from '../NativeAudioEngine';
import { GraphReconciler, GraphTransactionError } from '../bridge/GraphReconciler';

const createHarness = () => {
  let hashSequence = 0;
  let activeGraph: NativeGraphDescription = {
    generation: 0,
    graphHash: 'empty',
    nodeIds: [],
    routeEpoch: 1,
    engineInstance: 7,
  };
  const cloneGraph = (): NativeGraphDescription => ({
    ...activeGraph,
    nodeIds: [...activeGraph.nodeIds],
  });
  const describeGraph = jest.fn(async () => cloneGraph());
  const commit = async (
    request: NativeGraphApplyRequest,
  ): Promise<NativeGraphApplyResult> => {
    hashSequence += 1;
    activeGraph = {
      generation: request.expectedGeneration + 1,
      graphHash: `graph-${hashSequence}`,
      nodeIds: request.nodes.map((node) => node.id).sort(),
      routeEpoch: request.expectedRouteEpoch,
      engineInstance: request.expectedEngineInstance,
    };
    return {
      status: 'committed',
      transactionId: request.transactionId,
      graph: cloneGraph(),
    };
  };
  const applyGraph = jest.fn(commit);
  const getTransportState = jest.fn(async () => ({
    frame: 0,
    isPlaying: false,
  }));
  const stopTransport = jest.fn(async () => undefined);
  const locateTransport = jest.fn(async (_frame: number) => undefined);
  const startTransport = jest.fn(async () => undefined);
  const engine = {
    describeGraph,
    applyGraph,
    getTransportState,
    stopTransport,
    locateTransport,
    startTransport,
  } as unknown as AudioEngine;
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  return {
    reconciler: new GraphReconciler(engine, logger),
    describeGraph,
    applyGraph,
    commit,
    getActiveGraph: cloneGraph,
    getTransportState,
    stopTransport,
    locateTransport,
    startTransport,
    logger,
  };
};

const rejectedResult = (
  graph: NativeGraphDescription,
  status: 'stale' | 'rejected' = 'rejected',
): NativeGraphApplyResult => ({
  status,
  transactionId: `tx-${status}`,
  graph,
  failure: {
    stage: status === 'stale' ? 'route' : 'connect',
    code: status === 'stale' ? 'stale_route_epoch' : 'connection_rejected',
    nodeId: '',
    detail:
      status === 'stale' ? 'Route changed before commit' : 'Connection was rejected',
  },
});

describe('GraphReconciler', () => {
  it('submits one complete graph including the native output bus', async () => {
    const { reconciler, applyGraph } = createHarness();
    const node = { id: 'track:output', type: 'trackOutput' };

    await reconciler.apply(
      new Map([[node.id, node]]),
      new Set([reconciler.getConnectionKey(node.id, OUTPUT_BUS)]),
    );

    expect(applyGraph).toHaveBeenCalledTimes(1);
    expect(applyGraph.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        expectedGeneration: 0,
        expectedRouteEpoch: 1,
        expectedEngineInstance: 7,
        nodes: [{ ...node, options: {} }],
        connections: [{ source: node.id, destination: OUTPUT_BUS }],
      }),
    );
  });

  it('replaces changed nodes with one full transaction', async () => {
    const { reconciler, applyGraph } = createHarness();
    const initial = {
      id: 'track:output',
      type: 'trackOutput',
      options: { gain: 1 },
    };
    const changed = {
      ...initial,
      options: { gain: 0.5 },
    };
    const connections = new Set([reconciler.getConnectionKey(changed.id, OUTPUT_BUS)]);

    await reconciler.apply(new Map([[initial.id, initial]]), connections);
    const result = await reconciler.apply(new Map([[changed.id, changed]]), connections);

    expect(applyGraph).toHaveBeenCalledTimes(2);
    expect(applyGraph.mock.calls[1][0].nodes).toEqual([changed]);
    expect([...result.replacedNodeIds]).toEqual([changed.id]);
    expect([...result.removedNodeIds]).toEqual([]);
  });

  it('retries exactly once after a stale identity', async () => {
    const { reconciler, applyGraph, describeGraph, getActiveGraph } = createHarness();
    applyGraph.mockResolvedValueOnce(rejectedResult(getActiveGraph(), 'stale'));
    const node = { id: 'track:output', type: 'trackOutput' };

    await reconciler.apply(new Map([[node.id, node]]), new Set());

    expect(applyGraph).toHaveBeenCalledTimes(2);
    expect(describeGraph).toHaveBeenCalledTimes(2);
  });

  it('does not retry a structural rejection or mutate tracked state', async () => {
    const { reconciler, applyGraph, getActiveGraph } = createHarness();
    const initial = {
      id: 'track:output',
      type: 'trackOutput',
      options: { gain: 1 },
    };
    const changed = {
      ...initial,
      options: { gain: 0.5 },
    };
    await reconciler.apply(new Map([[initial.id, initial]]), new Set());
    applyGraph.mockResolvedValueOnce(rejectedResult(getActiveGraph()));

    await expect(
      reconciler.apply(new Map([[changed.id, changed]]), new Set()),
    ).rejects.toBeInstanceOf(GraphTransactionError);
    expect(applyGraph).toHaveBeenCalledTimes(2);

    const retry = await reconciler.apply(new Map([[changed.id, changed]]), new Set());
    expect([...retry.replacedNodeIds]).toEqual([changed.id]);
  });

  it('skips mutation only when native identity still matches the last commit', async () => {
    const { reconciler, applyGraph, getTransportState, describeGraph } = createHarness();
    const node = { id: 'track:output', type: 'trackOutput' };
    const nodes = new Map([[node.id, node]]);

    await reconciler.apply(nodes, new Set());
    applyGraph.mockClear();
    getTransportState.mockClear();
    describeGraph.mockClear();
    await reconciler.apply(nodes, new Set());

    expect(describeGraph).toHaveBeenCalledTimes(1);
    expect(applyGraph).not.toHaveBeenCalled();
    expect(getTransportState).not.toHaveBeenCalled();
  });

  it('pauses a playing transport and resumes after commit acknowledgment', async () => {
    const {
      reconciler,
      getTransportState,
      stopTransport,
      locateTransport,
      startTransport,
      applyGraph,
    } = createHarness();
    getTransportState
      .mockResolvedValueOnce({ frame: 120, isPlaying: true })
      .mockResolvedValueOnce({ frame: 128, isPlaying: false });
    const node = { id: 'track:output', type: 'trackOutput' };

    await reconciler.apply(new Map([[node.id, node]]), new Set());

    expect(stopTransport).toHaveBeenCalledTimes(1);
    expect(locateTransport).toHaveBeenCalledWith(128);
    expect(startTransport).toHaveBeenCalledTimes(1);
    expect(stopTransport.mock.invocationCallOrder[0]).toBeLessThan(
      applyGraph.mock.invocationCallOrder[0],
    );
    expect(applyGraph.mock.invocationCallOrder[0]).toBeLessThan(
      startTransport.mock.invocationCallOrder[0],
    );
  });

  it('keeps transport stopped after a rejected graph transaction', async () => {
    const {
      reconciler,
      getTransportState,
      stopTransport,
      locateTransport,
      startTransport,
      applyGraph,
      getActiveGraph,
      logger,
    } = createHarness();
    getTransportState
      .mockResolvedValueOnce({ frame: 64, isPlaying: true })
      .mockResolvedValueOnce({ frame: 72, isPlaying: false });
    applyGraph.mockResolvedValueOnce(rejectedResult(getActiveGraph()));
    const node = { id: 'track:output', type: 'trackOutput' };

    await expect(
      reconciler.apply(new Map([[node.id, node]]), new Set()),
    ).rejects.toBeInstanceOf(GraphTransactionError);

    expect(stopTransport).toHaveBeenCalledTimes(1);
    expect(locateTransport).toHaveBeenCalledWith(72);
    expect(startTransport).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Graph transaction failed; transport remains stopped at the captured frame',
      { frame: 72 },
    );
  });

  it('serializes overlapping graph transactions', async () => {
    const { reconciler, applyGraph, commit } = createHarness();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    applyGraph.mockImplementationOnce(async (request) => {
      markFirstStarted();
      await firstGate;
      return commit(request);
    });

    const firstNode = { id: 'first', type: 'trackOutput' };
    const secondNode = { id: 'second', type: 'trackOutput' };
    const first = reconciler.apply(new Map([[firstNode.id, firstNode]]), new Set());
    await firstStarted;
    const second = reconciler.forceConfigureNode(secondNode);
    await Promise.resolve();

    expect(applyGraph).toHaveBeenCalledTimes(1);
    releaseFirst();
    await first;
    await second;
    expect(applyGraph).toHaveBeenCalledTimes(2);
    expect(applyGraph.mock.calls[1][0].nodes).toEqual([{ ...secondNode, options: {} }]);
  });
});
