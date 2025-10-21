import 'react-native';

declare module 'react-native' {
  export const __mockPluginHostEmitter: {
    emit: (eventName: string, payload?: unknown) => void;
    addListener: (
      eventName: string,
      listener: (...args: unknown[]) => void,
    ) => { remove: () => void };
  };
}
