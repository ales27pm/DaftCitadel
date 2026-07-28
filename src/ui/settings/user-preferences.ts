import {
  DEFAULT_STUDIO_APPEARANCE,
  GLOW_INTENSITIES,
  INTERFACE_DENSITIES,
  STUDIO_ACCENT_PALETTES,
  STUDIO_SURFACES,
  type GlowIntensity,
  type InterfaceDensity,
  type StudioAccentPalette,
  type StudioSurface,
} from '../design-system/tokens';
import {
  clearPreferenceMemoryStorageForTesting,
  getPreferenceStorage,
} from './preference-storage';

export interface UserPreferences {
  accentPalette: StudioAccentPalette;
  autoPlayScenes: boolean;
  glowIntensity: GlowIntensity;
  interfaceDensity: InterfaceDensity;
  showDiagnostics: boolean;
  studioSurface: StudioSurface;
}

type PreferenceListener = () => void;

const STORAGE_KEY = 'daft-citadel:user-preferences:v1';

export const DEFAULT_USER_PREFERENCES: Readonly<UserPreferences> = {
  accentPalette: DEFAULT_STUDIO_APPEARANCE.accentPalette,
  autoPlayScenes: false,
  glowIntensity: DEFAULT_STUDIO_APPEARANCE.glow,
  interfaceDensity: DEFAULT_STUDIO_APPEARANCE.density,
  showDiagnostics: true,
  studioSurface: DEFAULT_STUDIO_APPEARANCE.surface,
};

const listeners = new Set<PreferenceListener>();
let snapshot: UserPreferences | undefined;

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isAllowedValue = <Value extends string>(
  value: unknown,
  allowed: ReadonlyArray<Value>,
): value is Value => typeof value === 'string' && allowed.includes(value as Value);

const readPreferences = (): UserPreferences => {
  try {
    const stored = getPreferenceStorage().getItem(STORAGE_KEY);
    if (!stored) {
      return { ...DEFAULT_USER_PREFERENCES };
    }
    const parsed = JSON.parse(stored) as Partial<UserPreferences>;
    return {
      accentPalette: isAllowedValue(parsed.accentPalette, STUDIO_ACCENT_PALETTES)
        ? parsed.accentPalette
        : DEFAULT_USER_PREFERENCES.accentPalette,
      autoPlayScenes: isBoolean(parsed.autoPlayScenes)
        ? parsed.autoPlayScenes
        : DEFAULT_USER_PREFERENCES.autoPlayScenes,
      glowIntensity: isAllowedValue(parsed.glowIntensity, GLOW_INTENSITIES)
        ? parsed.glowIntensity
        : DEFAULT_USER_PREFERENCES.glowIntensity,
      interfaceDensity: isAllowedValue(parsed.interfaceDensity, INTERFACE_DENSITIES)
        ? parsed.interfaceDensity
        : DEFAULT_USER_PREFERENCES.interfaceDensity,
      showDiagnostics: isBoolean(parsed.showDiagnostics)
        ? parsed.showDiagnostics
        : DEFAULT_USER_PREFERENCES.showDiagnostics,
      studioSurface: isAllowedValue(parsed.studioSurface, STUDIO_SURFACES)
        ? parsed.studioSurface
        : DEFAULT_USER_PREFERENCES.studioSurface,
    };
  } catch (error) {
    console.warn('Failed to load user preferences; using defaults', error);
    return { ...DEFAULT_USER_PREFERENCES };
  }
};

const getSnapshot = (): UserPreferences => {
  snapshot ??= readPreferences();
  return snapshot;
};

const setPreferences = (next: UserPreferences): void => {
  snapshot = next;
  try {
    getPreferenceStorage().setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn('Failed to persist user preferences', error);
  }
  listeners.forEach((listener) => listener());
};

export const userPreferencesStore = {
  getSnapshot,
  subscribe(listener: PreferenceListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  update(patch: Partial<UserPreferences>): void {
    setPreferences({ ...getSnapshot(), ...patch });
  },
  resetForTesting(): void {
    snapshot = undefined;
    clearPreferenceMemoryStorageForTesting();
    listeners.clear();
  },
};
