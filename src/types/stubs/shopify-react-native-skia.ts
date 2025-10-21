import type { ComponentType, ReactNode } from 'react';
import type { LayoutChangeEvent, StyleProp, ViewStyle } from 'react-native';

export interface SkPath {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  close(): void;
  toCmds(): string[];
  toSVGString(): string;
}

export interface PathProps {
  path: SkPath;
  color?: string;
  style?: 'stroke' | 'fill';
  strokeWidth?: number;
}

export const Skia = {
  Path: {
    Make(): SkPath {
      const commands: string[] = [];
      return {
        moveTo: (x: number, y: number) => {
          commands.push(`M${x},${y}`);
        },
        lineTo: (x: number, y: number) => {
          commands.push(`L${x},${y}`);
        },
        close: () => {
          commands.push('Z');
        },
        toCmds: () => [...commands],
        toSVGString: () => commands.join(' '),
      };
    },
  },
};

export const Canvas: ComponentType<{
  style?: StyleProp<ViewStyle>;
  onLayout?: (event: LayoutChangeEvent) => void;
  children?: ReactNode;
}> = () => null;

export const Path: ComponentType<PathProps> = () => null;
export const Group: ComponentType<Record<string, unknown>> = () => null;
