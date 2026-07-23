import { OUTPUT_BUS, type AudioEngine, type NodeConfiguration } from '../AudioEngine';

type Logger = Pick<typeof console, 'debug' | 'info' | 'warn' | 'error'>;

type NodeId = string;

type ConnectionKey = string;

export type GraphReconciliationResult = {
  removedNodeIds: ReadonlySet<string>;
  replacedNodeIds: ReadonlySet<string>;
};

const connectionKey = (source: NodeId, destination: NodeId): ConnectionKey =>
  `${source}->${destination}`;

export class GraphReconciler {
  private readonly nodeState = new Map<NodeId, NodeConfiguration>();

  private readonly connectionState = new Set<ConnectionKey>();

  private readonly pendingRemovedNodeIds = new Set<NodeId>();

  private readonly pendingReplacedNodeIds = new Set<NodeId>();

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
    await this.reconcileNodes(nodes);
    await this.reconcileConnections(connections, nodes);
    const result: GraphReconciliationResult = {
      removedNodeIds: new Set(this.pendingRemovedNodeIds),
      replacedNodeIds: new Set(this.pendingReplacedNodeIds),
    };
    this.pendingRemovedNodeIds.clear();
    this.pendingReplacedNodeIds.clear();
    return result;
  }

  async forceConfigureNode(node: NodeConfiguration): Promise<void> {
    const connectionsToRestore = [...this.connectionState].filter((key) => {
      const [source, destination] = this.parseConnectionKey(key);
      return source === node.id || destination === node.id;
    });
    if (this.nodeState.has(node.id)) {
      await this.removeTrackedNodes([node.id]);
    }
    await this.audioEngine.configureNodes([node]);
    this.nodeState.set(node.id, node);
    for (const key of connectionsToRestore) {
      const [source, destination] = this.parseConnectionKey(key);
      const otherNodeExists =
        (source === node.id || this.nodeState.has(source)) &&
        (destination === OUTPUT_BUS ||
          destination === node.id ||
          this.nodeState.has(destination));
      if (!otherNodeExists) {
        continue;
      }
      await this.audioEngine.connect(source, destination);
      this.connectionState.add(key);
    }
  }

  private async reconcileNodes(desired: Map<NodeId, NodeConfiguration>): Promise<void> {
    const toConfigure: NodeConfiguration[] = [];
    const replacements: NodeId[] = [];
    desired.forEach((node) => {
      const existing = this.nodeState.get(node.id);
      if (!existing || !this.nodeConfigurationEquals(existing, node)) {
        toConfigure.push(node);
        if (existing) {
          replacements.push(node.id);
        }
      }
    });

    const toRemove: NodeId[] = [];
    this.nodeState.forEach((_node, nodeId) => {
      if (!desired.has(nodeId)) {
        toRemove.push(nodeId);
      }
    });

    toRemove.forEach((nodeId) => this.pendingRemovedNodeIds.add(nodeId));
    replacements.forEach((nodeId) => this.pendingReplacedNodeIds.add(nodeId));

    const nodesToRemove = [...toRemove, ...replacements];
    if (nodesToRemove.length > 0) {
      this.logger.debug('Removing stale or changed nodes', { nodeIds: nodesToRemove });
      await this.removeTrackedNodes(nodesToRemove);
    }

    if (toConfigure.length > 0) {
      this.logger.debug('Configuring nodes', { count: toConfigure.length });
      await this.audioEngine.configureNodes(toConfigure);
      toConfigure.forEach((node) => this.nodeState.set(node.id, node));
    }
  }

  private async removeTrackedNodes(nodeIds: NodeId[]): Promise<void> {
    for (const nodeId of nodeIds) {
      await this.audioEngine.removeNodes([nodeId]);
      this.nodeState.delete(nodeId);
      [...this.connectionState].forEach((key) => {
        const [source, destination] = this.parseConnectionKey(key);
        if (source === nodeId || destination === nodeId) {
          this.connectionState.delete(key);
        }
      });
    }
  }

  private async reconcileConnections(
    desired: Set<ConnectionKey>,
    nodes: Map<NodeId, NodeConfiguration>,
  ): Promise<void> {
    const toDisconnect: ConnectionKey[] = [];
    this.connectionState.forEach((key) => {
      if (!desired.has(key)) {
        toDisconnect.push(key);
      }
    });

    if (toDisconnect.length > 0) {
      this.logger.debug('Disconnecting connections', { count: toDisconnect.length });
      for (const key of toDisconnect) {
        const [source, destination] = this.parseConnectionKey(key);
        await this.audioEngine.disconnect(source, destination);
        this.connectionState.delete(key);
      }
    }

    const toConnect: ConnectionKey[] = [];
    desired.forEach((key) => {
      if (this.connectionState.has(key)) {
        return;
      }
      const [source, destination] = this.parseConnectionKey(key);
      const hasSource = nodes.has(source) || this.nodeState.has(source);
      const hasDestination =
        destination === OUTPUT_BUS ||
        nodes.has(destination) ||
        this.nodeState.has(destination);
      if (!hasSource || !hasDestination) {
        return;
      }
      toConnect.push(key);
    });

    if (toConnect.length > 0) {
      this.logger.debug('Connecting connections', { count: toConnect.length });
      for (const key of toConnect) {
        const [source, destination] = this.parseConnectionKey(key);
        await this.audioEngine.connect(source, destination);
        this.connectionState.add(key);
      }
    }
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
    // Juno parameters are mutable realtime state. The session bridge applies
    // option changes through the instrument parameter API so held voices and
    // chorus history survive a knob or preset update.
    if (lhs.type === 'juno106') {
      return true;
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

export type { ConnectionKey };
