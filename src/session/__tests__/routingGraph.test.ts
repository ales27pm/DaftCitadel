import {
  createDefaultTrackRoutingGraph,
  normalizeTrack,
  RoutingGraph,
  Track,
  validateSession,
  Session,
} from '../models';

describe('routing graph schema', () => {
  const baseMetadata = {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sampleRate: 48000,
    bpm: 120,
    timeSignature: '4/4',
  };

  it('creates a default stereo through graph', () => {
    const graph = createDefaultTrackRoutingGraph('track-1');
    expect(graph.nodes).toHaveLength(2);
    expect(graph.connections).toEqual([
      expect.objectContaining({
        signal: 'audio',
        enabled: true,
      }),
    ]);
  });

  it('normalizes plugin order based on slot order', () => {
    const graph: RoutingGraph = {
      version: 1,
      nodes: [
        {
          id: 'track-1:output:main',
          type: 'trackOutput',
          ioId: 'output:main',
          channelCount: 2,
        },
        {
          id: 'plugin-b',
          type: 'plugin',
          slot: 'insert',
          instanceId: 'plugin-b',
          order: 2,
          accepts: ['audio'],
          emits: ['audio'],
        },
        {
          id: 'plugin-a',
          type: 'plugin',
          slot: 'insert',
          instanceId: 'plugin-a',
          order: 0,
          accepts: ['audio'],
          emits: ['audio'],
        },
        {
          id: 'track-1:input:main',
          type: 'trackInput',
          ioId: 'input:main',
          channelCount: 2,
        },
      ],
      connections: [],
    };
    const track: Track = {
      id: 'track-1',
      name: 'Track',
      clips: [],
      muted: false,
      solo: false,
      volume: 0,
      pan: 0,
      automationCurves: [],
      routing: {
        graph,
      },
    };

    const normalized = normalizeTrack(track);
    const pluginOrders = normalized.routing.graph?.nodes
      .filter((node) => node.type === 'plugin')
      .map((node) => (node.type === 'plugin' ? node.order : -1))
      .sort((a, b) => a - b);
    expect(pluginOrders).toEqual([0, 1]);
  });

  it('validates routing graph connectivity', () => {
    const session: Session = {
      id: 'session-1',
      name: 'Test',
      revision: 1,
      tracks: [
        {
          id: 'track-1',
          name: 'Track',
          clips: [],
          muted: false,
          solo: false,
          volume: 0,
          pan: 0,
          automationCurves: [],
          routing: {
            graph: {
              version: 1,
              nodes: [
                {
                  id: 'track-1:input:main',
                  type: 'trackInput',
                  ioId: 'input:main',
                  channelCount: 2,
                },
                {
                  id: 'track-1:output:main',
                  type: 'trackOutput',
                  ioId: 'output:main',
                  channelCount: 2,
                },
              ],
              connections: [
                {
                  id: 'conn-1',
                  from: { nodeId: 'track-1:input:main' },
                  to: { nodeId: 'track-1:output:main' },
                  signal: 'audio',
                  enabled: true,
                },
              ],
            },
          },
        },
      ],
      metadata: baseMetadata,
    };

    expect(() => validateSession(session)).not.toThrow();

    session.tracks[0].routing.graph?.nodes.push({
      id: 'track-1:input:main',
      type: 'trackInput',
      ioId: 'input:main',
      channelCount: 2,
    });

    expect(() => validateSession(session)).toThrow(
      'Duplicate routing node id detected: track-1:input:main',
    );
  });
});
