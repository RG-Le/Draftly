import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="callback-page">
      <div className="callback-card">
        <h2>Page not found</h2>
        <p>The page you requested does not exist in this workspace.</p>
        <Link to="/" className="inline-link">
          Back to home
        </Link>
      </div>
    </div>
  );
}
