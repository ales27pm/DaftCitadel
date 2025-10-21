import { Buffer } from 'buffer';
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
import { NativeAudioEngine } from './NativeAudioEngine';

type Logger = Pick<typeof console, 'debug' | 'info' | 'warn' | 'error'>;

export interface AudioFileData {
  sampleRate: number;
  channels: number;
  frames: number;
  data: Float32Array[];
}

export interface AudioFileLoader {
  load(filePath: string): Promise<AudioFileData>;
}

type CachedClipBuffer = {
  bufferKey: string;
  sampleRate: number;
  channels: number;
  frames: number;
  base64Channels: string[];
};

type AutomationRequest = {
  nodeId: string;
  lane: AutomationLane;
  signature: string;
};

const connectionKey = (source: string, destination: string): string =>
  `${source}->${destination}`;

const isTrackEndpointNode = (node: RoutingNode): node is TrackEndpointNode =>
  node.type === 'trackInput' || node.type === 'trackOutput';

const isPluginNode = (node: RoutingNode): node is PluginRoutingNode =>
  node.type === 'plugin';

const DEFAULT_LOGGER: Logger = {
  debug: (...args: unknown[]) => console.debug('[SessionAudioBridge]', ...args),
  info: (...args: unknown[]) => console.info('[SessionAudioBridge]', ...args),
  warn: (...args: unknown[]) => console.warn('[SessionAudioBridge]', ...args),
  error: (...args: unknown[]) => console.error('[SessionAudioBridge]', ...args),
};

const hashString = (value: string): string => {
  let hash = 0;
  const max = 0xffffffff;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % (max + 1);
  }
  return Math.abs(hash).toString(16);
};

const toBase64 = (view: Uint8Array): string => {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64');
  }

  let binary = '';
  for (let i = 0; i < view.byteLength; i += 1) {
    binary += String.fromCharCode(view[i]);
  }
  if (typeof globalThis.btoa === 'function') {
    return globalThis.btoa(binary);
  }
  throw new Error('No base64 encoder available');
};

const float32ArrayToBase64 = (data: Float32Array): string => {
  const buffer = new Uint8Array(data.length * 4);
  const view = new DataView(buffer.buffer);
  for (let i = 0; i < data.length; i += 1) {
    view.setFloat32(i * 4, data[i], true);
  }
  return toBase64(buffer);
};

class ClipBufferCache {
  private readonly cache = new Map<string, CachedClipBuffer>();

  constructor(
    private readonly loader: AudioFileLoader,
    private readonly logger: Logger,
  ) {}

  async getClipBuffer(
    filePath: string,
    targetSampleRate: number,
  ): Promise<CachedClipBuffer> {
    const key = `${filePath}@${targetSampleRate}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.logger.debug('ClipBufferCache hit', { filePath, targetSampleRate });
      return cached;
    }

    const decoded = await this.loader.load(filePath);
    if (decoded.channels <= 0) {
      throw new Error(`Audio file ${filePath} has no channels`);
    }
    if (decoded.data.length !== decoded.channels) {
      throw new Error(`Audio file ${filePath} channel data mismatch`);
    }

    const prepared =
      decoded.sampleRate === targetSampleRate
        ? decoded
        : await this.resampleBuffer(decoded, targetSampleRate);

    if (decoded.sampleRate !== targetSampleRate) {
      this.logger.info(
        `Resampled ${filePath} from ${decoded.sampleRate}Hz to ${targetSampleRate}Hz`,
      );
    }

    const base64Channels = prepared.data.map((channel) => float32ArrayToBase64(channel));
    const clipBuffer: CachedClipBuffer = {
      bufferKey: hashString(`${filePath}:${targetSampleRate}:${prepared.frames}`),
      sampleRate: targetSampleRate,
      channels: prepared.channels,
      frames: prepared.frames,
      base64Channels,
    };
    this.cache.set(key, clipBuffer);
    return clipBuffer;
  }

  private async resampleBuffer(
    buffer: AudioFileData,
    targetSampleRate: number,
  ): Promise<AudioFileData> {
    const ratio = targetSampleRate / buffer.sampleRate;
    const nextFrameCount = Math.max(1, Math.round(buffer.frames * ratio));
    const resampledChannels = buffer.data.map((channel) =>
      this.resampleChannel(channel, ratio, nextFrameCount),
    );
    return {
      sampleRate: targetSampleRate,
      channels: buffer.channels,
      frames: nextFrameCount,
      data: resampledChannels,
    };
  }

  private resampleChannel(
    channel: Float32Array,
    ratio: number,
    nextFrameCount: number,
  ): Float32Array {
    const result = new Float32Array(nextFrameCount);
    const maxIndex = channel.length - 1;
    for (let i = 0; i < nextFrameCount; i += 1) {
      const sourceIndex = i / ratio;
      const indexFloor = Math.floor(sourceIndex);
      const indexCeil = Math.min(indexFloor + 1, maxIndex);
      const t = sourceIndex - indexFloor;
      const start = channel[indexFloor] ?? 0;
      const end = channel[indexCeil] ?? start;
      result[i] = start + (end - start) * t;
    }
    return result;
  }
}

export interface SessionAudioBridgeOptions {
  fileLoader: AudioFileLoader;
  logger?: Logger;
}

type AudioEngineWithRemoval = AudioEngine & {
  removeNodes(nodeIds: string[]): Promise<void>;
};

export class SessionAudioBridge {
  private readonly clock: ClockSyncService;

  private readonly bufferCache: ClipBufferCache;

  private readonly logger: Logger;

  private previousSessionRevision = -1;

  private readonly nodeState = new Map<string, NodeConfiguration>();

  private readonly connectionState = new Set<string>();

  private readonly automationState = new Map<string, string>();

  constructor(
    private readonly audioEngine: AudioEngine,
    options: SessionAudioBridgeOptions,
  ) {
    if (!options.fileLoader) {
      throw new Error('SessionAudioBridge requires an AudioFileLoader');
    }
    this.clock = audioEngine.getClock();
    this.logger = options.logger ?? DEFAULT_LOGGER;
    this.bufferCache = new ClipBufferCache(options.fileLoader, this.logger);
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
    const sampleRate = engineDescription.sampleRate;
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error('AudioEngine clock reports invalid sample rate');
    }

    if (session.metadata.sampleRate !== sampleRate) {
      this.logger.warn(
        `Session sample rate ${session.metadata.sampleRate} does not match engine sample rate ${sampleRate}; resampling clips`,
      );
    }

    const desiredState = await this.buildDesiredState(session, sampleRate);

    await this.reconcileConnections(desiredState.connections);
    await this.reconcileNodes(desiredState.nodes);
    await this.reconcileConnections(desiredState.connections, desiredState.nodes);
    await this.publishAutomationChanges(desiredState.automations);

    this.previousSessionRevision = session.revision;
  }

  private async buildDesiredState(
    session: Session,
    sampleRate: number,
  ): Promise<{
    nodes: Map<string, NodeConfiguration>;
    connections: Set<string>;
    automations: Map<string, AutomationRequest>;
  }> {
    const nodes = new Map<string, NodeConfiguration>();
    const connections = new Set<string>();
    const automations = new Map<string, AutomationRequest>();

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
          nodes.set(node.id, this.createNodeConfiguration(node));
        });

        graph.connections.forEach((connection) => {
          connections.add(connectionKey(connection.from.nodeId, connection.to.nodeId));
        });

        if (trackOutput) {
          connections.add(connectionKey(trackOutput.id, OUTPUT_BUS));
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
              signature: this.describeAutomation(trackOutput.id, lane),
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
              const clipResult = await this.prepareClipNode(
                track,
                clip,
                trackInput.id,
                sampleRate,
              );
              nodes.set(clipResult.node.id, clipResult.node);
              connections.add(
                connectionKey(clipResult.node.id, clipResult.destinationNodeId),
              );
              automations.set(clipResult.automationKey, {
                nodeId: clipResult.node.id,
                lane: clipResult.lane,
                signature: this.describeAutomation(clipResult.node.id, clipResult.lane),
              });
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

    return { nodes, connections, automations };
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
          order: node.order,
          bypassed: node.bypassed ?? false,
        },
      };
    }
    if (node.type === 'send' || node.type === 'return') {
      return {
        id: node.id,
        type: node.type,
        options: {
          busId: node.busId,
          preFader: node.preFader,
          gain: node.gain,
        },
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
    destinationNodeId: string,
    sampleRate: number,
  ): Promise<{
    node: NodeConfiguration;
    destinationNodeId: string;
    lane: AutomationLane;
    automationKey: string;
  }> {
    const buffer = await this.bufferCache.getClipBuffer(clip.audioFile, sampleRate);
    const startFrame = this.quantizeFrame(this.msToFrames(clip.start, sampleRate));
    const durationFrames = Math.max(1, this.msToFrames(clip.duration, sampleRate));
    const endFrame = this.quantizeFrame(startFrame + durationFrames);
    const fadeInFrames = Math.min(
      durationFrames,
      this.msToFrames(clip.fadeIn, sampleRate),
    );
    const fadeOutFrames = Math.min(
      durationFrames,
      this.msToFrames(clip.fadeOut, sampleRate),
    );

    const payload = JSON.stringify({
      bufferKey: buffer.bufferKey,
      sampleRate: buffer.sampleRate,
      channels: buffer.channels,
      frames: buffer.frames,
      data: buffer.base64Channels,
    });

    const nodeId = `clip:${clip.id}`;
    const node: NodeConfiguration = {
      id: nodeId,
      type: 'clipPlayer',
      options: {
        trackId: track.id,
        payload,
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
      const fadeStart = this.quantizeFrame(endFrame - fadeOutFrames);
      lane.addPoint({ frame: fadeStart, value: clip.gain });
      lane.addPoint({ frame: endFrame, value: 0 });
    } else {
      lane.addPoint({ frame: endFrame, value: clip.gain });
    }

    return {
      node,
      destinationNodeId,
      lane,
      automationKey: `${nodeId}:gain`,
    };
  }

  private async reconcileNodes(desired: Map<string, NodeConfiguration>): Promise<void> {
    const nodesToRemove: string[] = [];
    this.nodeState.forEach((existingConfig, nodeId) => {
      const nextConfig = desired.get(nodeId);
      if (!nextConfig) {
        nodesToRemove.push(nodeId);
        return;
      }
      if (!this.nodeConfigurationEquals(existingConfig, nextConfig)) {
        nodesToRemove.push(nodeId);
      }
    });

    if (nodesToRemove.length > 0) {
      const connectionKeysToClear: string[] = [];
      this.connectionState.forEach((key) => {
        const [source, destination] = key.split('->');
        if (nodesToRemove.includes(source) || nodesToRemove.includes(destination)) {
          connectionKeysToClear.push(key);
        }
      });
      connectionKeysToClear.forEach((key) => this.connectionState.delete(key));
      await this.removeNodes(nodesToRemove);
      nodesToRemove.forEach((nodeId) => {
        this.nodeState.delete(nodeId);
      });
    }

    const nodesToAdd: NodeConfiguration[] = [];
    desired.forEach((config, nodeId) => {
      const existing = this.nodeState.get(nodeId);
      if (!existing || !this.nodeConfigurationEquals(existing, config)) {
        nodesToAdd.push(config);
      }
    });

    if (nodesToAdd.length > 0) {
      await this.audioEngine.configureNodes(nodesToAdd);
      nodesToAdd.forEach((config) => {
        this.nodeState.set(config.id, config);
      });
    }

    desired.forEach((config, nodeId) => {
      this.nodeState.set(nodeId, config);
    });
  }

  private async reconcileConnections(
    desired: Set<string>,
    nodes?: Map<string, NodeConfiguration>,
  ): Promise<void> {
    const toDisconnect: string[] = [];
    this.connectionState.forEach((key) => {
      if (!desired.has(key)) {
        toDisconnect.push(key);
      }
    });

    if (toDisconnect.length > 0) {
      await Promise.all(
        toDisconnect.map((key) => {
          const [source, destination] = key.split('->');
          return this.audioEngine.disconnect(source, destination);
        }),
      );
      toDisconnect.forEach((key) => this.connectionState.delete(key));
    }

    if (nodes) {
      const toConnect: string[] = [];
      desired.forEach((key) => {
        if (this.connectionState.has(key)) {
          return;
        }
        const [source] = key.split('->');
        if (!nodes.has(source) && !this.nodeState.has(source)) {
          return;
        }
        toConnect.push(key);
      });

      if (toConnect.length > 0) {
        await Promise.all(
          toConnect.map((key) => {
            const [source, destination] = key.split('->');
            return this.audioEngine.connect(source, destination);
          }),
        );
        toConnect.forEach((key) => this.connectionState.add(key));
      }
    }
  }

  private async publishAutomationChanges(
    requests: Map<string, AutomationRequest>,
  ): Promise<void> {
    const toPublish: AutomationRequest[] = [];
    requests.forEach((request, key) => {
      const existingSignature = this.automationState.get(key);
      if (existingSignature === request.signature) {
        return;
      }
      toPublish.push(request);
      this.automationState.set(key, request.signature);
    });

    const publishOperations = toPublish.map((request) =>
      this.audioEngine.publishAutomation(request.nodeId, request.lane),
    );
    await Promise.all(publishOperations);

    const staleKeys: string[] = [];
    this.automationState.forEach((_signature, key) => {
      if (!requests.has(key)) {
        staleKeys.push(key);
      }
    });
    staleKeys.forEach((key) => this.automationState.delete(key));
  }

  private describeAutomation(nodeId: string, lane: AutomationLane): string {
    const payload = lane.toPayload();
    const pointSig = payload.points
      .map((point) => `${point.frame}:${point.value.toFixed(6)}`)
      .join('|');
    return `${nodeId}:${payload.parameter}:${pointSig}`;
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

  private async removeNodes(nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) {
      return;
    }
    const engine = this.audioEngine as AudioEngineWithRemoval;
    if (typeof engine.removeNodes === 'function') {
      await engine.removeNodes(nodeIds);
      return;
    }
    await Promise.all(nodeIds.map((nodeId) => NativeAudioEngine.removeNode(nodeId)));
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
}

export type { CachedClipBuffer };
