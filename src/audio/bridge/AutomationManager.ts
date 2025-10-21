import { AutomationLane } from '../Automation';

export type AutomationKey = string;

export type AutomationRequest = {
  nodeId: string;
  lane: AutomationLane;
  signature: string;
};

type AutomationRecord = {
  signature: string;
  nodeId: string;
  parameter: string;
  lastValue: number | undefined;
};

export class AutomationPublisher {
  private readonly state: Map<AutomationKey, AutomationRecord> = new Map();

  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly publish: (nodeId: string, lane: AutomationLane) => Promise<void>,
  ) {}

  async applyChanges(requests: Map<AutomationKey, AutomationRequest>): Promise<void> {
    this.queue = this.queue.then(() => this.processRequests(requests));
    return this.queue;
  }

  private async processRequests(
    requests: Map<AutomationKey, AutomationRequest>,
  ): Promise<void> {
    const planned: Array<{
      key: AutomationKey;
      request: AutomationRequest;
      record: AutomationRecord;
    }> = [];
    requests.forEach((request, key) => {
      const payload = request.lane.toPayload();
      const record: AutomationRecord = {
        signature: request.signature,
        nodeId: request.nodeId,
        parameter: payload.parameter,
        lastValue: payload.points[payload.points.length - 1]?.value,
      };
      const existing = this.state.get(key);
      if (existing?.signature === record.signature) {
        return;
      }
      planned.push({ key, request, record });
    });

    let firstError: unknown;
    if (planned.length > 0) {
      const results = await Promise.allSettled(
        planned.map(({ request }) => this.publish(request.nodeId, request.lane)),
      );
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const { key, record } = planned[index];
          this.state.set(key, record);
        } else if (!firstError) {
          firstError = result.reason;
        }
      });
    }

    const staleEntries: Array<{ key: AutomationKey; record: AutomationRecord }> = [];
    this.state.forEach((record, key) => {
      if (!requests.has(key)) {
        staleEntries.push({ key, record });
      }
    });

    if (staleEntries.length > 0) {
      const results = await Promise.allSettled(
        staleEntries.map(({ record }) =>
          this.publish(record.nodeId, this.createClearLane(record)),
        ),
      );
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const { key } = staleEntries[index];
          this.state.delete(key);
        } else if (!firstError) {
          firstError = result.reason;
        }
      });
    }

    if (firstError) {
      throw firstError;
    }
  }

  private createClearLane(record: AutomationRecord): AutomationLane {
    const lane = new AutomationLane(record.parameter);
    const value = record.lastValue ?? 0;
    lane.addPoint({ frame: 0, value });
    return lane;
  }
}

export const describeAutomation = (nodeId: string, lane: AutomationLane): string => {
  const payload = lane.toPayload();
  const points = [...payload.points].sort((a, b) => a.frame - b.frame);
  const pointSig = points
    .map((point) => `${point.frame}:${point.value.toFixed(6)}`)
    .join('|');
  return `${nodeId}:${payload.parameter}:${pointSig}`;
};
