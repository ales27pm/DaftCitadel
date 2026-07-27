import 'react-native-gesture-handler';
import React from 'react';
import {registerRootComponent} from 'expo';
import App from './App';

const installGlobalErrorGuard = () => {
  const errorUtils = globalThis.ErrorUtils;
  if (!errorUtils || typeof errorUtils.setGlobalHandler !== 'function') {
    return;
  }
  errorUtils.setGlobalHandler((error, isFatal) => {
    console.error('Unhandled JS error guarded at app root', {
      error,
      isFatal,
    });
  });
};

installGlobalErrorGuard();

function Bootstrap() {
  return <App />;
}

registerRootComponent(Bootstrap);
