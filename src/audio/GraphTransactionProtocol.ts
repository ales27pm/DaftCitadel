import type {
  NativeGraphApplyResult,
  NativeGraphApplyStatus,
  NativeGraphDescription,
  NativeGraphErrorCode,
  NativeGraphFailure,
  NativeGraphFailureStage,
} from './NativeAudioEngine';

const APPLY_STATUSES = new Set<NativeGraphApplyStatus>([
  'committed',
  'stale',
  'rejected',
]);

const FAILURE_STAGES = new Set<NativeGraphFailureStage>([
  'none',
  'validate',
  'allocate',
  'prepare',
  'connect',
  'commit',
  'lifecycle',
  'route',
]);

const ERROR_CODES = new Set<NativeGraphErrorCode>([
  'none',
  'invalid_request',
  'duplicate_node',
  'missing_endpoint',
  'resource_allocation_failed',
  'node_preparation_failed',
  'connection_rejected',
  'commit_rejected',
  'stale_generation',
  'stale_route_epoch',
  'stale_engine_instance',
  'engine_unavailable',
  'engine_invalidated',
  'audio_configuration_changed',
]);

export class GraphTransactionProtocolError extends Error {
  readonly code = 'invalid_native_graph_response';

  constructor(message: string) {
    super(message);
    this.name = 'GraphTransactionProtocolError';
  }
}

const fail = (message: string): never => {
  throw new GraphTransactionProtocolError(message);
};

const asRecord = (value: unknown, field: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
};

const asString = (value: unknown, field: string, allowEmpty = false): string => {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    return fail(`${field} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
  return value;
};

const asSafeUnsignedInteger = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return fail(`${field} must be a non-negative safe integer`);
  }
  return value;
};

const parseDescription = (value: unknown, field: string): NativeGraphDescription => {
  const record = asRecord(value, field);
  if (!Array.isArray(record.nodeIds)) {
    return fail(`${field}.nodeIds must be an array`);
  }

  const nodeIds = record.nodeIds.map((nodeId, index) =>
    asString(nodeId, `${field}.nodeIds[${index}]`),
  );
  if (new Set(nodeIds).size !== nodeIds.length) {
    return fail(`${field}.nodeIds must not contain duplicates`);
  }

  return {
    generation: asSafeUnsignedInteger(record.generation, `${field}.generation`),
    graphHash: asString(record.graphHash, `${field}.graphHash`),
    nodeIds,
    routeEpoch: asSafeUnsignedInteger(record.routeEpoch, `${field}.routeEpoch`),
    engineInstance: asSafeUnsignedInteger(
      record.engineInstance,
      `${field}.engineInstance`,
    ),
  };
};

const parseFailure = (value: unknown, field: string): NativeGraphFailure => {
  const record = asRecord(value, field);
  const stage = asString(record.stage, `${field}.stage`);
  const code = asString(record.code, `${field}.code`);
  if (!FAILURE_STAGES.has(stage as NativeGraphFailureStage)) {
    return fail(`${field}.stage is not recognized`);
  }
  if (!ERROR_CODES.has(code as NativeGraphErrorCode)) {
    return fail(`${field}.code is not recognized`);
  }
  if (stage === 'none' || code === 'none') {
    return fail(`${field} must identify a concrete failure`);
  }

  return {
    stage: stage as NativeGraphFailureStage,
    code: code as NativeGraphErrorCode,
    nodeId: asString(record.nodeId, `${field}.nodeId`, true),
    detail: asString(record.detail, `${field}.detail`),
  };
};

export const parseNativeGraphDescription = (value: unknown): NativeGraphDescription =>
  parseDescription(value, 'graph');

export const parseNativeGraphApplyResult = (
  value: unknown,
  expectedTransactionId?: string,
): NativeGraphApplyResult => {
  const record = asRecord(value, 'result');
  const status = asString(record.status, 'result.status');
  if (!APPLY_STATUSES.has(status as NativeGraphApplyStatus)) {
    return fail('result.status is not recognized');
  }

  const transactionId = asString(record.transactionId, 'result.transactionId');
  if (expectedTransactionId !== undefined && transactionId !== expectedTransactionId) {
    return fail(`result.transactionId does not match ${expectedTransactionId}`);
  }

  const failure =
    record.failure === undefined
      ? undefined
      : parseFailure(record.failure, 'result.failure');
  if (status === 'committed' && failure !== undefined) {
    return fail('committed graph result must not include a failure');
  }
  if (status !== 'committed' && failure === undefined) {
    return fail(`${status} graph result must include a failure`);
  }

  return {
    status: status as NativeGraphApplyStatus,
    transactionId,
    graph: parseDescription(record.graph, 'result.graph'),
    ...(failure === undefined ? {} : { failure }),
  };
};
