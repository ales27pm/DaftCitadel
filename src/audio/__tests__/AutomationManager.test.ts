import { AutomationLane } from '../Automation';
import { AutomationPublisher, AutomationRequest } from '../bridge/AutomationManager';

const createRequest = (): AutomationRequest => {
  const lane = new AutomationLane('volume');
  lane.addPoint({ frame: 0, value: 0.5 });
  return {
    nodeId: 'track:output',
    lane,
    signature: 'track:output:volume:0:0.500000',
  };
};

describe('AutomationPublisher', () => {
  it('accepts a retry after a publication failure', async () => {
    const publish = jest
      .fn<Promise<void>, [string, AutomationLane]>()
      .mockRejectedValueOnce(new Error('Native publish failed'))
      .mockResolvedValue(undefined);
    const publisher = new AutomationPublisher(publish);
    const requests = new Map([['track:output:volume', createRequest()]]);

    await expect(publisher.applyChanges(requests)).rejects.toThrow(
      'Native publish failed',
    );
    await expect(publisher.applyChanges(requests)).resolves.toBeUndefined();

    expect(publish).toHaveBeenCalledTimes(2);
  });
});
