import { useEffect, useMemo, useState } from 'react';

import type { SessionTransportView } from './types';

const clamp = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
};

type FrameHandle = number | ReturnType<typeof setTimeout>;

const scheduleFrame = (callback: () => void): FrameHandle => {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(() => {
      callback();
    });
  }
  return setTimeout(callback, 16);
};

const cancelFrame = (handle: FrameHandle | undefined) => {
  if (handle === undefined) {
    return;
  }
  if (typeof handle === 'number' && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle as ReturnType<typeof setTimeout>);
};

const wrapBeats = (value: number, totalBeats: number): number => {
  if (totalBeats > 0) {
    const normalized = ((value % totalBeats) + totalBeats) % totalBeats;
    return clamp(normalized, 0, totalBeats);
  }
  return Math.max(0, value);
};

export interface ProjectedTransportState {
  projectedBeats: number;
  projectedRatio: number;
  transport: SessionTransportView | null;
}

export const useProjectedTransport = (
  transport: SessionTransportView | null,
): ProjectedTransportState => {
  const [projectedBeats, setProjectedBeats] = useState<number>(
    transport?.playheadBeats ?? 0,
  );

  useEffect(() => {
    setProjectedBeats(transport?.playheadBeats ?? 0);
  }, [transport]);

  useEffect(() => {
    if (!transport || !transport.isPlaying) {
      return undefined;
    }
    const reference = transport.playheadReference;
    if (!reference) {
      return undefined;
    }
    const referenceUpdatedAt = reference.updatedAt ?? Date.now();
    const referenceBeats = reference.beats;
    const bpm = reference.bpm > 0 ? reference.bpm : transport.bpm;
    const totalBeats = transport.lengthBeats;
    let frameHandle: FrameHandle | undefined;
    const tick = () => {
      const now = Date.now();
      const elapsedMs = Math.max(0, now - referenceUpdatedAt);
      const elapsedBeats = (elapsedMs / 60000) * bpm;
      const rawBeats = referenceBeats + elapsedBeats;
      setProjectedBeats(wrapBeats(rawBeats, totalBeats));
      frameHandle = scheduleFrame(tick);
    };
    frameHandle = scheduleFrame(tick);
    return () => {
      cancelFrame(frameHandle);
    };
  }, [transport]);

  const projectedRatio = useMemo(() => {
    if (!transport || transport.lengthBeats <= 0) {
      return 0;
    }
    return clamp(projectedBeats / transport.lengthBeats, 0, 1);
  }, [projectedBeats, transport]);

  return useMemo(
    () => ({
      projectedBeats,
      projectedRatio,
      transport,
    }),
    [projectedBeats, projectedRatio, transport],
  );
};
