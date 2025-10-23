import { useCallback, useContext, useMemo } from 'react';

import { useSessionViewModel } from './SessionViewModelProvider';
import { TransportControlsContext } from './SessionViewModelProvider';

export interface TransportControlsHandle {
  play: () => Promise<void>;
  stop: () => Promise<void>;
  locateFrame: (frame: number) => Promise<void>;
  locateBeats: (beats: number) => Promise<void>;
  locateStart: () => Promise<void>;
  isAvailable: boolean;
  isPlaying: boolean;
  transportRuntime: ReturnType<typeof useSessionViewModel>['transportRuntime'];
  transport: ReturnType<typeof useSessionViewModel>['transport'];
}

export const useTransportControls = (): TransportControlsHandle => {
  const controller = useContext(TransportControlsContext);
  if (!controller) {
    throw new Error(
      'useTransportControls must be used within a SessionViewModelProvider',
    );
  }

  const { transport, transportRuntime } = useSessionViewModel();

  const play = useCallback(() => controller.start(), [controller]);
  const stop = useCallback(() => controller.stop(), [controller]);
  const locateFrame = useCallback(
    (frame: number) => controller.locateFrame(Math.max(0, Math.floor(frame))),
    [controller],
  );

  const locateBeats = useCallback(
    async (beats: number) => {
      if (!Number.isFinite(beats)) {
        throw new Error('beats must be a finite number');
      }
      const runtime = transportRuntime;
      const bpm = runtime?.bpm ?? transport?.bpm ?? 120;
      const sampleRate = runtime?.sampleRate;
      if (!sampleRate || sampleRate <= 0) {
        console.warn('Transport runtime missing sample rate; rewinding to start.');
        await controller.locateFrame(0);
        return;
      }
      const framesPerBeat = (sampleRate * 60) / bpm;
      const frameTarget = Math.max(0, Math.floor(beats * framesPerBeat));
      await controller.locateFrame(frameTarget);
    },
    [controller, transport?.bpm, transportRuntime],
  );

  const locateStart = useCallback(() => locateBeats(0), [locateBeats]);

  return useMemo(
    () => ({
      play,
      stop,
      locateFrame,
      locateBeats,
      locateStart,
      isAvailable: controller.isAvailable,
      isPlaying: transport?.isPlaying ?? false,
      transportRuntime,
      transport,
    }),
    [
      controller.isAvailable,
      locateBeats,
      locateFrame,
      locateStart,
      play,
      stop,
      transport,
      transportRuntime,
    ],
  );
};
