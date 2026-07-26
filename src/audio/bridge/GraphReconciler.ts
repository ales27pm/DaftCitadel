import type { AudioEngine, NodeConfiguration } from '../AudioEngine';

type Logger = Pick<typeof console, 'debug' | 'info' | 'warn' | 'error'>;

type NodeId = string;

type ConnectionKey = string;

const connectionKey = (source: NodeId, destination: NodeId): ConnectionKey =>
  `${source}->${destination}`;

export class GraphReconciler {
  private readonly nodeState = new Map<NodeId, NodeConfiguration>();

  private readonly connectionState = new Set<ConnectionKey>();

  constructor(
    private readonly audioEngine: AudioEngine,
    private readonly logger: Logger,
  ) {}

  getConnectionKey(source: NodeId, destination: NodeId): ConnectionKey {
    return connectionKey(source, destination);
  }

  async apply(
    nodes: Map<NodeId, NodeConfiguration>,
    connections: Set<ConnectionKey>,
  ): Promise<void> {
    await this.reconcileNodes(nodes);
    await this.reconcileConnections(connections, nodes);
  }

  async forceConfigureNode(node: NodeConfiguration): Promise<void> {
    await this.audioEngine.configureNodes([node]);
    this.nodeState.set(node.id, node);
  }

  private async reconcileNodes(desired: Map<NodeId, NodeConfiguration>): Promise<void> {
    const toConfigure: NodeConfiguration[] = [];
    desired.forEach((node) => {
      const existing = this.nodeState.get(node.id);
      if (!existing || !this.nodeConfigurationEquals(existing, node)) {
        toConfigure.push(node);
      }
    });

    const toRemove: NodeId[] = [];
    this.nodeState.forEach((_node, nodeId) => {
      if (!desired.has(nodeId)) {
        toRemove.push(nodeId);
      }
    });

    if (toRemove.length > 0) {
      this.logger.debug('Removing stale nodes', { nodeIds: toRemove });
      await this.audioEngine.removeNodes(toRemove);
      toRemove.forEach((nodeId) => {
        this.nodeState.delete(nodeId);
        [...this.connectionState]
          .filter((key) => key.startsWith(`${nodeId}->`) || key.endsWith(`->${nodeId}`))
          .forEach((key) => this.connectionState.delete(key));
      });
    }

    if (toConfigure.length > 0) {
      this.logger.debug('Configuring nodes', { count: toConfigure.length });
      await this.audioEngine.configureNodes(toConfigure);
      toConfigure.forEach((node) => this.nodeState.set(node.id, node));
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
      await Promise.all(
        toDisconnect.map((key) => {
          const [source, destination] = key.split('->');
          return this.audioEngine.disconnect(source, destination);
        }),
      );
      toDisconnect.forEach((key) => this.connectionState.delete(key));
    }

    const toConnect: ConnectionKey[] = [];
    desired.forEach((key) => {
      if (this.connectionState.has(key)) {
        return;
      }
      const [source, destination] = key.split('->');
      const hasSource = nodes.has(source) || this.nodeState.has(source);
      const hasDestination = nodes.has(destination) || this.nodeState.has(destination);
      if (!hasSource || !hasDestination) {
        return;
      }
      toConnect.push(key);
    });

    if (toConnect.length > 0) {
      this.logger.debug('Connecting connections', { count: toConnect.length });
      await Promise.all(
        toConnect.map((key) => {
          const [source, destination] = key.split('->');
          return this.audioEngine.connect(source, destination);
        }),
      );
      toConnect.forEach((key) => this.connectionState.add(key));
    }
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

export type { ConnectionKey };
