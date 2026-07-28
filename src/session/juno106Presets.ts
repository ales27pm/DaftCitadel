import { Buffer } from 'buffer';

import {
  JUNO106_DEFAULT_PARAMETERS,
  JUNO106_PARAMETER_NAMES,
  type Juno106ParameterMap,
  type Juno106ParameterName,
} from './models';
import {
  JUNO106_SYSEX_MESSAGE_BYTES,
  parseJuno106SysExMessage,
  type Juno106SysExPatch,
} from './juno106SysEx';

export const JUNO106_PRESET_FORMAT = 'daftcitadel.juno106-preset';
export const JUNO106_PRESET_VERSION = 1;
export const MAX_JUNO106_PRESET_ID_LENGTH = 64;
export const MAX_JUNO106_PRESET_NAME_LENGTH = 80;
export const MAX_JUNO106_PRESET_SERIALIZED_BYTES = 4096;

const PRESET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_CUTOFF_HZ = 20000;
const PRESET_KEYS = new Set([
  'format',
  'version',
  'id',
  'name',
  'instrumentType',
  'parameters',
  'source',
  'rawSysEx',
]);

const PARAMETER_RANGES: Record<
  Juno106ParameterName,
  readonly [minimum: number, maximum: number]
> = {
  pulseWidth: [0.05, 0.95],
  subLevel: [0, 1],
  cutoffHz: [20, MAX_CUTOFF_HZ],
  resonance: [0, 1.2],
  attackSeconds: [0.0005, 30],
  releaseSeconds: [0.0005, 30],
  chorusMode: [0, 2],
  outputGain: [0, 2],
  lfoRateHz: [0.05, 20],
  lfoDepth: [0, 1],
};

export type Juno106PresetSource =
  | { kind: 'builtin' }
  | {
      kind: 'sysex';
      sourcePatchNumber: number;
      midiChannel: number;
    }
  | { kind: 'user' };

export interface Juno106PresetRecord {
  format: typeof JUNO106_PRESET_FORMAT;
  version: typeof JUNO106_PRESET_VERSION;
  id: string;
  name: string;
  instrumentType: 'juno106';
  parameters: Juno106ParameterMap;
  source: Juno106PresetSource;
  rawSysEx?: number[];
}

export type Juno106PresetValidationErrorCode =
  'bounds' | 'format' | 'version' | 'validation';

export class Juno106PresetValidationError extends Error {
  constructor(
    message: string,
    public readonly code: Juno106PresetValidationErrorCode,
  ) {
    super(message);
    this.name = 'Juno106PresetValidationError';
  }
}

const cloneSource = (source: Juno106PresetSource): Juno106PresetSource => ({
  ...source,
});

export const cloneJuno106Preset = (preset: Juno106PresetRecord): Juno106PresetRecord => ({
  ...preset,
  parameters: { ...preset.parameters },
  source: cloneSource(preset.source),
  ...(preset.rawSysEx ? { rawSysEx: [...preset.rawSysEx] } : {}),
});

export const validateJuno106PresetId = (id: string): void => {
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > MAX_JUNO106_PRESET_ID_LENGTH ||
    !PRESET_ID_PATTERN.test(id)
  ) {
    throw new Juno106PresetValidationError(
      `Juno-106 preset id must match ${PRESET_ID_PATTERN.source} and contain at most ${MAX_JUNO106_PRESET_ID_LENGTH} characters`,
      'validation',
    );
  }
};

export function validateJuno106Preset(
  value: unknown,
): asserts value is Juno106PresetRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Juno106PresetValidationError(
      'Juno-106 preset must be an object',
      'validation',
    );
  }
  const preset = value as Partial<Juno106PresetRecord>;
  if (Object.keys(preset).some((key) => !PRESET_KEYS.has(key))) {
    throw new Juno106PresetValidationError(
      'Juno-106 preset contains unsupported fields',
      'validation',
    );
  }
  if (preset.format !== JUNO106_PRESET_FORMAT) {
    throw new Juno106PresetValidationError(
      'Unsupported Juno-106 preset format',
      'format',
    );
  }
  if (preset.version !== JUNO106_PRESET_VERSION) {
    throw new Juno106PresetValidationError(
      `Unsupported Juno-106 preset version ${String(preset.version)}`,
      'version',
    );
  }
  if (preset.instrumentType !== 'juno106') {
    throw new Juno106PresetValidationError(
      'Juno-106 preset has an invalid instrument type',
      'validation',
    );
  }
  validateJuno106PresetId(preset.id as string);
  if (
    typeof preset.name !== 'string' ||
    preset.name.length === 0 ||
    preset.name !== preset.name.trim() ||
    preset.name.length > MAX_JUNO106_PRESET_NAME_LENGTH
  ) {
    throw new Juno106PresetValidationError(
      `Juno-106 preset name must be trimmed and contain 1-${MAX_JUNO106_PRESET_NAME_LENGTH} characters`,
      'validation',
    );
  }
  if (
    !preset.parameters ||
    typeof preset.parameters !== 'object' ||
    Array.isArray(preset.parameters)
  ) {
    throw new Juno106PresetValidationError(
      'Juno-106 preset requires a parameter map',
      'validation',
    );
  }

  const parameterKeys = Object.keys(preset.parameters);
  if (
    parameterKeys.length !== JUNO106_PARAMETER_NAMES.length ||
    parameterKeys.some(
      (parameter) => !JUNO106_PARAMETER_NAMES.includes(parameter as Juno106ParameterName),
    )
  ) {
    throw new Juno106PresetValidationError(
      'Juno-106 preset contains missing or unsupported parameters',
      'validation',
    );
  }
  JUNO106_PARAMETER_NAMES.forEach((parameter) => {
    const parameterValue = preset.parameters?.[parameter];
    const [minimum, maximum] = PARAMETER_RANGES[parameter];
    if (
      !Number.isFinite(parameterValue) ||
      (parameterValue as number) < minimum ||
      (parameterValue as number) > maximum
    ) {
      throw new Juno106PresetValidationError(
        `Juno-106 preset parameter ${parameter} must be finite and between ${minimum} and ${maximum}`,
        'validation',
      );
    }
  });
  if (!Number.isInteger(preset.parameters.chorusMode)) {
    throw new Juno106PresetValidationError(
      'Juno-106 preset chorusMode must be 0, 1, or 2',
      'validation',
    );
  }

  const source = preset.source as Partial<Juno106PresetSource> | undefined;
  if (
    !source ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    !['builtin', 'sysex', 'user'].includes(source.kind ?? '')
  ) {
    throw new Juno106PresetValidationError(
      'Juno-106 preset has invalid source metadata',
      'validation',
    );
  }
  if (source.kind === 'sysex') {
    const sysexSource = source as Partial<
      Extract<Juno106PresetSource, { kind: 'sysex' }>
    >;
    if (
      !Number.isInteger(sysexSource.sourcePatchNumber) ||
      (sysexSource.sourcePatchNumber as number) < 0 ||
      (sysexSource.sourcePatchNumber as number) > 127 ||
      !Number.isInteger(sysexSource.midiChannel) ||
      (sysexSource.midiChannel as number) < 0 ||
      (sysexSource.midiChannel as number) > 15
    ) {
      throw new Juno106PresetValidationError(
        'Juno-106 SysEx source metadata is out of range',
        'validation',
      );
    }
    if (
      Object.keys(source).length !== 3 ||
      !Object.keys(source).every((key) =>
        ['kind', 'sourcePatchNumber', 'midiChannel'].includes(key),
      )
    ) {
      throw new Juno106PresetValidationError(
        'Juno-106 SysEx source metadata contains unsupported fields',
        'validation',
      );
    }
  } else if (Object.keys(source).length !== 1) {
    throw new Juno106PresetValidationError(
      'Juno-106 preset source metadata contains unsupported fields',
      'validation',
    );
  }

  if (preset.rawSysEx !== undefined) {
    if (
      !Array.isArray(preset.rawSysEx) ||
      preset.rawSysEx.length !== JUNO106_SYSEX_MESSAGE_BYTES
    ) {
      throw new Juno106PresetValidationError(
        `Raw Juno-106 SysEx must contain exactly ${JUNO106_SYSEX_MESSAGE_BYTES} bytes`,
        'bounds',
      );
    }
    try {
      parseJuno106SysExMessage(preset.rawSysEx);
    } catch (error) {
      throw new Juno106PresetValidationError(
        `Raw Juno-106 SysEx is invalid: ${(error as Error).message}`,
        'validation',
      );
    }
  }
}

export const serializeJuno106Preset = (preset: Juno106PresetRecord): string => {
  validateJuno106Preset(preset);
  const serialized = JSON.stringify(cloneJuno106Preset(preset));
  if (Buffer.byteLength(serialized, 'utf8') > MAX_JUNO106_PRESET_SERIALIZED_BYTES) {
    throw new Juno106PresetValidationError(
      `Serialized Juno-106 preset exceeds the ${MAX_JUNO106_PRESET_SERIALIZED_BYTES}-byte limit`,
      'bounds',
    );
  }
  return serialized;
};

export const deserializeJuno106Preset = (serialized: string): Juno106PresetRecord => {
  if (
    typeof serialized !== 'string' ||
    serialized.length === 0 ||
    Buffer.byteLength(serialized, 'utf8') > MAX_JUNO106_PRESET_SERIALIZED_BYTES
  ) {
    throw new Juno106PresetValidationError(
      `Serialized Juno-106 preset must contain 1-${MAX_JUNO106_PRESET_SERIALIZED_BYTES} UTF-8 bytes`,
      'bounds',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Juno106PresetValidationError(
      `Juno-106 preset JSON is invalid: ${(error as Error).message}`,
      'format',
    );
  }
  validateJuno106Preset(parsed);
  return cloneJuno106Preset(parsed);
};

const normalizedSlider = (value: number): number => value / 127;
const rounded = (value: number): number => Number(value.toFixed(6));
const scaleLinear = (value: number, minimum: number, maximum: number): number =>
  rounded(minimum + normalizedSlider(value) * (maximum - minimum));
const scaleExponential = (value: number, minimum: number, maximum: number): number =>
  rounded(minimum * Math.pow(maximum / minimum, normalizedSlider(value)));

export interface MapJuno106SysExPresetOptions {
  id?: string;
  name?: string;
  preserveRawSysEx?: boolean;
}

export const mapJuno106SysExPatchToPreset = (
  patch: Juno106SysExPatch,
  options: MapJuno106SysExPresetOptions = {},
): Juno106PresetRecord => {
  // Reparse the bounded raw message so callers cannot forge decoded fields.
  const verified = parseJuno106SysExMessage(patch.rawSysEx);
  const patchLabel = String(verified.sourcePatchNumber + 1).padStart(3, '0');
  const preset: Juno106PresetRecord = {
    format: JUNO106_PRESET_FORMAT,
    version: JUNO106_PRESET_VERSION,
    id: options.id ?? `juno106-sysex-${patchLabel}`,
    name: options.name?.trim() || `Imported Juno-106 ${patchLabel}`,
    instrumentType: 'juno106',
    parameters: {
      ...JUNO106_DEFAULT_PARAMETERS,
      pulseWidth: scaleLinear(verified.sliders.dcoPwmDepth, 0.05, 0.95),
      subLevel: rounded(normalizedSlider(verified.sliders.dcoSubLevel)),
      cutoffHz: scaleExponential(verified.sliders.vcfCutoff, 20, MAX_CUTOFF_HZ),
      resonance: scaleLinear(verified.sliders.vcfResonance, 0, 1.2),
      attackSeconds: scaleExponential(verified.sliders.envAttack, 0.0005, 30),
      releaseSeconds: scaleExponential(verified.sliders.envRelease, 0.0005, 30),
      chorusMode: verified.switches.chorusOn
        ? verified.switches.chorusLevelII
          ? 2
          : 1
        : 0,
      // Keep the Juno core's conservative output headroom at full VCA level.
      outputGain: rounded(
        JUNO106_DEFAULT_PARAMETERS.outputGain *
          normalizedSlider(verified.sliders.vcaLevel),
      ),
      lfoRateHz: scaleExponential(verified.sliders.lfoRate, 0.05, 20),
      lfoDepth: rounded(normalizedSlider(verified.sliders.dcoLfoMod)),
    },
    source: {
      kind: 'sysex',
      sourcePatchNumber: verified.sourcePatchNumber,
      midiChannel: verified.midiChannel,
    },
    ...(options.preserveRawSysEx === false ? {} : { rawSysEx: [...verified.rawSysEx] }),
  };
  validateJuno106Preset(preset);
  return preset;
};

const createBuiltInPreset = (
  id: string,
  name: string,
  parameters: Juno106ParameterMap,
): Readonly<Juno106PresetRecord> => {
  const preset: Juno106PresetRecord = {
    format: JUNO106_PRESET_FORMAT,
    version: JUNO106_PRESET_VERSION,
    id,
    name,
    instrumentType: 'juno106',
    parameters,
    source: { kind: 'builtin' },
  };
  validateJuno106Preset(preset);
  Object.freeze(preset.parameters);
  Object.freeze(preset.source);
  return Object.freeze(preset);
};

const BUILT_IN_PRESETS: ReadonlyArray<Readonly<Juno106PresetRecord>> = Object.freeze([
  createBuiltInPreset('builtin-init', 'Init Juno', {
    ...JUNO106_DEFAULT_PARAMETERS,
  }),
  createBuiltInPreset('builtin-neon-bass', 'Neon Bass', {
    ...JUNO106_DEFAULT_PARAMETERS,
    pulseWidth: 0.38,
    subLevel: 0.78,
    cutoffHz: 820,
    resonance: 0.42,
    attackSeconds: 0.004,
    releaseSeconds: 0.32,
    chorusMode: 0,
    outputGain: 0.16,
    lfoRateHz: 4.2,
    lfoDepth: 0.04,
  }),
  createBuiltInPreset('builtin-soft-pad', 'Soft Pad', {
    ...JUNO106_DEFAULT_PARAMETERS,
    pulseWidth: 0.48,
    subLevel: 0.28,
    cutoffHz: 1850,
    resonance: 0.24,
    attackSeconds: 1.4,
    releaseSeconds: 4.2,
    chorusMode: 2,
    outputGain: 0.18,
    lfoRateHz: 0.35,
    lfoDepth: 0.12,
  }),
]);

export const listBuiltInJuno106Presets = (): Juno106PresetRecord[] =>
  BUILT_IN_PRESETS.map((preset) => cloneJuno106Preset(preset));
