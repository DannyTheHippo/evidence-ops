import { useEffect, useState, type FormEvent } from 'react';
import {
  listInvitations,
  mintInvitation,
  type Invitation,
  type MintedInvitation,
  type UserRole,
} from '../api/client';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import Field from '../components/ui/Field';
import Pager from '../components/ui/Pager';
import Select from '../components/ui/Select';
import Skeleton from '../components/ui/Skeleton';
import Table, { TableHeaderCell } from '../components/ui/Table';
import { notify } from '../components/ui/toast';

const PAGE_SIZE = 25;

const ROLE_OPTIONS = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
];

function invitationStatus(invitation: Invitation): {
  tone: 'verified' | 'caution' | 'neutral';
  label: string;
} {
  if (invitation.acceptedAt) return { tone: 'verified', label: 'accepted' };
  if (new Date(invitation.expiresAt) <= new Date()) return { tone: 'caution', label: 'expired' };
  return { tone: 'neutral', label: 'pending' };
}

export default function InvitationsPage() {
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [count, setCount] = useState(0);
  const [skip, setSkip] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('member');
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  // The page's only copy of a plaintext token, backing the one-time panel — mirrors
  // ApiKeysPage's `minted`. `invitations` receives the metadata-only shape the list endpoint
  // already returns, so that state never holds a token at any point.
  const [minted, setMinted] = useState<MintedInvitation | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    listInvitations({ skip, limit: PAGE_SIZE })
      .then(({ docs, count: total }) => {
        setInvitations(docs);
        setCount(total);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load invitations');
      });
  }, [skip]);

  async function handleMint(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMinting(true);
    setMintError(null);
    setCopied(false);
    setMinted(null);
    try {
      const invitation = await mintInvitation(email, role);
      setMinted(invitation);
      setInvitations((current) => [invitation, ...(current ?? [])]);
      setCount((current) => current + 1);
      setEmail('');
      setRole('member');
      notify('success', `Invited "${invitation.email}".`);
    } catch (err: unknown) {
      setMintError(err instanceof Error ? err.message : 'Failed to mint invitation');
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

  return (
    <div className="view view--flow">
      <div className="page-head">
        <div>
          <span className="eyebrow">Admin</span>
          <h1 className="page-title">Invitations</h1>
          <p className="page-sub">
            Bring a colleague into this tenant with a single-use, expiring token.
          </p>
        </div>
      </div>

      {minted && (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">{minted.email}</h2>
          </div>
          <p className="notice notice--warn">
            This is the only time this token is shown — copy it now and send it to {minted.email}.
            Evidence Ops sends no invitation email.
          </p>
          <p className="mono">{minted.token}</p>
          <div className="form-actions">
            <Button variant="secondary" size="sm" onClick={() => void handleCopy()}>
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
          <h2 className="card-title">Invite a colleague</h2>
        </div>
        <form onSubmit={(e) => void handleMint(e)} className="form">
          <Field label="Email">
            {(inputProps) => (
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="colleague@example.com"
                {...inputProps}
              />
            )}
          </Field>
          <Select
            label="Role"
            options={ROLE_OPTIONS}
            value={role}
            onChange={(value) => setRole(value as UserRole)}
          />
          <div className="form-actions">
            <Button type="submit" variant="primary" disabled={minting}>
              {minting ? 'Inviting…' : 'Send invitation'}
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

      {!invitations && !error && <Skeleton label="Loading invitations…" />}

      {invitations && invitations.length === 0 && (
        <EmptyState
          title="No invitations yet"
          description="Invite a colleague above to bring them into this tenant."
        />
      )}

      {invitations && invitations.length > 0 && (
        <section className="panel">
          <Table caption="Invitations minted for this tenant.">
            <thead>
              <tr>
                <TableHeaderCell>Email</TableHeaderCell>
                <TableHeaderCell>Role</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Expires</TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {invitations.map((invitation) => {
                const status = invitationStatus(invitation);
                return (
                  <tr key={invitation.id}>
                    <td>{invitation.email}</td>
                    <td className="cell-sub">{invitation.role}</td>
                    <td>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </td>
                    <td className="cell-sub">{new Date(invitation.expiresAt).toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </section>
      )}

      {invitations && (
        <Pager count={count} skip={skip} pageSize={PAGE_SIZE} onSkipChange={setSkip} />
      )}
    </div>
  );
}
