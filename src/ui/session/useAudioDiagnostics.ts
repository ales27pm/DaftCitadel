import { useEffect, useState } from 'react';

import {
  NativeAudioEngine,
  isNativeModuleAvailable,
} from '../../audio/NativeAudioEngine';
import { buildDiagnosticsView } from './selectors';
import { SessionDiagnosticsView } from './types';

interface AudioDiagnosticsHookState {
  diagnostics: SessionDiagnosticsView;
  raw?: { xruns: number; lastRenderDurationMicros: number; clipBufferBytes: number };
}

const INITIAL_DIAGNOSTICS: SessionDiagnosticsView = {
  status: 'loading',
  xruns: 0,
  renderLoad: 0,
  clipBufferBytes: 0,
};

export const useAudioDiagnostics = (pollIntervalMs = 1500): AudioDiagnosticsHookState => {
  const [state, setState] = useState<AudioDiagnosticsHookState>({
    diagnostics: INITIAL_DIAGNOSTICS,
  });

  useEffect(() => {
    let cancelled = false;
    if (!isNativeModuleAvailable()) {
      setState({
        diagnostics: {
          status: 'unavailable',
          xruns: 0,
          renderLoad: 0,
        },
      });
      return () => {
        cancelled = true;
      };
    }

    const fetchDiagnostics = async () => {
      try {
        const data = await NativeAudioEngine.getRenderDiagnostics();
        if (cancelled) {
          return;
        }
        setState((previous) => ({
          diagnostics: buildDiagnosticsView(
            previous?.diagnostics ?? INITIAL_DIAGNOSTICS,
            data,
          ),
          raw: data,
        }));
      } catch (error) {
        if (cancelled) {
          return;
        }
        setState({
          diagnostics: {
            status: 'error',
            xruns: 0,
            renderLoad: 0,
            error: error as Error,
          },
        });
      }
    };

    const executeFetch = () => {
      fetchDiagnostics().catch(() => undefined);
    };

    executeFetch();

    if (pollIntervalMs > 0) {
      const interval = setInterval(() => {
        executeFetch();
      }, pollIntervalMs);
      return () => {
        cancelled = true;
        clearInterval(interval);
      };
    }

    return () => {
      cancelled = true;
    };
  }, [pollIntervalMs]);

  return state;
};
