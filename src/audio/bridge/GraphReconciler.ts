import { OUTPUT_BUS, type AudioEngine, type NodeConfiguration } from '../AudioEngine';
import type {
  NativeGraphApplyResult,
  NativeGraphDescription,
} from '../NativeAudioEngine';

type Logger = Pick<typeof console, 'debug' | 'info' | 'warn' | 'error'>;

type NodeId = string;

type ConnectionKey = string;
type TransportSnapshot = {
  frame: number;
  currentFrame?: number;
  isPlaying: boolean;
};

export type GraphReconciliationResult = {
  removedNodeIds: ReadonlySet<string>;
  replacedNodeIds: ReadonlySet<string>;
};

export class GraphTransactionError extends Error {
  constructor(public readonly result: NativeGraphApplyResult) {
    const failure = result.failure;
    super(
      failure
        ? `Graph transaction ${result.status} at ${failure.stage}: ${failure.code} (${failure.detail})`
        : `Graph transaction ${result.status}`,
    );
    this.name = 'GraphTransactionError';
  }
}

const connectionKey = (source: NodeId, destination: NodeId): ConnectionKey =>
  `${source}->${destination}`;

export class GraphReconciler {
  private readonly nodeState = new Map<NodeId, NodeConfiguration>();

  private readonly connectionState = new Set<ConnectionKey>();

  private structuralMutationTail: Promise<void> = Promise.resolve();

  private transactionSequence = 0;

  private lastCommittedGraph: NativeGraphDescription | null = null;

  constructor(
    private readonly audioEngine: AudioEngine,
    private readonly logger: Logger,
  ) {}

  getConnectionKey(source: NodeId, destination: NodeId): ConnectionKey {
    return connectionKey(source, destination);
  }

  hasChanges(
    nodes: ReadonlyMap<NodeId, NodeConfiguration>,
    connections: ReadonlySet<ConnectionKey>,
  ): boolean {
    if (
      nodes.size !== this.nodeState.size ||
      connections.size !== this.connectionState.size
    ) {
      return true;
    }
    for (const [nodeId, node] of nodes) {
      const existing = this.nodeState.get(nodeId);
      if (!existing || !this.nodeConfigurationEquals(existing, node)) {
        return true;
      }
    }
    for (const connection of connections) {
      if (!this.connectionState.has(connection)) {
        return true;
      }
    }
    return false;
  }

  async apply(
    nodes: Map<NodeId, NodeConfiguration>,
    connections: Set<ConnectionKey>,
  ): Promise<GraphReconciliationResult> {
    return this.runSerialized(async () => {
      const result = this.getReconciliationResult(nodes);
      if (
        !this.hasChanges(nodes, connections) &&
        (await this.nativeGraphMatchesLastCommit(nodes))
      ) {
        return result;
      }

      return this.withTransportStopped(async () => {
        const committed = await this.commitDesiredGraph(nodes, connections);
        this.replaceTrackedState(nodes, connections);
        this.lastCommittedGraph = committed;
        return result;
      });
    });
  }

  async forceConfigureNode(node: NodeConfiguration): Promise<void> {
    const desiredNodes = new Map(this.nodeState);
    desiredNodes.set(node.id, node);
    await this.apply(desiredNodes, new Set(this.connectionState));
  }

  private async runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    let releaseTail!: () => void;
    const previous = this.structuralMutationTail;
    this.structuralMutationTail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    await previous;

    try {
      return await operation();
    } finally {
      releaseTail();
    }
  }

  private async withTransportStopped<T>(operation: () => Promise<T>): Promise<T> {
    let resumeFrame: number | null = null;
    let mutationSucceeded = false;
    try {
      const transport = await this.audioEngine.getTransportState();
      if (transport.isPlaying) {
        await this.audioEngine.stopTransport();
        const stopped = await this.audioEngine.getTransportState();
        resumeFrame = Math.max(0, Math.floor(extractTransportFrame(stopped)));
      }

      const result = await operation();
      mutationSucceeded = true;
      return result;
    } finally {
      if (resumeFrame !== null) {
        try {
          await this.audioEngine.locateTransport(resumeFrame);
          if (mutationSucceeded) {
            await this.audioEngine.startTransport();
          } else {
            this.logger.warn(
              'Graph transaction failed; transport remains stopped at the captured frame',
              { frame: resumeFrame },
            );
          }
        } catch (recoveryError) {
          this.logger.error('Failed to restore transport after graph transaction', {
            frame: resumeFrame,
            mutationSucceeded,
            recoveryError,
          });
        }
      }
    }
  }

  private async commitDesiredGraph(
    nodes: Map<NodeId, NodeConfiguration>,
    connections: Set<ConnectionKey>,
  ): Promise<NativeGraphDescription> {
    const nativeNodes = [...nodes.values()]
      .sort((lhs, rhs) => lhs.id.localeCompare(rhs.id))
      .map((node) => ({
        id: node.id,
        type: node.type,
        options: { ...(node.options ?? {}) },
      }));
    const nativeConnections = [...connections].sort().map((key) => {
      const [source, destination] = this.parseConnectionKey(key);
      if (!nodes.has(source)) {
        throw new Error(`Connection source does not exist: ${source}`);
      }
      if (destination !== OUTPUT_BUS && !nodes.has(destination)) {
        throw new Error(`Connection destination does not exist: ${destination}`);
      }
      return { source, destination };
    });

    let expected = await this.audioEngine.describeGraph();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const transactionId = this.nextTransactionId(attempt);
      this.logger.debug('Applying complete native graph transaction', {
        transactionId,
        attempt,
        nodeCount: nativeNodes.length,
        connectionCount: nativeConnections.length,
      });
      const result = await this.audioEngine.applyGraph({
        transactionId,
        expectedGeneration: expected.generation,
        expectedRouteEpoch: expected.routeEpoch,
        expectedEngineInstance: expected.engineInstance,
        nodes: nativeNodes,
        connections: nativeConnections,
      });

      if (result.status === 'committed') {
        this.validateCommittedGraph(result.graph, expected, nodes);
        return result.graph;
      }
      if (result.status === 'stale' && attempt === 0) {
        this.logger.info('Retrying graph transaction after stale native identity', {
          transactionId,
          failure: result.failure,
        });
        expected = await this.audioEngine.describeGraph();
        continue;
      }
      throw new GraphTransactionError(result);
    }

    throw new Error('Graph transaction retry loop completed without a result');
  }

  private validateCommittedGraph(
    committed: NativeGraphDescription,
    expected: NativeGraphDescription,
    nodes: ReadonlyMap<NodeId, NodeConfiguration>,
  ): void {
    const expectedNodeIds = [...nodes.keys()].sort();
    if (
      committed.nodeIds.length !== expectedNodeIds.length ||
      committed.nodeIds.some((nodeId, index) => nodeId !== expectedNodeIds[index])
    ) {
      throw new Error('Committed native graph node identity does not match request');
    }
    if (
      committed.engineInstance !== expected.engineInstance ||
      committed.routeEpoch !== expected.routeEpoch
    ) {
      throw new Error('Committed native graph lifecycle identity changed unexpectedly');
    }
    if (
      committed.generation !== expected.generation &&
      committed.generation !== expected.generation + 1
    ) {
      throw new Error('Committed native graph generation is not monotonic');
    }
  }

  private async nativeGraphMatchesLastCommit(
    nodes: ReadonlyMap<NodeId, NodeConfiguration>,
  ): Promise<boolean> {
    if (this.lastCommittedGraph === null) {
      return false;
    }
    const current = await this.audioEngine.describeGraph();
    const expectedNodeIds = [...nodes.keys()].sort();
    const matches =
      current.engineInstance === this.lastCommittedGraph.engineInstance &&
      current.generation === this.lastCommittedGraph.generation &&
      current.graphHash === this.lastCommittedGraph.graphHash &&
      current.nodeIds.length === expectedNodeIds.length &&
      current.nodeIds.every((nodeId, index) => nodeId === expectedNodeIds[index]);
    if (matches) {
      this.lastCommittedGraph = current;
    }
    return matches;
  }

  private getReconciliationResult(
    desired: ReadonlyMap<NodeId, NodeConfiguration>,
  ): GraphReconciliationResult {
    const removedNodeIds = new Set<string>();
    const replacedNodeIds = new Set<string>();
    for (const [nodeId, existing] of this.nodeState) {
      const replacement = desired.get(nodeId);
      if (replacement === undefined) {
        removedNodeIds.add(nodeId);
      } else if (!this.nodeConfigurationEquals(existing, replacement)) {
        replacedNodeIds.add(nodeId);
      }
    }
    return { removedNodeIds, replacedNodeIds };
  }

  private replaceTrackedState(
    nodes: ReadonlyMap<NodeId, NodeConfiguration>,
    connections: ReadonlySet<ConnectionKey>,
  ): void {
    this.nodeState.clear();
    for (const [nodeId, node] of nodes) {
      this.nodeState.set(nodeId, {
        ...node,
        ...(node.options === undefined ? {} : { options: { ...node.options } }),
      });
    }
    this.connectionState.clear();
    for (const connection of connections) {
      this.connectionState.add(connection);
    }
  }

  private nextTransactionId(attempt: number): string {
    this.transactionSequence += 1;
    return `graph-${Date.now().toString(36)}-${this.transactionSequence.toString(
      36,
    )}-${attempt}`;
  }

  private parseConnectionKey(key: ConnectionKey): [NodeId, NodeId] {
    const separator = key.indexOf('->');
    if (separator <= 0 || separator === key.length - 2) {
      throw new Error(`Invalid connection key: ${key}`);
    }
    return [key.slice(0, separator), key.slice(separator + 2)];
  }

  private nodeConfigurationEquals(
    lhs: NodeConfiguration,
    rhs: NodeConfiguration,
  ): boolean {
    if (lhs.id !== rhs.id || lhs.type !== rhs.type) {
      return false;
    }
    const leftOptions = lhs.options ?? {};
    const rightOptions = rhs.options ?? {};
    const leftKeys = Object.keys(leftOptions);
    const rightKeys = Object.keys(rightOptions);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    return leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightOptions, key) &&
        leftOptions[key] === rightOptions[key],
    );
  }
}

const extractTransportFrame = (transport: TransportSnapshot): number => {
  if (Number.isFinite(transport.frame)) {
    return transport.frame;
  }
  if (Number.isFinite(transport.currentFrame)) {
    return transport.currentFrame as number;
  }
  throw new Error('Transport state missing frame information');
};

export type { ConnectionKey };
