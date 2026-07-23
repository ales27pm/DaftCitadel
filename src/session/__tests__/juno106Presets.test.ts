import {
  deserializeJuno106Preset,
  JUNO106_PRESET_FORMAT,
  JUNO106_PRESET_VERSION,
  listBuiltInJuno106Presets,
  mapJuno106SysExPatchToPreset,
  serializeJuno106Preset,
  validateJuno106Preset,
} from '../juno106Presets';
import {
  computeJuno106RolandChecksum,
  MAX_JUNO106_SYSEX_BYTES,
  parseJuno106SysExBank,
  parseJuno106SysExMessage,
} from '../juno106SysEx';

const createValidSysEx = (overrides: Readonly<Record<number, number>> = {}): number[] => {
  const bytes = new Array<number>(25).fill(0);
  bytes[0] = 0xf0;
  bytes[1] = 0x41;
  bytes[2] = 0x12;
  bytes[3] = 4;
  bytes[4] = 0;
  bytes[5] = 127;
  bytes[6] = 18;
  bytes[7] = 127;
  bytes[8] = 127;
  bytes[9] = 9;
  bytes[10] = 127;
  bytes[11] = 127;
  bytes[12] = 12;
  bytes[13] = 13;
  bytes[14] = 14;
  bytes[15] = 127;
  bytes[16] = 0;
  bytes[17] = 17;
  bytes[18] = 18;
  bytes[19] = 127;
  bytes[20] = 127;
  bytes[21] = 0;
  bytes[22] = 0;
  bytes[24] = 0xf7;
  Object.entries(overrides).forEach(([index, value]) => {
    bytes[Number(index)] = value;
  });
  bytes[23] = computeJuno106RolandChecksum(bytes.slice(5, 23));
  return bytes;
};

describe('Juno-106 SysEx parsing and presets', () => {
  it('strictly parses the pinned 25-byte Juno-106 layout', () => {
    const bytes = createValidSysEx();
    expect(bytes[23]).toBe(35);

    const patch = parseJuno106SysExMessage(Uint8Array.from(bytes));

    expect(patch).toMatchObject({
      midiChannel: 2,
      sourcePatchNumber: 4,
      sliders: {
        lfoRate: 127,
        lfoDelay: 18,
        dcoLfoMod: 127,
        dcoPwmDepth: 127,
        dcoNoiseLevel: 9,
        vcfCutoff: 127,
        vcfResonance: 127,
        vcfEnvMod: 12,
        vcfLfoMod: 13,
        vcfKeyFollow: 14,
        vcaLevel: 127,
        envAttack: 0,
        envDecay: 17,
        envSustain: 18,
        envRelease: 127,
        dcoSubLevel: 127,
      },
      switches: {
        chorusOn: true,
        chorusLevelII: true,
        pwmSourceLFO: true,
        vcfEnvPositive: true,
        vcaModeEnv: true,
        hpfSetting: 0,
      },
      checksum: bytes[23],
    });
    expect(patch.rawSysEx).toEqual(bytes);
    expect(Object.isFrozen(patch.rawSysEx)).toBe(true);
  });

  it('maps supported SysEx controls into a versioned preset', () => {
    const preset = mapJuno106SysExPatchToPreset(
      parseJuno106SysExMessage(createValidSysEx()),
    );

    expect(preset).toMatchObject({
      format: JUNO106_PRESET_FORMAT,
      version: JUNO106_PRESET_VERSION,
      id: 'juno106-sysex-005',
      name: 'Imported Juno-106 005',
      instrumentType: 'juno106',
      parameters: {
        pulseWidth: 0.95,
        subLevel: 1,
        cutoffHz: 20000,
        resonance: 1.2,
        attackSeconds: 0.0005,
        releaseSeconds: 30,
        chorusMode: 2,
        outputGain: 0.2,
        lfoRateHz: 20,
        lfoDepth: 1,
      },
      source: {
        kind: 'sysex',
        sourcePatchNumber: 4,
        midiChannel: 2,
      },
    });
    expect(preset.rawSysEx).toHaveLength(25);
    expect(
      mapJuno106SysExPatchToPreset(parseJuno106SysExMessage(createValidSysEx()), {
        preserveRawSysEx: false,
      }).rawSysEx,
    ).toBeUndefined();
  });

  it('rejects malformed, non-7-bit, and checksum-invalid messages', () => {
    const valid = createValidSysEx();
    expect(() => parseJuno106SysExMessage(valid.slice(0, 24))).toThrow(
      expect.objectContaining({ code: 'length' }),
    );
    expect(() => parseJuno106SysExMessage([...valid, 0])).toThrow(
      expect.objectContaining({ code: 'bounds' }),
    );
    expect(() => parseJuno106SysExMessage(createValidSysEx({ 0: 0xf1 }))).toThrow(
      expect.objectContaining({ code: 'format' }),
    );
    expect(() => parseJuno106SysExMessage(createValidSysEx({ 1: 0x42 }))).toThrow(
      expect.objectContaining({ code: 'format' }),
    );
    expect(() => parseJuno106SysExMessage(createValidSysEx({ 24: 0xf6 }))).toThrow(
      expect.objectContaining({ code: 'format' }),
    );

    const nonSevenBit = [...valid];
    nonSevenBit[5] = 0x80;
    expect(() => parseJuno106SysExMessage(nonSevenBit)).toThrow(
      expect.objectContaining({ code: 'data' }),
    );

    const badChecksum = [...valid];
    badChecksum[23] = (badChecksum[23] + 1) % 128;
    expect(() => parseJuno106SysExMessage(badChecksum)).toThrow(
      expect.objectContaining({ code: 'checksum' }),
    );
  });

  it('enforces checksum and bank bounds before decoding', () => {
    expect(() => computeJuno106RolandChecksum([1, 2])).toThrow(
      expect.objectContaining({ code: 'length' }),
    );
    expect(() =>
      computeJuno106RolandChecksum([...new Array<number>(17).fill(0), 0x80]),
    ).toThrow(expect.objectContaining({ code: 'data' }));
    expect(() => parseJuno106SysExBank([...createValidSysEx(), 0])).toThrow(
      expect.objectContaining({ code: 'length' }),
    );
    expect(() =>
      parseJuno106SysExBank(new Array<number>(MAX_JUNO106_SYSEX_BYTES + 1).fill(0)),
    ).toThrow(expect.objectContaining({ code: 'bounds' }));

    expect(
      parseJuno106SysExBank([
        ...createValidSysEx({ 3: 0 }),
        ...createValidSysEx({ 3: 1 }),
      ]).map((patch) => patch.sourcePatchNumber),
    ).toEqual([0, 1]);
  });

  it('round-trips and validates the complete versioned preset record', () => {
    const preset = mapJuno106SysExPatchToPreset(
      parseJuno106SysExMessage(createValidSysEx()),
    );
    const restored = deserializeJuno106Preset(serializeJuno106Preset(preset));

    expect(restored).toEqual(preset);
    expect(restored).not.toBe(preset);
    expect(restored.parameters).not.toBe(preset.parameters);
    expect(restored.rawSysEx).not.toBe(preset.rawSysEx);

    expect(() =>
      deserializeJuno106Preset(
        JSON.stringify({ ...preset, version: JUNO106_PRESET_VERSION + 1 }),
      ),
    ).toThrow(expect.objectContaining({ code: 'version' }));
    expect(() =>
      validateJuno106Preset({
        ...preset,
        parameters: { ...preset.parameters, lfoDepth: undefined },
      }),
    ).toThrow(expect.objectContaining({ code: 'validation' }));
    expect(() => validateJuno106Preset({ ...preset, rawSysEx: [0xf0, 0xf7] })).toThrow(
      expect.objectContaining({ code: 'bounds' }),
    );
    expect(() => validateJuno106Preset({ ...preset, unsupportedBlob: 'nope' })).toThrow(
      expect.objectContaining({ code: 'validation' }),
    );
    expect(() => deserializeJuno106Preset('💥'.repeat(2000))).toThrow(
      expect.objectContaining({ code: 'bounds' }),
    );
  });

  it('provides a small deterministic, mutation-isolated built-in bank', () => {
    const first = listBuiltInJuno106Presets();
    const second = listBuiltInJuno106Presets();

    expect(first.map(({ id }) => id)).toEqual([
      'builtin-init',
      'builtin-neon-bass',
      'builtin-soft-pad',
    ]);
    expect(first).toEqual(second);
    first[0].name = 'Changed';
    first[0].parameters.lfoDepth = 1;
    expect(second[0].name).toBe('Init Juno');
    expect(second[0].parameters.lfoDepth).toBe(0);
    second.forEach(validateJuno106Preset);
  });
});
