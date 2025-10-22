import { AudioEngine, NodeConfiguration, OUTPUT_BUS } from './AudioEngine';
import { AutomationLane, ClockSyncService } from './Automation';
import {
  Clip,
  PluginRoutingNode,
  RoutingGraph,
  RoutingNode,
  Session,
  Track,
  TrackEndpointNode,
} from '../session/models';
import {
  AudioFileLoader,
  ClipBufferCache,
  ClipBufferDescriptor,
  createClipBufferUploader,
} from './bridge/ClipBufferCache';
import {
  AutomationPublisher,
  describeAutomation,
  AutomationRequest,
} from './bridge/AutomationManager';
import { ConnectionKey, GraphReconciler } from './bridge/GraphReconciler';
import type { PluginHost } from './plugins/PluginHost';
import type { PluginDescriptor, PluginInstanceHandle } from './plugins/types';
import type { PluginAutomationPoint } from './plugins/NativePluginHost';

type Logger = Pick<typeof console, 'debug' | 'info' | 'warn' | 'error'>;

type TrackNodeId = string;

type SessionState = {
  nodes: Map<string, NodeConfiguration>;
  connections: Set<ConnectionKey>;
  automations: Map<string, AutomationRequest>;
  pluginAutomations: Map<string, PluginAutomationRequest>;
  activePluginInstances: Set<string>;
  clipBuffers: Map<string, ClipBufferDescriptor>;
};

const isTrackEndpointNode = (node: RoutingNode): node is TrackEndpointNode =>
  node.type === 'trackInput' || node.type === 'trackOutput';

const isPluginNode = (node: RoutingNode): node is PluginRoutingNode =>
  node.type === 'plugin';

type PluginAutomationRequest = {
  key: string;
  instanceId: string;
  hostInstanceId: string;
  parameterId: string;
  signature: string;
  points: PluginAutomationPoint[];
};

type PluginInstanceBinding = {
  descriptor: PluginDescriptor;
  hostInstanceId: string;
  handle: PluginInstanceHandle;
};

const DEFAULT_LOGGER: Logger = {
  debug: (...args: unknown[]) => console.debug('[SessionAudioBridge]', ...args),
  info: (...args: unknown[]) => console.info('[SessionAudioBridge]', ...args),
  warn: (...args: unknown[]) => console.warn('[SessionAudioBridge]', ...args),
  error: (...args: unknown[]) => console.error('[SessionAudioBridge]', ...args),
};

export interface SessionAudioBridgeOptions {
  fileLoader: AudioFileLoader;
  logger?: Logger;
  pluginHost?: PluginHost;
  resolvePluginDescriptor?: (
    instanceId: string,
    node: PluginRoutingNode,
  ) => Promise<PluginDescriptor | undefined> | PluginDescriptor | undefined;
}

export class SessionAudioBridge {
  private readonly clock: ClockSyncService;

  private readonly bufferCache: ClipBufferCache;

  private readonly graph: GraphReconciler;

  private readonly automationPublisher: AutomationPublisher;

  private readonly logger: Logger;

  private readonly pluginHost?: PluginHost;

  private readonly resolvePluginDescriptor?: SessionAudioBridgeOptions['resolvePluginDescriptor'];

  private previousSessionRevision = -1;

  private readonly pluginBindings = new Map<string, PluginInstanceBinding>();

  private readonly pluginAutomationState = new Map<string, string>();

  private readonly activeClipBuffers = new Map<string, ClipBufferDescriptor>();

  constructor(
    private readonly audioEngine: AudioEngine,
    options: SessionAudioBridgeOptions,
  ) {
    if (!options.fileLoader) {
      throw new Error('SessionAudioBridge requires an AudioFileLoader');
    }
    this.clock = audioEngine.getClock();
    this.logger = options.logger ?? DEFAULT_LOGGER;
    this.bufferCache = new ClipBufferCache(
      options.fileLoader,
      createClipBufferUploader(audioEngine),
      this.logger,
    );
    this.graph = new GraphReconciler(audioEngine, this.logger);
    this.automationPublisher = new AutomationPublisher((nodeId, lane) =>
      this.audioEngine.publishAutomation(nodeId, lane),
    );
    this.pluginHost = options.pluginHost;
    this.resolvePluginDescriptor = options.resolvePluginDescriptor;
  }

  public async applySessionUpdate(session: Session): Promise<void> {
    if (session.revision < this.previousSessionRevision) {
      throw new Error('Session revision regressed; refusing to apply update');
    }
    if (session.revision === this.previousSessionRevision) {
      this.logger.debug('Session revision unchanged; skipping update');
      return;
    }

    const engineDescription = this.clock.describe();
    const { sampleRate } = engineDescription;
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error('AudioEngine clock reports invalid sample rate');
    }

    if (session.metadata.sampleRate !== sampleRate) {
      this.logger.warn(
        `Session sample rate ${session.metadata.sampleRate} does not match engine sample rate ${sampleRate}; resampling clips`,
      );
    }

    const desiredState = await this.buildDesiredState(session, sampleRate);

    await this.graph.apply(desiredState.nodes, desiredState.connections);
    await this.automationPublisher.applyChanges(desiredState.automations);
    await this.applyPluginAutomations(desiredState.pluginAutomations);
    await this.releaseStalePluginInstances(desiredState.activePluginInstances);
    await this.reconcileClipBuffers(desiredState.clipBuffers);

    this.previousSessionRevision = session.revision;
  }

  private async buildDesiredState(
    session: Session,
    sampleRate: number,
  ): Promise<SessionState> {
    const nodes = new Map<string, NodeConfiguration>();
    const connections = new Set<ConnectionKey>();
    const automations = new Map<string, AutomationRequest>();
    const pluginAutomations = new Map<string, PluginAutomationRequest>();
    const activePluginInstances = new Set<string>();
    const clipBuffers = new Map<string, ClipBufferDescriptor>();

    await Promise.all(
      session.tracks.map(async (track) => {
        const graph = this.resolveRoutingGraph(track);
        const trackInput = graph.nodes.find(
          (node): node is TrackEndpointNode => node.type === 'trackInput',
        );
        const trackOutput = graph.nodes.find(
          (node): node is TrackEndpointNode => node.type === 'trackOutput',
        );

        graph.nodes.forEach((node) => {
          if (isPluginNode(node)) {
            return;
          }
          nodes.set(node.id, this.createNodeConfiguration(node));
        });

        await this.preparePluginNodes(
          track,
          graph,
          nodes,
          pluginAutomations,
          activePluginInstances,
          session.revision,
        );

        graph.connections.forEach((connection) => {
          if (connection.enabled === false) {
            return;
          }
          connections.add(
            this.graph.getConnectionKey(connection.from.nodeId, connection.to.nodeId),
          );
        });

        if (trackOutput) {
          connections.add(this.graph.getConnectionKey(trackOutput.id, OUTPUT_BUS));
        } else {
          this.logger.warn(`Track ${track.id} is missing a trackOutput node`);
        }

        if (trackOutput) {
          track.automationCurves.forEach((curve) => {
            const lane = new AutomationLane(curve.parameter);
            curve.points.forEach((point) => {
              const frame = this.quantizeFrame(this.msToFrames(point.time, sampleRate));
              lane.addPoint({ frame, value: point.value });
            });
            const key = `${trackOutput.id}:${curve.parameter}`;
            automations.set(key, {
              nodeId: trackOutput.id,
              lane,
              signature: describeAutomation(trackOutput.id, lane),
            });
          });
        }

        if (!trackInput) {
          this.logger.warn(`Track ${track.id} is missing a trackInput node`);
          return;
        }

        await Promise.all(
          track.clips.map(async (clip) => {
            try {
              const clipState = await this.prepareClipNode(
                track,
                clip,
                trackInput.id,
                sampleRate,
              );
              nodes.set(clipState.node.id, clipState.node);
              connections.add(
                this.graph.getConnectionKey(
                  clipState.node.id,
                  clipState.destinationNodeId,
                ),
              );
              automations.set(clipState.automationKey, {
                nodeId: clipState.node.id,
                lane: clipState.lane,
                signature: describeAutomation(clipState.node.id, clipState.lane),
              });
              clipBuffers.set(clip.id, clipState.bufferDescriptor);
            } catch (error) {
              this.logger.error('Failed to prepare clip node', {
                clipId: clip.id,
                error,
              });
            }
          }),
        );
      }),
    );

    return {
      nodes,
      connections,
      automations,
      pluginAutomations,
      activePluginInstances,
      clipBuffers,
    };
  }

  private resolveRoutingGraph(track: Track): RoutingGraph {
    if (track.routing.graph) {
      return track.routing.graph;
    }
    throw new Error(`Track ${track.id} is missing a routing graph`);
  }

  private createNodeConfiguration(node: RoutingNode): NodeConfiguration {
    if (isTrackEndpointNode(node)) {
      return {
        id: node.id,
        type: node.type,
        options: {
          ioId: node.ioId,
          channelCount: node.channelCount,
          label: node.label ?? '',
        },
      };
    }
    if (isPluginNode(node)) {
      return {
        id: node.id,
        type: `plugin:${node.slot}`,
        options: {
          instanceId: node.instanceId,
          hostInstanceId:
            this.pluginBindings.get(node.instanceId)?.hostInstanceId ?? node.instanceId,
          order: node.order,
          bypassed: node.bypassed ?? false,
          acceptsAudio: node.accepts.includes('audio'),
          acceptsMidi: node.accepts.includes('midi'),
          acceptsSidechain: node.accepts.includes('sidechain'),
          emitsAudio: node.emits.includes('audio'),
          emitsMidi: node.emits.includes('midi'),
          emitsSidechain: node.emits.includes('sidechain'),
        },
      };
    }
    if (node.type === 'send' || node.type === 'return') {
      const options: Record<string, number | string | boolean> = {
        busId: node.busId,
      };
      if (typeof node.preFader === 'boolean') {
        options.preFader = node.preFader;
      }
      if (typeof node.gain === 'number') {
        options.gain = node.gain;
      }
      return {
        id: node.id,
        type: node.type,
        options,
      };
    }
    if (node.type === 'sidechainTap') {
      return {
        id: node.id,
        type: node.type,
        options: {
          sourceTrackId: node.sourceTrackId,
          busId: node.busId,
        },
      };
    }
    throw new Error(`Unsupported routing node type: ${(node as RoutingNode).type}`);
  }

  private async prepareClipNode(
    track: Track,
    clip: Clip,
    destinationNodeId: TrackNodeId,
    sampleRate: number,
  ): Promise<{
    node: NodeConfiguration;
    destinationNodeId: TrackNodeId;
    lane: AutomationLane;
    automationKey: string;
    bufferDescriptor: ClipBufferDescriptor;
  }> {
    const bufferDescriptor = await this.bufferCache.getClipBuffer(
      clip.audioFile,
      sampleRate,
    );

    const startFrame = this.quantizeFrame(this.msToFrames(clip.start, sampleRate));
    const requestedFrames = Math.max(1, this.msToFrames(clip.duration, sampleRate));
    const playbackFrames = Math.min(requestedFrames, bufferDescriptor.frames);
    const endFrame = this.quantizeFrame(startFrame + playbackFrames);
    const fadeInFrames = Math.min(
      playbackFrames,
      this.msToFrames(clip.fadeIn, sampleRate),
    );
    const fadeOutFrames = Math.min(
      playbackFrames,
      this.msToFrames(clip.fadeOut, sampleRate),
    );

    const nodeId = `clip:${clip.id}`;
    const node: NodeConfiguration = {
      id: nodeId,
      type: 'clipPlayer',
      options: {
        trackId: track.id,
        bufferKey: bufferDescriptor.bufferKey,
        bufferSampleRate: bufferDescriptor.sampleRate,
        bufferChannels: bufferDescriptor.channels,
        bufferFrames: bufferDescriptor.frames,
        startFrame,
        endFrame,
        gain: clip.gain,
        fadeInFrames,
        fadeOutFrames,
      },
    };

    const lane = new AutomationLane('gain');
    if (fadeInFrames > 0) {
      lane.addPoint({ frame: startFrame, value: 0 });
      lane.addPoint({
        frame: this.quantizeFrame(startFrame + fadeInFrames),
        value: clip.gain,
      });
    } else {
      lane.addPoint({ frame: startFrame, value: clip.gain });
    }
    if (fadeOutFrames > 0) {
      lane.addPoint({
        frame: this.quantizeFrame(endFrame - fadeOutFrames),
        value: clip.gain,
      });
      lane.addPoint({ frame: endFrame, value: 0 });
    } else {
      lane.addPoint({ frame: endFrame, value: clip.gain });
    }

    const automationKey = `${nodeId}:gain`;
    return {
      node,
      destinationNodeId,
      lane,
      automationKey,
      bufferDescriptor,
    };
  }

  private async reconcileClipBuffers(
    nextClipBuffers: Map<string, ClipBufferDescriptor>,
  ): Promise<void> {
    const releaseOperations: Array<Promise<void>> = [];

    nextClipBuffers.forEach((descriptor, clipId) => {
      const previous = this.activeClipBuffers.get(clipId);
      if (!previous) {
        this.bufferCache.retainClipBuffer(descriptor.bufferKey);
        return;
      }
      if (previous.bufferKey !== descriptor.bufferKey) {
        this.bufferCache.retainClipBuffer(descriptor.bufferKey);
        releaseOperations.push(this.bufferCache.releaseClipBuffer(previous.bufferKey));
      }
    });

    this.activeClipBuffers.forEach((descriptor, clipId) => {
      if (!nextClipBuffers.has(clipId)) {
        releaseOperations.push(this.bufferCache.releaseClipBuffer(descriptor.bufferKey));
      }
    });

    if (releaseOperations.length > 0) {
      await Promise.all(releaseOperations);
    }

    this.activeClipBuffers.clear();
    nextClipBuffers.forEach((descriptor, clipId) => {
      this.activeClipBuffers.set(clipId, descriptor);
    });
  }

  private msToFrames(ms: number, sampleRate: number): number {
    if (!Number.isFinite(ms)) {
      throw new Error('Invalid time in milliseconds');
    }
    return Math.max(0, Math.round((ms / 1000) * sampleRate));
  }

  private quantizeFrame(frame: number): number {
    return this.clock.quantizeFrameToBuffer(frame);
  }

  private async preparePluginNodes(
    track: Track,
    graph: RoutingGraph,
    nodes: Map<string, NodeConfiguration>,
    pluginAutomations: Map<string, PluginAutomationRequest>,
    activePluginInstances: Set<string>,
    sessionRevision: number,
  ): Promise<void> {
    const pluginNodes = graph.nodes
      .filter(isPluginNode)
      .sort((a, b) => a.order - b.order);

    await Promise.all(
      pluginNodes.map(async (node) => {
        const binding = await this.ensurePluginInstance(node);
        if (!binding) {
          nodes.set(node.id, this.createNodeConfiguration(node));
          return;
        }

        activePluginInstances.add(node.instanceId);
        nodes.set(node.id, {
          id: node.id,
          type: `plugin:${node.slot}`,
          options: {
            instanceId: node.instanceId,
            hostInstanceId: binding.hostInstanceId,
            order: node.order,
            bypassed: node.bypassed ?? false,
            acceptsAudio: node.accepts.includes('audio'),
            acceptsMidi: node.accepts.includes('midi'),
            acceptsSidechain: node.accepts.includes('sidechain'),
            emitsAudio: node.emits.includes('audio'),
            emitsMidi: node.emits.includes('midi'),
            emitsSidechain: node.emits.includes('sidechain'),
          },
        });

        if (!node.automation || node.automation.length === 0) {
          return;
        }

        node.automation.forEach((target) => {
          const curve = track.automationCurves.find(
            (candidate) => candidate.id === target.curveId,
          );
          if (!curve) {
            this.logger.warn(
              `Automation curve ${target.curveId} missing for plugin ${node.instanceId}`,
            );
            return;
          }
          const points = [...curve.points]
            .map<PluginAutomationPoint>((point) => ({
              time: Math.max(0, point.time),
              value: point.value,
            }))
            .sort((a, b) => a.time - b.time);
          const key = `${node.instanceId}:${target.parameterId}`;
          const signature = this.describePluginAutomation(
            sessionRevision,
            node.instanceId,
            target.parameterId,
            points,
          );
          pluginAutomations.set(key, {
            key,
            instanceId: node.instanceId,
            hostInstanceId: binding.hostInstanceId,
            parameterId: target.parameterId,
            signature,
            points,
          });
        });
      }),
    );
  }

  private async ensurePluginInstance(
    node: PluginRoutingNode,
  ): Promise<PluginInstanceBinding | undefined> {
    if (!this.pluginHost) {
      if (this.resolvePluginDescriptor) {
        this.logger.warn(
          `PluginHost unavailable; plugin node ${node.instanceId} will run offline`,
        );
      }
      return undefined;
    }

    if (!this.resolvePluginDescriptor) {
      this.logger.warn(
        `No plugin descriptor resolver configured; skipping plugin ${node.instanceId}`,
      );
      return undefined;
    }

    try {
      const descriptor = await this.resolvePluginDescriptor(node.instanceId, node);
      if (!descriptor) {
        this.logger.warn(
          `Descriptor resolver returned empty result for plugin ${node.instanceId}`,
        );
        return undefined;
      }

      const existing = this.pluginBindings.get(node.instanceId);
      if (
        existing &&
        existing.descriptor.identifier === descriptor.identifier &&
        existing.handle.descriptor.version === descriptor.version
      ) {
        existing.descriptor = descriptor;
        return existing;
      }

      if (existing) {
        await this.safeReleasePlugin(existing.hostInstanceId, node.instanceId);
        this.pluginBindings.delete(node.instanceId);
      }

      const handle = await this.pluginHost.loadPlugin(descriptor, {
        sandboxIdentifier: node.instanceId,
        automationBindings: node.automation?.map((binding) => ({
          parameterId: binding.parameterId,
          curveId: binding.curveId,
        })),
      });
      const binding: PluginInstanceBinding = {
        descriptor,
        hostInstanceId: handle.instanceId,
        handle,
      };
      this.pluginBindings.set(node.instanceId, binding);
      return binding;
    } catch (error) {
      this.logger.error('Failed to ensure plugin instance', {
        pluginInstanceId: node.instanceId,
        error,
      });
      return undefined;
    }
  }

  private describePluginAutomation(
    revision: number,
    instanceId: string,
    parameterId: string,
    points: PluginAutomationPoint[],
  ): string {
    const pointSignature = points
      .map((point) => `${Math.round(point.time)}:${point.value.toFixed(6)}`)
      .join('|');
    return `${revision}:${instanceId}:${parameterId}:${pointSignature}`;
  }

  private async applyPluginAutomations(
    requests: Map<string, PluginAutomationRequest>,
  ): Promise<void> {
    const pluginHost = this.pluginHost;
    if (!pluginHost) {
      if (requests.size > 0) {
        this.logger.warn(
          'Plugin automation requests present but PluginHost is unavailable',
        );
      }
      this.pluginAutomationState.clear();
      return;
    }

    const operations: Array<Promise<void>> = [];

    requests.forEach((request) => {
      const previous = this.pluginAutomationState.get(request.key);
      if (previous === request.signature) {
        return;
      }
      operations.push(
        pluginHost
          .scheduleAutomation(request.hostInstanceId, request.parameterId, request.points)
          .then(() => {
            this.pluginAutomationState.set(request.key, request.signature);
          })
          .catch((error) => {
            this.logger.error('Failed to schedule plugin automation', {
              instanceId: request.instanceId,
              parameterId: request.parameterId,
              error,
            });
          }),
      );
    });

    await Promise.all(operations);

    const staleKeys: string[] = [];
    this.pluginAutomationState.forEach((_signature, key) => {
      if (!requests.has(key)) {
        staleKeys.push(key);
      }
    });
    staleKeys.forEach((key) => this.pluginAutomationState.delete(key));
  }

  private async releaseStalePluginInstances(
    activePluginInstances: Set<string>,
  ): Promise<void> {
    if (!this.pluginHost) {
      if (this.pluginBindings.size > 0 && activePluginInstances.size === 0) {
        this.pluginBindings.clear();
      }
      return;
    }

    const releases: Array<Promise<void>> = [];
    this.pluginBindings.forEach((binding, instanceId) => {
      if (!activePluginInstances.has(instanceId)) {
        releases.push(
          this.safeReleasePlugin(binding.hostInstanceId, instanceId).then(() => {
            this.pluginBindings.delete(instanceId);
          }),
        );
      }
    });
    await Promise.all(releases);

    if (activePluginInstances.size === 0) {
      this.pluginAutomationState.clear();
    } else {
      this.pluginAutomationState.forEach((_signature, key) => {
        const [instanceId] = key.split(':');
        if (!activePluginInstances.has(instanceId)) {
          this.pluginAutomationState.delete(key);
        }
      });
    }
  }

  private async safeReleasePlugin(
    hostInstanceId: string,
    sessionInstanceId: string,
  ): Promise<void> {
    if (!this.pluginHost) {
      return;
    }
    try {
      await this.pluginHost.releasePlugin(hostInstanceId);
    } catch (error) {
      this.logger.error('Failed to release plugin instance', {
        pluginInstanceId: sessionInstanceId,
        error,
      });
    }
  }
}

export type { AudioFileLoader, AudioFileData } from './bridge/ClipBufferCache';
