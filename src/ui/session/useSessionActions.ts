import { useMemo } from 'react';

import { createSessionActions, type SessionActions } from './session-actions';
import { useSessionViewModel } from './SessionViewModelProvider';

export const useSessionActions = (): SessionActions => {
  const { manager } = useSessionViewModel();

  return useMemo(() => createSessionActions(manager), [manager]);
};
