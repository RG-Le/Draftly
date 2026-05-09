import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { loginLocal, registerLocal, getGoogleAuthUrl } from '../api/auth';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { Button } from '../components/Button';

export function LandingPage() {
  const navigate = useNavigate();
  const { setSession } = useAuth();
  const { pushToast } = useToast();

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);

    try {
      const session =
        mode === 'login'
          ? await loginLocal(email, password)
          : await registerLocal(email, name, password);

      setSession(session);
      pushToast({ title: 'Welcome to Draftly', description: 'Session started successfully.', tone: 'success' });
      navigate('/app/inbox');
    } catch (error: any) {
      pushToast({
        title: 'Authentication failed',
        description: error?.message || 'Unable to authenticate right now.',
        tone: 'danger'
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="landing">
      <section className="landing-hero">
        <p className="hero-kicker">Approval-first Gmail AI workflow</p>
        <h1>Draftly keeps you in control of every reply.</h1>
        <p>
          Sync your inbox, triage threads, review AI drafts, and send only what you approve.
          Human-in-the-loop by design.
        </p>
        <ul>
          <li>Incremental Google consent, not all permissions upfront</li>
          <li>Triage-first queue so priority replies surface fast</li>
          <li>Live sync, draft, and send status in one workspace</li>
        </ul>
      </section>

      <section className="landing-auth">
        <div className="auth-card">
          <h2>Sign in to Draftly</h2>
          <p>Use Google for the full flow, or local auth for development/testing.</p>

          <Button
            className="google-btn"
            variant="secondary"
            onClick={() => {
              window.location.href = getGoogleAuthUrl();
            }}
          >
            Continue with Google
          </Button>

          <div className="auth-divider">
            <span>or</span>
          </div>

          <div className="auth-mode-toggle">
            <button
              className={mode === 'login' ? 'active' : ''}
              onClick={() => setMode('login')}
              type="button"
            >
              Login
            </button>
            <button
              className={mode === 'register' ? 'active' : ''}
              onClick={() => setMode('register')}
              type="button"
            >
              Register
            </button>
          </div>

          <form onSubmit={handleSubmit}>
            {mode === 'register' ? (
              <label>
                Name
                <input value={name} onChange={(event) => setName(event.target.value)} required />
              </label>
            ) : null}

            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>

            <label>
              Password
              <input
                type="password"
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>

            <Button type="submit" loading={loading}>
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </Button>
          </form>
        </div>
      </section>
    </div>
  );
}
