import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { completeGoogleCallback, getMeWithToken } from '../api/auth';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

export function AuthCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { setSession } = useAuth();
  const { pushToast } = useToast();
  const [status, setStatus] = useState<'working' | 'error'>('working');
  const [errorMessage, setErrorMessage] = useState('Unable to complete authentication.');

  useEffect(() => {
    const run = async () => {
      const code = searchParams.get('code');
      const state = searchParams.get('state');
      const accessToken = searchParams.get('accessToken');
      const refreshToken = searchParams.get('refreshToken');
      const error = searchParams.get('error');

      if (error) {
        setStatus('error');
        setErrorMessage(error);
        return;
      }

      try {
        if (accessToken && refreshToken) {
          const user = await getMeWithToken(accessToken);
          setSession({ user, accessToken, refreshToken });
          pushToast({ title: 'Authenticated', description: 'Signed in successfully.', tone: 'success' });
          navigate('/app/inbox');
          return;
        }

        if (code && state) {
          const session = await completeGoogleCallback(code, state);
          setSession(session);
          pushToast({ title: 'Authenticated', description: 'Google sign-in successful.', tone: 'success' });
          navigate('/app/inbox');
          return;
        }

        setStatus('error');
        setErrorMessage('Missing callback parameters. Please retry login.');
      } catch (err: any) {
        setStatus('error');
        setErrorMessage(err?.message || 'Failed to complete Google login callback.');
      }
    };

    void run();
  }, [searchParams, setSession, navigate, pushToast]);

  if (status === 'working') {
    return (
      <div className="callback-page">
        <div className="callback-card">
          <h2>Completing sign-in...</h2>
          <p>We are finalizing your Draftly session.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="callback-page">
      <div className="callback-card">
        <h2>Sign-in could not be completed</h2>
        <p>{errorMessage}</p>
        <p>
          If you are using the current backend callback response mode, use local login for now or configure the
          backend to redirect to this page after OAuth.
        </p>
        <Link to="/" className="inline-link">
          Back to login
        </Link>
      </div>
    </div>
  );
}
