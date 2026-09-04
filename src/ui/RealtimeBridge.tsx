import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { ensureOperatorRealtime } from './realtime.js';

export const RealtimeBridge = ({ initialSequence }: { readonly initialSequence: number }) => {
  const queryClient = useQueryClient();
  const initialSequenceRef = useRef(initialSequence);

  useEffect(() => {
    const realtime = ensureOperatorRealtime(queryClient, {
      initialSequence: initialSequenceRef.current,
    });
    return () => {
      realtime.close();
    };
  }, [queryClient]);

  return null;
};
