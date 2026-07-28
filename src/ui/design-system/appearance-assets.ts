import type { ImageSource } from 'expo-image';

import type { StudioSurface } from './tokens';

export const STUDIO_SURFACE_SOURCES: Record<StudioSurface, ImageSource> = {
  carbon: require('../../../assets/ui/surfaces/carbon.webp'),
  grid: require('../../../assets/ui/surfaces/grid.webp'),
  spectral: require('../../../assets/ui/surfaces/spectral.webp'),
};
