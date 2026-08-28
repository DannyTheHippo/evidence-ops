import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  listApiKeys,
  mintApiKey,
  revokeApiKey,
  rotateApiKey,
  type ApiKey,
  type ApiKeySortField,
  type MintedApiKey,
  type SortDirection,
} from '../api/client';
import { IconKey } from '../components/icons';
import RecordListPage, { type RecordListStatus } from '../components/RecordListPage';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import CopyButton from '../components/ui/CopyButton';
import Field from '../components/ui/Field';
import Pager from '../components/ui/Pager';
import SortableHeaderCell from '../components/ui/SortableHeaderCell';
import Table, { TableCell, TableHeaderCell } from '../components/ui/Table';
import Timestamp from '../components/ui/Timestamp';
import { notify } from '../components/ui/toast';
import { useUrlState } from '../lib/use-url-state';

const PAGE_SIZE = 20;

// Declared at module scope so `useUrlState` adopts one stable-in-value object on mount; see
// AnswersPage for the identity/value distinction that makes an inline literal safe here too.
const URL_DEFAULTS: Record<'sort' | 'sortDir' | 'skip', string> = {
  sort: 'createdAt',
  sortDir: 'desc',
  skip: '0',
};

// The plaintext token a mint or a rotate just returned, backing the one-time panel below the
// header. `action` only changes the panel's wording — mint and rotate share one panel because
// both hand back the same shape and both must disappear the moment the operator navigates away
// or starts another mint/rotate.
interface OneTimeToken {
  key: MintedApiKey;
  action: 'minted' | 'rotated';
}

function keyStatus(key: ApiKey): { tone: 'verified' | 'caution' | 'neutral'; label: string } {
  if (key.revokedAt) return { tone: 'neutral', label: 'revoked' };
  if (key.expiresAt && new Date(key.expiresAt) <= new Date()) {
    return { tone: 'caution', label: 'expired' };
  }
  return { tone: 'verified', label: 'active' };
}

function KeyRow({
  apiKey,
  onRevoked,
  onRotated,
}: {
  apiKey: ApiKey;
  onRevoked: (id: string) => void;
  onRotated: (rotated: MintedApiKey) => void;
}) {
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const status = keyStatus(apiKey);
  const revoked = Boolean(apiKey.revokedAt);

  async function handleRotate() {
    setRotating(true);
    setRotateError(null);
    try {
      const rotated = await rotateApiKey(apiKey.id);
      notify('success', `Rotated "${apiKey.name}". The previous token no longer works.`);
      setRotateOpen(false);
      onRotated(rotated);
    } catch (err: unknown) {
      setRotateError(err instanceof Error ? err.message : 'Failed to rotate key');
    } finally {
      setRotating(false);
    }
  }

  async function handleRevoke() {
    setRevoking(true);
    setRevokeError(null);
    try {
      await revokeApiKey(apiKey.id);
      notify('success', `Revoked "${apiKey.name}".`);
      setRevokeOpen(false);
      onRevoked(apiKey.id);
    } catch (err: unknown) {
      setRevokeError(err instanceof Error ? err.message : 'Failed to revoke key');
    } finally {
      setRevoking(false);
    }
  }

  return (
    <tr>
      <TableCell label="Name">{apiKey.name}</TableCell>
      <TableCell label="Prefix" className="cell-sub mono">
        {apiKey.tokenPrefix}…
      </TableCell>
      <TableCell label="Status">
        <Badge tone={status.tone}>{status.label}</Badge>
      </TableCell>
      <TableCell label="Created" className="cell-sub">
        <Timestamp value={apiKey.createdAt} />
      </TableCell>
      <TableCell label="Expires" className="cell-sub">
        {apiKey.expiresAt ? <Timestamp value={apiKey.expiresAt} /> : 'Never expires'}
      </TableCell>
      <TableCell label="Last used" className="cell-sub">
        {apiKey.lastUsedAt ? <Timestamp value={apiKey.lastUsedAt} /> : 'Never used'}
      </TableCell>
      <TableCell label="Actions" className="cell-actions">
        {!revoked && (
          <>
            <Button variant="secondary" size="sm" onClick={() => setRotateOpen(true)}>
              Rotate
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setRevokeOpen(true)}>
              Revoke
            </Button>
            <ConfirmDialog
              open={rotateOpen}
              onClose={() => setRotateOpen(false)}
              title={`Rotate "${apiKey.name}"?`}
              body="This issues a fresh token onto this same key — its name, creation date and audit history stay. The current token stops working the instant rotation completes, so anything still using it starts failing right away."
              confirmLabel="Rotate key"
              destructive
              busy={rotating}
              error={rotateError ?? undefined}
              onConfirm={() => void handleRotate()}
            />
            <ConfirmDialog
              open={revokeOpen}
              onClose={() => setRevokeOpen(false)}
              title={`Revoke "${apiKey.name}"?`}
              body="Revoking is immediate and cannot be undone. Any MCP client using this key loses access right away."
              confirmLabel="Revoke key"
              destructive
              busy={revoking}
              error={revokeError ?? undefined}
              onConfirm={() => void handleRevoke()}
            />
          </>
        )}
      </TableCell>
    </tr>
  );
}

export default function ApiKeysPage() {
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  const sort = urlState.sort as ApiKeySortField;
  const sortDir = urlState.sortDir as SortDirection;
  const skip = Number(urlState.skip);

  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  // The page's only copy of a plaintext token, backing the one-time panel. `keys` is populated
  // solely by re-fetching the list endpoint, whose response never carries a token, so dismissing
  // the panel, starting another mint or rotate, or leaving the page destroys the only copy that
  // exists, matching the server's one-time delivery.
  const [oneTimeToken, setOneTimeToken] = useState<OneTimeToken | null>(null);
  // Blocks a double mint between the click and the re-render that disables the submit button —
  // `disabled={minting}` alone only takes effect once React has committed it.
  const mintInFlightRef = useRef(false);

  // The plaintext token above is the only copy that will ever exist; closing the tab or reloading
  // while the panel holds one destroys it exactly as if the operator had never seen it. In-app
  // navigation away from this page is not covered — this app uses the declarative router, which
  // has no navigation-blocking API, only `beforeunload` for a full document unload.
  useEffect(() => {
    if (!oneTimeToken) return;
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [oneTimeToken]);

  const load = useCallback(() => {
    return listApiKeys({ skip, limit: PAGE_SIZE, sort, sortDir })
      .then(({ docs, count: total }) => {
        setKeys(docs);
        setCount(total);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load API keys');
      });
  }, [skip, sort, sortDir]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleMint(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (mintInFlightRef.current) return;
    mintInFlightRef.current = true;
    setMinting(true);
    setMintError(null);
    // The previous token's panel goes with the previous attempt; a failed mint must not leave it
    // on screen beside the new error.
    setOneTimeToken(null);
    try {
      const key = await mintApiKey(name, expiresAt ? new Date(expiresAt).toISOString() : undefined);
      setOneTimeToken({ key, action: 'minted' });
      void load();
      setName('');
      setExpiresAt('');
      notify('success', `Minted "${key.name}".`);
    } catch (err: unknown) {
      setMintError(err instanceof Error ? err.message : 'Failed to mint API key');
    } finally {
      setMinting(false);
      mintInFlightRef.current = false;
    }
  }

  function handleRevoked(id: string) {
    setKeys(
      (current) =>
        current?.map((key) =>
          key.id === id ? { ...key, revokedAt: new Date().toISOString() } : key,
        ) ?? current,
    );
  }

  function handleRotated(rotated: MintedApiKey) {
    setKeys(
      (current) =>
        current?.map((key) =>
          key.id === rotated.id ? { ...key, tokenPrefix: rotated.tokenPrefix } : key,
        ) ?? current,
    );
    setOneTimeToken({ key: rotated, action: 'rotated' });
  }

  function handleSort(field: ApiKeySortField) {
    const nextDir: SortDirection = field === sort && sortDir === 'desc' ? 'asc' : 'desc';
    setUrlState({ sort: field, sortDir: nextDir, skip: URL_DEFAULTS.skip });
  }

  let status: RecordListStatus;
  if (keys === null) {
    status = error ? { kind: 'blank' } : { kind: 'loading', label: 'Loading API keys…' };
  } else if (keys.length === 0) {
    status = {
      kind: 'empty',
      icon: <IconKey size={24} />,
      title: 'No API keys yet',
      description:
        'An API key authenticates the MCP surface as you. Mint one above to connect an MCP client.',
    };
  } else {
    status = { kind: 'ready' };
  }

  return (
    <RecordListPage
      eyebrow="Admin"
      title="API Keys"
      description="Tokens an MCP client uses to authenticate as you."
      filters={
        <>
          {oneTimeToken && (
            <section className="card">
              <div className="card-head">
                <h2 className="card-title">{oneTimeToken.key.name}</h2>
              </div>
              <p className="notice notice--warn">
                {oneTimeToken.action === 'rotated'
                  ? 'This is the only time the new token is shown, and it cannot be retrieved again. The previous token has already stopped working — copy this one now.'
                  : 'This is the only time this token is shown. It cannot be retrieved again — copy it now or mint a new key later.'}
              </p>
              <p className="mono">{oneTimeToken.key.token}</p>
              <div className="form-actions">
                <CopyButton text={oneTimeToken.key.token} />
                <Button variant="ghost" size="sm" onClick={() => setOneTimeToken(null)}>
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
              <Field
                label="Expires (optional)"
                hint="Leave blank and the platform applies its own default expiry. Set a date to choose a different one."
              >
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
        </>
      }
      error={error ?? undefined}
      status={status}
      footer={
        keys && (
          <Pager
            count={count}
            skip={skip}
            pageSize={PAGE_SIZE}
            onSkipChange={(next) => setUrlState({ skip: String(next) })}
          />
        )
      }
    >
      {keys && keys.length > 0 && (
        <section className="panel">
          <Table caption="API keys that authenticate an MCP client as you.">
            <thead>
              <tr>
                <SortableHeaderCell<ApiKeySortField>
                  field="name"
                  label="Name"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <TableHeaderCell>Prefix</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <SortableHeaderCell<ApiKeySortField>
                  field="createdAt"
                  label="Created"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <SortableHeaderCell<ApiKeySortField>
                  field="expiresAt"
                  label="Expires"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <SortableHeaderCell<ApiKeySortField>
                  field="lastUsedAt"
                  label="Last used"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <TableHeaderCell>Actions</TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <KeyRow
                  key={key.id}
                  apiKey={key}
                  onRevoked={handleRevoked}
                  onRotated={handleRotated}
                />
              ))}
            </tbody>
          </Table>
        </section>
      )}
    </RecordListPage>
  );
}
