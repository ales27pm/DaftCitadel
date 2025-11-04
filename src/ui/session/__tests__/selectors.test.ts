import { buildDiagnosticsView, buildTracks, buildTransport } from '../selectors';
import type { SessionDiagnosticsView } from '../types';
import type { Session, Track, RoutingGraph, PluginRoutingNode } from '../../../session';
import type { PluginCrashReport } from '../../../audio';

describe('session selectors', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-11-02T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const createSession = (): Session => {
    const pluginNode: PluginRoutingNode = {
      id: 'plugin-node',
      type: 'plugin',
      slot: 'insert',
      instanceId: 'plugin-instance',
      order: 1,
      accepts: ['audio'],
      emits: ['audio'],
    };
    const routingGraph: RoutingGraph = {
      version: 1,
      nodes: [
        {
          id: 'track-input',
          type: 'trackInput',
          ioId: 'input:main',
          channelCount: 2,
        },
        pluginNode,
        {
          id: 'track-output',
          type: 'trackOutput',
          ioId: 'output:main',
          channelCount: 2,
        },
      ],
      connections: [
        {
          id: 'conn-input-plugin',
          from: { nodeId: 'track-input' },
          to: { nodeId: 'plugin-node' },
          signal: 'audio',
          enabled: true,
        },
        {
          id: 'conn-plugin-output',
          from: { nodeId: 'plugin-node' },
          to: { nodeId: 'track-output' },
          signal: 'audio',
          enabled: true,
        },
      ],
    };

    const track: Track = {
      id: 'track-1',
      name: 'Fixture Track',
      clips: [
        {
          id: 'clip-1',
          name: 'Clip',
          start: 0,
          duration: 4000,
          audioFile: 'clip.wav',
          gain: 1,
          fadeIn: 0,
          fadeOut: 0,
          automationCurveIds: ['volume-curve'],
          midi: {
            notes: [
              { id: 'note-1', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 90 },
            ],
          },
        },
      ],
      muted: false,
      solo: false,
      volume: 0,
      pan: 0,
      automationCurves: [
        {
          id: 'volume-curve',
          parameter: 'volume',
          interpolation: 'linear',
          points: [
            { time: 0, value: 1 },
            { time: 4000, value: 1 },
          ],
        },
      ],
      routing: { graph: routingGraph },
    };

    const session: Session = {
      id: 'session-1',
      name: 'Fixture Session',
      revision: 1,
      metadata: {
        version: 1,
        createdAt: new Date('2025-10-31T00:00:00Z').toISOString(),
        updatedAt: new Date('2025-10-31T00:00:00Z').toISOString(),
        bpm: 120,
        timeSignature: '4/4',
        sampleRate: 48_000,
      },
      tracks: [track],
    };

    return session;
  };

  it('produces track view models with plugin crash state applied', () => {
    const session = createSession();
    const diagnostics: SessionDiagnosticsView = {
      status: 'ready',
      xruns: 0,
      renderLoad: 0.2,
      lastRenderDurationMicros: 4_000,
      clipBufferBytes: 1024,
      updatedAt: Date.now(),
    };
    const crashReport: PluginCrashReport = {
      instanceId: 'plugin-instance',
      descriptor: {
        identifier: 'com.daft.fixture',
        name: 'Fixture Plugin',
        manufacturer: 'Daft',
        format: 'auv3',
        version: '1.0',
        supportsSandbox: true,
        audioInputChannels: 2,
        audioOutputChannels: 2,
        midiInput: false,
        midiOutput: false,
        parameters: [],
      },
      timestamp: new Date('2025-11-02T11:59:00Z').toISOString(),
      reason: 'fixture crash',
      recovered: false,
    };
    const tracks = buildTracks(
      session,
      diagnostics,
      new Map([['plugin-instance', crashReport]]),
    );

    expect(tracks).toHaveLength(1);
    const [track] = tracks;
    expect(track.plugins).toHaveLength(1);
    expect(track.plugins[0].status).toBe('crashed');
    expect(track.meterLevel).toBeCloseTo(0.8, 2);
    expect(track.waveform.length).toBeGreaterThan(0);
    expect(track.midiNotes).toHaveLength(1);
  });

  it('derives diagnostics view from native payloads and snapshots', () => {
    const previous: SessionDiagnosticsView = {
      status: 'loading',
      xruns: 0,
      renderLoad: 0,
    };

    const nativeView = buildDiagnosticsView(previous, {
      xruns: 2,
      lastRenderDurationMicros: 5_000,
      clipBufferBytes: 2048,
    });

    expect(nativeView.status).toBe('ready');
    expect(nativeView.renderLoad).toBeCloseTo(0.5, 2);
    expect(nativeView.updatedAt).toBe(Date.now());

    const errorSnapshot = buildDiagnosticsView(nativeView, {
      status: 'error',
      xruns: 3,
      renderLoad: 0.75,
      error: new Error('engine failure'),
    });

    expect(errorSnapshot.status).toBe('error');
    expect(errorSnapshot.error?.message).toContain('engine failure');

    const loadingSnapshot = buildDiagnosticsView(errorSnapshot, {
      status: 'loading',
      xruns: 3,
      renderLoad: 0.6,
    });

    expect(loadingSnapshot.status).toBe('loading');
    expect(loadingSnapshot.lastRenderDurationMicros).toBeUndefined();

    const unavailableSnapshot = buildDiagnosticsView(loadingSnapshot, {
      status: 'unavailable',
      xruns: 0,
      renderLoad: 0,
    });

    expect(unavailableSnapshot.status).toBe('unavailable');
  });

  it('provides runtime playhead reference when runtime is playing', () => {
    const session = createSession();
    const diagnostics: SessionDiagnosticsView = {
      status: 'ready',
      xruns: 0,
      renderLoad: 0.1,
      updatedAt: Date.now(),
    };

    const runtimeUpdatedAt = Date.now() - 1_000;
    const transport = buildTransport(session, diagnostics, {
      frame: 0,
      seconds: 0,
      beats: 2,
      bpm: 120,
      sampleRate: 48_000,
      isPlaying: true,
      updatedAt: runtimeUpdatedAt,
    });

    expect(transport.isPlaying).toBe(true);
    expect(transport.playheadBeats).toBeCloseTo(2, 5);
    expect(transport.playheadRatio).toBeCloseTo(0.25, 5);
    expect(transport.diagnosticsGate).toBe(true);
    expect(transport.playheadReference).toEqual({
      source: 'runtime',
      beats: 2,
      bpm: 120,
      updatedAt: runtimeUpdatedAt,
    });
  });

  it('derives diagnostics playhead reference when runtime is unavailable', () => {
    const session = createSession();
    const diagnostics: SessionDiagnosticsView = {
      status: 'ready',
      xruns: 0,
      renderLoad: 0.15,
      updatedAt: Date.now(),
    };

    const transport = buildTransport(session, diagnostics, undefined, 4000);

    expect(transport.isPlaying).toBe(true);
    expect(transport.playheadReference).toMatchObject({
      source: 'diagnostics',
      bpm: session.metadata.bpm,
    });
    expect(transport.playheadReference?.updatedAt).toBe(diagnostics.updatedAt);
  });
});
