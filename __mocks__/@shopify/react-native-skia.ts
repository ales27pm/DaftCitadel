/* eslint-disable @typescript-eslint/no-explicit-any */
export const Canvas = 'Canvas';
export const Path = 'Path';
export const Group = 'Group';
export const Skia = {
  Path: {
    Make: () => {
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
        toCmds: () => commands,
        toSVGString: () => commands.join(' '),
      } as SkPath;
    },
  },
};

export type SkPath = any;

export const useValue = <T,>(value: T) => ({ current: value });
export const useComputedValue = (compute: () => any) => ({ current: compute() });

export default {
  Canvas,
  Path,
  Skia,
  useValue,
  useComputedValue,
};
