import {
  GraphTransactionProtocolError,
  parseNativeGraphApplyResult,
  parseNativeGraphDescription,
} from '../GraphTransactionProtocol';

const graph = {
  generation: 3,
  graphHash: '8e9b43a77d87c31a',
  nodeIds: ['bass', 'output'],
  routeEpoch: 2,
  engineInstance: 11,
};

describe('GraphTransactionProtocol', () => {
  it('accepts a complete committed result', () => {
    expect(
      parseNativeGraphApplyResult(
        {
          status: 'committed',
          transactionId: 'tx-1',
          graph,
        },
        'tx-1',
      ),
    ).toEqual({
      status: 'committed',
      transactionId: 'tx-1',
      graph,
    });
  });

  it('accepts a structured stale result', () => {
    expect(
      parseNativeGraphApplyResult({
        status: 'stale',
        transactionId: 'tx-stale',
        graph,
        failure: {
          stage: 'route',
          code: 'stale_route_epoch',
          nodeId: '',
          detail: 'Audio route changed before commit',
        },
      }).failure?.code,
    ).toBe('stale_route_epoch');
  });

  it('rejects transaction mismatches', () => {
    expect(() =>
      parseNativeGraphApplyResult(
        {
          status: 'committed',
          transactionId: 'wrong',
          graph,
        },
        'expected',
      ),
    ).toThrow(GraphTransactionProtocolError);
  });

  it('rejects a non-commit without structured failure evidence', () => {
    expect(() =>
      parseNativeGraphApplyResult({
        status: 'rejected',
        transactionId: 'tx-rejected',
        graph,
      }),
    ).toThrow('must include a failure');
  });

  it('rejects unknown native error codes', () => {
    expect(() =>
      parseNativeGraphApplyResult({
        status: 'rejected',
        transactionId: 'tx-invalid',
        graph,
        failure: {
          stage: 'commit',
          code: 'mystery_error',
          nodeId: '',
          detail: 'Unknown failure',
        },
      }),
    ).toThrow('code is not recognized');
  });

  it('rejects duplicate node identities and unsafe counters', () => {
    expect(() =>
      parseNativeGraphDescription({
        ...graph,
        nodeIds: ['bass', 'bass'],
      }),
    ).toThrow('must not contain duplicates');
    expect(() =>
      parseNativeGraphDescription({
        ...graph,
        generation: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow('safe integer');
  });
});
