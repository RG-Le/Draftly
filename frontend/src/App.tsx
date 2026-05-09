import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './components/RequireAuth';
import { ToastViewport } from './components/ToastViewport';
import { AppLayout } from './pages/AppLayout';
import { AuthCallbackPage } from './pages/AuthCallbackPage';
import { DraftsPage } from './pages/DraftsPage';
import { InboxPage } from './pages/InboxPage';
import { LandingPage } from './pages/LandingPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OAuthConnectionCallbackPage } from './pages/OAuthConnectionCallbackPage';
import { SentPage } from './pages/SentPage';
import { SettingsPage } from './pages/SettingsPage';
import { UsagePage } from './pages/UsagePage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/auth/callback" element={<AuthCallbackPage />} />
        <Route path="/app/oauth/callback" element={<OAuthConnectionCallbackPage />} />

        <Route element={<RequireAuth />}>
          <Route path="/app" element={<AppLayout />}>
            <Route index element={<Navigate to="/app/inbox" replace />} />
            <Route path="inbox" element={<InboxPage />} />
            <Route path="inbox/:threadId" element={<InboxPage />} />
            <Route path="drafts" element={<DraftsPage />} />
            <Route path="sent" element={<SentPage />} />
            <Route path="usage" element={<UsagePage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <ToastViewport />
    </BrowserRouter>
  );
}
