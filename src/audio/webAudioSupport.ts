type AudioContextOptions = {
  sampleRate?: number;
  latencyHint?: 'balanced' | 'interactive' | 'playback' | number;
};

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

type WindowAudioConstructors = {
  AudioContext?: unknown;
  webkitAudioContext?: unknown;
};

const resolveAudioContextConstructor = (): AudioContextConstructor | null => {
  const candidates: Array<keyof WindowAudioConstructors> = [
    'AudioContext',
    'webkitAudioContext',
  ];
  const globalCandidate = globalThis as WindowAudioConstructors;
  for (const key of candidates) {
    const candidate = globalCandidate[key];
    if (typeof candidate === 'function') {
      return candidate as AudioContextConstructor;
    }
  }
  return null;
};

export const createWebAudioContext = (sampleRate?: number): AudioContext | null => {
  const constructor = resolveAudioContextConstructor();
  if (!constructor) {
    return null;
  }
  try {
    return sampleRate == null ? new constructor() : new constructor({ sampleRate });
  } catch (error) {
    console.warn('Failed to create AudioContext for web audio engine', error);
    return null;
  }
};

export const isWebAudioEngineAvailable = (): boolean => {
  const context = createWebAudioContext();
  if (!context) {
    return false;
  }
  try {
    const closeResult: unknown = context.close();
    if (
      closeResult != null &&
      typeof (closeResult as { then?: unknown }).then === 'function'
    ) {
      void Promise.resolve(closeResult).catch(() => undefined);
    }
    return true;
  } catch {
    return false;
  }
};
