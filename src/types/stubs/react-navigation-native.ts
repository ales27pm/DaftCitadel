import type { ComponentType, ReactNode } from 'react';

export interface Theme {
  dark: boolean;
  colors: {
    primary: string;
    background: string;
    card: string;
    text: string;
    border: string;
    notification: string;
    [key: string]: string;
  };
}

export const DefaultTheme: Theme = {
  dark: false,
  colors: {
    primary: '#000000',
    background: '#ffffff',
    card: '#ffffff',
    text: '#000000',
    border: '#000000',
    notification: '#ff0000',
  },
};

export interface NavigationContainerProps {
  children?: ReactNode;
  theme?: Theme;
}

export const NavigationContainer: ComponentType<NavigationContainerProps> = () => null;

export type NavigationTheme = Theme;
