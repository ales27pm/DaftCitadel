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

  it('coalesces concurrent decode and upload requests for the same clip', async () => {
    let resolveLoad: ((value: ReturnType<typeof createAudioFile>) => void) | undefined;
    const loader = {
      load: jest.fn(
        () =>
          new Promise<ReturnType<typeof createAudioFile>>((resolve) => {
            resolveLoad = resolve;
          }),
      ),
    };
    const uploader = {
      uploadClipBuffer: jest.fn(async () => undefined),
      releaseClipBuffer: jest.fn(async () => undefined),
    };
    const cache = new ClipBufferCache(loader, uploader, createLogger());

    const first = cache.getClipBuffer('fixtures/shared.wav', sampleRate);
    const second = cache.getClipBuffer('fixtures/shared.wav', sampleRate);
    expect(loader.load).toHaveBeenCalledTimes(1);

    resolveLoad?.(createAudioFile());
    const [firstDescriptor, secondDescriptor] = await Promise.all([first, second]);

    expect(firstDescriptor).toEqual(secondDescriptor);
    expect(uploader.uploadClipBuffer).toHaveBeenCalledTimes(1);
  });
});
