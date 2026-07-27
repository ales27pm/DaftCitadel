import {
  normalizeSession,
  validateSession,
  type PluginRoutingNode,
  type Session,
} from '../models';

describe('legacy session normalization', () => {
  it('fills arrays and routing capabilities added after schema version 1', () => {
    const legacySession = {
      id: 'legacy-session',
      name: 'Legacy Session',
      revision: 3,
      metadata: {
        version: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        sampleRate: 48000,
        bpm: 120,
        timeSignature: '4/4',
      },
      tracks: [
        {
          id: 'legacy-track',
          name: 'Legacy Track',
          muted: false,
          solo: false,
          volume: -3,
          pan: 0,
          routing: {
            graph: {
              version: 1,
              nodes: [
                {
                  id: 'legacy-track:input',
                  type: 'trackInput',
                  ioId: 'input:main',
                  channelCount: 2,
                },
                {
                  id: 'legacy-plugin',
                  type: 'plugin',
                  slot: 'insert',
                  instanceId: 'legacy-plugin-instance',
                  order: 0,
                },
                {
                  id: 'legacy-track:output',
                  type: 'trackOutput',
                  ioId: 'output:main',
                  channelCount: 2,
                },
              ],
              connections: [],
            },
          },
        },
      ],
    } as unknown as Session;

    const normalized = normalizeSession(legacySession);
    const track = normalized.tracks[0];
    const plugin = track.routing.graph?.nodes.find(
      (node): node is PluginRoutingNode => node.type === 'plugin',
    );

    expect(track.clips).toEqual([]);
    expect(track.automationCurves).toEqual([]);
    expect(plugin?.accepts).toEqual(['audio']);
    expect(plugin?.emits).toEqual(['audio']);
    expect(() => validateSession(normalized)).not.toThrow();
  });
});
