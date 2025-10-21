import { LatencyCompensator } from '../LatencyCompensator';

describe('LatencyCompensator', () => {
  it('smooths observed offsets', () => {
    const compensator = new LatencyCompensator({ smoothing: 0.5 });
    const first = compensator.update({ remoteClock: 1000, receivedAt: 900 });
    expect(first).toBe(100);

    const second = compensator.update({ remoteClock: 2100, receivedAt: 2000 });
    // Exponential moving average: 0.5 * 100 + 0.5 * 100 = 100
    expect(second).toBe(100);

    const third = compensator.update({ remoteClock: 3300, receivedAt: 3000 });
    // Observed offset 300, expectation: 0.5 * 300 + 0.5 * 100 = 200
    expect(third).toBe(200);

    const compensated = compensator.compensate(3600);
    expect(compensated).toBe(3400);
    expect(compensator.isStable()).toBe(true);
  });
});
