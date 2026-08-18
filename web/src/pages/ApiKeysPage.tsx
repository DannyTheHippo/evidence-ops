import { useEffect, useState, type FormEvent } from 'react';
import {
  listApiKeys,
  mintApiKey,
  revokeApiKey,
  type ApiKey,
  type MintedApiKey,
} from '../api/client';
import { IconCopy } from '../components/icons';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Dialog from '../components/ui/Dialog';
import EmptyState from '../components/ui/EmptyState';
import Field from '../components/ui/Field';
import Skeleton from '../components/ui/Skeleton';
import Table, { TableHeaderCell } from '../components/ui/Table';
import { notify } from '../components/ui/toast';

/**
 * Drops the one-time plaintext `token` from a minted key, returning only the metadata the list
 * renders. This is the sole path a minted key takes into the `keys` state, so that state holds no
 * credential at any point.
 */
// eslint-disable-next-line react-refresh/only-export-components -- non-component export: this file trades fast refresh for a token-stripping guarantee a test can assert directly
export function toListedKey({ token: _token, ...listed }: MintedApiKey): ApiKey {
  return listed;
}

function keyStatus(key: ApiKey): { tone: 'verified' | 'caution' | 'neutral'; label: string } {
  if (key.revokedAt) return { tone: 'neutral', label: 'revoked' };
  if (key.expiresAt && new Date(key.expiresAt) <= new Date()) {
    return { tone: 'caution', label: 'expired' };
  }
  return { tone: 'verified', label: 'active' };
}

function KeyRow({ apiKey, onRevoked }: { apiKey: ApiKey; onRevoked: (id: string) => void }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = keyStatus(apiKey);
  const revoked = Boolean(apiKey.revokedAt);

  async function handleRevoke() {
    setRevoking(true);
    setError(null);
    try {
      await revokeApiKey(apiKey.id);
      notify('success', `Revoked "${apiKey.name}".`);
      setConfirmOpen(false);
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
        <Badge tone={status.tone}>{status.label}</Badge>
      </td>
      <td className="cell-sub">
        {apiKey.expiresAt ? new Date(apiKey.expiresAt).toLocaleString() : 'Never expires'}
      </td>
      <td className="cell-actions">
        {!revoked && (
          <>
            <Button variant="secondary" size="sm" onClick={() => setConfirmOpen(true)}>
              Revoke
            </Button>
            <Dialog
              open={confirmOpen}
              onClose={() => setConfirmOpen(false)}
              title={`Revoke "${apiKey.name}"?`}
            >
              <p>
                Revoking is immediate and cannot be undone. Any MCP client using this key loses
                access right away.
              </p>
              <div className="form-actions">
                <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
                  Cancel
                </Button>
                <Button variant="danger" disabled={revoking} onClick={() => void handleRevoke()}>
                  {revoking ? 'Revoking…' : 'Revoke key'}
                </Button>
              </div>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
            </Dialog>
          </>
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
      notify('success', `Minted "${key.name}".`);
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
            <Button variant="secondary" size="sm" onClick={() => void handleCopy()}>
              <IconCopy />
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setMinted(null);
                setCopied(false);
              }}
            >
              Dismiss
            </Button>
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Mint a key</h2>
        </div>
        <form onSubmit={(e) => void handleMint(e)} className="form">
          <Field label="Name">
            {(inputProps) => (
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="CI integration"
                {...inputProps}
              />
            )}
          </Field>
          <Field label="Expires (optional)" hint="Leave blank for a key that never expires.">
            {(inputProps) => (
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                {...inputProps}
              />
            )}
          </Field>
          <div className="form-actions">
            <Button type="submit" variant="primary" disabled={minting}>
              {minting ? 'Minting…' : 'Mint key'}
            </Button>
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

      {!keys && !error && <Skeleton label="Loading API keys…" />}

      {keys && keys.length === 0 && (
        <EmptyState
          title="No API keys yet"
          description="An API key authenticates the MCP surface as you. Mint one above to connect an MCP client."
        />
      )}

      {keys && keys.length > 0 && (
        <section className="panel">
          <Table caption="API keys that authenticate an MCP client as you.">
            <thead>
              <tr>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Prefix</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Expires</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <KeyRow key={key.id} apiKey={key} onRevoked={handleRevoked} />
              ))}
            </tbody>
          </Table>
        </section>
      )}
    </div>
  );
}
