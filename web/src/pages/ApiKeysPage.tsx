import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
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
import Alert from '../components/ui/Alert';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import Dialog from '../components/ui/Dialog';
import Input from '../components/ui/Input';
import Pager from '../components/ui/Pager';
import Panel from '../components/ui/Panel';
import SortableHeaderCell from '../components/ui/SortableHeaderCell';
import Table, { TableCell, TableHeaderCell } from '../components/ui/Table';
import Timestamp from '../components/ui/Timestamp';
import { notify } from '../components/ui/toast';
import { clampPageSize, clampSkip, pickOption } from '../lib/paging';
import { useFormSubmit } from '../lib/use-form-submit';
import { useAbortableEffect } from '../lib/use-latest';
import { useUrlState } from '../lib/use-url-state';

const PAGE_SIZE_OPTIONS = [25, 50, 100];

// Declared at module scope so `useUrlState` adopts one stable-in-value object on mount; see
// AnswersPage for the identity/value distinction that makes an inline literal safe here too.
const URL_DEFAULTS: Record<'sort' | 'sortDir' | 'skip' | 'limit', string> = {
  sort: 'createdAt',
  sortDir: 'desc',
  skip: '0',
  limit: '25',
};

// Matches the server's `@IsIn` list in `list-api-keys.request.dto.ts`.
const SORT_FIELDS: readonly ApiKeySortField[] = ['createdAt', 'name', 'lastUsedAt', 'expiresAt'];
const SORT_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];

/** Mirrors `CreateApiKeyRequestDto`'s `@MaxDate` bound
 * (`src/features/platform/api-keys/dtos/request/create-api-key.request.dto.ts`), which accepts an
 * instant at or before `now + 365 days`. A submission sends the end of the picked local day,
 * clamped to `maxExpiresAt`, so the picker's `max` and the "365 days" preset can offer the
 * calendar day `now + 365 days` falls on. On that day the key expires at the bound instant rather
 * than at 23:59:59. The server stays the sole authority: an expiry that slips past this check
 * anyway — clock skew, a stale build — still comes back as its own field-validation error, which
 * `useFormSubmit` folds onto the `expiresAt` field the same way as any other server rejection. */
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
  onNeedsReload,
}: {
  apiKey: ApiKey;
  onRevoked: (id: string) => void;
  onRotated: (rotated: MintedApiKey) => void;
  /** Called when a rotate is refused with a 409 (`ApiKeyExpiredException`) — the server, not this
   * row's own clock, has the last word on expiry, so a stale row is refreshed from it. */
  onNeedsReload: () => void;
}) {
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const status = keyStatus(apiKey);
  const revoked = Boolean(apiKey.revokedAt);
  // Receives focus when a revoke closes its dialog: the revoke removes every row action, so the
  // opener is gone. Programmatically focusable only once the row has no actions of its own.
  const rowRef = useRef<HTMLTableRowElement>(null);

  async function handleRotate() {
    setRotating(true);
    setRotateError(null);
    try {
      const rotated = await rotateApiKey(apiKey.id);
      notify('success', `Rotated "${apiKey.name}". The previous token no longer works.`);
      setRotateOpen(false);
      onRotated(rotated);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409) {
        setRotateError('This key has already expired. Mint a new key instead.');
        onNeedsReload();
      } else {
        setRotateError(err instanceof Error ? err.message : 'Failed to rotate key');
      }
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
    <tr ref={rowRef} tabIndex={revoked ? -1 : undefined}>
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
            {status.label === 'active' && (
              <>
                <Button variant="secondary" size="sm" onClick={() => setRotateOpen(true)}>
                  Rotate<span className="sr-only"> {apiKey.name}</span>
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
              </>
            )}
            <Button variant="secondary" size="sm" onClick={() => setRevokeOpen(true)}>
              Revoke<span className="sr-only"> {apiKey.name}</span>
            </Button>
            {status.label === 'expired' && (
              <span className="cell-sub">Expired — mint a new key</span>
            )}
            <ConfirmDialog
              open={revokeOpen}
              onClose={() => setRevokeOpen(false)}
              title={`Revoke "${apiKey.name}"?`}
              body="Revoking is immediate and cannot be undone. Any MCP client using this key loses access right away."
              confirmLabel="Revoke key"
              destructive
              busy={revoking}
              error={revokeError ?? undefined}
              fallbackFocusRef={rowRef}
              onConfirm={() => void handleRevoke()}
            />
          </>
        )}
      </TableCell>
    </tr>
  );
}

/** Formats a `Date` as the local calendar date a `type="date"` input's `value`/`max` expects
 * (`YYYY-MM-DD`) — the same local interpretation the browser gives the field's own value. */
function toDateInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parses a `type="date"` input's `YYYY-MM-DD` value as that day's local midnight. */
function startOfLocalDay(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Parses a `type="date"` input's `YYYY-MM-DD` value as the last second of that local day — the
 * instant the server records as the key's expiry, so a key picked for "today" still grants the
 * rest of today rather than expiring on arrival. */
function endOfLocalDay(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59);
}

const EXPIRY_PRESET_DAYS = [30, 90, 365];

// Formats `maxExpiresAt`'s time of day for the hint below the picker on the last eligible day,
// where the expiry instant is the bound itself rather than that day's 23:59:59.
const maxExpiryTimeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

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
  // The calendar day `maxExpiresAt` falls on — never a fresh `setDate(+365)`, which can land on a
  // different day than the exact millisecond bound across a DST transition. The picker's `max`,
  // the "365 days" preset and this validation all read the same day, so they agree with each other
  // and with the hint text below.
  const maxExpiryDayValue = toDateInputValue(new Date(maxExpiresAt));

  function validate(): Partial<Record<MintField, string>> {
    const errors: Partial<Record<MintField, string>> = {};
    if (!name.trim()) errors.name = 'Name is required.';
    if (expiresAt) {
      const startOfDay = startOfLocalDay(expiresAt);
      if (Number.isNaN(startOfDay.getTime())) {
        errors.expiresAt = 'Enter a valid date.';
      } else if (endOfLocalDay(expiresAt).getTime() <= Date.now()) {
        errors.expiresAt = 'Expiry must be in the future.';
      } else if (startOfDay.getTime() > startOfLocalDay(maxExpiryDayValue).getTime()) {
        errors.expiresAt = 'Expiry cannot be more than 365 days out.';
      }
    }
    return errors;
  }

  async function submit() {
    // The picked day's end-of-day instant can fall a few hours past `maxExpiresAt` on the day the
    // picker offers as its maximum, since that day's `max` is a calendar day and the server's bound
    // is an exact millisecond — clamped here rather than refused, so the boundary day never 400s.
    const expiresAtInstant = expiresAt
      ? new Date(Math.min(endOfLocalDay(expiresAt).getTime(), maxExpiresAt)).toISOString()
      : undefined;
    const key = await mintApiKey(name.trim(), expiresAtInstant);
    onMinted(key);
  }

  const { pending, formError, onSubmit, fieldProps } = useFormSubmit<MintField>({
    validate,
    submit,
    onSuccess: onClose,
  });

  const nameField = fieldProps('name');
  const expiresField = fieldProps('expiresAt');
  // On every other day the key expires at 23:59:59 local time; on this last eligible day it
  // expires at the bound instant itself, which can be up to a day earlier in the clock.
  const expiresHint =
    expiresAt === maxExpiryDayValue
      ? `On this last day the key expires at ${maxExpiryTimeFormat.format(new Date(maxExpiresAt))}, the 365-day limit.`
      : 'Leave blank and the platform applies its own default expiry, or set a date up to 365 days out.';

  return (
    <Dialog open onClose={onClose} title="Mint a key" size="sm">
      <form onSubmit={onSubmit} className="form" noValidate>
        {formError && <Alert tone="rejected">{formError}</Alert>}
        <Input
          {...nameField}
          label="Name"
          value={name}
          onChange={setName}
          placeholder="CI integration"
          hint="So you can tell this key apart from your others later."
        />
        <div className="button-row">
          {EXPIRY_PRESET_DAYS.map((days) => (
            <Button
              key={days}
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                if (days === MAX_EXPIRY_DAYS) {
                  setExpiresAt(maxExpiryDayValue);
                  return;
                }
                const preset = new Date();
                preset.setDate(preset.getDate() + days);
                setExpiresAt(toDateInputValue(preset));
              }}
            >
              {days} days
            </Button>
          ))}
        </div>
        <Input
          {...expiresField}
          label="Expires"
          optional
          width="sm"
          type="date"
          max={maxExpiryDayValue}
          value={expiresAt}
          onChange={setExpiresAt}
          hint={expiresHint}
        />
        <div className="form-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={pending} busyLabel="Minting…">
            Mint
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export default function ApiKeysPage() {
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  // A hand-edited or stale `sort`/`sortDir` falls back to the page default rather than reaching
  // the API with a value its `@IsIn` decorator refuses, which would otherwise blank the page.
  const sort = pickOption(urlState.sort, SORT_FIELDS, 'createdAt');
  const sortDir = pickOption(urlState.sortDir, SORT_DIRECTIONS, 'desc');
  const skip = clampSkip(urlState.skip);
  const limit = clampPageSize(urlState.limit, PAGE_SIZE_OPTIONS, 25);

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
  // Bumped whenever a mint or an expired-rotate needs a refetch outside the normal
  // skip/sort/sortDir change — SecretReveal owns the only `beforeunload` guard, so this page holds
  // no state for that.
  const [reloadKey, setReloadKey] = useState(0);

  // Moves focus to the panel every time a mint or a rotate replaces it — both land here, so both
  // need the same focus move.
  useEffect(() => {
    if (oneTimeToken) secretRevealRef.current?.focus();
  }, [oneTimeToken]);

  useAbortableEffect(
    (isCurrent) => {
      return listApiKeys({ skip, limit, sort, sortDir })
        .then(({ docs, count: total }) => {
          if (!isCurrent()) return;
          setKeys(docs);
          setCount(total);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          setError(err instanceof Error ? err.message : 'Failed to load API keys');
        });
    },
    [skip, limit, sort, sortDir, reloadKey],
  );

  function handleMinted(key: MintedApiKey) {
    setOneTimeToken({ key, action: 'minted' });
    setUrlState({ skip: URL_DEFAULTS.skip });
    setReloadKey((current) => current + 1);
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
        title="API keys"
        description="Tokens an MCP client uses to authenticate as you. Every member manages their own."
        actions={
          <Button type="button" variant="primary" onClick={() => setMintOpen(true)}>
            Mint key
          </Button>
        }
        lead={
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
        skeletonVariant="table"
        footer={
          keys && (
            <Pager
              count={count}
              skip={skip}
              pageSize={limit}
              onSkipChange={(next) => setUrlState({ skip: String(next) })}
              onPageSizeChange={(next) =>
                setUrlState({ limit: String(next), skip: URL_DEFAULTS.skip })
              }
              pageSizeOptions={PAGE_SIZE_OPTIONS}
            />
          )
        }
      >
        {keys && keys.length > 0 && (
          <Panel aria-label="API keys that authenticate an MCP client as you">
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
                    onNeedsReload={() => setReloadKey((current) => current + 1)}
                  />
                ))}
              </tbody>
            </Table>
          </Panel>
        )}
      </RecordListPage>

      {mintOpen && <MintKeyDialog onClose={() => setMintOpen(false)} onMinted={handleMinted} />}
    </>
  );
}
