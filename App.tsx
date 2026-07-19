import React from 'react';
import { StatusBar } from 'expo-status-bar';

import { AppNavigator } from './src/ui/navigation';

// Expo's root-component contract requires a default export at this boundary.
// eslint-disable-next-line import/no-default-export
export default function App(): React.JSX.Element {
  return (
    <>
      <StatusBar style="light" />
      <AppNavigator />
    </>
  );
}
