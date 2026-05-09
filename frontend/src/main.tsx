import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { PipelineStatusProvider } from './context/PipelineStatusContext';
import { ToastProvider } from './context/ToastContext';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1
    }
  }
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <PipelineStatusProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </PipelineStatusProvider>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
