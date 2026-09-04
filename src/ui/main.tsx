import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { createOperatorQueryClient } from './query-client.js';
import './styles.css';

const root = document.querySelector('#root');

if (root === null) {
  throw new Error('Operator UI root element is missing');
}

const queryClient = createOperatorQueryClient();

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
