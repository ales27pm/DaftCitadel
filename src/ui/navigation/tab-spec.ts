import type { StudioIconName } from '../design-system';

export type AppTabParamList = {
  Arrangement: undefined;
  Mixer: undefined;
  Performance: undefined;
  Settings: undefined;
};

export type AppTabName = keyof AppTabParamList;

export const APP_TABS: ReadonlyArray<{
  name: AppTabName;
  icon: StudioIconName;
  accessibilityLabel: string;
}> = [
  { name: 'Arrangement', icon: 'arrangement', accessibilityLabel: 'Arrangement' },
  { name: 'Mixer', icon: 'mixer', accessibilityLabel: 'Mixer' },
  { name: 'Performance', icon: 'performance', accessibilityLabel: 'Performance' },
  { name: 'Settings', icon: 'settings', accessibilityLabel: 'Settings' },
];
