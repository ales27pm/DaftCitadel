import { NativeAudioFileLoader } from '../bridge/NativeAudioFileLoader';

describe('NativeAudioFileLoader mobile budgets', () => {
  it('rejects excessive channel counts before decoding bridge payloads', async () => {
    const loader = new NativeAudioFileLoader({
      decode: jest.fn().mockResolvedValue({
        sampleRate: 48_000,
        channels: 9,
        frames: 1,
        channelData: Array.from({ length: 9 }, () => ''),
      }),
    });

    await expect(loader.load('too-many-channels.wav')).rejects.toThrow(
      'invalid channel count',
    );
  });

  it('rejects decoded PCM larger than 64 MiB before copying base64 data', async () => {
    const loader = new NativeAudioFileLoader({
      decode: jest.fn().mockResolvedValue({
        sampleRate: 48_000,
        channels: 2,
        frames: 8_388_609,
        channelData: ['', ''],
      }),
    });

    await expect(loader.load('oversized.wav')).rejects.toThrow(
      'larger than the mobile PCM budget',
    );
  });
});
