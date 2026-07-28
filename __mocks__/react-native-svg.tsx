import React from 'react';

export const Svg: React.FC<Record<string, unknown>> = (props) =>
  React.createElement('Svg', props);

export const Path: React.FC<Record<string, unknown>> = (props) =>
  React.createElement('SvgPath', props);

export default Svg;
