export type AppTabParamList = {
  Arrangement: undefined;
  Mixer: undefined;
  Performance: undefined;
  Settings: undefined;
};

export type StudioIconName =
  | 'arrangement'
  | 'mixer'
  | 'performance'
  | 'settings'
  | 'play'
  | 'stop'
  | 'rewind'
  | 'plus'
  | 'engine'
  | 'waveform'
  | 'midi'
  | 'diagnostics'
  | 'chevronDown'
  | 'chevronUp'
  | 'mute'
  | 'solo';

export type AppTabName = keyof AppTabParamList;

export const APP_TAB_SEQUENCE: ReadonlyArray<AppTabName> = [
  'Arrangement',
  'Mixer',
  'Performance',
  'Settings',
];

export const APP_TABS: ReadonlyArray<{
  name: AppTabName;
  label: string;
  icon: StudioIconName;
  accessibilityLabel: string;
}> = [
  {
    name: 'Arrangement',
    label: 'ARRANGE',
    icon: 'arrangement',
    accessibilityLabel: 'Arrangement',
  },
  { name: 'Mixer', label: 'MIXER', icon: 'mixer', accessibilityLabel: 'Mixer' },
  {
    name: 'Performance',
    label: 'PERFORM',
    icon: 'performance',
    accessibilityLabel: 'Performance',
  },
  {
    name: 'Settings',
    label: 'SETTINGS',
    icon: 'settings',
    accessibilityLabel: 'Settings',
  },
];
