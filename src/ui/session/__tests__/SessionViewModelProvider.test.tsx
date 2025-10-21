import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { demoSession, DEMO_SESSION_ID } from '../../../session/fixtures/demoSession';
import { InMemorySessionStorageAdapter, SessionManager } from '../../../session';
import { PassiveAudioEngineBridge } from '../environment';
import {
  SessionViewModelProvider,
  useSessionViewModel,
} from '../SessionViewModelProvider';
import type { PluginCrashReport, PluginHost } from '../../../audio';

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

  it('captures plugin crash notifications from the plugin host', async () => {
    const storage = new InMemorySessionStorageAdapter();
    await storage.initialize();
    const bridge = new PassiveAudioEngineBridge();
    const manager = new SessionManager(storage, bridge);

    let listener: ((report: PluginCrashReport) => void) | undefined;
    const host: PluginHost = {
      onCrash: (cb: (report: PluginCrashReport) => void) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      },
    } as PluginHost;

    let alerts: PluginCrashReport[] = [];

    const Consumer = () => {
      const viewModel = useSessionViewModel();
      alerts = viewModel.pluginAlerts;
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
            pluginHost: host,
          },
          React.createElement(Consumer, null),
        ),
      );
      await Promise.resolve();
    });

    expect(alerts).toHaveLength(0);

    const crashReport: PluginCrashReport = {
      instanceId: 'plugin-1',
      descriptor: {
        identifier: 'com.acme.Plugin',
        name: 'Fixture Plugin',
        format: 'auv3',
        manufacturer: 'Acme',
        version: '1.0',
        supportsSandbox: true,
        audioInputChannels: 2,
        audioOutputChannels: 2,
        midiInput: false,
        midiOutput: false,
        parameters: [],
      },
      timestamp: new Date().toISOString(),
      reason: 'test',
      recovered: false,
    };

    await act(async () => {
      listener?.(crashReport);
      await Promise.resolve();
    });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toEqual(crashReport);

    await act(async () => {
      listener?.(crashReport);
      await Promise.resolve();
    });

    expect(alerts).toHaveLength(1);
  });
});
