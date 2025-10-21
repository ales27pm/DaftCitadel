/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ComponentType, ReactNode } from 'react';

export interface NativeStackScreenProps<
  ParamList extends Record<string, object | undefined>,
> {
  name: keyof ParamList & string;
  component: ComponentType<any>;
  options?: Record<string, unknown>;
}

export interface NativeStackNavigator<
  ParamList extends Record<string, object | undefined>,
> {
  Navigator: ComponentType<{ children?: ReactNode }>;
  Screen: ComponentType<NativeStackScreenProps<ParamList>>;
}

export function createNativeStackNavigator<
  ParamList extends Record<string, object | undefined>,
>(): NativeStackNavigator<ParamList> {
  const Navigator: ComponentType<{ children?: ReactNode }> = ({ children }) =>
    children ?? null;
  const Screen: ComponentType<NativeStackScreenProps<ParamList>> = () => null;
  return {
    Navigator,
    Screen,
  };
}
