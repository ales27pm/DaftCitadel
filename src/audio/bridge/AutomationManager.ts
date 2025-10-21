import { AutomationLane } from '../Automation';

type AutomationKey = string;

type AutomationRequest = {
  nodeId: string;
  lane: AutomationLane;
  signature: string;
};

type AutomationState = Map<AutomationKey, string>;

export class AutomationPublisher {
  private readonly state: AutomationState = new Map();

  constructor(
    private readonly publish: (nodeId: string, lane: AutomationLane) => Promise<void>,
  ) {}

  async applyChanges(requests: Map<AutomationKey, AutomationRequest>): Promise<void> {
    const toPublish: AutomationRequest[] = [];
    requests.forEach((request, key) => {
      const existing = this.state.get(key);
      if (existing === request.signature) {
        return;
      }
      toPublish.push(request);
      this.state.set(key, request.signature);
    });

    await Promise.all(
      toPublish.map((request) => this.publish(request.nodeId, request.lane)),
    );

    const staleKeys: AutomationKey[] = [];
    this.state.forEach((_signature, key) => {
      if (!requests.has(key)) {
        staleKeys.push(key);
      }
    });
    staleKeys.forEach((key) => this.state.delete(key));
  }
}

export const describeAutomation = (nodeId: string, lane: AutomationLane): string => {
  const payload = lane.toPayload();
  const pointSig = payload.points
    .map((point) => `${point.frame}:${point.value.toFixed(6)}`)
    .join('|');
  return `${nodeId}:${payload.parameter}:${pointSig}`;
};

export type { AutomationRequest };
