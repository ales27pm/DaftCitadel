/* eslint-disable no-bitwise -- SysEx switches and Roland checksum fields are bit-packed. */

export const JUNO106_SYSEX_MESSAGE_BYTES = 25;
export const MAX_JUNO106_SYSEX_PATCHES = 128;
export const MAX_JUNO106_SYSEX_BYTES =
  JUNO106_SYSEX_MESSAGE_BYTES * MAX_JUNO106_SYSEX_PATCHES;

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const ROLAND_MANUFACTURER_ID = 0x41;
const CHECKSUM_DATA_START = 5;
const CHECKSUM_DATA_END = 22;
const CHECKSUM_INDEX = 23;

export type Juno106SysExErrorCode =
  'empty' | 'bounds' | 'length' | 'format' | 'data' | 'checksum';

export class Juno106SysExError extends Error {
  constructor(
    message: string,
    public readonly code: Juno106SysExErrorCode,
  ) {
    super(message);
    this.name = 'Juno106SysExError';
  }
}

export interface Juno106SysExSliders {
  lfoRate: number;
  lfoDelay: number;
  dcoLfoMod: number;
  dcoPwmDepth: number;
  dcoNoiseLevel: number;
  vcfCutoff: number;
  vcfResonance: number;
  vcfEnvMod: number;
  vcfLfoMod: number;
  vcfKeyFollow: number;
  vcaLevel: number;
  envAttack: number;
  envDecay: number;
  envSustain: number;
  envRelease: number;
  dcoSubLevel: number;
}

export interface Juno106SysExSwitches {
  dcoFoot16: boolean;
  dcoFoot8: boolean;
  dcoFoot4: boolean;
  pulseWaveOn: boolean;
  sawWaveOn: boolean;
  chorusOn: boolean;
  chorusLevelII: boolean;
  pwmSourceLFO: boolean;
  vcfEnvPositive: boolean;
  vcaModeEnv: boolean;
  hpfSetting: number;
}

export interface Juno106SysExPatch {
  midiChannel: number;
  sourcePatchNumber: number;
  sliders: Juno106SysExSliders;
  switches: Juno106SysExSwitches;
  checksum: number;
  rawSysEx: readonly number[];
}

export type Juno106SysExInput = Uint8Array | ReadonlyArray<number>;

const copyBoundedInput = (input: Juno106SysExInput, maximumBytes: number): number[] => {
  if (!input || typeof input.length !== 'number' || input.length === 0) {
    throw new Juno106SysExError('Juno-106 SysEx input is empty', 'empty');
  }
  if (input.length > maximumBytes) {
    throw new Juno106SysExError(
      `Juno-106 SysEx input exceeds the ${maximumBytes}-byte limit`,
      'bounds',
    );
  }

  const bytes = new Array<number>(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new Juno106SysExError(
        `Juno-106 SysEx byte ${index} is not an unsigned byte`,
        'data',
      );
    }
    bytes[index] = value;
  }
  return bytes;
};

const checksumForMessage = (bytes: ReadonlyArray<number>, offset: number): number => {
  let sum = 0;
  for (let index = CHECKSUM_DATA_START; index <= CHECKSUM_DATA_END; index += 1) {
    sum += bytes[offset + index];
  }
  return (128 - (sum & 0x7f)) & 0x7f;
};

export const computeJuno106RolandChecksum = (
  checksumData: ReadonlyArray<number>,
): number => {
  const expectedLength = CHECKSUM_DATA_END - CHECKSUM_DATA_START + 1;
  if (checksumData.length !== expectedLength) {
    throw new Juno106SysExError(
      `Roland checksum data must contain exactly ${expectedLength} bytes`,
      'length',
    );
  }
  let sum = 0;
  checksumData.forEach((value, index) => {
    if (!Number.isInteger(value) || value < 0 || value > 0x7f) {
      throw new Juno106SysExError(
        `Roland checksum byte ${index} must be 7-bit data`,
        'data',
      );
    }
    sum += value;
  });
  return (128 - (sum & 0x7f)) & 0x7f;
};

const parseMessageAt = (
  bytes: ReadonlyArray<number>,
  offset: number,
  patchIndex: number,
): Juno106SysExPatch => {
  const byteAt = (index: number): number => bytes[offset + index];
  if (byteAt(0) !== SYSEX_START || byteAt(24) !== SYSEX_END) {
    throw new Juno106SysExError(
      `Juno-106 patch ${patchIndex} has invalid SysEx start/end bytes`,
      'format',
    );
  }
  if (byteAt(1) !== ROLAND_MANUFACTURER_ID) {
    throw new Juno106SysExError(
      `Juno-106 patch ${patchIndex} is not a Roland SysEx message`,
      'format',
    );
  }
  for (let index = 1; index <= CHECKSUM_INDEX; index += 1) {
    if (byteAt(index) > 0x7f) {
      throw new Juno106SysExError(
        `Juno-106 patch ${patchIndex} contains non-7-bit data at byte ${index}`,
        'data',
      );
    }
  }

  const computedChecksum = checksumForMessage(bytes, offset);
  if (byteAt(CHECKSUM_INDEX) !== computedChecksum) {
    throw new Juno106SysExError(
      `Juno-106 patch ${patchIndex} has an invalid Roland checksum`,
      'checksum',
    );
  }

  const switch1 = byteAt(21);
  const switch2 = byteAt(22);
  const rawSysEx = Object.freeze(
    Array.from({ length: JUNO106_SYSEX_MESSAGE_BYTES }, (_unused, index) =>
      byteAt(index),
    ),
  );

  return {
    midiChannel: byteAt(2) & 0x0f,
    sourcePatchNumber: byteAt(3),
    sliders: {
      lfoRate: byteAt(5),
      lfoDelay: byteAt(6),
      dcoLfoMod: byteAt(7),
      dcoPwmDepth: byteAt(8),
      dcoNoiseLevel: byteAt(9),
      vcfCutoff: byteAt(10),
      vcfResonance: byteAt(11),
      vcfEnvMod: byteAt(12),
      vcfLfoMod: byteAt(13),
      vcfKeyFollow: byteAt(14),
      vcaLevel: byteAt(15),
      envAttack: byteAt(16),
      envDecay: byteAt(17),
      envSustain: byteAt(18),
      envRelease: byteAt(19),
      dcoSubLevel: byteAt(20),
    },
    switches: {
      dcoFoot16: (switch1 & 0x01) !== 0,
      dcoFoot8: (switch1 & 0x02) !== 0,
      dcoFoot4: (switch1 & 0x04) !== 0,
      pulseWaveOn: (switch1 & 0x08) !== 0,
      sawWaveOn: (switch1 & 0x10) !== 0,
      chorusOn: (switch1 & 0x20) === 0,
      chorusLevelII: (switch1 & 0x40) === 0,
      pwmSourceLFO: (switch2 & 0x01) === 0,
      vcfEnvPositive: (switch2 & 0x02) === 0,
      vcaModeEnv: (switch2 & 0x04) === 0,
      hpfSetting: (switch2 >> 3) & 0x03,
    },
    checksum: computedChecksum,
    rawSysEx,
  };
};

export const parseJuno106SysExMessage = (input: Juno106SysExInput): Juno106SysExPatch => {
  const bytes = copyBoundedInput(input, JUNO106_SYSEX_MESSAGE_BYTES);
  if (bytes.length !== JUNO106_SYSEX_MESSAGE_BYTES) {
    throw new Juno106SysExError(
      `Juno-106 SysEx messages must contain exactly ${JUNO106_SYSEX_MESSAGE_BYTES} bytes`,
      'length',
    );
  }
  return parseMessageAt(bytes, 0, 0);
};

export const parseJuno106SysExBank = (input: Juno106SysExInput): Juno106SysExPatch[] => {
  const bytes = copyBoundedInput(input, MAX_JUNO106_SYSEX_BYTES);
  if (bytes.length % JUNO106_SYSEX_MESSAGE_BYTES !== 0) {
    throw new Juno106SysExError(
      `Juno-106 SysEx banks must be a multiple of ${JUNO106_SYSEX_MESSAGE_BYTES} bytes`,
      'length',
    );
  }
  const patchCount = bytes.length / JUNO106_SYSEX_MESSAGE_BYTES;
  if (patchCount > MAX_JUNO106_SYSEX_PATCHES) {
    throw new Juno106SysExError(
      `Juno-106 SysEx banks may contain at most ${MAX_JUNO106_SYSEX_PATCHES} patches`,
      'bounds',
    );
  }

  return Array.from({ length: patchCount }, (_unused, patchIndex) =>
    parseMessageAt(bytes, patchIndex * JUNO106_SYSEX_MESSAGE_BYTES, patchIndex),
  );
};
