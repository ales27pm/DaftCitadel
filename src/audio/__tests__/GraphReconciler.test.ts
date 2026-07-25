import { OUTPUT_BUS, type AudioEngine, type NodeConfiguration } from '../AudioEngine';
import { GraphReconciler } from '../bridge/GraphReconciler';

const createHarness = () => {
  const configureNodes = jest.fn(async (_nodes: NodeConfiguration[]) => undefined);
  const removeNodes = jest.fn(async (_nodeIds: string[]) => undefined);
  const connect = jest.fn(async (_source: string, _destination: string) => undefined);
  const disconnect = jest.fn(async (_source: string, _destination: string) => undefined);
  const getTransportState = jest.fn(async () => ({ frame: 0, isPlaying: false }));
  const stopTransport = jest.fn(async () => undefined);
  const locateTransport = jest.fn(async (_frame: number) => undefined);
  const startTransport = jest.fn(async () => undefined);
  const engine = {
    configureNodes,
    removeNodes,
    connect,
    disconnect,
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
    configureNodes,
    removeNodes,
    connect,
    disconnect,
    getTransportState,
    stopTransport,
    locateTransport,
    startTransport,
    logger,
  };
};

describe('GraphReconciler', () => {
  it('connects graph nodes to the native output bus', async () => {
    const { reconciler, connect } = createHarness();
    const node = { id: 'track:output', type: 'trackOutput' };

    await reconciler.apply(
      new Map([[node.id, node]]),
      new Set([reconciler.getConnectionKey(node.id, OUTPUT_BUS)]),
    );

    expect(connect).toHaveBeenCalledWith(node.id, OUTPUT_BUS);
  });

  it('removes and recreates changed nodes before restoring their connections', async () => {
    const { reconciler, configureNodes, removeNodes, connect } = createHarness();
    const initial = {
      id: 'track:output',
      type: 'trackOutput',
      options: { gain: 1 },
    };
    const changed = {
      id: 'track:output',
      type: 'trackOutput',
      options: { gain: 0.5 },
    };
    const connections = new Set([
      reconciler.getConnectionKey(changed.id, OUTPUT_BUS),
    ]);

    await reconciler.apply(new Map([[initial.id, initial]]), connections);
    configureNodes.mockClear();
    removeNodes.mockClear();
    connect.mockClear();

    const result = await reconciler.apply(
      new Map([[changed.id, changed]]),
      connections,
    );

    expect(removeNodes).toHaveBeenCalledWith([changed.id]);
    expect(configureNodes).toHaveBeenCalledWith([changed]);
    expect(connect).toHaveBeenCalledWith(changed.id, OUTPUT_BUS);
    expect([...result.replacedNodeIds]).toEqual([changed.id]);
    expect([...result.removedNodeIds]).toEqual([]);
    expect(removeNodes.mock.invocationCallOrder[0]).toBeLessThan(
      configureNodes.mock.invocationCallOrder[0],
    );
  });

  it('keeps Juno nodes in place when only realtime parameters change', async () => {
    const { reconciler, configureNodes, removeNodes, getTransportState } =
      createHarness();
    const initial = {
      id: 'juno',
      type: 'juno106',
      options: { cutoffHz: 1200, resonance: 0.2 },
    };
    const changed = {
      ...initial,
      options: { cutoffHz: 3200, resonance: 0.7 },
    };
    const nodes = new Map([[initial.id, initial]]);

    await reconciler.apply(nodes, new Set());
    configureNodes.mockClear();
    removeNodes.mockClear();
    getTransportState.mockClear();

    expect(
      reconciler.hasChanges(new Map([[changed.id, changed]]), new Set()),
    ).toBe(false);
    const result = await reconciler.apply(
      new Map([[changed.id, changed]]),
      new Set(),
    );

    expect(removeNodes).not.toHaveBeenCalled();
    expect(configureNodes).not.toHaveBeenCalled();
    expect(getTransportState).not.toHaveBeenCalled();
    expect([...result.replacedNodeIds]).toEqual([]);
  });

  it('reports nodes removed without replacement', async () => {
    const { reconciler, removeNodes } = createHarness();
    const node = { id: 'track:output', type: 'trackOutput' };

    await reconciler.apply(new Map([[node.id, node]]), new Set());
    const result = await reconciler.apply(new Map(), new Set());

    expect(removeNodes).toHaveBeenCalledWith([node.id]);
    expect([...result.removedNodeIds]).toEqual([node.id]);
    expect([...result.replacedNodeIds]).toEqual([]);
  });

  it('preserves replacement changes when connection reconciliation fails', async () => {
    const { reconciler, connect } = createHarness();
    const initial = {
      id: 'track:output',
      type: 'trackOutput',
      options: { gain: 1 },
    };
    const changed = {
      id: 'track:output',
      type: 'trackOutput',
      options: { gain: 0.5 },
    };
    const connections = new Set([
      reconciler.getConnectionKey(changed.id, OUTPUT_BUS),
    ]);

    await reconciler.apply(new Map([[initial.id, initial]]), connections);
    connect.mockRejectedValueOnce(new Error('Connection unavailable'));

    await expect(
      reconciler.apply(new Map([[changed.id, changed]]), connections),
    ).rejects.toThrow('Connection unavailable');

    const result = await reconciler.apply(
      new Map([[changed.id, changed]]),
      connections,
    );
    expect([...result.replacedNodeIds]).toEqual([changed.id]);
  });

  it('replaces an existing node during forced plugin recovery', async () => {
    const { reconciler, configureNodes, removeNodes, connect } = createHarness();
    const initial = {
      id: 'plugin',
      type: 'plugin:insert',
      options: { hostInstanceId: 'a' },
    };
    const recovered = {
      id: 'plugin',
      type: 'plugin:insert',
      options: { hostInstanceId: 'b' },
    };

    const outputConnection = reconciler.getConnectionKey(initial.id, OUTPUT_BUS);
    await reconciler.apply(
      new Map([[initial.id, initial]]),
      new Set([outputConnection]),
    );
    configureNodes.mockClear();
    connect.mockClear();
    await reconciler.forceConfigureNode(recovered);

    expect(removeNodes).toHaveBeenCalledWith([recovered.id]);
    expect(configureNodes).toHaveBeenCalledWith([recovered]);
    expect(connect).toHaveBeenCalledWith(recovered.id, OUTPUT_BUS);
  });

  it('pauses a playing transport and resumes at the stopped frame', async () => {
    const {
      reconciler,
      getTransportState,
      stopTransport,
      locateTransport,
      startTransport,
      configureNodes,
    } = createHarness();
    getTransportState
      .mockResolvedValueOnce({ frame: 120, isPlaying: true })
      .mockResolvedValueOnce({ frame: 128, isPlaying: false });
    const node = { id: 'track:output', type: 'trackOutput' };

    await reconciler.apply(new Map([[node.id, node]]), new Set());

    expect(stopTransport).toHaveBeenCalledTimes(1);
    expect(configureNodes).toHaveBeenCalledWith([node]);
    expect(locateTransport).toHaveBeenCalledWith(128);
    expect(startTransport).toHaveBeenCalledTimes(1);
    expect(stopTransport.mock.invocationCallOrder[0]).toBeLessThan(
      configureNodes.mock.invocationCallOrder[0],
    );
    expect(configureNodes.mock.invocationCallOrder[0]).toBeLessThan(
      startTransport.mock.invocationCallOrder[0],
    );
  });

  it('keeps transport stopped when a structural mutation fails', async () => {
    const {
      reconciler,
      getTransportState,
      stopTransport,
      locateTransport,
      startTransport,
      configureNodes,
      logger,
    } = createHarness();
    getTransportState
      .mockResolvedValueOnce({ frame: 64, isPlaying: true })
      .mockResolvedValueOnce({ frame: 72, isPlaying: false });
    configureNodes.mockRejectedValueOnce(
      new Error('Native graph rejected mutation'),
    );
    const node = { id: 'track:output', type: 'trackOutput' };

    await expect(
      reconciler.apply(new Map([[node.id, node]]), new Set()),
    ).rejects.toThrow('Native graph rejected mutation');

    expect(stopTransport).toHaveBeenCalledTimes(1);
    expect(locateTransport).toHaveBeenCalledWith(72);
    expect(startTransport).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Graph mutation failed; transport remains stopped at the captured frame',
      { frame: 72 },
    );
  });

  it('serializes overlapping structural mutations', async () => {
    const { reconciler, configureNodes } = createHarness();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    configureNodes.mockImplementationOnce(async () => {
      markFirstStarted();
      await firstGate;
    });

    const firstNode = { id: 'first', type: 'trackOutput' };
    const secondNode = { id: 'second', type: 'trackOutput' };
    const first = reconciler.apply(
      new Map([[firstNode.id, firstNode]]),
      new Set(),
    );
    await firstStarted;
    const second = reconciler.forceConfigureNode(secondNode);
    await Promise.resolve();

    expect(configureNodes).toHaveBeenCalledTimes(1);
    releaseFirst();
    await first;
    await second;
    expect(configureNodes).toHaveBeenCalledTimes(2);
    expect(configureNodes.mock.calls[1][0]).toEqual([secondNode]);
  });
});
