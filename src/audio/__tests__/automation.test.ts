import { AutomationLane, ClockSyncService } from '../Automation';

describe('AutomationLane', () => {
  it('keeps automation points sorted without duplication', () => {
    const lane = new AutomationLane('gain');
    lane.addPoint({ frame: 128, value: 0.5 });
    lane.addPoint({ frame: 64, value: 0.25 });
    lane.addPoint({ frame: 256, value: 0.75 });
    lane.addPoint({ frame: 128, value: 0.6 });

    expect(lane.toPayload()).toEqual({
      parameter: 'gain',
      points: [
        { frame: 64, value: 0.25 },
        { frame: 128, value: 0.6 },
        { frame: 256, value: 0.75 },
      ],
    });
  });

  it('rejects non-integer frames', () => {
    const lane = new AutomationLane('gain');
    expect(() => lane.addPoint({ frame: 1.5, value: 0.25 })).toThrow('Automation frame must be an integer');
  });
});

describe('ClockSyncService', () => {
  it('quantizes automation frame to buffer boundaries deterministically', () => {
    const clock = new ClockSyncService(48000, 128, 120);
    const frames = [1, 128, 129, 255, 256, 257, 4095, 4096];
    const quantized = frames.map((frame) => clock.quantizeFrameToBuffer(frame));

    expect(quantized).toEqual([128, 128, 256, 256, 256, 384, 4096, 4096]);
  });

  it('rejects fractional frames when quantizing', () => {
    const clock = new ClockSyncService(48000, 128, 120);
    expect(() => clock.quantizeFrameToBuffer(1.2)).toThrow('Frame must be an integer');
  });

  it('updates tempo revision on tempo change', () => {
    const clock = new ClockSyncService(48000, 128, 120);
    expect(clock.describe()).toMatchObject({ tempoRevision: 0 });
    clock.updateTempo(90);
    expect(clock.describe()).toMatchObject({ bpm: 90, tempoRevision: 1 });
  });

  it('bumps revision when the buffer size changes', () => {
    const clock = new ClockSyncService(48000, 128, 120);
    clock.updateBufferSize(256);
    expect(clock.describe()).toMatchObject({ framesPerBuffer: 256, tempoRevision: 1 });
  });

  it('computes frames per beat consistently', () => {
    const clock = new ClockSyncService(48000, 256, 60);
    expect(clock.framesPerBeat()).toBeCloseTo(48000);
  });
});
