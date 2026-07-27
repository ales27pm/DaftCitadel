const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const expoVirtualNoop = path.resolve(__dirname, 'src/polyfills/expoVirtualNoop.js');
const defaultResolveRequest = config.resolver.resolveRequest;

// Expo's native Web Streams prelude runs before Metro's module wrappers exist.
// Keep Babel helpers inlined there; otherwise Release Hermes crashes on launch
// when the prelude tries to call a global `require`.
config.transformer.enableBabelRuntime = false;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const isNativePlatform = platform === 'ios' || platform === 'android' || platform === 'native';
  const isExpoVirtualRuntime =
    moduleName === 'expo/virtual/rsc' ||
    moduleName === 'expo/virtual/rsc.js' ||
    moduleName === 'expo/virtual/streams' ||
    moduleName === 'expo/virtual/streams.js';

  if (isNativePlatform && isExpoVirtualRuntime) {
    return {
      type: 'sourceFile',
      filePath: expoVirtualNoop,
    };
  }

  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
