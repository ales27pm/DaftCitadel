import { NativeAudioEngine } from './NativeAudioEngine';

export type AutomationPoint = {
  /** Absolute frame position in the engine timeline */
  frame: number;
  /** Value to apply to the parameter at the specified frame */
  value: number;
};

export class AutomationLane {
  private readonly parameter: string;
  private readonly points: AutomationPoint[] = [];

  constructor(parameter: string) {
    this.parameter = parameter;
  }

  public addPoint(point: AutomationPoint): void {
    if (point.frame < 0) {
      throw new Error('Automation frame cannot be negative');
    }
    const index = this.points.findIndex((p) => p.frame === point.frame);
    if (index >= 0) {
      this.points[index] = point;
      return;
    }

    const insertAt = this.points.findIndex((p) => p.frame > point.frame);
    if (insertAt === -1) {
      this.points.push(point);
    } else {
      this.points.splice(insertAt, 0, point);
    }
  }

  public clear(): void {
    this.points.splice(0, this.points.length);
  }

  public toPayload() {
    return {
      parameter: this.parameter,
      points: [...this.points],
    };
  }
}

export class ClockSyncService {
  private readonly sampleRate: number;
  private framesPerBuffer: number;
  private bpm: number;
  private tempoMapRevision = 0;

  constructor(sampleRate: number, framesPerBuffer: number, bpm: number) {
    if (sampleRate <= 0) {
      throw new Error('Invalid sample rate');
    }
    if (framesPerBuffer <= 0) {
      throw new Error('Invalid buffer size');
    }
    this.sampleRate = sampleRate;
    this.framesPerBuffer = framesPerBuffer;
    this.bpm = bpm;
  }

  public updateTempo(bpm: number): void {
    if (bpm <= 0) {
      throw new Error('Tempo must be positive');
    }
    this.bpm = bpm;
    this.tempoMapRevision += 1;
  }

  public updateBufferSize(framesPerBuffer: number): void {
    if (framesPerBuffer <= 0) {
      throw new Error('Buffer size must be positive');
    }
    this.framesPerBuffer = framesPerBuffer;
  }

  public framesPerBeat(): number {
    return (this.sampleRate * 60) / this.bpm;
  }

  public bufferDurationSeconds(): number {
    return this.framesPerBuffer / this.sampleRate;
  }

  public quantizeFrameToBuffer(frame: number): number {
    if (frame < 0) {
      throw new Error('Frame must be non-negative');
    }
    const remainder = frame % this.framesPerBuffer;
    if (remainder === 0) {
      return frame;
    }
    return frame + (this.framesPerBuffer - remainder);
  }

  public describe(): {
    sampleRate: number;
    framesPerBuffer: number;
    bpm: number;
    tempoRevision: number;
  } {
    return {
      sampleRate: this.sampleRate,
      framesPerBuffer: this.framesPerBuffer,
      bpm: this.bpm,
      tempoRevision: this.tempoMapRevision,
    };
  }
}

export const publishAutomationLane = async (
  graphId: string,
  nodeId: string,
  lane: AutomationLane,
): Promise<void> => {
  await NativeAudioEngine.scheduleAutomation(graphId, nodeId, lane.toPayload());
};
