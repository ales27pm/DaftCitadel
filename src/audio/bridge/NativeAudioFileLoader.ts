import { NativeModules } from 'react-native';
import { Buffer } from 'buffer';

import type { AudioFileData, AudioFileLoader } from './ClipBufferCache';

type NativeChannelPayload = string | number[] | ArrayBuffer | ArrayBufferView;

type NativeAudioSample = {
  sampleRate: number;
  channels: number;
  frames: number;
  channelData: NativeChannelPayload[];
};

type NativeAudioFileLoaderModule = {
  decode(filePath: string): Promise<NativeAudioSample>;
};

const MODULE_NAME = 'AudioSampleLoaderModule';

export class NativeAudioFileLoader implements AudioFileLoader {
  private readonly nativeModule: NativeAudioFileLoaderModule;

  constructor(module: NativeAudioFileLoaderModule = getNativeLoaderModule()) {
    this.nativeModule = module;
  }

  async load(filePath: string): Promise<AudioFileData> {
    if (!filePath) {
      throw new Error('Audio file path is required');
    }
    const decoded = await this.nativeModule.decode(filePath);
    validateDecodedPayload(decoded, filePath);
    const channelData = decoded.channelData.map((payload, index) =>
      coerceChannelPayload(payload, decoded.frames, index, filePath),
    );
    return {
      sampleRate: decoded.sampleRate,
      channels: decoded.channels,
      frames: decoded.frames,
      data: channelData,
    };
  }
}

export const isNativeAudioFileLoaderAvailable = (): boolean =>
  NativeModules[MODULE_NAME] != null;

const getNativeLoaderModule = (): NativeAudioFileLoaderModule => {
  const module = NativeModules[MODULE_NAME] as NativeAudioFileLoaderModule | undefined;
  if (!module) {
    throw new Error('AudioSampleLoaderModule is unavailable');
  }
  if (typeof module.decode !== 'function') {
    throw new Error('AudioSampleLoaderModule.decode is not implemented');
  }
  return module;
};

const validateDecodedPayload = (sample: NativeAudioSample, filePath: string): void => {
  if (!Number.isFinite(sample.sampleRate) || sample.sampleRate <= 0) {
    throw new Error(`AudioSampleLoader returned invalid sampleRate for ${filePath}`);
  }
  if (!Number.isInteger(sample.channels) || sample.channels <= 0) {
    throw new Error(`AudioSampleLoader returned invalid channel count for ${filePath}`);
  }
  if (!Number.isInteger(sample.frames) || sample.frames <= 0) {
    throw new Error(`AudioSampleLoader returned invalid frame count for ${filePath}`);
  }
  if (
    !Array.isArray(sample.channelData) ||
    sample.channelData.length !== sample.channels
  ) {
    throw new Error(
      `AudioSampleLoader returned mismatched channel data for ${filePath} (${sample.channelData.length} != ${sample.channels})`,
    );
  }
};

const coerceChannelPayload = (
  payload: NativeChannelPayload,
  frames: number,
  index: number,
  filePath: string,
): Float32Array => {
  if (payload instanceof ArrayBuffer) {
    return ensureFrameLength(new Float32Array(payload), frames, index, filePath);
  }
  if (ArrayBuffer.isView(payload)) {
    const view = payload as ArrayBufferView;
    const cloned = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    return ensureFrameLength(new Float32Array(cloned), frames, index, filePath);
  }
  if (Array.isArray(payload)) {
    return ensureFrameLength(Float32Array.from(payload), frames, index, filePath);
  }
  if (typeof payload === 'string') {
    const buffer = Buffer.from(payload, 'base64');
    const floatBuffer = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      Math.floor(buffer.byteLength / 4),
    );
    return ensureFrameLength(new Float32Array(floatBuffer), frames, index, filePath);
  }
  throw new Error(
    `Unsupported channel payload for ${filePath} at index ${index}: ${typeof payload}`,
  );
};

const ensureFrameLength = (
  channel: Float32Array,
  frames: number,
  index: number,
  filePath: string,
): Float32Array => {
  if (channel.length < frames) {
    throw new Error(
      `Decoded channel ${index} for ${filePath} is shorter than expected (${channel.length} < ${frames})`,
    );
  }
  if (channel.length === frames) {
    return channel;
  }
  return channel.slice(0, frames);
};

export type { NativeAudioSample };
