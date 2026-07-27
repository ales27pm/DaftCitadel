import { SessionAudioBridge } from '../SessionAudioBridge';
import type { AudioEngine } from '../AudioEngine';
import {
  createDefaultTrackRoutingGraph,
  createEmptySession,
  type Session,
  type Track,
} from '../../session/models';

describe('SessionAudioBridge startup recovery', () => {
  it('keeps a real session available when optional automation is rejected', async () => {
    const publishAutomation = jest
      .fn()
      .mockRejectedValue(new Error('Node parameter is invalid'));
    const audioEngine = {
      getClock: () => ({
        quantizeFrameToBuffer: (frame: number) => frame,
        describe: () => ({
          sampleRate: 48000,
          framesPerBuffer: 256,
          bpm: 120,
          tempoRevision: 0,
        }),
      }),
      getTransportState: jest.fn().mockResolvedValue({
        frame: 0,
        isPlaying: false,
      }),
      configureNodes: jest.fn().mockResolvedValue(undefined),
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      removeNodes: jest.fn().mockResolvedValue(undefined),
      publishAutomation,
    } as unknown as AudioEngine;
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const bridge = new SessionAudioBridge(audioEngine, {
      fileLoader: {
        load: jest.fn(),
      },
      logger,
    });
    const track: Track = {
      id: 'track-1',
      name: 'Track 1',
      clips: [],
      muted: false,
      solo: false,
      volume: 0,
      pan: 0,
      automationCurves: [
        {
          id: 'volume',
          parameter: 'volume',
          interpolation: 'linear',
          points: [{ time: 0, value: 0.8 }],
        },
      ],
      routing: {
        graph: createDefaultTrackRoutingGraph('track-1'),
      },
    };
    const session: Session = {
      ...createEmptySession('session-1', 'Session 1'),
      revision: 1,
      tracks: [track],
    };

    await expect(bridge.applySessionUpdate(session)).resolves.toBeUndefined();
    expect(publishAutomation).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('continuing with static node values'),
      expect.any(Error),
    );
  });
});
