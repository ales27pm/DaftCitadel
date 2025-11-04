const SUPPORTED_PLUGIN_FORMATS = [
  'vst3',
  'vst',
  'clap',
  'lv2',
  'auv3',
  'standalone',
] as const;

type UnknownRecord = Record<string, unknown>;

type SupportedPluginFormatsTuple = typeof SUPPORTED_PLUGIN_FORMATS;

export type PluginFormat = SupportedPluginFormatsTuple[number];

export interface InstallerProfilePaths {
  readonly base: string;
  readonly log: string;
  readonly pluginCache: string;
  readonly pluginCacheHints: string;
}

export interface InstallerProfileFeatures {
  readonly ai: boolean;
  readonly gui: boolean;
  readonly expandedSynths: boolean;
  readonly heavyAssets: boolean;
  readonly grooveTools: boolean;
  readonly experimentalSynths: boolean;
  readonly container: boolean;
}

export interface InstallerProfileModules {
  readonly enabledOverrides: readonly string[];
  readonly disabledOverrides: readonly string[];
}

export interface InstallerProfileManifest {
  readonly version: number;
  readonly generatedAt: string;
  readonly profile: string;
  readonly profileName?: string;
  readonly features: InstallerProfileFeatures;
  readonly paths: InstallerProfilePaths;
  readonly modules: InstallerProfileModules;
}

export interface PluginCacheHintEntry {
  readonly format: PluginFormat;
  readonly identifier: string;
  readonly name: string;
  readonly binaryPath: string;
  readonly cachePath: string;
  readonly version?: string;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly modules: readonly string[];
}

export interface PluginCacheHintsFile {
  readonly version: number;
  readonly generatedAt: string;
  readonly hints: readonly PluginCacheHintEntry[];
}

export const PROFILE_MANIFEST_FILENAME = 'citadel_profile.json';
export const PLUGIN_CACHE_HINTS_FILENAME = 'plugin_cache_hints.json';

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ensureString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${path}: expected a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Invalid ${path}: expected a non-empty string`);
  }
  return trimmed;
}

function ensureOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return ensureString(value, path);
}

function ensureBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid ${path}: expected a boolean`);
  }
  return value;
}

function ensurePositiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${path}: expected a non-negative integer`);
  }
  return value;
}

function ensureStringArray(value: unknown, path: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${path}: expected an array`);
  }
  const result: string[] = [];
  value.forEach((entry, index) => {
    const resolved = ensureString(entry, `${path}[${index}]`);
    result.push(resolved);
  });
  return dedupeAndSort(result);
}

function ensurePluginFormat(value: unknown, path: string): PluginFormat {
  const format = ensureString(value, path).toLowerCase();
  if ((SUPPORTED_PLUGIN_FORMATS as readonly string[]).includes(format)) {
    return format as PluginFormat;
  }
  throw new Error(`Invalid ${path}: unsupported plugin format '${format}'`);
}

function dedupeAndSort(values: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  values.forEach((value) => {
    if (!seen.has(value)) {
      seen.add(value);
      ordered.push(value);
    }
  });
  return ordered.sort();
}

function parseModules(value: unknown): InstallerProfileModules {
  if (!value) {
    return { enabledOverrides: [], disabledOverrides: [] };
  }
  if (!isRecord(value)) {
    throw new Error('Invalid modules: expected an object');
  }
  const enabled = ensureStringArray(value.enabledOverrides, 'modules.enabledOverrides');
  const disabled = ensureStringArray(
    value.disabledOverrides,
    'modules.disabledOverrides',
  );
  return { enabledOverrides: enabled, disabledOverrides: disabled };
}

function parseFeatures(record: UnknownRecord): InstallerProfileFeatures {
  return {
    ai: ensureBoolean(record.ai, 'features.ai'),
    gui: ensureBoolean(record.gui, 'features.gui'),
    expandedSynths: ensureBoolean(record.expandedSynths, 'features.expandedSynths'),
    heavyAssets: ensureBoolean(record.heavyAssets, 'features.heavyAssets'),
    grooveTools: ensureBoolean(record.grooveTools, 'features.grooveTools'),
    experimentalSynths: ensureBoolean(
      record.experimentalSynths,
      'features.experimentalSynths',
    ),
    container: ensureBoolean(record.container, 'features.container'),
  };
}

function parsePaths(record: UnknownRecord): InstallerProfilePaths {
  return {
    base: ensureString(record.base, 'paths.base'),
    log: ensureString(record.log, 'paths.log'),
    pluginCache: ensureString(record.pluginCache, 'paths.pluginCache'),
    pluginCacheHints: ensureString(record.pluginCacheHints, 'paths.pluginCacheHints'),
  };
}

function parsePluginCacheHintEntry(value: unknown, index: number): PluginCacheHintEntry {
  if (!isRecord(value)) {
    throw new Error(`Invalid plugin cache hint at index ${index}: expected an object`);
  }

  const format = ensurePluginFormat(value.format, `hints[${index}].format`);
  const identifier = ensureString(value.identifier, `hints[${index}].identifier`);
  const name = ensureString(value.name, `hints[${index}].name`);
  const binaryPath = ensureString(value.binaryPath, `hints[${index}].binaryPath`);
  const cachePath = ensureString(value.cachePath, `hints[${index}].cachePath`);
  const version = ensureOptionalString(value.version, `hints[${index}].version`);
  const enabled = ensureBoolean(value.enabled, `hints[${index}].enabled`);
  const available = ensureBoolean(value.available, `hints[${index}].available`);
  const modules = ensureStringArray(value.modules, `hints[${index}].modules`);

  return {
    format,
    identifier,
    name,
    binaryPath,
    cachePath,
    version,
    enabled,
    available,
    modules,
  };
}

export function parseProfileManifest(payload: unknown): InstallerProfileManifest {
  if (!isRecord(payload)) {
    throw new Error('Invalid profile manifest: expected an object');
  }

  const version = ensurePositiveInteger(payload.version, 'version');
  const generatedAt = ensureString(payload.generatedAt, 'generatedAt');
  const profile = ensureString(payload.profile, 'profile');
  const profileName = ensureOptionalString(payload.profileName, 'profileName');

  const featuresValue = payload.features;
  if (!isRecord(featuresValue)) {
    throw new Error('Invalid features: expected an object');
  }
  const features = parseFeatures(featuresValue);

  const pathsValue = payload.paths;
  if (!isRecord(pathsValue)) {
    throw new Error('Invalid paths: expected an object');
  }
  const paths = parsePaths(pathsValue);

  const modules = parseModules(payload.modules);

  return {
    version,
    generatedAt,
    profile,
    profileName,
    features,
    paths,
    modules,
  };
}

export function parsePluginCacheHints(payload: unknown): PluginCacheHintsFile {
  if (!isRecord(payload)) {
    throw new Error('Invalid plugin cache hints: expected an object');
  }

  const version = ensurePositiveInteger(payload.version, 'version');
  const generatedAt = ensureString(payload.generatedAt, 'generatedAt');
  const hintsValue = payload.hints;
  if (!Array.isArray(hintsValue)) {
    throw new Error('Invalid hints: expected an array');
  }

  const hints = hintsValue.map((entry, index) => parsePluginCacheHintEntry(entry, index));

  return {
    version,
    generatedAt,
    hints,
  };
}

export function isSupportedPluginFormat(format: string): format is PluginFormat {
  return (SUPPORTED_PLUGIN_FORMATS as readonly string[]).includes(format.toLowerCase());
}

export function getSupportedPluginFormats(): readonly PluginFormat[] {
  return SUPPORTED_PLUGIN_FORMATS;
}
