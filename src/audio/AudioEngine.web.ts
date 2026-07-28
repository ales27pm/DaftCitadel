import { ClockSyncService, type AutomationLane } from './Automation';
import { createWebAudioContext, isWebAudioEngineAvailable } from './webAudioSupport';
import type { NodeConfiguration, RenderDiagnostics, TransportState } from './AudioEngine';
import type {
  NativeGraphApplyRequest,
  NativeGraphApplyResult,
  NativeGraphDescription,
  NativeGraphErrorCode,
  NativeGraphFailureStage,
} from './NativeAudioEngine';

export type AutomationPublisher = (nodeId: string, lane: AutomationLane) => Promise<void>;

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

type PreparedWebGraph = {
  nodes: Map<string, GenericAudioNode>;
  connections: Set<string>;
  outputGain: GainNode;
  clipSources: Map<string, AudioBufferSourceNode>;
  nodeToBufferKey: Map<string, string>;
  canonicalGraph: string;
  graphHash: string;
};

type WebGraphNodeRequest = {
  id: string;
  type: string;
  options?: Record<string, number | string | boolean>;
};

type WebGraphConnectionRequest = {
  source: string;
  destination: string;
};

export const OUTPUT_BUS = '__output__';

const EMPTY_GRAPH_CANONICAL = '{"connections":[],"nodes":[],"schemaVersion":1}';

let webEngineInstanceSequence = 0;

const nextWebEngineInstance = (): number => {
  webEngineInstanceSequence = (webEngineInstanceSequence + 1) % 1000;
  return Date.now() * 1000 + webEngineInstanceSequence;
};

const stableSerialize = (value: unknown): string => {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Graph options must contain only finite numbers');
    }
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error(`Unsupported graph option type '${typeof value}'`);
};

const hashCanonicalGraph = (canonicalGraph: string): string => {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < canonicalGraph.length; index += 1) {
    const code = canonicalGraph.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `web-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
};

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
  private readonly engineInstance = nextWebEngineInstance();
  private readonly graphResults = new Map<string, NativeGraphApplyResult>();
  private outputGain: GainNode;
  private graphTransactionQueue: Promise<void> = Promise.resolve();
  private generation = 0;
  private routeEpoch = 0;
  private canonicalGraph = EMPTY_GRAPH_CANONICAL;
  private graphHash = hashCanonicalGraph(EMPTY_GRAPH_CANONICAL);
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
    this.outputGain = context.createGain();
    this.outputGain.gain.value = 1;
    this.outputGain.connect(context.destination);
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
    try {
      this.outputGain.disconnect();
    } catch {
      // Ignore disconnect failures during disposal.
    }
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
      const gain = Number.isFinite(options.gain as number) ? (options.gain as number) : 1;
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
            Number.isFinite(startFrameValue as number) && (startFrameValue as number) >= 0
              ? Math.max(0, Math.floor(startFrameValue as number))
              : undefined,
          endFrame:
            Number.isFinite(endFrameValue as number) && (endFrameValue as number) >= 0
              ? Math.floor(endFrameValue as number)
              : undefined,
          gain: Number.isFinite(gainValue as number) ? (gainValue as number) : undefined,
        };
      }

      this.nodes.set(id, entry);
    });
  }

  public async describeGraph(): Promise<NativeGraphDescription> {
    return this.graphDescription();
  }

  public applyGraph(request: NativeGraphApplyRequest): Promise<NativeGraphApplyResult> {
    const operation = this.graphTransactionQueue.then(() => this.applyGraphNow(request));
    this.graphTransactionQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
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
      audioNode.connect(this.outputGain);
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
        sourceNode.audioNode.disconnect(this.outputGain);
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
      throw new Error('channels must be a positive integer less than or equal to 64');
    }
    if (!Number.isInteger(frames) || frames <= 0 || frames > 10_000_000) {
      throw new Error('frames must be a positive integer not exceeding 10,000,000');
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
        throw new Error(`channelData[${index}] is insufficient for ${frames} frames`);
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

  private async applyGraphNow(
    request: NativeGraphApplyRequest,
  ): Promise<NativeGraphApplyResult> {
    const transactionId = String(request.transactionId ?? '').trim();
    const cached = this.graphResults.get(transactionId);
    if (cached) {
      return cached;
    }
    if (!transactionId) {
      return this.graphFailureResult(
        request,
        'rejected',
        'validate',
        'invalid_request',
        'transactionId must be a non-empty string',
      );
    }
    if (this.disposed || this.context.state === 'closed') {
      return this.rememberGraphResult(
        transactionId,
        this.graphFailureResult(
          request,
          'rejected',
          'validate',
          'invalid_request',
          'Web audio engine is unavailable',
        ),
      );
    }

    this.synchronizeGraphIdentityFromMaps();
    const requestRecord = request as unknown as Record<string, unknown>;
    const expectedGeneration = this.expectedCounter(
      requestRecord,
      'expectedGeneration',
      'baseGeneration',
      'generation',
    );
    const expectedRouteEpoch = this.expectedCounter(
      requestRecord,
      'expectedRouteEpoch',
      'baseRouteEpoch',
      'routeEpoch',
    );
    const expectedEngineInstance = this.expectedCounter(
      requestRecord,
      'expectedEngineInstance',
      'baseEngineInstance',
      'engineInstance',
    );
    if (
      expectedGeneration == null ||
      expectedRouteEpoch == null ||
      expectedEngineInstance == null
    ) {
      return this.rememberGraphResult(
        transactionId,
        this.graphFailureResult(
          request,
          'rejected',
          'validate',
          'invalid_request',
          'Graph base counters must be safe integers',
        ),
      );
    }
    if (expectedEngineInstance !== this.engineInstance) {
      return this.rememberGraphResult(
        transactionId,
        this.graphFailureResult(
          request,
          'stale',
          'validate',
          'stale_engine_instance',
          `Expected engine ${expectedEngineInstance}, current engine is ${this.engineInstance}`,
        ),
      );
    }
    if (expectedRouteEpoch !== this.routeEpoch) {
      return this.rememberGraphResult(
        transactionId,
        this.graphFailureResult(
          request,
          'stale',
          'validate',
          'stale_route_epoch',
          `Expected route epoch ${expectedRouteEpoch}, current route epoch is ${this.routeEpoch}`,
        ),
      );
    }
    if (expectedGeneration !== this.generation) {
      return this.rememberGraphResult(
        transactionId,
        this.graphFailureResult(
          request,
          'stale',
          'validate',
          'stale_generation',
          `Expected generation ${expectedGeneration}, current generation is ${this.generation}`,
        ),
      );
    }

    let prepared: PreparedWebGraph;
    try {
      prepared = this.prepareWebGraph(
        request.nodes as WebGraphNodeRequest[],
        request.connections as WebGraphConnectionRequest[],
      );
    } catch (error) {
      return this.rememberGraphResult(
        transactionId,
        this.graphFailureResult(
          request,
          'rejected',
          'prepare',
          'invalid_request',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }

    if (prepared.canonicalGraph === this.canonicalGraph) {
      this.disposePreparedGraph(prepared);
      return this.rememberGraphResult(transactionId, {
        transactionId,
        status: 'committed',
        graph: this.graphDescription(),
      } as NativeGraphApplyResult);
    }

    const previousOutputGain = this.outputGain;
    const previousNodes = Array.from(this.nodes.values());
    const previousClipSources = Array.from(this.activeClipSources.values());
    const transitionDelayMs = this.activatePreparedGraph(prepared);

    if (transitionDelayMs > 0) {
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, transitionDelayMs);
      });
    }

    previousClipSources.forEach((source) => this.stopAndDisconnectSource(source));
    previousNodes.forEach((node) => this.disconnectNode(node.audioNode));
    this.disconnectNode(previousOutputGain);

    return this.rememberGraphResult(transactionId, {
      transactionId,
      status: 'committed',
      graph: this.graphDescription(),
    } as NativeGraphApplyResult);
  }

  private prepareWebGraph(
    requestedNodes: WebGraphNodeRequest[],
    requestedConnections: WebGraphConnectionRequest[],
  ): PreparedWebGraph {
    if (!Array.isArray(requestedNodes) || !Array.isArray(requestedConnections)) {
      throw new Error('nodes and connections must be arrays');
    }

    const nodes = new Map<string, GenericAudioNode>();
    requestedNodes.forEach((requestedNode) => {
      const entry = this.createWebNode(requestedNode as NodeConfiguration);
      if (entry.id.includes('->')) {
        throw new Error(`Node id '${entry.id}' contains a reserved connection token`);
      }
      if (nodes.has(entry.id)) {
        throw new Error(`Duplicate node id '${entry.id}'`);
      }
      nodes.set(entry.id, entry);
    });

    const connections = new Set<string>();
    const canonicalConnections: WebGraphConnectionRequest[] = [];
    requestedConnections.forEach((requestedConnection) => {
      const source = String(requestedConnection.source ?? '').trim();
      const destination = String(requestedConnection.destination ?? '').trim();
      if (!source || !destination) {
        throw new Error('Graph connection endpoints must be non-empty');
      }
      if (source === OUTPUT_BUS || !nodes.has(source)) {
        throw new Error(`Source node '${source}' does not exist`);
      }
      if (destination !== OUTPUT_BUS && !nodes.has(destination)) {
        throw new Error(`Destination node '${destination}' does not exist`);
      }
      const key = this.connectionKey(source, destination);
      if (connections.has(key)) {
        throw new Error(`Duplicate graph connection '${key}'`);
      }
      connections.add(key);
      canonicalConnections.push({ source, destination });
    });
    this.assertAcyclic(nodes, canonicalConnections);

    const canonicalGraph = this.canonicalGraphFor(nodes, canonicalConnections);
    const outputGain = this.context.createGain();
    outputGain.gain.value = 0;
    outputGain.connect(this.context.destination);
    const clipSources = new Map<string, AudioBufferSourceNode>();
    const nodeToBufferKey = new Map<string, string>();

    try {
      canonicalConnections.forEach(({ source, destination }) => {
        const sourceNode = nodes.get(source);
        if (!sourceNode) {
          throw new Error(`Source node '${source}' disappeared during preparation`);
        }
        if (destination === OUTPUT_BUS) {
          sourceNode.audioNode.connect(outputGain);
          return;
        }
        const destinationNode = nodes.get(destination);
        if (!destinationNode) {
          throw new Error(
            `Destination node '${destination}' disappeared during preparation`,
          );
        }
        sourceNode.audioNode.connect(destinationNode.audioNode);
      });
      if (this.isTransportRunning) {
        this.prepareClipSources(nodes, clipSources, nodeToBufferKey);
      }
    } catch (error) {
      clipSources.forEach((source) => this.stopAndDisconnectSource(source));
      nodes.forEach((node) => this.disconnectNode(node.audioNode));
      this.disconnectNode(outputGain);
      throw error;
    }

    return {
      nodes,
      connections,
      outputGain,
      clipSources,
      nodeToBufferKey,
      canonicalGraph,
      graphHash: hashCanonicalGraph(canonicalGraph),
    };
  }

  private activatePreparedGraph(prepared: PreparedWebGraph): number {
    const previousOutputGain = this.outputGain;
    let transitionDelayMs = 0;
    if (this.context.state === 'running') {
      const quantumSeconds = Math.max(128, this.framesPerBuffer) / this.sampleRate;
      const fadeSeconds = Math.min(0.02, Math.max(0.005, quantumSeconds));
      const transitionStart = this.context.currentTime + quantumSeconds;
      const transitionEnd = transitionStart + fadeSeconds;
      previousOutputGain.gain.cancelScheduledValues(this.context.currentTime);
      previousOutputGain.gain.setValueAtTime(
        previousOutputGain.gain.value,
        transitionStart,
      );
      previousOutputGain.gain.linearRampToValueAtTime(0, transitionEnd);
      prepared.outputGain.gain.cancelScheduledValues(this.context.currentTime);
      prepared.outputGain.gain.setValueAtTime(0, transitionStart);
      prepared.outputGain.gain.linearRampToValueAtTime(1, transitionEnd);
      // Look ahead by one render quantum, wait for the fade to complete, then
      // keep a 1 ms safety guard before tearing down the previous graph.
      transitionDelayMs =
        Math.ceil((transitionEnd - this.context.currentTime) * 1000) + 1;
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.debug('Web audio graph transition timing', {
          quantumSeconds,
          fadeSeconds,
          transitionStart,
          transitionEnd,
          transitionDelayMs,
        });
      }
    } else {
      previousOutputGain.gain.value = 0;
      prepared.outputGain.gain.value = 1;
    }

    this.nodes.clear();
    prepared.nodes.forEach((node, nodeId) => this.nodes.set(nodeId, node));
    this.connections.clear();
    prepared.connections.forEach((connection) => this.connections.add(connection));
    this.activeClipSources.clear();
    prepared.clipSources.forEach((source, nodeId) =>
      this.activeClipSources.set(nodeId, source),
    );
    this.nodeToBufferKey.clear();
    prepared.nodeToBufferKey.forEach((bufferKey, nodeId) =>
      this.nodeToBufferKey.set(nodeId, bufferKey),
    );
    this.outputGain = prepared.outputGain;
    this.canonicalGraph = prepared.canonicalGraph;
    this.graphHash = prepared.graphHash;
    this.generation += 1;
    return transitionDelayMs;
  }

  private disposePreparedGraph(prepared: PreparedWebGraph): void {
    prepared.clipSources.forEach((source) => this.stopAndDisconnectSource(source));
    prepared.nodes.forEach((node) => this.disconnectNode(node.audioNode));
    this.disconnectNode(prepared.outputGain);
  }

  private prepareClipSources(
    nodes: Map<string, GenericAudioNode>,
    clipSources: Map<string, AudioBufferSourceNode>,
    nodeToBufferKey: Map<string, string>,
  ): void {
    nodes.forEach((node, nodeId) => {
      const clipPlayer = node.clipPlayer;
      if (!clipPlayer?.bufferKey) {
        return;
      }
      const descriptor = this.clipBuffers.get(clipPlayer.bufferKey);
      if (!descriptor) {
        return;
      }
      const source = this.context.createBufferSource();
      source.buffer = descriptor.buffer;
      source.connect(node.audioNode);
      const gainValue =
        clipPlayer.gain == null || Number.isNaN(clipPlayer.gain) ? 1 : clipPlayer.gain;
      node.audioNode.gain.value = gainValue;
      const clipStartFrame = Math.max(0, Math.floor(clipPlayer.startFrame ?? 0));
      source.start(0, clipStartFrame / descriptor.sampleRate);
      clipSources.set(nodeId, source);
      nodeToBufferKey.set(nodeId, clipPlayer.bufferKey);
    });
  }

  private createWebNode(node: NodeConfiguration): GenericAudioNode {
    const id = String(node.id).trim();
    if (!id) {
      throw new Error('Node id must be a non-empty string');
    }
    const type = String(node.type).trim();
    if (!type) {
      throw new Error('Node type must be a non-empty string');
    }
    const options = node.options ?? {};
    stableSerialize(options);
    const audioNode = this.context.createGain();
    const gain = Number.isFinite(options.gain as number) ? (options.gain as number) : 1;
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
          Number.isFinite(startFrameValue as number) && (startFrameValue as number) >= 0
            ? Math.max(0, Math.floor(startFrameValue as number))
            : undefined,
        endFrame:
          Number.isFinite(endFrameValue as number) && (endFrameValue as number) >= 0
            ? Math.floor(endFrameValue as number)
            : undefined,
        gain: Number.isFinite(gainValue as number) ? (gainValue as number) : undefined,
      };
    }
    return entry;
  }

  private assertAcyclic(
    nodes: Map<string, GenericAudioNode>,
    connections: WebGraphConnectionRequest[],
  ): void {
    const outgoing = new Map<string, string[]>();
    nodes.forEach((_node, nodeId) => outgoing.set(nodeId, []));
    connections.forEach(({ source, destination }) => {
      if (destination !== OUTPUT_BUS) {
        outgoing.get(source)?.push(destination);
      }
    });
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (nodeId: string): void => {
      if (visiting.has(nodeId)) {
        throw new Error(`Audio graph contains a cycle through '${nodeId}'`);
      }
      if (visited.has(nodeId)) {
        return;
      }
      visiting.add(nodeId);
      outgoing.get(nodeId)?.forEach(visit);
      visiting.delete(nodeId);
      visited.add(nodeId);
    };
    nodes.forEach((_node, nodeId) => visit(nodeId));
  }

  private canonicalGraphFor(
    nodes: Map<string, GenericAudioNode>,
    connections: WebGraphConnectionRequest[],
  ): string {
    const canonicalNodes = Array.from(nodes.values())
      .map((node) => ({ id: node.id, options: node.options, type: node.type }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const canonicalConnections = connections
      .map(({ source, destination }) => ({ destination, source }))
      .sort((left, right) => {
        const sourceComparison = left.source.localeCompare(right.source);
        return sourceComparison !== 0
          ? sourceComparison
          : left.destination.localeCompare(right.destination);
      });
    return stableSerialize({
      connections: canonicalConnections,
      nodes: canonicalNodes,
      schemaVersion: 1,
    });
  }

  private synchronizeGraphIdentityFromMaps(): void {
    const connections = Array.from(this.connections).map((connection) => {
      const delimiter = connection.indexOf('->');
      return {
        source: connection.slice(0, delimiter),
        destination: connection.slice(delimiter + 2),
      };
    });
    const currentCanonicalGraph = this.canonicalGraphFor(this.nodes, connections);
    if (currentCanonicalGraph === this.canonicalGraph) {
      return;
    }
    this.canonicalGraph = currentCanonicalGraph;
    this.graphHash = hashCanonicalGraph(currentCanonicalGraph);
    this.generation += 1;
  }

  private graphDescription(): NativeGraphDescription {
    this.synchronizeGraphIdentityFromMaps();
    return {
      generation: this.generation,
      graphHash: this.graphHash,
      nodeIds: Array.from(this.nodes.keys()).sort(),
      routeEpoch: this.routeEpoch,
      engineInstance: this.engineInstance,
    };
  }

  private graphFailureResult(
    request: NativeGraphApplyRequest,
    status: 'stale' | 'rejected',
    stage: NativeGraphFailureStage,
    code: NativeGraphErrorCode,
    message: string,
  ): NativeGraphApplyResult {
    return {
      transactionId: String(request.transactionId ?? ''),
      status,
      graph: this.graphDescription(),
      failure: { stage, code, nodeId: '', detail: message },
    } as NativeGraphApplyResult;
  }

  private rememberGraphResult(
    transactionId: string,
    result: NativeGraphApplyResult,
  ): NativeGraphApplyResult {
    if (this.graphResults.size >= 64) {
      const oldest = this.graphResults.keys().next().value as string | undefined;
      if (oldest) {
        this.graphResults.delete(oldest);
      }
    }
    this.graphResults.set(transactionId, result);
    return result;
  }

  private expectedCounter(
    request: Record<string, unknown>,
    ...keys: string[]
  ): number | null {
    for (const key of keys) {
      const value = request[key];
      if (Number.isSafeInteger(value) && (value as number) >= 0) {
        return value as number;
      }
    }
    return null;
  }

  private stopAndDisconnectSource(source: AudioBufferSourceNode): void {
    try {
      source.stop();
    } catch {
      // Ignore sources that have already stopped.
    }
    this.disconnectNode(source);
  }

  private disconnectNode(node: AudioNode): void {
    try {
      node.disconnect();
    } catch {
      // Ignore nodes that are already disconnected.
    }
  }

  private framesToMs(frame: number): number {
    return (frame / this.sampleRate) * 1000;
  }

  private getTransportFrame(): number {
    if (!this.isTransportRunning) {
      return this.transportFrame;
    }
    const elapsedFrames = this.clock.quantizeFrameToBuffer(
      Math.floor(((this.nowMs() - this.transportStartedAtMs) / 1000) * this.sampleRate),
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
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};
