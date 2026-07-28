import React from 'react';

const insets = { bottom: 0, left: 0, right: 0, top: 0 };
const frame = { height: 832, width: 1280, x: 0, y: 0 };

export const SafeAreaInsetsContext = React.createContext(insets);
export const SafeAreaFrameContext = React.createContext(frame);
export const SafeAreaView = 'SafeAreaView';
export const SafeAreaProvider = 'SafeAreaProvider';
export const initialWindowMetrics = { frame, insets };
export const useSafeAreaInsets = () => insets;
export const useSafeAreaFrame = () => frame;
