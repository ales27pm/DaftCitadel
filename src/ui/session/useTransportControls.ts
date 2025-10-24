import { NativeModules, Platform } from 'react-native';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useSessionViewModel } from './SessionViewModelProvider';
import { TransportControlsContext } from './SessionViewModelProvider';
import type { TransportRuntimeState } from './types';

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

type TransportOperation = 'start' | 'stop' | 'locate';

type NativeLogger = {
  logWithLevel?: (
    level: 'info' | 'warn' | 'error',
    message: string,
    metadata?: Record<string, unknown>,
  ) => void;
};

const DEFAULT_BPM = 120;

const clamp = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
};

const deriveRuntimeFromTransport = (
  transport: ReturnType<typeof useSessionViewModel>['transport'],
): TransportRuntimeState | null => {
  if (!transport) {
    return null;
  }
  const sampleRate = 0;
  const bpm = transport.bpm > 0 ? transport.bpm : DEFAULT_BPM;
  const beats = clamp(transport.playheadBeats, 0, Number.MAX_SAFE_INTEGER);
  const frame = 0;
  const seconds = 0;
  return {
    frame,
    seconds,
    beats,
    bpm,
    sampleRate,
    isPlaying: transport.isPlaying,
    updatedAt: Date.now(),
  };
};

const logTransportError = (operation: TransportOperation, error: unknown) => {
  const logger = NativeModules.DaftCitadelLogger as NativeLogger | undefined;
  const normalizedError =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'unknown error';
  const message = `[transport] Failed to ${operation} transport`;
  const metadata: Record<string, unknown> = {
    operation,
    error: normalizedError,
  };
  if (Platform.OS === 'ios' || Platform.OS === 'macos') {
    metadata.subsystem = 'com.daftcitadel.transport';
    metadata.category = 'transport-controls';
  } else if (Platform.OS === 'android') {
    metadata.tag = 'DaftCitadelTransport';
  }
  logger?.logWithLevel?.('error', message, metadata);
  // Always surface the error to JS logs for development visibility.
  console.error(message, error);
};

export const useTransportControls = (): TransportControlsHandle => {
  const controller = useContext(TransportControlsContext);
  if (!controller) {
    throw new Error(
      'useTransportControls must be used within a SessionViewModelProvider',
    );
  }

  const { transport, transportRuntime } = useSessionViewModel();
  const [optimisticRuntime, setOptimisticRuntime] =
    useState<TransportRuntimeState | null>(null);
  const runtimeSnapshotRef = useRef<TransportRuntimeState | null>(transportRuntime);

  useEffect(() => {
    runtimeSnapshotRef.current = transportRuntime ?? null;
    setOptimisticRuntime(null);
  }, [transportRuntime]);

  const resolveBaselineRuntime = useCallback((): TransportRuntimeState | null => {
    const existing =
      optimisticRuntime ??
      runtimeSnapshotRef.current ??
      transportRuntime ??
      deriveRuntimeFromTransport(transport);

    if (!existing) {
      return null;
    }

    const sampleRate =
      existing.sampleRate > 0
        ? existing.sampleRate
        : transportRuntime?.sampleRate && transportRuntime.sampleRate > 0
          ? transportRuntime.sampleRate
          : 0;

    const bpm =
      existing.bpm > 0
        ? existing.bpm
        : transport?.bpm && transport.bpm > 0
          ? transport.bpm
          : DEFAULT_BPM;

    return {
      ...existing,
      sampleRate,
      bpm,
    };
  }, [optimisticRuntime, transport, transportRuntime]);

  const withOptimisticRuntime = useCallback(
    async (
      operation: TransportOperation,
      transform: (runtime: TransportRuntimeState) => TransportRuntimeState,
      action: () => Promise<void>,
    ) => {
      const baseline = resolveBaselineRuntime();
      const fallback = baseline ? { ...baseline } : null;
      if (baseline) {
        const snapshot = transform({ ...baseline, updatedAt: Date.now() });
        setOptimisticRuntime(snapshot);
      }
      try {
        await action();
      } catch (error) {
        if (fallback) {
          setOptimisticRuntime({ ...fallback, updatedAt: Date.now() });
        } else {
          setOptimisticRuntime(null);
        }
        logTransportError(operation, error);
        throw error;
      }
    },
    [resolveBaselineRuntime],
  );

  const play = useCallback(() => {
    return withOptimisticRuntime(
      'start',
      (runtime) => ({ ...runtime, isPlaying: true }),
      () => controller.start(),
    );
  }, [controller, withOptimisticRuntime]);

  const stop = useCallback(() => {
    return withOptimisticRuntime(
      'stop',
      (runtime) => ({ ...runtime, isPlaying: false }),
      () => controller.stop(),
    );
  }, [controller, withOptimisticRuntime]);

  const locateFrame = useCallback(
    async (frame: number) => {
      const sanitized = Number.isFinite(frame) ? Math.max(0, Math.floor(frame)) : 0;
      await withOptimisticRuntime(
        'locate',
        (runtime) => {
          const sampleRate =
            runtime.sampleRate > 0
              ? runtime.sampleRate
              : transportRuntime?.sampleRate && transportRuntime.sampleRate > 0
                ? transportRuntime.sampleRate
                : 0;
          const bpm = runtime.bpm > 0 ? runtime.bpm : (transport?.bpm ?? DEFAULT_BPM);
          const seconds = sampleRate > 0 ? sanitized / sampleRate : 0;
          const beats = sampleRate > 0 ? (seconds * bpm) / 60 : runtime.beats;
          return {
            ...runtime,
            frame: sanitized,
            seconds,
            beats,
          };
        },
        () => controller.locateFrame(sanitized),
      );
    },
    [controller, transport?.bpm, transportRuntime, withOptimisticRuntime],
  );

  const locateBeats = useCallback(
    async (beats: number) => {
      if (!Number.isFinite(beats)) {
        throw new Error('beats must be a finite number');
      }
      const baseline = resolveBaselineRuntime();
      const bpm = baseline?.bpm ?? transport?.bpm ?? DEFAULT_BPM;
      const sampleRate = baseline?.sampleRate ?? transportRuntime?.sampleRate;
      if (!sampleRate || sampleRate <= 0) {
        console.warn('Transport runtime missing sample rate; rewinding to start.');
        await controller.locateFrame(0);
        return;
      }
      const framesPerBeat = (sampleRate * 60) / bpm;
      const frameTarget = Math.max(0, Math.floor(beats * framesPerBeat));
      await locateFrame(frameTarget);
    },
    [controller, locateFrame, resolveBaselineRuntime, transport?.bpm, transportRuntime],
  );

  const locateStart = useCallback(() => locateBeats(0), [locateBeats]);

  const resolvedRuntime =
    optimisticRuntime ?? transportRuntime ?? runtimeSnapshotRef.current;

  const resolvedTransport = useMemo(() => {
    if (!transport) {
      return transport;
    }
    if (!resolvedRuntime) {
      return transport;
    }
    const clampedBeats = clamp(
      resolvedRuntime.beats,
      0,
      transport.lengthBeats || Number.MAX_SAFE_INTEGER,
    );
    const ratio =
      transport.lengthBeats > 0 ? clamp(clampedBeats / transport.lengthBeats, 0, 1) : 0;
    return {
      ...transport,
      isPlaying: resolvedRuntime.isPlaying,
      playheadBeats: clampedBeats,
      playheadRatio: ratio,
    };
  }, [resolvedRuntime, transport]);

  return useMemo(
    () => ({
      play,
      stop,
      locateFrame,
      locateBeats,
      locateStart,
      isAvailable: controller.isAvailable,
      isPlaying: resolvedTransport?.isPlaying ?? transport?.isPlaying ?? false,
      transportRuntime: resolvedRuntime ?? null,
      transport: resolvedTransport ?? transport,
    }),
    [
      controller.isAvailable,
      locateBeats,
      locateFrame,
      locateStart,
      play,
      stop,
      resolvedRuntime,
      resolvedTransport,
      transport,
    ],
  );
};
