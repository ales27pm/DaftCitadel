import { OUTPUT_BUS, type AudioEngine, type NodeConfiguration } from '../AudioEngine';
import { GraphReconciler } from '../bridge/GraphReconciler';

const createHarness = () => {
  const configureNodes = jest.fn(async (_nodes: NodeConfiguration[]) => undefined);
  const removeNodes = jest.fn(async (_nodeIds: string[]) => undefined);
  const connect = jest.fn(async (_source: string, _destination: string) => undefined);
  const disconnect = jest.fn(async (_source: string, _destination: string) => undefined);
  const engine = {
    configureNodes,
    removeNodes,
    connect,
    disconnect,
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
    const initial = { id: 'track:output', type: 'trackOutput', options: { gain: 1 } };
    const changed = { id: 'track:output', type: 'trackOutput', options: { gain: 0.5 } };
    const connections = new Set([reconciler.getConnectionKey(changed.id, OUTPUT_BUS)]);

    await reconciler.apply(new Map([[initial.id, initial]]), connections);
    configureNodes.mockClear();
    removeNodes.mockClear();
    connect.mockClear();

    await reconciler.apply(new Map([[changed.id, changed]]), connections);

    expect(removeNodes).toHaveBeenCalledWith([changed.id]);
    expect(configureNodes).toHaveBeenCalledWith([changed]);
    expect(connect).toHaveBeenCalledWith(changed.id, OUTPUT_BUS);
    expect(removeNodes.mock.invocationCallOrder[0]).toBeLessThan(
      configureNodes.mock.invocationCallOrder[0],
    );
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
    await reconciler.apply(new Map([[initial.id, initial]]), new Set([outputConnection]));
    configureNodes.mockClear();
    connect.mockClear();
    await reconciler.forceConfigureNode(recovered);

    expect(removeNodes).toHaveBeenCalledWith([recovered.id]);
    expect(configureNodes).toHaveBeenCalledWith([recovered]);
    expect(connect).toHaveBeenCalledWith(recovered.id, OUTPUT_BUS);
  });
});
