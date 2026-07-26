import { ClockSyncService, type AutomationLane } from './Automation';
import {
  createWebAudioContext,
  isWebAudioEngineAvailable,
} from './webAudioSupport';
import type {
  NodeConfiguration,
  RenderDiagnostics,
  TransportState,
} from './AudioEngine';

export type AutomationPublisher = (
  nodeId: string,
  lane: AutomationLane,
) => Promise<void>;

type ChannelPayload = ArrayBuffer | ArrayBufferView;

type ClipBufferDescriptor = {
  buffer: AudioBuffer;
  sampleRate: number;
  channels: number;
  frames: number;
  byteLength: number;
};

type ClipPlayerNode = {
  type: 'clipPlayer';
  bufferKey?: string;
  startFrame?: number;
  endFrame?: number;
  gain?: number;
};

type GenericAudioNode = {
  id: string;
  type: string;
  audioNode: GainNode;
  options: Record<string, number | string | boolean>;
  clipPlayer?: ClipPlayerNode;
};

export const OUTPUT_BUS = '__output__';

export class AudioEngine {
  private readonly sampleRate: number;
  private readonly framesPerBuffer: number;
  private readonly clock: ClockSyncService;
  private readonly publishAutomationLane: AutomationPublisher;
  private readonly context: AudioContext;
  private readonly nodes = new Map<string, GenericAudioNode>();
  private readonly connections = new Set<string>();
  private readonly clipBuffers = new Map<string, ClipBufferDescriptor>();
  private readonly activeClipSources = new Map<string, AudioBufferSourceNode>();
  private readonly nodeToBufferKey = new Map<string, string>();
  private readonly byteLengthByBuffer = new Map<string, number>();
  private transportFrame = 0;
  private transportStartedAtMs = 0;
  private transportStartFrame = 0;
  private isTransportRunning = false;
  private disposed = false;
  private lastRenderDiagnosticsAtMs = Date.now();

  constructor(
    params: { sampleRate: number; framesPerBuffer: number; bpm: number },
    options: { publishAutomation?: AutomationPublisher } = {},
  ) {
    if (!isWebAudioEngineAvailable()) {
      throw new Error('WebAudioEngine is unavailable');
    }
    if (params.sampleRate <= 0) {
      throw new Error('sampleRate must be positive');
    }
    if (params.framesPerBuffer <= 0) {
      throw new Error('framesPerBuffer must be positive');
    }
    const context = createWebAudioContext();
    if (!context) {
      throw new Error('WebAudioEngine failed to create context');
    }
    this.sampleRate = params.sampleRate;
    this.framesPerBuffer = params.framesPerBuffer;
    this.clock = new ClockSyncService(
      params.sampleRate,
      params.framesPerBuffer,
      params.bpm,
    );
    this.context = context;
    this.publishAutomationLane = options.publishAutomation ?? this.scheduleAutomation;
  }

  public getClock(): ClockSyncService {
    return this.clock;
  }

  public async init(): Promise<void> {
    if (this.disposed) {
      throw new Error('AudioEngine is disposed');
    }
    if (this.context.state === 'closed') {
      throw new Error('AudioContext is closed');
    }
    // Browsers keep resume() pending until a user gesture. startTransport()
    // resumes the context from the Play action instead of blocking app startup.
  }

  public async dispose(): Promise<void> {
    this.isTransportRunning = false;
    this.stopAllClipSources();
    this.connections.clear();
    this.nodeToBufferKey.clear();
    this.nodes.forEach((node) => {
      try {
        node.audioNode.disconnect();
      } catch {
        // Ignore disconnect failures during disposal.
      }
    });
    this.nodes.clear();
    this.activeClipSources.clear();
    this.disposed = true;
    try {
      await this.context.close();
    } catch {
      // Ignore close failures.
    }
  }

  public async configureNodes(nodes: NodeConfiguration[]): Promise<void> {
    if (this.disposed) {
      throw new Error('AudioEngine is disposed');
    }
    if (nodes.length === 0) {
      return;
    }

    nodes.forEach((node) => {
      const id = String(node.id).trim();
      if (!id) {
        throw new Error('Node id must be a non-empty string');
      }
      const type = String(node.type).trim();
      if (!type) {
        throw new Error('Node type must be a non-empty string');
      }
      if (this.nodes.has(id)) {
        throw new Error(`Node '${id}' already exists`);
      }

      const options = node.options ?? {};
      const audioNode = this.context.createGain();
      const gain = Number.isFinite(options.gain as number)
        ? (options.gain as number)
        : 1;
      audioNode.gain.value = gain;

      const entry: GenericAudioNode = {
        id,
        type,
        audioNode,
        options: { ...options },
      };

      if (type === 'clipPlayer') {
        const clipOptions = options as Record<string, unknown>;
        const startFrameValue = clipOptions.startFrame;
        const endFrameValue = clipOptions.endFrame;
        const gainValue = clipOptions.gain;
        entry.clipPlayer = {
          type: 'clipPlayer',
          bufferKey:
            typeof clipOptions.bufferKey === 'string'
              ? String(clipOptions.bufferKey)
              : undefined,
          startFrame:
            Number.isFinite(startFrameValue as number) &&
            (startFrameValue as number) >= 0
              ? Math.max(0, Math.floor(startFrameValue as number))
              : undefined,
          endFrame:
            Number.isFinite(endFrameValue as number) && (endFrameValue as number) >= 0
              ? Math.floor(endFrameValue as number)
              : undefined,
          gain:
            Number.isFinite(gainValue as number)
              ? (gainValue as number)
              : undefined,
        };
      }

      this.nodes.set(id, entry);
    });
  }

  public async connect(source: string, destination: string): Promise<void> {
    if (!source.trim() || !destination.trim()) {
      throw new Error('source and destination must be non-empty');
    }
    const key = this.connectionKey(source, destination);
    if (this.connections.has(key)) {
      return;
    }
    const sourceNode = this.nodes.get(source);
    if (!sourceNode) {
      throw new Error(`source node '${source}' not found`);
    }
    const audioNode = sourceNode.audioNode;
    if (destination === OUTPUT_BUS) {
      audioNode.connect(this.context.destination);
      this.connections.add(key);
      return;
    }
    const destinationNode = this.nodes.get(destination);
    if (!destinationNode) {
      throw new Error(`destination node '${destination}' not found`);
    }
    audioNode.connect(destinationNode.audioNode);
    this.connections.add(key);
  }

  public async disconnect(source: string, destination: string): Promise<void> {
    if (!source.trim() || !destination.trim()) {
      return;
    }
    const key = this.connectionKey(source, destination);
    if (!this.connections.delete(key)) {
      return;
    }
    const sourceNode = this.nodes.get(source);
    if (!sourceNode) {
      return;
    }
    if (destination === OUTPUT_BUS) {
      try {
        sourceNode.audioNode.disconnect(this.context.destination);
      } catch {
        // ignore
      }
      return;
    }
    const destinationNode = this.nodes.get(destination);
    if (!destinationNode) {
      return;
    }
    try {
      sourceNode.audioNode.disconnect(destinationNode.audioNode);
    } catch {
      // ignore
    }
  }

  public async publishAutomation(nodeId: string, lane: AutomationLane): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.publishAutomationLane(nodeId, lane);
  }

  public async startTransport(): Promise<void> {
    if (this.disposed) {
      throw new Error('AudioEngine is disposed');
    }
    this.transportStartFrame = this.transportFrame;
    this.transportStartedAtMs = this.nowMs();
    this.isTransportRunning = true;
    try {
      await this.context.resume();
    } catch {
      // Ignore transport resume errors.
    }
    this.scheduleClipPlayers();
  }

  public async stopTransport(): Promise<void> {
    if (!this.isTransportRunning) {
      return;
    }
    this.isTransportRunning = false;
    this.transportFrame = this.getTransportFrame();
    this.stopAllClipSources();
  }

  public async locateTransport(frame: number): Promise<void> {
    if (this.disposed) {
      throw new Error('AudioEngine is disposed');
    }
    if (!Number.isFinite(frame)) {
      throw new Error('frame must be finite');
    }
    if (frame < 0) {
      throw new Error('frame must be non-negative');
    }
    const sanitized = Math.floor(frame);
    this.transportFrame = sanitized;
    if (this.isTransportRunning) {
      this.transportStartFrame = sanitized;
      this.transportStartedAtMs = this.nowMs() - this.framesToMs(sanitized);
    }
  }

  public async getTransportState(): Promise<TransportState> {
    if (this.disposed) {
      throw new Error('AudioEngine is disposed');
    }
    const frame = this.getTransportFrame();
    return {
      frame,
      isPlaying: this.isTransportRunning,
    };
  }

  public async getRenderDiagnostics(): Promise<RenderDiagnostics> {
    if (this.disposed) {
      throw new Error('AudioEngine is disposed');
    }
    const now = this.nowMs();
    const renderDurationMicros = Math.max(
      0,
      Math.round((now - this.lastRenderDiagnosticsAtMs) * 1000),
    );
    this.lastRenderDiagnosticsAtMs = now;
    return {
      xruns: 0,
      lastRenderDurationMicros: renderDurationMicros,
      clipBufferBytes: this.totalClipBufferBytes(),
      initialized: true,
      activeVoices: this.activeClipSources.size,
    };
  }

  public async uploadClipBuffer(
    bufferKey: string,
    sampleRate: number,
    channels: number,
    frames: number,
    channelData: ReadonlyArray<ChannelPayload>,
  ): Promise<void> {
    if (this.disposed) {
      throw new Error('AudioEngine is disposed');
    }
    if (!bufferKey) {
      throw new Error('bufferKey must be a non-empty string');
    }
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error('sampleRate must be a positive number');
    }
    if (!Number.isInteger(channels) || channels <= 0 || channels > 64) {
      throw new Error(
        'channels must be a positive integer less than or equal to 64',
      );
    }
    if (!Number.isInteger(frames) || frames <= 0 || frames > 10_000_000) {
      throw new Error(
        'frames must be a positive integer not exceeding 10,000,000',
      );
    }
    if (!Array.isArray(channelData) || channelData.length !== channels) {
      throw new Error('channelData length must equal channels');
    }

    const audioBuffer = this.context.createBuffer(channels, frames, sampleRate);
    const descriptor = {
      buffer: audioBuffer,
      sampleRate,
      channels,
      frames,
      byteLength: 0,
    };
    let totalBytes = 0;

    channelData.forEach((channel, index) => {
      const source = ensureArrayBuffer(channel);
      const sourceFrames = source.byteLength / Float32Array.BYTES_PER_ELEMENT;
      if (!Number.isFinite(sourceFrames) || sourceFrames < frames) {
        throw new Error(
          `channelData[${index}] is insufficient for ${frames} frames`,
        );
      }
      const sourceChannel = new Float32Array(source);
      const sourceLength = sourceChannel.length;
      const targetChannel = audioBuffer.getChannelData(index);
      targetChannel.set(sourceChannel.subarray(0, Math.min(frames, sourceLength)), 0);
      const byteLength = frames * Float32Array.BYTES_PER_ELEMENT;
      totalBytes += byteLength;
      descriptor.byteLength += byteLength;
    });
    this.clipBuffers.set(bufferKey, descriptor);
    this.byteLengthByBuffer.set(bufferKey, totalBytes);
  }

  public async releaseClipBuffer(bufferKey: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!bufferKey) {
      throw new Error('bufferKey must be a non-empty string');
    }
    if (!this.clipBuffers.has(bufferKey)) {
      return;
    }

    const nodeIds = Array.from(this.nodeToBufferKey.entries())
      .filter(([, key]) => key === bufferKey)
      .map(([nodeId]) => nodeId);
    nodeIds.forEach((nodeId) => {
      this.stopClipPlayer(nodeId);
      this.nodeToBufferKey.delete(nodeId);
    });

    this.clipBuffers.delete(bufferKey);
    this.byteLengthByBuffer.delete(bufferKey);
  }

  public async removeNodes(nodeIds: string[]): Promise<void> {
    if (this.disposed) {
      return;
    }
    const ids = nodeIds.filter((nodeId) => nodeId.length > 0);
    ids.forEach((nodeId) => {
      this.stopClipPlayer(nodeId);
      this.connections.forEach((connection) => {
        const [source, destination] = connection.split('->');
        if (source === nodeId || destination === nodeId) {
          this.connections.delete(connection);
        }
      });
      const node = this.nodes.get(nodeId);
      if (!node) {
        return;
      }
      try {
        node.audioNode.disconnect();
      } catch {
        // ignore
      }
      this.nodes.delete(nodeId);
      this.nodeToBufferKey.delete(nodeId);
    });
  }

  private scheduleAutomation = async (
    nodeId: string,
    lane: AutomationLane,
  ): Promise<void> => {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Cannot schedule automation for unknown node ${nodeId}`);
    }
    const payload = lane.toPayload();
    const points = payload.points;
    if (points.length === 0) {
      return;
    }
    if (!node.audioNode?.gain?.setValueAtTime) {
      return;
    }
    if (payload.parameter !== 'gain' && payload.parameter !== 'volume') {
      return;
    }
    const gain = node.audioNode.gain;
    points.forEach((point) => {
      if (!Number.isFinite(point.value) || !Number.isFinite(point.frame)) {
        return;
      }
      const seconds = point.frame / this.sampleRate;
      try {
        gain.setValueAtTime(point.value, seconds + this.context.currentTime);
      } catch {
        // Ignore malformed points.
      }
    });
  };

  private stopAllClipSources(): void {
    this.activeClipSources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // ignore
      }
      try {
        source.disconnect();
      } catch {
        // ignore
      }
    });
    this.activeClipSources.clear();
  }

  private stopClipPlayer(nodeId: string): void {
    const source = this.activeClipSources.get(nodeId);
    if (!source) {
      return;
    }
    try {
      source.stop();
    } catch {
      // ignore
    }
    try {
      source.disconnect();
    } catch {
      // ignore
    }
    this.activeClipSources.delete(nodeId);
  }

  private scheduleClipPlayers(): void {
    this.nodes.forEach((node, nodeId) => {
      const clipPlayer = node.clipPlayer;
      if (!clipPlayer || !clipPlayer.bufferKey) {
        return;
      }
      if (this.activeClipSources.has(nodeId)) {
        return;
      }
      const descriptor = this.clipBuffers.get(clipPlayer.bufferKey);
      if (!descriptor) {
        return;
      }

      const source = this.context.createBufferSource();
      source.buffer = descriptor.buffer;
      source.connect(node.audioNode);
      this.activeClipSources.set(nodeId, source);
      this.nodeToBufferKey.set(nodeId, clipPlayer.bufferKey);

      const gainValue =
        clipPlayer.gain == null || Number.isNaN(clipPlayer.gain) ? 1 : clipPlayer.gain;
      node.audioNode.gain.value = gainValue;

      const clipStartFrame = Math.max(0, Math.floor(clipPlayer.startFrame ?? 0));
      const startOffsetSeconds = clipStartFrame / descriptor.sampleRate;

      try {
        source.start(0, startOffsetSeconds > 0 ? startOffsetSeconds : 0);
      } catch {
        try {
          source.stop();
        } catch {
          // ignore
        }
        this.activeClipSources.delete(nodeId);
      }
    });
  }

  private framesToMs(frame: number): number {
    return (frame / this.sampleRate) * 1000;
  }

  private getTransportFrame(): number {
    if (!this.isTransportRunning) {
      return this.transportFrame;
    }
    const elapsedFrames = this.clock.quantizeFrameToBuffer(
      Math.floor(
        ((this.nowMs() - this.transportStartedAtMs) / 1000) * this.sampleRate,
      ),
    );
    return this.transportStartFrame + elapsedFrames;
  }

  private nowMs(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  private connectionKey(source: string, destination: string): string {
    return `${source}->${destination}`;
  }

  private totalClipBufferBytes(): number {
    let total = 0;
    this.byteLengthByBuffer.forEach((byteLength) => {
      total += byteLength;
    });
    return total;
  }
}

const ensureArrayBuffer = (value: ChannelPayload): ArrayBuffer => {
  if (value instanceof ArrayBuffer) {
    return value;
  }
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
};
