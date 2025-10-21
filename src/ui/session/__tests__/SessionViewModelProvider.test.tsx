import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { demoSession, DEMO_SESSION_ID } from '../../../session/fixtures/demoSession';
import { InMemorySessionStorageAdapter, SessionManager } from '../../../session';
import { PassiveAudioEngineBridge } from '../environment';
import {
  SessionViewModelProvider,
  useSessionViewModel,
} from '../SessionViewModelProvider';

describe('SessionViewModelProvider', () => {
  it('provides tracks with waveform and midi data', async () => {
    const storage = new InMemorySessionStorageAdapter();
    await storage.initialize();
    const bridge = new PassiveAudioEngineBridge();
    const manager = new SessionManager(storage, bridge);

    let latestStatus: string | undefined;
    let midiCount = 0;
    let trackCount = 0;

    const Consumer = () => {
      const viewModel = useSessionViewModel();
      latestStatus = viewModel.status;
      midiCount = viewModel.tracks.reduce(
        (total, track) => total + track.midiNotes.length,
        0,
      );
      trackCount = viewModel.tracks.length;
      return null;
    };

    await act(async () => {
      TestRenderer.create(
        React.createElement(
          SessionViewModelProvider,
          {
            manager,
            sessionId: DEMO_SESSION_ID,
            bootstrapSession: () => demoSession,
            diagnosticsPollIntervalMs: 0,
          },
          React.createElement(Consumer, null),
        ),
      );
      await Promise.resolve();
    });

    expect(latestStatus).toBe('ready');
    expect(trackCount).toBeGreaterThan(0);
    expect(midiCount).toBeGreaterThan(0);
  });
});
