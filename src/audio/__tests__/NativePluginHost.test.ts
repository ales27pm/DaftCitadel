import { NativeModules } from 'react-native';

import { isPluginHostAvailable } from '../plugins/NativePluginHost';

describe('native plugin-host capability', () => {
  const module = NativeModules.PluginHostModule as {
    runtimeReady?: boolean;
  };
  const originalRuntimeReady = module.runtimeReady;

  afterEach(() => {
    module.runtimeReady = originalRuntimeReady;
  });

  it('is available only when native explicitly reports a render-ready runtime', () => {
    module.runtimeReady = true;
    expect(isPluginHostAvailable()).toBe(true);
  });

  it.each([false, undefined])('fails closed when runtimeReady is %s', (runtimeReady) => {
    module.runtimeReady = runtimeReady;
    expect(isPluginHostAvailable()).toBe(false);
  });
});
