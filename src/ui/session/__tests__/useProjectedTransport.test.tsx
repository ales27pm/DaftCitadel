import React, { useEffect } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import type { SessionTransportView } from '../types';
import { useProjectedTransport } from '../useProjectedTransport';

describe('useProjectedTransport', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const renderHook = async (
    transport: SessionTransportView | null,
    onChange: (state: ReturnType<typeof useProjectedTransport>) => void,
  ) => {
    const Wrapper: React.FC<{ value: SessionTransportView | null }> = ({ value }) => {
      const projected = useProjectedTransport(value);
      const latestHandler = React.useRef(onChange);

      useEffect(() => {
        latestHandler.current = onChange;
      });

      useEffect(() => {
        latestHandler.current(projected);
      }, [projected]);
      return null;
    };

    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(() => {
      renderer = TestRenderer.create(<Wrapper value={transport} />);
    });
    if (!renderer) {
      throw new Error('Renderer did not mount');
    }

    const update = async (value: SessionTransportView | null) => {
      await act(() => {
        renderer!.update(<Wrapper value={value} />);
      });
    };

    return { renderer, update };
  };

  const createTransport = (
    overrides: Partial<SessionTransportView> = {},
  ): SessionTransportView => ({
    bpm: 120,
    timeSignature: '4/4',
    lengthBeats: 64,
    totalBars: 16,
    playheadBeats: 4,
    playheadRatio: 4 / 64,
    isPlaying: true,
    diagnosticsGate: true,
    playheadReference: {
      source: 'runtime',
      beats: 4,
      bpm: 120,
      updatedAt: 1_000,
    },
    ...overrides,
  });

  it('returns baseline state when transport is null', async () => {
    const handleChange = jest.fn();
    await renderHook(null, handleChange);

    expect(handleChange).toHaveBeenCalledTimes(1);
    expect(handleChange.mock.calls[0][0]).toEqual({
      projectedBeats: 0,
      projectedRatio: 0,
      transport: null,
    });
  });

  it('projects beats forward using runtime reference', async () => {
    const handleChange = jest.fn();
    const transport = createTransport();
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    const { renderer } = await renderHook(transport, handleChange);

    expect(handleChange).toHaveBeenLastCalledWith({
      projectedBeats: 4,
      projectedRatio: 4 / 64,
      transport,
    });

    await act(() => {
      now = 1_250;
      jest.advanceTimersByTime(250);
    });

    const expectedBeats = 4 + (250 / 60_000) * transport.playheadReference!.bpm;
    const lastCall = handleChange.mock.calls[handleChange.mock.calls.length - 1][0];
    expect(lastCall.projectedBeats).toBeCloseTo(expectedBeats, 5);
    expect(lastCall.projectedRatio).toBeCloseTo(expectedBeats / transport.lengthBeats, 5);
    expect(lastCall.transport).toBe(transport);

    renderer.unmount();
  });

  it('stops projecting when playback is paused', async () => {
    const handleChange = jest.fn();
    const transport = createTransport();
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    const { renderer, update } = await renderHook(transport, handleChange);

    await act(() => {
      now = 1_100;
      jest.advanceTimersByTime(100);
    });

    const pausedTransport: SessionTransportView = {
      ...transport,
      isPlaying: false,
    };

    await update(pausedTransport);

    const pausedState = handleChange.mock.calls[handleChange.mock.calls.length - 1][0];

    await act(() => {
      now = 1_500;
      jest.advanceTimersByTime(400);
    });

    const finalCall = handleChange.mock.calls[handleChange.mock.calls.length - 1][0];
    expect(finalCall.projectedBeats).toBeCloseTo(pausedState.projectedBeats, 5);
    expect(finalCall.projectedRatio).toBeCloseTo(pausedState.projectedRatio, 5);

    renderer.unmount();
  });
});
