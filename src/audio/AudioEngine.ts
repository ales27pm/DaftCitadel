import { NativeAudioEngine, isNativeModuleAvailable } from './NativeAudioEngine';
import { AutomationLane, publishAutomationLane, ClockSyncService } from './Automation';

export type NodeConfiguration = {
  id: string;
  type: string;
  options?: Record<string, number | string | boolean>;
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

  public async uploadClipBuffer(
    bufferKey: string,
    sampleRate: number,
    channels: number,
    frames: number,
    channelData: ReadonlyArray<ArrayBuffer>,
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
    channelData.forEach((buffer, index) => {
      if (!(buffer instanceof ArrayBuffer)) {
        throw new Error(`channelData[${index}] must be an ArrayBuffer`);
      }
      if (buffer.byteLength < frames * bytesPerSample) {
        throw new Error(
          `channelData[${index}] byteLength ${buffer.byteLength} is insufficient for ${frames} frames`,
        );
      }
    });
    await NativeAudioEngine.registerClipBuffer(
      bufferKey,
      sampleRate,
      channels,
      frames,
      Array.from(channelData),
    );
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
