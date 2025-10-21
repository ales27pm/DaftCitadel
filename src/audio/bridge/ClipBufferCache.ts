import type { AudioEngine } from '../AudioEngine';

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

export interface ClipBufferDescriptor {
  bufferKey: string;
  sampleRate: number;
  channels: number;
  frames: number;
}

export interface ClipBufferUploader {
  uploadClipBuffer(
    bufferKey: string,
    sampleRate: number,
    channels: number,
    frames: number,
    channelData: ReadonlyArray<ArrayBuffer>,
  ): Promise<void>;
}

type CacheKey = string;

type CacheEntry = {
  descriptor: ClipBufferDescriptor;
  upload: Promise<void>;
};

const hashString = (value: string): string => {
  let hash = 0;
  const max = 0xffffffff;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % (max + 1);
  }
  return Math.abs(hash).toString(16);
};

const ensureArrayBuffer = (channel: Float32Array): ArrayBuffer => {
  if (channel.byteOffset === 0 && channel.byteLength === channel.buffer.byteLength) {
    return channel.buffer;
  }
  const start = channel.byteOffset;
  const end = channel.byteOffset + channel.byteLength;
  return channel.buffer.slice(start, end);
};

export class ClipBufferCache {
  private readonly cache = new Map<CacheKey, CacheEntry>();

  constructor(
    private readonly loader: AudioFileLoader,
    private readonly uploader: ClipBufferUploader,
    private readonly logger: Logger,
  ) {}

  async getClipBuffer(
    filePath: string,
    targetSampleRate: number,
  ): Promise<ClipBufferDescriptor> {
    const key = this.buildCacheKey(filePath, targetSampleRate);
    const cached = this.cache.get(key);
    if (cached) {
      this.logger.debug('ClipBufferCache hit', { filePath, targetSampleRate });
      await cached.upload;
      return cached.descriptor;
    }

    const decoded = await this.loader.load(filePath);
    this.validateDecodedBuffer(filePath, decoded);

    const prepared =
      decoded.sampleRate === targetSampleRate
        ? decoded
        : this.resampleBuffer(decoded, targetSampleRate);

    if (decoded.sampleRate !== targetSampleRate) {
      this.logger.info(
        `Resampled ${filePath} from ${decoded.sampleRate}Hz to ${targetSampleRate}Hz`,
      );
    }

    const descriptor: ClipBufferDescriptor = {
      bufferKey: hashString(
        `${filePath}:${targetSampleRate}:${prepared.frames}:${prepared.channels}`,
      ),
      sampleRate: targetSampleRate,
      channels: prepared.channels,
      frames: prepared.frames,
    };

    const channelPayload = prepared.data.map((channel) => ensureArrayBuffer(channel));

    const upload = this.uploader.uploadClipBuffer(
      descriptor.bufferKey,
      descriptor.sampleRate,
      descriptor.channels,
      descriptor.frames,
      channelPayload,
    );

    this.cache.set(key, { descriptor, upload });
    try {
      await upload;
    } catch (error) {
      this.cache.delete(key);
      throw error;
    }
    return descriptor;
  }

  private validateDecodedBuffer(filePath: string, data: AudioFileData): void {
    if (data.channels <= 0) {
      throw new Error(`Audio file ${filePath} has no channels`);
    }
    if (data.frames <= 0) {
      throw new Error(`Audio file ${filePath} contains no audio frames`);
    }
    if (data.data.length !== data.channels) {
      throw new Error(`Audio file ${filePath} channel data mismatch`);
    }
    for (let i = 0; i < data.channels; i += 1) {
      if (data.data[i].length !== data.frames) {
        throw new Error(
          `Audio file ${filePath} channel ${i} length ${data.data[i].length} != frames ${data.frames}`,
        );
      }
    }
  }

  private resampleBuffer(buffer: AudioFileData, targetSampleRate: number): AudioFileData {
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

  private buildCacheKey(filePath: string, targetSampleRate: number): CacheKey {
    return `${filePath}@${targetSampleRate}`;
  }
}

export const createClipBufferUploader = (engine: AudioEngine): ClipBufferUploader => ({
  uploadClipBuffer: async (bufferKey, sampleRate, channels, frames, channelData) => {
    await engine.uploadClipBuffer(bufferKey, sampleRate, channels, frames, channelData);
  },
});
