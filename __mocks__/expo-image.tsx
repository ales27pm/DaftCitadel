import React from 'react';

export type ImageSource = unknown;

export const Image: React.FC<Record<string, unknown>> = (props) =>
  React.createElement('ExpoImage', props);
