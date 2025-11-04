import {
  getSupportedPluginFormats,
  parsePluginCacheHints,
  parseProfileManifest,
  isSupportedPluginFormat,
  type InstallerProfileManifest,
  type PluginCacheHintsFile,
} from '../metadata';

describe('installer metadata parsing', () => {
  const baseManifest: InstallerProfileManifest = {
    version: 2,
    generatedAt: '2024-08-01T00:00:00Z',
    profile: 'citadel',
    profileName: 'Daft Citadel',
    features: {
      ai: true,
      gui: true,
      expandedSynths: true,
      heavyAssets: true,
      grooveTools: false,
      experimentalSynths: false,
      container: false,
    },
    paths: {
      base: '/home/daftpunk/DaftCitadel',
      log: '/home/daftpunk/daft_citadel.log',
      pluginCache: '/home/daftpunk/DaftCitadel/PluginCache',
      pluginCacheHints: '/home/daftpunk/DaftCitadel/plugin_cache_hints.json',
    },
    modules: {
      enabledOverrides: ['ai', 'synths'],
      disabledOverrides: ['experimental'],
    },
  };

  const baseHints: PluginCacheHintsFile = {
    version: 1,
    generatedAt: '2024-08-01T00:00:00Z',
    hints: [
      {
        format: 'vst3',
        identifier: 'surge-xt',
        name: 'Surge XT',
        binaryPath: '/usr/lib/vst3/Surge XT.vst3',
        cachePath: '/home/daftpunk/DaftCitadel/PluginCache/vst3/surge-xt',
        version: '1.3.4',
        enabled: true,
        available: true,
        modules: ['synths', 'core', 'synths'],
      },
    ],
  };

  it('normalizes profile manifest payloads', () => {
    const parsed = parseProfileManifest({
      ...baseManifest,
      modules: {
        enabledOverrides: ['synths', 'ai', 'ai'],
        disabledOverrides: ['experimental', 'experimental'],
      },
    });

    expect(parsed.profile).toBe('citadel');
    expect(parsed.features.heavyAssets).toBe(true);
    expect(parsed.paths.pluginCacheHints).toBe(
      '/home/daftpunk/DaftCitadel/plugin_cache_hints.json',
    );
    expect(parsed.modules.enabledOverrides).toEqual(['ai', 'synths']);
    expect(parsed.modules.disabledOverrides).toEqual(['experimental']);
  });

  it('throws when manifest features are malformed', () => {
    expect(() =>
      parseProfileManifest({
        ...baseManifest,
        features: { ...baseManifest.features, ai: 'yes' as unknown as boolean },
      }),
    ).toThrow('Invalid features.ai');
  });

  it('normalizes plugin cache hints and dedupes module tags', () => {
    const parsed = parsePluginCacheHints(baseHints);
    expect(parsed.hints).toHaveLength(1);
    const hint = parsed.hints[0];
    expect(hint.modules).toEqual(['core', 'synths']);
    expect(hint.enabled).toBe(true);
  });

  it('rejects unsupported plugin formats', () => {
    const invalid = {
      ...baseHints,
      hints: [
        {
          ...baseHints.hints[0],
          format: 'unknown-format',
        },
      ],
    };
    expect(() => parsePluginCacheHints(invalid)).toThrow('unsupported plugin format');
  });

  it('exposes supported plugin formats helper', () => {
    const formats = getSupportedPluginFormats();
    expect(formats).toContain('vst3');
    expect(isSupportedPluginFormat('CLAP')).toBe(true);
    expect(isSupportedPluginFormat('superplug')).toBe(false);
  });
});
