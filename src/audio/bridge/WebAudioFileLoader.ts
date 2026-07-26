import { createWebAudioContext } from '../webAudioSupport';
import type { AudioFileData, AudioFileLoader } from './ClipBufferCache';

type FetchLike = (
  input: string,
) => Promise<{ arrayBuffer(): Promise<ArrayBuffer>; ok: boolean; status?: number }>;

const createFetch = (): FetchLike => {
  const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
  if (typeof globalFetch === 'function') {
    return globalFetch;
  }
  return async () => {
    throw new Error('fetch is unavailable in this environment');
  };
};

const isFiniteNumber = (value: unknown): value is number =>
  Number.isFinite(value as number);

export class WebAudioFileLoader implements AudioFileLoader {
  private readonly audioContext: AudioContext;
  private readonly fetcher: FetchLike;

  constructor(
    audioContext: AudioContext | null = createWebAudioContext(),
    fetcher: FetchLike = createFetch(),
  ) {
    if (!audioContext) {
      throw new Error('Web Audio context is unavailable');
    }
    this.audioContext = audioContext;
    this.fetcher = fetcher;
  }

  async load(filePath: string): Promise<AudioFileData> {
    if (!filePath) {
      throw new Error('Audio file path is required');
    }
    const response = await this.fetcher(filePath);
    if (!response.ok) {
      throw new Error(`Failed to fetch audio file for ${filePath}`);
    }
    const encoded = await response.arrayBuffer();
    const decoded = await this.audioContext.decodeAudioData(encoded);
    validateDecodedBuffer(decoded, filePath);
    const sampleRate = decoded.sampleRate;
    const channels = decoded.numberOfChannels;
    const frames = decoded.length;
    const data = new Array(channels) as Array<Float32Array>;
    for (let index = 0; index < channels; index += 1) {
      const channelSource = decoded.getChannelData(index);
      data[index] = new Float32Array(channelSource);
    }

    return {
      sampleRate,
      channels,
      frames,
      data,
    };
  }
}

const validateDecodedBuffer = (sample: AudioBuffer, filePath: string): void => {
  if (!isFiniteNumber(sample.sampleRate) || sample.sampleRate <= 0) {
    throw new Error(`Audio file ${filePath} returned invalid sampleRate`);
  }
  if (!Number.isInteger(sample.numberOfChannels) || sample.numberOfChannels <= 0) {
    throw new Error(`Audio file ${filePath} returned invalid channel count`);
  }
  if (!Number.isInteger(sample.length) || sample.length <= 0) {
    throw new Error(`Audio file ${filePath} returned invalid frame count`);
  }
};
