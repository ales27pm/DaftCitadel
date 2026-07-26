/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ComponentType, ReactNode } from 'react';

export interface BottomTabScreenProps<
  ParamList extends Record<string, object | undefined>,
> {
  name: keyof ParamList & string;
  component: ComponentType<any>;
  options?: Record<string, unknown>;
}

export interface BottomTabNavigatorProps {
  children?: ReactNode;
  screenOptions?: Record<string, unknown>;
}

export interface BottomTabNavigator<
  ParamList extends Record<string, object | undefined>,
> {
  Navigator: ComponentType<BottomTabNavigatorProps>;
  Screen: ComponentType<BottomTabScreenProps<ParamList>>;
}

export function createBottomTabNavigator<
  ParamList extends Record<string, object | undefined>,
>(): BottomTabNavigator<ParamList> {
  const Navigator: ComponentType<BottomTabNavigatorProps> = ({ children }) =>
    children ?? null;
  const Screen: ComponentType<BottomTabScreenProps<ParamList>> = () => null;
  return {
    Navigator,
    Screen,
  };
}
