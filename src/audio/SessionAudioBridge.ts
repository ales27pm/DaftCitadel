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
  createClipBufferUploader,
} from './bridge/ClipBufferCache';
import {
  AutomationPublisher,
  describeAutomation,
  AutomationRequest,
} from './bridge/AutomationManager';
import { ConnectionKey, GraphReconciler } from './bridge/GraphReconciler';

type Logger = Pick<typeof console, 'debug' | 'info' | 'warn' | 'error'>;

type TrackNodeId = string;

type SessionState = {
  nodes: Map<string, NodeConfiguration>;
  connections: Set<ConnectionKey>;
  automations: Map<string, AutomationRequest>;
};

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

export interface SessionAudioBridgeOptions {
  fileLoader: AudioFileLoader;
  logger?: Logger;
}

export class SessionAudioBridge {
  private readonly clock: ClockSyncService;

  private readonly bufferCache: ClipBufferCache;

  private readonly graph: GraphReconciler;

  private readonly automationPublisher: AutomationPublisher;

  private readonly logger: Logger;

  private previousSessionRevision = -1;

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

    this.previousSessionRevision = session.revision;
  }

  private async buildDesiredState(
    session: Session,
    sampleRate: number,
  ): Promise<SessionState> {
    const nodes = new Map<string, NodeConfiguration>();
    const connections = new Set<ConnectionKey>();
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
    destinationNodeId: TrackNodeId,
    sampleRate: number,
  ): Promise<{
    node: NodeConfiguration;
    destinationNodeId: TrackNodeId;
    lane: AutomationLane;
    automationKey: string;
  }> {
    const bufferDescriptor = await this.bufferCache.getClipBuffer(
      clip.audioFile,
      sampleRate,
    );

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
    };
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

export type { AudioFileLoader, AudioFileData } from './bridge/ClipBufferCache';
