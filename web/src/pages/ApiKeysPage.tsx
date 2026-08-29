import { useCallback, useEffect, useRef, useState } from 'react';
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
import SecretReveal from '../components/SecretReveal';
import { IconKey } from '../components/icons';
import RecordListPage, { type RecordListStatus } from '../components/RecordListPage';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import Dialog from '../components/ui/Dialog';
import Input from '../components/ui/Input';
import Pager from '../components/ui/Pager';
import SortableHeaderCell from '../components/ui/SortableHeaderCell';
import Table, { TableCell, TableHeaderCell } from '../components/ui/Table';
import Timestamp from '../components/ui/Timestamp';
import { notify } from '../components/ui/toast';
import { useFormSubmit } from '../lib/use-form-submit';
import { useUrlState } from '../lib/use-url-state';

const PAGE_SIZE = 20;

// Declared at module scope so `useUrlState` adopts one stable-in-value object on mount; see
// AnswersPage for the identity/value distinction that makes an inline literal safe here too.
const URL_DEFAULTS: Record<'sort' | 'sortDir' | 'skip', string> = {
  sort: 'createdAt',
  sortDir: 'desc',
  skip: '0',
};

/** Mirrors `CreateApiKeyRequestDto`'s `@MaxDate` bound
 * (`src/features/platform/api-keys/dtos/request/create-api-key.request.dto.ts`) so the picker
 * refuses an out-of-range date before a round trip. The server stays the sole authority: an
 * expiry that slips past this check anyway — clock skew, a stale build — still comes back as its
 * own field-validation error, which `useFormSubmit` folds onto the `expiresAt` field the same way
 * as any other server rejection. */
const MAX_EXPIRY_DAYS = 365;
const MAX_EXPIRY_MS = MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

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

/** Formats a `Date` as the local-time string a `datetime-local` input's `max` attribute expects
 * (`YYYY-MM-DDTHH:mm`) — the same local interpretation the browser gives the field's own value. */
function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type MintField = 'name' | 'expiresAt';

interface MintKeyDialogProps {
  onClose: () => void;
  onMinted: (key: MintedApiKey) => void;
}

/** Create-only authoring surface for one key, mounted only while the dialog is open — its parent
 * mounts it only while `open`, so each open starts fresh rather than replaying a prior attempt's
 * values or server error. Two fields is too few to earn an `ErrorSummary`: a plain `formError`
 * alert, matching `PeoplePage`'s `InviteMemberDialog`, is all a failed mint needs. */
function MintKeyDialog({ onClose, onMinted }: MintKeyDialogProps) {
  const [name, setName] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  // Adopted once, at mount, so the picker's `max` and the validation bound below judge the same
  // instant an operator opened the dialog rather than drifting apart as they fill in the form.
  const [maxExpiresAt] = useState(() => Date.now() + MAX_EXPIRY_MS);

  function validate(): Partial<Record<MintField, string>> {
    const errors: Partial<Record<MintField, string>> = {};
    if (!name.trim()) errors.name = 'Name is required.';
    if (expiresAt) {
      const parsed = new Date(expiresAt).getTime();
      if (Number.isNaN(parsed)) {
        errors.expiresAt = 'Enter a valid date and time.';
      } else if (parsed <= Date.now()) {
        errors.expiresAt = 'Expiry must be in the future.';
      } else if (parsed > maxExpiresAt) {
        errors.expiresAt = 'Expiry cannot be more than 365 days out.';
      }
    }
    return errors;
  }

  async function submit() {
    const key = await mintApiKey(
      name.trim(),
      expiresAt ? new Date(expiresAt).toISOString() : undefined,
    );
    onMinted(key);
  }

  const { pending, formError, onSubmit, fieldProps } = useFormSubmit<MintField>({
    validate,
    submit,
    onSuccess: onClose,
  });

  const nameField = fieldProps('name');
  const expiresField = fieldProps('expiresAt');

  return (
    <Dialog open onClose={onClose} title="Mint a key" size="sm">
      <form onSubmit={onSubmit} className="form" noValidate>
        {formError && (
          <p className="error" role="alert">
            {formError}
          </p>
        )}
        <Input
          {...nameField}
          label="Name"
          value={name}
          onChange={setName}
          placeholder="CI integration"
          hint="So you can tell this key apart from your others later."
        />
        <Input
          {...expiresField}
          label="Expires"
          optional
          type="datetime-local"
          max={toDatetimeLocalValue(new Date(maxExpiresAt))}
          value={expiresAt}
          onChange={setExpiresAt}
          hint="Leave blank and the platform applies its own default expiry, or set a date up to 365 days out."
        />
        <div className="form-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Minting…' : 'Mint'}
          </Button>
        </div>
      </form>
    </Dialog>
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
  const [mintOpen, setMintOpen] = useState(false);
  // The page's only copy of a plaintext token, backing the one-time panel. `keys` is populated
  // solely by re-fetching the list endpoint, whose response never carries a token, so dismissing
  // the panel, starting another mint or rotate, or leaving the page destroys the only copy that
  // exists, matching the server's one-time delivery.
  const [oneTimeToken, setOneTimeToken] = useState<OneTimeToken | null>(null);
  const secretRevealRef = useRef<HTMLElement>(null);

  // Moves focus to the panel every time a mint or a rotate replaces it — both land here, so both
  // need the same focus move.
  useEffect(() => {
    if (oneTimeToken) secretRevealRef.current?.focus();
  }, [oneTimeToken]);

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

  function handleMinted(key: MintedApiKey) {
    setOneTimeToken({ key, action: 'minted' });
    void load();
    notify('success', `Minted "${key.name}".`);
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
    <>
      <RecordListPage
        eyebrow="Account"
        title="API Keys"
        description="Tokens an MCP client uses to authenticate as you."
        actions={
          <Button type="button" variant="primary" onClick={() => setMintOpen(true)}>
            Mint key
          </Button>
        }
        filters={
          oneTimeToken && (
            <SecretReveal
              ref={secretRevealRef}
              secret={oneTimeToken.key.token}
              expiresAt={oneTimeToken.key.expiresAt ?? ''}
              notice={
                oneTimeToken.action === 'rotated'
                  ? 'This is the only time the new token is shown, and it cannot be retrieved again. The previous token has already stopped working — copy this one now.'
                  : 'This is the only time this token is shown. It cannot be retrieved again — copy it now or mint a new key later.'
              }
              onDismiss={() => setOneTimeToken(null)}
            />
          )
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
          <section
            className="panel"
            tabIndex={0}
            role="region"
            aria-label="API keys that authenticate an MCP client as you"
          >
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

      {mintOpen && <MintKeyDialog onClose={() => setMintOpen(false)} onMinted={handleMinted} />}
    </>
  );
}
