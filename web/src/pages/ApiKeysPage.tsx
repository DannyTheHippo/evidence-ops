import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  listApiKeys,
  mintApiKey,
  revokeApiKey,
  type ApiKey,
  type MintedApiKey,
} from '../api/client';

/**
 * Drops the one-time plaintext `token` from a minted key, returning only the metadata the list
 * renders. This is the sole path a minted key takes into the `keys` state, so that state holds no
 * credential at any point.
 */
// eslint-disable-next-line react-refresh/only-export-components -- non-component export: this file trades fast refresh for a token-stripping guarantee a test can assert directly
export function toListedKey({ token: _token, ...listed }: MintedApiKey): ApiKey {
  return listed;
}

function keyStatus(key: ApiKey): { className: string; label: string } {
  if (key.revokedAt) return { className: 'badge badge--reject', label: 'revoked' };
  if (key.expiresAt && new Date(key.expiresAt) <= new Date()) {
    return { className: 'badge badge--neutral', label: 'expired' };
  }
  return { className: 'badge badge--strong', label: 'active' };
}

function KeyRow({ apiKey, onRevoked }: { apiKey: ApiKey; onRevoked: (id: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const status = keyStatus(apiKey);
  const revoked = Boolean(apiKey.revokedAt);

  // Arming the confirm unmounts the button that was focused, which would otherwise drop focus to
  // <body> and strand a keyboard user mid-revoke.
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  async function handleRevoke() {
    setRevoking(true);
    setError(null);
    try {
      await revokeApiKey(apiKey.id);
      onRevoked(apiKey.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to revoke key');
      setRevoking(false);
    }
  }

  return (
    <tr>
      <td>{apiKey.name}</td>
      <td className="cell-sub mono">{apiKey.tokenPrefix}…</td>
      <td>
        <span className={status.className}>{status.label}</span>
      </td>
      <td className="cell-sub">
        {apiKey.expiresAt ? new Date(apiKey.expiresAt).toLocaleString() : 'Never expires'}
      </td>
      <td className="cell-actions">
        {!revoked &&
          (confirming ? (
            <div className="form-actions" role="alert">
              <button
                type="button"
                ref={confirmRef}
                className="btn btn--primary btn--sm"
                disabled={revoking}
                onClick={() => void handleRevoke()}
              >
                {revoking ? 'Revoking…' : 'Confirm revoke'}
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={revoking}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => setConfirming(true)}
            >
              Revoke
            </button>
          ))}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </td>
    </tr>
  );
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  // The page's only copy of a plaintext token, backing the one-time panel. `keys` receives a
  // stripped copy, so dismissing the panel, starting another mint, or leaving the page destroys it,
  // matching the server's one-time delivery.
  const [minted, setMinted] = useState<MintedApiKey | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    listApiKeys()
      .then(({ docs }) => setKeys(docs))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load API keys');
      });
  }, []);

  async function handleMint(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMinting(true);
    setMintError(null);
    setCopied(false);
    // The previous token's panel goes with the previous attempt; a failed mint must not leave it
    // on screen beside the new error.
    setMinted(null);
    try {
      const key = await mintApiKey(name, expiresAt ? new Date(expiresAt).toISOString() : undefined);
      setMinted(key);
      setKeys((current) => [toListedKey(key), ...(current ?? [])]);
      setName('');
      setExpiresAt('');
    } catch (err: unknown) {
      setMintError(err instanceof Error ? err.message : 'Failed to mint API key');
    } finally {
      setMinting(false);
    }
  }

  async function handleCopy() {
    if (!minted) return;
    // jsdom (and some browser contexts) has no Clipboard API — a missing `navigator.clipboard`
    // must not throw, it just means the copy affordance silently does nothing.
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(minted.token);
    setCopied(true);
  }

  function handleRevoked(id: string) {
    setKeys(
      (current) =>
        current?.map((key) =>
          key.id === id ? { ...key, revokedAt: new Date().toISOString() } : key,
        ) ?? current,
    );
  }

  return (
    <div className="view view--flow">
      <div className="page-head">
        <div>
          <span className="eyebrow">Platform</span>
          <h1 className="page-title">API Keys</h1>
          <p className="page-sub">Tokens an MCP client uses to authenticate as you.</p>
        </div>
      </div>

      {minted && (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">{minted.name}</h2>
          </div>
          <p className="notice notice--warn">
            This is the only time this token is shown. It cannot be retrieved again — copy it now or
            mint a new key later.
          </p>
          <p className="mono">{minted.token}</p>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => void handleCopy()}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setMinted(null);
                setCopied(false);
              }}
            >
              Dismiss
            </button>
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Mint a key</h2>
        </div>
        <form onSubmit={(e) => void handleMint(e)} className="form">
          <label>
            Name
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="CI integration"
            />
          </label>
          <label>
            Expires (optional)
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
            <span className="form-hint">Leave blank for a key that never expires.</span>
          </label>
          <div className="form-actions">
            <button type="submit" className="btn btn--primary" disabled={minting}>
              {minting ? 'Minting…' : 'Mint key'}
            </button>
          </div>
        </form>
        {mintError && (
          <p className="error" role="alert">
            {mintError}
          </p>
        )}
      </section>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!keys && !error && <p>Loading…</p>}

      {keys && keys.length === 0 && <p className="notice notice--info">No API keys yet.</p>}

      {keys && keys.length > 0 && (
        <section className="panel">
          <table className="grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                <th>Status</th>
                <th>Expires</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <KeyRow key={key.id} apiKey={key} onRevoked={handleRevoked} />
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
