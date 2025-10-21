export interface LatencySample {
  readonly remoteClock: number;
  readonly receivedAt: number;
}

/**
 * Maintains a smoothed offset between the local monotonic clock and the
 * collaborator's reported timestamps. The value is used to compensate updates
 * so UI consumers can order actions without jitter.
 */
export class LatencyCompensator {
  private readonly alpha: number;
  private offsetEstimate: number;
  private readonly minSamples: number;
  private sampleCount = 0;

  constructor({
    initialOffset = 0,
    smoothing = 0.2,
    minSamples = 3,
  }: {
    initialOffset?: number;
    smoothing?: number;
    minSamples?: number;
  } = {}) {
    if (smoothing <= 0 || smoothing > 1) {
      throw new Error('Smoothing factor must be within (0, 1].');
    }
    this.alpha = smoothing;
    this.offsetEstimate = initialOffset;
    this.minSamples = minSamples;
  }

  /** Updates the offset estimate using an exponentially weighted moving average. */
  update(sample: LatencySample): number {
    const observedOffset = sample.remoteClock - sample.receivedAt;
    if (this.sampleCount === 0) {
      this.offsetEstimate = observedOffset;
    } else {
      this.offsetEstimate =
        this.alpha * observedOffset + (1 - this.alpha) * this.offsetEstimate;
    }
    this.sampleCount += 1;
    return this.offsetEstimate;
  }

  /** Returns the remote timestamp compensated for the estimated offset. */
  compensate(remoteClock: number): number {
    return remoteClock - this.offsetEstimate;
  }

  /** Indicates whether enough samples have been accumulated to trust compensation. */
  isStable(): boolean {
    return this.sampleCount >= this.minSamples;
  }
}
