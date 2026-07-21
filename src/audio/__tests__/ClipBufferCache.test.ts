import { ClipBufferCache } from '../bridge/ClipBufferCache';

const createLogger = () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

describe('ClipBufferCache', () => {
  const sampleRate = 48000;
  const frames = 1024;
  const channels = 2;
  const createAudioFile = () => ({
    sampleRate,
    frames,
    channels,
    data: Array.from({ length: channels }, (_unused, channelIndex) =>
      Float32Array.from({ length: frames }, (_frameUnused, frameIndex) =>
        Math.sin((frameIndex + channelIndex) / 10),
      ),
    ),
  });

  it('evicts clip buffers when reference counts drop to zero', async () => {
    const loader = {
      load: jest.fn(async () => createAudioFile()),
    };
    const uploader = {
      uploadClipBuffer: jest.fn(async () => undefined),
      releaseClipBuffer: jest.fn(async () => undefined),
    };
    const logger = createLogger();
    const cache = new ClipBufferCache(loader, uploader, logger);

    const descriptor = await cache.getClipBuffer('fixtures/clip.wav', sampleRate);
    expect(loader.load).toHaveBeenCalledTimes(1);
    expect(uploader.uploadClipBuffer).toHaveBeenCalledTimes(1);

    cache.retainClipBuffer(descriptor.bufferKey);
    cache.retainClipBuffer(descriptor.bufferKey);

    await cache.releaseClipBuffer(descriptor.bufferKey);
    expect(uploader.releaseClipBuffer).not.toHaveBeenCalled();

    await cache.releaseClipBuffer(descriptor.bufferKey);
    expect(uploader.releaseClipBuffer).toHaveBeenCalledTimes(1);

    const reloaded = await cache.getClipBuffer('fixtures/clip.wav', sampleRate);
    expect(loader.load).toHaveBeenCalledTimes(2);
    expect(uploader.uploadClipBuffer).toHaveBeenCalledTimes(2);
    expect(reloaded.bufferKey).toBe(descriptor.bufferKey);

    cache.retainClipBuffer(reloaded.bufferKey);
    await cache.releaseClipBuffer(reloaded.bufferKey);
    expect(uploader.releaseClipBuffer).toHaveBeenCalledTimes(2);
  });

  it('copies shared-memory channels into native-safe ArrayBuffers', async () => {
    const sharedSamples = new Float32Array(
      new SharedArrayBuffer(frames * Float32Array.BYTES_PER_ELEMENT),
    );
    sharedSamples.fill(0.25);
    const loader = {
      load: jest.fn(async () => ({
        sampleRate,
        frames,
        channels: 1,
        data: [sharedSamples],
      })),
    };
    let uploadedChannels: ReadonlyArray<ArrayBuffer> | undefined;
    const uploader = {
      uploadClipBuffer: jest.fn(
        async (
          _bufferKey: string,
          _sampleRate: number,
          _channels: number,
          _frames: number,
          channelData: ReadonlyArray<ArrayBuffer>,
        ) => {
          uploadedChannels = channelData;
        },
      ),
      releaseClipBuffer: jest.fn(async () => undefined),
    };
    const cache = new ClipBufferCache(loader, uploader, createLogger());

    await cache.getClipBuffer('fixtures/shared.wav', sampleRate);

    expect(uploadedChannels).toBeDefined();
    if (!uploadedChannels) {
      throw new Error('Expected the cache to upload shared-memory channel data');
    }
    expect(uploadedChannels[0]).toBeInstanceOf(ArrayBuffer);
    expect(new Float32Array(uploadedChannels[0])[0]).toBeCloseTo(0.25);
  });
});
