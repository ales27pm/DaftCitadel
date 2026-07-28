import React from 'react';

export type SFSymbol = string;

export const SymbolView: React.FC<Record<string, unknown>> = ({
  fallback: _fallback,
  ...props
}) => React.createElement('SymbolView', props);
