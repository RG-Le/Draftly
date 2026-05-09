import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { completeConnectionCallback } from '../api/connections';
import { useToast } from '../context/ToastContext';

export function OAuthConnectionCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = params.get('code');
    const state = params.get('state');
    const connector = params.get('connector') || 'gmail';

    if (!code || !state) {
      setError('Missing OAuth callback parameters.');
      return;
    }

    completeConnectionCallback(code, state, connector)
      .then(() => {
        pushToast({
          title: 'Connection established',
          description: 'Connector linked successfully.',
          tone: 'success'
        });
        navigate('/app/inbox');
      })
      .catch((err: any) => {
        setError(err?.message || 'Connector callback failed.');
      });
  }, [params, navigate, pushToast]);

  if (error) {
    return (
      <div className="callback-page">
        <div className="callback-card">
          <h2>Connection failed</h2>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="callback-page">
      <div className="callback-card">
        <h2>Finishing connector setup...</h2>
        <p>One moment while we store permissions and start sync.</p>
      </div>
    </div>
  );
}
