import { NativeAudioEngine, isNativeModuleAvailable } from './NativeAudioEngine';
import { AutomationLane, publishAutomationLane, ClockSyncService } from './Automation';

type ChannelPayload =
  | ArrayBuffer
  | ArrayBufferView
  | ReadonlyArray<number>
  | { buffer: ArrayBuffer; byteOffset: number; byteLength: number };

type NormalizedChannel = {
  buffer: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
};

const isArrayBufferPayload = (value: unknown): value is ArrayBuffer => {
  if (value instanceof ArrayBuffer) {
    return true;
  }
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
};

const isArrayBufferViewPayload = (value: unknown): value is ArrayBufferView => {
  return typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value);
};

const isNodeBufferLike = (
  value: unknown,
): value is { buffer: ArrayBuffer; byteOffset: number; byteLength: number } => {
  const globalBuffer = (
    globalThis as {
      Buffer?: { isBuffer?: (candidate: unknown) => boolean };
    }
  ).Buffer;
  if (!globalBuffer || typeof globalBuffer.isBuffer !== 'function') {
    return false;
  }
  return globalBuffer.isBuffer(value);
};

const isNumericArray = (value: unknown): value is ReadonlyArray<number> => {
  if (!Array.isArray(value)) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const element = value[index];
    if (!Number.isFinite(element)) {
      return false;
    }
  }
  return true;
};

const normalizeChannelPayload = (payload: ChannelPayload): NormalizedChannel => {
  if (isArrayBufferPayload(payload)) {
    return {
      buffer: payload,
      byteOffset: 0,
      byteLength: payload.byteLength,
    };
  }
  if (isArrayBufferViewPayload(payload)) {
    if (!(payload instanceof Float32Array)) {
      throw new Error('channelData typed views must be Float32Array (Float32 PCM)');
    }
    return {
      buffer: payload.buffer,
      byteOffset: payload.byteOffset,
      byteLength: payload.byteLength,
    };
  }
  if (isNodeBufferLike(payload)) {
    return {
      buffer: payload.buffer,
      byteOffset: payload.byteOffset,
      byteLength: payload.byteLength,
    };
  }
  if (isNumericArray(payload)) {
    const channel = new Float32Array(payload.length);
    for (let i = 0; i < payload.length; i += 1) {
      channel[i] = payload[i];
    }
    return {
      buffer: channel.buffer,
      byteOffset: channel.byteOffset,
      byteLength: channel.byteLength,
    };
  }
  throw new Error(
    'channelData entries must be ArrayBuffers, Float32Array views, Node Buffers, or numeric arrays',
  );
};

export type NodeConfiguration = {
  id: string;
  type: string;
  options?: Record<string, number | string | boolean>;
};

export type TransportState = {
  frame: number;
  isPlaying: boolean;
};

export type RenderDiagnostics = {
  xruns: number;
  lastRenderDurationMicros: number;
  clipBufferBytes: number;
};

export class AudioEngine {
  private readonly sampleRate: number;
  private readonly framesPerBuffer: number;
  private readonly clock: ClockSyncService;

  constructor(params: { sampleRate: number; framesPerBuffer: number; bpm: number }) {
    if (!isNativeModuleAvailable()) {
      throw new Error('AudioEngine native module is unavailable');
    }
    if (params.sampleRate <= 0) {
      throw new Error('sampleRate must be positive');
    }
    if (params.framesPerBuffer <= 0) {
      throw new Error('framesPerBuffer must be positive');
    }
    this.sampleRate = params.sampleRate;
    this.framesPerBuffer = params.framesPerBuffer;
    this.clock = new ClockSyncService(
      params.sampleRate,
      params.framesPerBuffer,
      params.bpm,
    );
  }

  public getClock(): ClockSyncService {
    return this.clock;
  }

  public async init(): Promise<void> {
    await NativeAudioEngine.initialize(this.sampleRate, this.framesPerBuffer);
  }

  public async dispose(): Promise<void> {
    await NativeAudioEngine.shutdown();
  }

  public async configureNodes(nodes: NodeConfiguration[]): Promise<void> {
    if (nodes.length === 0) {
      return;
    }

    await Promise.all(
      nodes.map((node) =>
        NativeAudioEngine.addNode(node.id, node.type, node.options ?? {}),
      ),
    );
  }

  public async connect(source: string, destination: string): Promise<void> {
    await NativeAudioEngine.connectNodes(source, destination);
  }

  public async disconnect(source: string, destination: string): Promise<void> {
    await NativeAudioEngine.disconnectNodes(source, destination);
  }

  public async publishAutomation(nodeId: string, lane: AutomationLane): Promise<void> {
    await publishAutomationLane(nodeId, lane);
  }

  public async startTransport(): Promise<void> {
    await NativeAudioEngine.startTransport();
  }

  public async stopTransport(): Promise<void> {
    await NativeAudioEngine.stopTransport();
  }

  public async locateTransport(frame: number): Promise<void> {
    if (!Number.isFinite(frame)) {
      throw new Error('frame must be finite');
    }
    if (frame < 0) {
      throw new Error('frame must be non-negative');
    }
    await NativeAudioEngine.locateTransport(Math.floor(frame));
  }

  public async getTransportState(): Promise<TransportState> {
    const state = await NativeAudioEngine.getTransportState();
    if (
      typeof state !== 'object' ||
      state === null ||
      !Number.isFinite((state as { currentFrame?: unknown }).currentFrame) ||
      typeof (state as { isPlaying?: unknown }).isPlaying !== 'boolean'
    ) {
      throw new Error('AudioEngine returned invalid transport state');
    }
    const currentFrame = Math.max(
      0,
      Math.floor((state as { currentFrame: number }).currentFrame),
    );
    return {
      frame: currentFrame,
      isPlaying: Boolean((state as { isPlaying: boolean }).isPlaying),
    };
  }

  public async getRenderDiagnostics(): Promise<RenderDiagnostics> {
    const diagnostics = await NativeAudioEngine.getRenderDiagnostics();
    if (
      typeof diagnostics !== 'object' ||
      diagnostics === null ||
      !Number.isFinite(diagnostics.xruns) ||
      !Number.isFinite(diagnostics.lastRenderDurationMicros) ||
      !Number.isFinite(diagnostics.clipBufferBytes)
    ) {
      throw new Error('AudioEngine returned invalid diagnostics payload');
    }
    return diagnostics;
  }

  public async uploadClipBuffer(
    bufferKey: string,
    sampleRate: number,
    channels: number,
    frames: number,
    channelData: ReadonlyArray<ChannelPayload>,
  ): Promise<void> {
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
    const bytesPerSample = 4; // Float32 PCM
    const normalizedChannels = channelData.map((payload, index) => {
      const source = normalizeChannelPayload(payload);
      let workingBuffer = source.buffer;
      let byteOffset = source.byteOffset;
      let byteLength = source.byteLength;

      const hasAlignmentMetadata =
        Number.isInteger(byteOffset) && Number.isInteger(byteLength);

      if (
        hasAlignmentMetadata &&
        (byteOffset % bytesPerSample !== 0 || byteLength % bytesPerSample !== 0)
      ) {
        const alignedCopy = new Uint8Array(byteLength);
        alignedCopy.set(new Uint8Array(workingBuffer, byteOffset, byteLength));
        workingBuffer = alignedCopy.buffer;
        byteOffset = 0;
        byteLength = alignedCopy.byteLength;
      }

      const contiguousBuffer =
        byteOffset === 0 && byteLength === workingBuffer.byteLength
          ? workingBuffer
          : workingBuffer.slice(byteOffset, byteOffset + byteLength);

      if (contiguousBuffer.byteLength % bytesPerSample !== 0) {
        throw new Error(
          `channelData[${index}] byteLength ${contiguousBuffer.byteLength} is not 4-byte aligned for Float32 PCM`,
        );
      }
      if (contiguousBuffer.byteLength < frames * bytesPerSample) {
        throw new Error(
          `channelData[${index}] byteLength ${contiguousBuffer.byteLength} is insufficient for ${frames} frames`,
        );
      }
      return contiguousBuffer;
    });
    await NativeAudioEngine.registerClipBuffer(
      bufferKey,
      sampleRate,
      channels,
      frames,
      normalizedChannels,
    );
  }

  public async releaseClipBuffer(bufferKey: string): Promise<void> {
    if (typeof bufferKey !== 'string' || bufferKey.length === 0) {
      throw new Error('bufferKey must be a non-empty string');
    }
    await NativeAudioEngine.unregisterClipBuffer(bufferKey);
  }

  public async removeNodes(nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) {
      return;
    }

    await Promise.all(nodeIds.map((nodeId) => NativeAudioEngine.removeNode(nodeId)));
  }
}

export { AutomationLane, publishAutomationLane, ClockSyncService };
export const OUTPUT_BUS = '__output__';
