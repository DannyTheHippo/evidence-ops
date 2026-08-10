import { useEffect, useState } from 'react';
import { getMe, type Me } from '../api/client';

export default function HomePage() {
  const [user, setUser] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMe()
      .then(setUser)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load account');
      });
  }, []);

  return (
    <div className="view view--flow">
      <div className="page-head">
        <div>
          <span className="eyebrow">Account</span>
          <h1 className="page-title">Home</h1>
          <p className="page-sub">You are signed in.</p>
        </div>
      </div>

      <section className="card card--narrow">
        {user && (
          <dl className="form">
            <div>
              <dt>Email</dt>
              <dd>{user.email}</dd>
            </div>
            <div>
              <dt>Member since</dt>
              <dd>{new Date(user.createdAt).toLocaleDateString()}</dd>
            </div>
          </dl>
        )}
        {!user && !error && <p>Loading…</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
