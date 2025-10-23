import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import {
  CloudSyncProvider,
  InMemorySessionStorageAdapter,
  Session,
  SessionManager,
} from '../../../session';
import { demoSession, DEMO_SESSION_ID } from '../../../session/fixtures/demoSession';
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
    class RecoveringBridge extends PassiveAudioEngineBridge {
      public retryPluginInstance = jest.fn(async () => true);
    }
    const bridge = new RecoveringBridge();
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
    let viewModelRef: ReturnType<typeof useSessionViewModel> | undefined;

    const Consumer = () => {
      const viewModel = useSessionViewModel();
      alerts = viewModel.pluginAlerts;
      viewModelRef = viewModel;
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
            audioBridge: bridge,
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
      await viewModelRef?.retryPlugin('plugin-1');
      await Promise.resolve();
    });

    expect(bridge.retryPluginInstance).toHaveBeenCalledWith('plugin-1');
    expect(alerts[0].recovered).toBe(true);
  });

  it('surfaces audio engine failures as an error status', async () => {
    const storage = new InMemorySessionStorageAdapter();
    await storage.initialize();
    await storage.write(demoSession, { expectedRevision: 0 });

    class FailingBridge extends PassiveAudioEngineBridge {
      private failed = false;

      override async applySessionUpdate(session: Session): Promise<void> {
        if (!this.failed) {
          this.failed = true;
          throw new Error('Audio engine initialization failed');
        }
        await super.applySessionUpdate(session);
      }
    }

    const bridge = new FailingBridge();
    const manager = new SessionManager(storage, bridge);

    let latestStatus: string | undefined;
    let latestError: Error | undefined;

    const Consumer = () => {
      const viewModel = useSessionViewModel();
      latestStatus = viewModel.status;
      latestError = viewModel.error;
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

    expect(latestStatus).toBe('error');
    expect(latestError).toBeInstanceOf(Error);
    expect(latestError?.message).toContain('Audio engine initialization failed');
  });

  it('pushes session updates to the cloud after manager mutations', async () => {
    const storage = new InMemorySessionStorageAdapter();
    await storage.initialize();
    const bridge = new PassiveAudioEngineBridge();
    const cloud: CloudSyncProvider = {
      pull: jest.fn(async () => ({ session: null })),
      push: jest.fn(async () => undefined),
    };
    const manager = new SessionManager(storage, bridge, { cloudSyncProvider: cloud });

    let capturedManager: SessionManager | null = null;
    let sessionName: string | undefined;

    const Consumer = () => {
      const viewModel = useSessionViewModel();
      capturedManager = viewModel.manager;
      sessionName = viewModel.sessionName;
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

    const pullMock = cloud.pull as jest.Mock;
    const pushMock = cloud.push as jest.Mock;
    expect(pullMock).toHaveBeenCalledWith(DEMO_SESSION_ID);
    expect(pushMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await capturedManager?.updateSession((current) => ({
        ...current,
        name: 'Updated via provider',
      }));
    });

    expect(pushMock).toHaveBeenCalledTimes(2);
    const pushedSession = pushMock.mock.calls[pushMock.mock.calls.length - 1]?.[0];
    expect(pushedSession?.name).toBe('Updated via provider');
    expect(sessionName).toBe('Updated via provider');
  });
});
