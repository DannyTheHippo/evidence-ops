import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  changeUserRole,
  listInvitations,
  listUsers,
  mintInvitation,
  removeUser,
  resendInvitation,
  revokeInvitation,
  revokeUserSessions,
  type Invitation,
  type MintedInvitation,
  type SortDirection,
  type User,
  type UserRole,
  type UserSortField,
} from '../api/client';
import { IconUserPlus, IconUsers } from '../components/icons';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import EmptyState from '../components/ui/EmptyState';
import Field from '../components/ui/Field';
import Pager from '../components/ui/Pager';
import Select from '../components/ui/Select';
import Skeleton from '../components/ui/Skeleton';
import SortableHeaderCell from '../components/ui/SortableHeaderCell';
import Table, { TableCell, TableHeaderCell } from '../components/ui/Table';
import Timestamp from '../components/ui/Timestamp';
import { notify } from '../components/ui/toast';
import { useUrlState } from '../lib/use-url-state';

const MEMBERS_PAGE_SIZE = 25;
const INVITATIONS_PAGE_SIZE = 25;

const ROLE_OPTIONS = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
];

// Declared at module scope: `useUrlState` adopts `defaults` once on mount and keeps that identity,
// but only needs it stable in value — a module-level object satisfies both. See AnswersPage.tsx
// for the identity/value distinction. Members only — the invitations list below keeps the plain
// `useState` paging InvitationsPage used, since it carries no sort.
const URL_DEFAULTS: Record<'sort' | 'sortDir' | 'skip', string> = {
  sort: 'email',
  sortDir: 'asc',
  skip: '0',
};

/** `acceptedAt` wins over `revokedAt`: an accepted invitation's token is already spent, so whether
 * it was also revoked afterward (revoking an accepted invitation is refused server-side) never
 * comes up. `revokedAt` wins over expiry: a revoked invitation reads as revoked even past its own
 * `expiresAt`, since revoking is the more specific, deliberate fact about it. */
function invitationStatus(invitation: Invitation): {
  tone: 'verified' | 'caution' | 'neutral';
  label: string;
} {
  if (invitation.acceptedAt) return { tone: 'verified', label: 'accepted' };
  if (invitation.revokedAt) return { tone: 'neutral', label: 'revoked' };
  if (new Date(invitation.expiresAt) <= new Date()) return { tone: 'caution', label: 'expired' };
  return { tone: 'neutral', label: 'pending' };
}

function MemberRow({
  member,
  onRoleChanged,
  onRemoved,
}: {
  member: User;
  onRoleChanged: (updated: User) => void;
  onRemoved: (id: string) => void;
}) {
  const targetRole: UserRole = member.role === 'admin' ? 'member' : 'admin';
  const [roleOpen, setRoleOpen] = useState(false);
  const [changingRole, setChangingRole] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function handleRoleChange() {
    setChangingRole(true);
    setRoleError(null);
    try {
      const updated = await changeUserRole(member.id, targetRole);
      notify('success', `Changed "${updated.email}" to ${updated.role}.`);
      setRoleOpen(false);
      onRoleChanged(updated);
    } catch (err: unknown) {
      // A tenant's last admin can be neither demoted nor removed — the API's 409 message already
      // names the tenant and the user, so it is shown verbatim rather than a generic fallback.
      setRoleError(err instanceof Error ? err.message : 'Failed to change role');
    } finally {
      setChangingRole(false);
    }
  }

  async function handleRevokeSessions() {
    setRevoking(true);
    setRevokeError(null);
    try {
      await revokeUserSessions(member.id);
      notify('success', `Revoked every session and API key held by "${member.email}".`);
      setRevokeOpen(false);
    } catch (err: unknown) {
      setRevokeError(err instanceof Error ? err.message : 'Failed to revoke sessions');
    } finally {
      setRevoking(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    setRemoveError(null);
    try {
      await removeUser(member.id);
      notify('success', `Removed "${member.email}" from this tenant.`);
      setRemoveOpen(false);
      onRemoved(member.id);
    } catch (err: unknown) {
      setRemoveError(err instanceof Error ? err.message : 'Failed to remove member');
    } finally {
      setRemoving(false);
    }
  }

  return (
    <tr>
      <TableCell label="Email">{member.email}</TableCell>
      <TableCell label="Role" className="cell-sub">
        {member.role}
      </TableCell>
      <TableCell label="Created" className="cell-sub">
        <Timestamp value={member.createdAt} />
      </TableCell>
      <TableCell label="Actions" className="cell-actions">
        <Button variant="secondary" size="sm" onClick={() => setRoleOpen(true)}>
          {targetRole === 'admin' ? 'Make admin' : 'Make member'}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setRevokeOpen(true)}>
          Revoke sessions
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setRemoveOpen(true)}>
          Remove
        </Button>
        <ConfirmDialog
          open={roleOpen}
          onClose={() => setRoleOpen(false)}
          title={`Change "${member.email}" to ${targetRole}?`}
          body={`"${member.email}" currently has the ${member.role} role. This changes it to ${targetRole}, effective immediately.`}
          confirmLabel={targetRole === 'admin' ? 'Make admin' : 'Make member'}
          busy={changingRole}
          error={roleError ?? undefined}
          onConfirm={() => void handleRoleChange()}
        />
        <ConfirmDialog
          open={revokeOpen}
          onClose={() => setRevokeOpen(false)}
          title={`Revoke sessions for "${member.email}"?`}
          body={`Signs "${member.email}" out of every browser session and disables every API key they hold, right away — a session cookie and an API key are checked against the same session epoch, so revoking one revokes both.`}
          confirmLabel="Revoke sessions"
          destructive
          busy={revoking}
          error={revokeError ?? undefined}
          onConfirm={() => void handleRevokeSessions()}
        />
        <ConfirmDialog
          open={removeOpen}
          onClose={() => setRemoveOpen(false)}
          title={`Remove "${member.email}"?`}
          body={`Removes "${member.email}" from this tenant immediately. They lose access right away and must be invited again to return.`}
          confirmLabel="Remove member"
          destructive
          busy={removing}
          error={removeError ?? undefined}
          onConfirm={() => void handleRemove()}
        />
      </TableCell>
    </tr>
  );
}

function InvitationRow({
  invitation,
  onRevoked,
  onResent,
}: {
  invitation: Invitation;
  onRevoked: (id: string) => void;
  onResent: (resent: MintedInvitation) => void;
}) {
  const [resendOpen, setResendOpen] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const status = invitationStatus(invitation);
  // Only a pending or expired invitation can be revoked or resent — the server refuses both once
  // accepted, and refuses resend once revoked.
  const actionable = !invitation.acceptedAt && !invitation.revokedAt;

  async function handleResend() {
    setResending(true);
    setResendError(null);
    try {
      const resent = await resendInvitation(invitation.id);
      notify(
        'success',
        `Resent the invitation to "${resent.email}". The previous link no longer works.`,
      );
      setResendOpen(false);
      onResent(resent);
    } catch (err: unknown) {
      setResendError(err instanceof Error ? err.message : 'Failed to resend invitation');
    } finally {
      setResending(false);
    }
  }

  async function handleRevoke() {
    setRevoking(true);
    setRevokeError(null);
    try {
      await revokeInvitation(invitation.id);
      notify('success', `Revoked the invitation to "${invitation.email}".`);
      setRevokeOpen(false);
      onRevoked(invitation.id);
    } catch (err: unknown) {
      setRevokeError(err instanceof Error ? err.message : 'Failed to revoke invitation');
    } finally {
      setRevoking(false);
    }
  }

  return (
    <tr>
      <TableCell label="Email">{invitation.email}</TableCell>
      <TableCell label="Role" className="cell-sub">
        {invitation.role}
      </TableCell>
      <TableCell label="Status">
        <Badge tone={status.tone}>{status.label}</Badge>
      </TableCell>
      <TableCell label="Expires" className="cell-sub">
        <Timestamp value={invitation.expiresAt} />
      </TableCell>
      <TableCell label="Actions" className="cell-actions">
        {actionable && (
          <>
            <Button variant="secondary" size="sm" onClick={() => setResendOpen(true)}>
              Resend
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setRevokeOpen(true)}>
              Revoke
            </Button>
            <ConfirmDialog
              open={resendOpen}
              onClose={() => setResendOpen(false)}
              title={`Resend the invitation to "${invitation.email}"?`}
              body="Resending mints a fresh link on this same invitation. Only a hash of the previous link's token was ever stored, so that link stops working the instant this completes — there is nothing to fall back to."
              confirmLabel="Resend invitation"
              busy={resending}
              error={resendError ?? undefined}
              onConfirm={() => void handleResend()}
            />
            <ConfirmDialog
              open={revokeOpen}
              onClose={() => setRevokeOpen(false)}
              title={`Revoke the invitation to "${invitation.email}"?`}
              body={`Revokes this invitation immediately. Its link stops working and "${invitation.email}" can no longer use it to join.`}
              confirmLabel="Revoke invitation"
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

export default function PeoplePage() {
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  const sort = urlState.sort as UserSortField;
  const sortDir = urlState.sortDir as SortDirection;
  const skip = Number(urlState.skip);

  const [members, setMembers] = useState<User[] | null>(null);
  const [memberCount, setMemberCount] = useState(0);
  const [memberError, setMemberError] = useState<string | null>(null);

  const loadMembers = useCallback(() => {
    return listUsers({ skip, limit: MEMBERS_PAGE_SIZE, sort, sortDir })
      .then(({ docs, count: total }) => {
        setMembers(docs);
        setMemberCount(total);
        setMemberError(null);
      })
      .catch((err: unknown) => {
        setMemberError(err instanceof Error ? err.message : 'Failed to load members');
      });
  }, [skip, sort, sortDir]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  function handleSort(field: UserSortField) {
    // Switching to a different column always starts it at `desc`; clicking the active column
    // toggles direction — matches AnswersPage.tsx and ApiKeysPage.tsx.
    const nextDir: SortDirection = field === sort && sortDir === 'desc' ? 'asc' : 'desc';
    setUrlState({ sort: field, sortDir: nextDir, skip: URL_DEFAULTS.skip });
  }

  function handleRoleChanged(updated: User) {
    setMembers((current) => current?.map((m) => (m.id === updated.id ? updated : m)) ?? current);
  }

  function handleRemoved(id: string) {
    setMembers((current) => current?.filter((m) => m.id !== id) ?? current);
    setMemberCount((current) => Math.max(0, current - 1));
  }

  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [invitationCount, setInvitationCount] = useState(0);
  const [invitationSkip, setInvitationSkip] = useState(0);
  const [invitationError, setInvitationError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('member');
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  // The page's only copy of a plaintext invitation token, backing the one-time panel — mirrors
  // ApiKeysPage's `oneTimeToken`. `action` only changes the panel's wording: mint and resend hand
  // back the same shape, and both must replace whatever the panel was already showing.
  const [linkPanel, setLinkPanel] = useState<{
    invitation: MintedInvitation;
    action: 'invited' | 'resent';
  } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    listInvitations({ skip: invitationSkip, limit: INVITATIONS_PAGE_SIZE })
      .then(({ docs, count: total }) => {
        setInvitations(docs);
        setInvitationCount(total);
        setInvitationError(null);
      })
      .catch((err: unknown) => {
        setInvitationError(err instanceof Error ? err.message : 'Failed to load invitations');
      });
  }, [invitationSkip]);

  async function handleMint(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMinting(true);
    setMintError(null);
    setCopied(false);
    setLinkPanel(null);
    try {
      const invitation = await mintInvitation(email, role);
      setLinkPanel({ invitation, action: 'invited' });
      setInvitations((current) => [invitation, ...(current ?? [])]);
      setInvitationCount((current) => current + 1);
      setEmail('');
      setRole('member');
      notify('success', `Invited "${invitation.email}".`);
    } catch (err: unknown) {
      setMintError(err instanceof Error ? err.message : 'Failed to mint invitation');
    } finally {
      setMinting(false);
    }
  }

  function handleInvitationRevoked(id: string) {
    setInvitations(
      (current) =>
        current?.map((invitation) =>
          invitation.id === id
            ? { ...invitation, revokedAt: new Date().toISOString() }
            : invitation,
        ) ?? current,
    );
  }

  function handleInvitationResent(resent: MintedInvitation) {
    setInvitations(
      (current) =>
        current?.map((invitation) =>
          invitation.id === resent.id ? { ...invitation, expiresAt: resent.expiresAt } : invitation,
        ) ?? current,
    );
    setLinkPanel({ invitation: resent, action: 'resent' });
    setCopied(false);
  }

  // The fragment, not the query string, carries the token: a fragment is never sent in the request
  // that loads `/invite`, so it cannot end up in nginx's access log or any proxy's.
  function inviteLink(invitation: MintedInvitation): string {
    return `${window.location.origin}/invite#token=${invitation.token}`;
  }

  // Evidence Ops sends no invitation email itself — this opens the operator's own mail client
  // pre-addressed and pre-filled with the one-time link, so sending it is one click rather than a
  // manual copy-paste into a new message.
  function mailtoLink(invitation: MintedInvitation): string {
    const subject = encodeURIComponent('Your invitation to Evidence Ops');
    const body = encodeURIComponent(
      `You've been invited to Evidence Ops. Use this link to accept — it only works once:\n\n${inviteLink(invitation)}`,
    );
    return `mailto:${invitation.email}?subject=${subject}&body=${body}`;
  }

  async function handleCopy() {
    if (!linkPanel) return;
    // jsdom (and some browser contexts) has no Clipboard API — a missing `navigator.clipboard`
    // must not throw, it just means the copy affordance silently does nothing.
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(inviteLink(linkPanel.invitation));
    setCopied(true);
  }

  return (
    <div className="view">
      <div className="page-head">
        <div>
          <span className="eyebrow">Admin</span>
          <h1 className="page-title">People</h1>
          <p className="page-sub">Manage this tenant's members and outstanding invitations.</p>
        </div>
      </div>

      <div className="section-head">
        <h2 className="card-title">Members</h2>
      </div>

      {memberError && (
        <p className="error error--page" role="alert">
          {memberError}
        </p>
      )}

      {!members && !memberError && <Skeleton label="Loading members…" />}

      {members && members.length === 0 && (
        <EmptyState
          icon={<IconUsers size={24} />}
          title="No members yet"
          description="Invite a colleague below to bring them into this tenant."
        />
      )}

      {members && members.length > 0 && (
        <section
          className="panel"
          tabIndex={0}
          role="region"
          aria-label="Members of this tenant and their roles"
        >
          <Table caption="Members of this tenant and their roles.">
            <thead>
              <tr>
                <SortableHeaderCell<UserSortField>
                  field="email"
                  label="Email"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <SortableHeaderCell<UserSortField>
                  field="role"
                  label="Role"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <SortableHeaderCell<UserSortField>
                  field="createdAt"
                  label="Created"
                  sort={sort}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <TableHeaderCell>Actions</TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  onRoleChanged={handleRoleChanged}
                  onRemoved={handleRemoved}
                />
              ))}
            </tbody>
          </Table>
        </section>
      )}

      {members && (
        <Pager
          count={memberCount}
          skip={skip}
          pageSize={MEMBERS_PAGE_SIZE}
          onSkipChange={(next) => setUrlState({ skip: String(next) })}
        />
      )}

      <div className="section-head">
        <h2 className="card-title">Invitations</h2>
      </div>

      {linkPanel && (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">{linkPanel.invitation.email}</h2>
          </div>
          <p className="notice notice--warn">
            {linkPanel.action === 'resent'
              ? 'This is the only time this new link is shown, and the previous link has already stopped working — copy it now and send it to ' +
                `${linkPanel.invitation.email}.`
              : `This is the only time this link is shown — copy it now and send it to ${linkPanel.invitation.email}. Evidence Ops sends no invitation email.`}
          </p>
          <p className="mono">{inviteLink(linkPanel.invitation)}</p>
          <div className="form-actions">
            <Button variant="secondary" size="sm" onClick={() => void handleCopy()}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <a className="btn btn--secondary btn--sm" href={mailtoLink(linkPanel.invitation)}>
              Email invite
            </a>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setLinkPanel(null);
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
              {minting ? 'Inviting…' : 'Invite'}
            </Button>
          </div>
        </form>
        {mintError && (
          <p className="error" role="alert">
            {mintError}
          </p>
        )}
      </section>

      {invitationError && (
        <p className="error error--page" role="alert">
          {invitationError}
        </p>
      )}

      {!invitations && !invitationError && <Skeleton label="Loading invitations…" />}

      {invitations && invitations.length === 0 && (
        <EmptyState
          icon={<IconUserPlus size={24} />}
          title="No invitations yet"
          description="Invite a colleague above to bring them into this tenant."
        />
      )}

      {invitations && invitations.length > 0 && (
        <section
          className="panel"
          tabIndex={0}
          role="region"
          aria-label="Invitations minted for this tenant"
        >
          <Table caption="Invitations minted for this tenant.">
            <thead>
              <tr>
                <TableHeaderCell>Email</TableHeaderCell>
                <TableHeaderCell>Role</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Expires</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {invitations.map((invitation) => (
                <InvitationRow
                  key={invitation.id}
                  invitation={invitation}
                  onRevoked={handleInvitationRevoked}
                  onResent={handleInvitationResent}
                />
              ))}
            </tbody>
          </Table>
        </section>
      )}

      {invitations && (
        <Pager
          count={invitationCount}
          skip={invitationSkip}
          pageSize={INVITATIONS_PAGE_SIZE}
          onSkipChange={setInvitationSkip}
        />
      )}
    </div>
  );
}
