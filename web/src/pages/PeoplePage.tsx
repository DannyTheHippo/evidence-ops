import { useEffect, useRef, useState } from 'react';
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
  type InvitationSortField,
  type MintedInvitation,
  type SortDirection,
  type User,
  type UserRole,
  type UserSortField,
} from '../api/client';
import SecretReveal from '../components/SecretReveal';
import { IconUserPlus, IconUsers } from '../components/icons';
import Alert from '../components/ui/Alert';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import Dialog from '../components/ui/Dialog';
import EmptyState from '../components/ui/EmptyState';
import Input from '../components/ui/Input';
import LinkButton from '../components/ui/LinkButton';
import Menu from '../components/ui/Menu';
import Pager from '../components/ui/Pager';
import PageHeader from '../components/ui/PageHeader';
import Panel from '../components/ui/Panel';
import RadioGroup, { type RadioOption } from '../components/ui/RadioGroup';
import SegmentedControl from '../components/ui/SegmentedControl';
import Skeleton from '../components/ui/Skeleton';
import SortableHeaderCell from '../components/ui/SortableHeaderCell';
import Table, { TableCell, TableHeaderCell } from '../components/ui/Table';
import Timestamp from '../components/ui/Timestamp';
import Toolbar from '../components/ui/Toolbar';
import { notify } from '../components/ui/toast';
import { clampPageSize, clampSkip, pickOption } from '../lib/paging';
import { useAbortableEffect } from '../lib/use-latest';
import { useFormSubmit } from '../lib/use-form-submit';
import { useSession } from '../lib/use-session';
import { useUrlState } from '../lib/use-url-state';

const MEMBERS_PAGE_SIZE = 25;
const INVITATIONS_PAGE_SIZE = 25;

type PeopleView = 'members' | 'invitations';

const ROLE_OPTIONS: RadioOption[] = [
  {
    value: 'member',
    label: 'Member',
    hint: 'Search evidence, ask questions, and review conflicts.',
  },
  {
    value: 'admin',
    label: 'Admin',
    hint: 'Everything a member can, plus manage sources, invite people, and change roles.',
  },
];

// Declared at module scope: `useUrlState` adopts `defaults` once on mount and keeps that identity,
// but only needs it stable in value — a module-level object satisfies both. Two skip keys, not
// one, mirroring SourcesPage.tsx: members and invitations page independently, and each keeps its
// own position while the other view is off screen.
const URL_DEFAULTS: Record<
  | 'view'
  | 'sort'
  | 'sortDir'
  | 'skip'
  | 'limit'
  | 'invSkip'
  | 'invLimit'
  | 'invSort'
  | 'invSortDir',
  string
> = {
  view: 'members',
  sort: 'email',
  sortDir: 'asc',
  skip: '0',
  limit: String(MEMBERS_PAGE_SIZE),
  invSkip: '0',
  invLimit: String(INVITATIONS_PAGE_SIZE),
  invSort: 'createdAt',
  invSortDir: 'desc',
};

// Match the server's `@IsIn` lists in `list-users.request.dto.ts` and
// `list-invitations.request.dto.ts`.
const USER_SORT_FIELDS: readonly UserSortField[] = ['createdAt', 'email', 'role'];
const INVITATION_SORT_FIELDS: readonly InvitationSortField[] = [
  'createdAt',
  'email',
  'expiresAt',
  'role',
];
const SORT_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];

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
  isYou,
  onRoleChanged,
  onRemoved,
}: {
  member: User;
  isYou: boolean;
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
      // names the tenant and the user, so it is shown verbatim rather than a generic fallback. No
      // client-side guess at that rule is made here; the server's refusal is the only source of it.
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
      <TableCell label="Email">
        {member.email}
        {isYou && <span className="cell-sub"> (you)</span>}
      </TableCell>
      <TableCell label="Role" className="cell-sub">
        {member.role}
      </TableCell>
      <TableCell label="Created" className="cell-sub">
        <Timestamp value={member.createdAt} />
      </TableCell>
      <TableCell label="Actions" className="cell-actions">
        <Menu
          trigger={
            <>
              <span aria-hidden="true">⋮</span>
              <span className="sr-only">{`Actions for ${member.email}`}</span>
            </>
          }
          items={[
            {
              label: targetRole === 'admin' ? 'Make admin' : 'Make member',
              onSelect: () => setRoleOpen(true),
            },
            { label: 'Revoke sessions', onSelect: () => setRevokeOpen(true) },
            // Hidden for the caller's own row: the API refuses self-removal with a 409, so
            // offering the action would only surface that refusal.
            ...(isYou
              ? []
              : [
                  {
                    label: 'Remove member',
                    onSelect: () => setRemoveOpen(true),
                    tone: 'danger' as const,
                  },
                ]),
          ]}
        />
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
          body={`Signs "${member.email}" out of every browser session and disables every API key they hold, right away — a session cookie and an API key are checked against the same session epoch, so revoking one revokes both.${isYou ? ' You are revoking your own sessions — this signs you out of this browser too.' : ''}`}
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
  // Receives focus when a revoke closes its dialog: the revoke removes both row actions, so the
  // opener is gone. Programmatically focusable only once the row has no actions of its own.
  const rowRef = useRef<HTMLTableRowElement>(null);

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
    <tr ref={rowRef} tabIndex={actionable ? undefined : -1}>
      <TableCell label="Email">{invitation.email}</TableCell>
      <TableCell label="Role" className="cell-sub">
        {invitation.role}
      </TableCell>
      <TableCell label="Status">
        <Badge tone={status.tone}>{status.label}</Badge>
      </TableCell>
      <TableCell label="Created" className="cell-sub">
        <Timestamp value={invitation.createdAt} />
      </TableCell>
      <TableCell label="Expires" className="cell-sub">
        <Timestamp value={invitation.expiresAt} />
      </TableCell>
      <TableCell label="Actions" className="cell-actions">
        {actionable && (
          <>
            <Button variant="secondary" size="sm" onClick={() => setResendOpen(true)}>
              Resend<span className="sr-only"> {invitation.email}</span>
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setRevokeOpen(true)}>
              Revoke<span className="sr-only"> {invitation.email}</span>
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
              fallbackFocusRef={rowRef}
              onConfirm={() => void handleRevoke()}
            />
          </>
        )}
      </TableCell>
    </tr>
  );
}

type InviteField = 'email' | 'role';

interface InviteMemberDialogProps {
  onClose: () => void;
  // Runs once the invitation is minted, before the dialog closes — the caller lands the resulting
  // one-time link into its own SecretReveal, which lives outside this dialog's own tree, so
  // dismissing the dialog can never take that one copy of the link down with it.
  onInvited: (invitation: MintedInvitation) => void;
}

/** Create-only authoring surface for one invitation, always open — its parent mounts it only
 * while the dialog is open, so each open starts fresh rather than replaying a prior open's values
 * or server error. */
function InviteMemberDialog({ onClose, onInvited }: InviteMemberDialogProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('member');

  function validate(): Partial<Record<InviteField, string>> {
    const errors: Partial<Record<InviteField, string>> = {};
    const trimmed = email.trim();
    if (!trimmed) errors.email = 'Email is required.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      errors.email = 'Enter a valid email address.';
    }
    return errors;
  }

  async function submit() {
    const invitation = await mintInvitation(email.trim(), role);
    onInvited(invitation);
  }

  const { pending, formError, onSubmit, fieldProps } = useFormSubmit<InviteField>({
    validate,
    submit,
    onSuccess: onClose,
  });

  const emailField = fieldProps('email');
  const roleField = fieldProps('role');

  return (
    <Dialog open onClose={onClose} title="Invite member" size="sm">
      <form onSubmit={onSubmit} className="form" noValidate>
        {formError && <Alert tone="rejected">{formError}</Alert>}
        <Input
          {...emailField}
          label="Email"
          type="email"
          autoComplete="off"
          value={email}
          onChange={setEmail}
          placeholder="colleague@example.com"
        />
        <RadioGroup
          id={roleField.id}
          legend="Role"
          error={roleField.error}
          onBlur={roleField.onBlur}
          options={ROLE_OPTIONS}
          value={role}
          onChange={(value) => setRole(value as UserRole)}
        />
        <div className="form-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={pending} busyLabel="Inviting…">
            Invite
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export default function PeoplePage() {
  const session = useSession();
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS);
  // An unknown `?view=` renders Members with its segment pressed, rather than a header and
  // toolbar with nothing painted underneath.
  const view: PeopleView = urlState.view === 'invitations' ? 'invitations' : 'members';
  // A hand-edited or stale `sort`/`sortDir` falls back to the page default rather than reaching
  // the API with a value its `@IsIn` decorator refuses, which would otherwise blank the page.
  const sort = pickOption(urlState.sort, USER_SORT_FIELDS, 'email');
  const sortDir = pickOption(urlState.sortDir, SORT_DIRECTIONS, 'asc');
  const skip = clampSkip(urlState.skip);
  const pageSize = clampPageSize(urlState.limit, [25, 50, 100], MEMBERS_PAGE_SIZE);
  const invitationSkip = clampSkip(urlState.invSkip);
  const invitationPageSize = clampPageSize(urlState.invLimit, [25, 50, 100], INVITATIONS_PAGE_SIZE);
  const invitationSort = pickOption(urlState.invSort, INVITATION_SORT_FIELDS, 'createdAt');
  const invitationSortDir = pickOption(urlState.invSortDir, SORT_DIRECTIONS, 'desc');

  const [members, setMembers] = useState<User[] | null>(null);
  const [memberCount, setMemberCount] = useState(0);
  const [memberError, setMemberError] = useState<string | null>(null);

  useAbortableEffect(
    (isCurrent) => {
      return listUsers({ skip, limit: pageSize, sort, sortDir })
        .then(({ docs, count: total }) => {
          if (!isCurrent()) return;
          setMembers(docs);
          setMemberCount(total);
          setMemberError(null);
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          setMemberError(err instanceof Error ? err.message : 'Failed to load members');
        });
    },
    [skip, pageSize, sort, sortDir],
  );

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
  const [invitationError, setInvitationError] = useState<string | null>(null);

  const [inviteOpen, setInviteOpen] = useState(false);

  // The page's only copy of a plaintext invitation token, backing `SecretReveal`. `action` only
  // changes the panel's wording: mint and resend hand back the same shape, and both must replace
  // whatever the panel was already showing. Rendered at page level, outside both view branches, so
  // a segment switch can never unmount it while it holds a live token.
  const [secretPanel, setSecretPanel] = useState<{
    invitation: MintedInvitation;
    action: 'invited' | 'resent';
  } | null>(null);
  const secretRevealRef = useRef<HTMLElement>(null);

  // Bumped after a mint or a resend so the invitations list re-fetches instead of being patched
  // in place with the minted shape (token included) — the list then only ever holds the
  // token-free wire shape.
  const [reloadKey, setReloadKey] = useState(0);

  // Moves focus to the panel every time a mint or a resend replaces it.
  useEffect(() => {
    if (secretPanel) secretRevealRef.current?.focus();
  }, [secretPanel]);

  useAbortableEffect(
    (isCurrent) => {
      return listInvitations({
        skip: invitationSkip,
        limit: invitationPageSize,
        sort: invitationSort,
        sortDir: invitationSortDir,
      })
        .then(({ docs, count: total }) => {
          if (!isCurrent()) return;
          setInvitations(docs);
          setInvitationCount(total);
          setInvitationError(null);
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          setInvitationError(err instanceof Error ? err.message : 'Failed to load invitations');
        });
    },
    [invitationSkip, invitationPageSize, invitationSort, invitationSortDir, reloadKey],
  );

  function handleInvitationSort(field: InvitationSortField) {
    // Switching to a different column always starts it at `desc`; clicking the active column
    // toggles direction — matches `handleSort` above.
    const nextDir: SortDirection =
      field === invitationSort && invitationSortDir === 'desc' ? 'asc' : 'desc';
    setUrlState({ invSort: field, invSortDir: nextDir, invSkip: URL_DEFAULTS.invSkip });
  }

  function handleInvited(invitation: MintedInvitation) {
    setSecretPanel({ invitation, action: 'invited' });
    setUrlState({ view: 'invitations', invSkip: URL_DEFAULTS.invSkip });
    setReloadKey((current) => current + 1);
    notify('success', `Invited "${invitation.email}".`);
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
    setSecretPanel({ invitation: resent, action: 'resent' });
    setReloadKey((current) => current + 1);
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

  return (
    <div className="view">
      <PageHeader
        eyebrow="Admin"
        title="People"
        description="Manage this tenant's members and outstanding invitations."
        actions={
          <Button type="button" variant="primary" onClick={() => setInviteOpen(true)}>
            Invite member
          </Button>
        }
      />

      {inviteOpen && (
        <InviteMemberDialog onClose={() => setInviteOpen(false)} onInvited={handleInvited} />
      )}

      {secretPanel && (
        <SecretReveal
          ref={secretRevealRef}
          secret={inviteLink(secretPanel.invitation)}
          expiresAt={secretPanel.invitation.expiresAt}
          notice={
            secretPanel.action === 'resent'
              ? `This is the only time this new link is shown, and the previous link has already stopped working — copy it now and send it to ${secretPanel.invitation.email}.`
              : `This is the only time this link is shown — copy it now and send it to ${secretPanel.invitation.email}. Evidence Ops sends no invitation email.`
          }
          extraActions={
            <LinkButton href={mailtoLink(secretPanel.invitation)} variant="secondary" size="sm">
              Email invite
            </LinkButton>
          }
          onDismiss={() => setSecretPanel(null)}
        />
      )}

      <Toolbar
        view={
          <SegmentedControl<PeopleView>
            aria-label="People view"
            options={[
              { value: 'members', label: 'Members', count: memberCount },
              { value: 'invitations', label: 'Invitations', count: invitationCount },
            ]}
            value={view}
            onChange={(next) => setUrlState({ view: next })}
          />
        }
      />

      {view === 'members' && (
        <>
          {memberError && <Alert tone="rejected">{memberError}</Alert>}

          {!members && !memberError && <Skeleton label="Loading members…" variant="table" />}

          {members && members.length === 0 && (
            <EmptyState
              icon={<IconUsers size={24} />}
              title="No members yet"
              description="Invite a colleague to bring them into this tenant."
            />
          )}

          {members && members.length > 0 && (
            <Panel aria-label="Members of this tenant and their roles">
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
                      isYou={session.status === 'authed' && session.me.id === member.id}
                      onRoleChanged={handleRoleChanged}
                      onRemoved={handleRemoved}
                    />
                  ))}
                </tbody>
              </Table>
            </Panel>
          )}

          {members && (
            <Pager
              count={memberCount}
              skip={skip}
              pageSize={pageSize}
              onSkipChange={(next) => setUrlState({ skip: String(next) })}
              onPageSizeChange={(next) =>
                setUrlState({ limit: String(next), skip: URL_DEFAULTS.skip })
              }
              pageSizeOptions={[25, 50, 100]}
            />
          )}
        </>
      )}

      {view === 'invitations' && (
        <>
          {invitationError && <Alert tone="rejected">{invitationError}</Alert>}

          {!invitations && !invitationError && (
            <Skeleton label="Loading invitations…" variant="table" />
          )}

          {invitations && invitations.length === 0 && (
            <EmptyState
              icon={<IconUserPlus size={24} />}
              title="No invitations yet"
              description="Invite a colleague above to bring them into this tenant."
            />
          )}

          {invitations && invitations.length > 0 && (
            <Panel aria-label="Invitations minted for this tenant">
              <Table caption="Invitations minted for this tenant.">
                <thead>
                  <tr>
                    <SortableHeaderCell<InvitationSortField>
                      field="email"
                      label="Email"
                      sort={invitationSort}
                      direction={invitationSortDir}
                      onSort={handleInvitationSort}
                    />
                    <SortableHeaderCell<InvitationSortField>
                      field="role"
                      label="Role"
                      sort={invitationSort}
                      direction={invitationSortDir}
                      onSort={handleInvitationSort}
                    />
                    <TableHeaderCell>Status</TableHeaderCell>
                    <SortableHeaderCell<InvitationSortField>
                      field="createdAt"
                      label="Created"
                      sort={invitationSort}
                      direction={invitationSortDir}
                      onSort={handleInvitationSort}
                    />
                    <SortableHeaderCell<InvitationSortField>
                      field="expiresAt"
                      label="Expires"
                      sort={invitationSort}
                      direction={invitationSortDir}
                      onSort={handleInvitationSort}
                    />
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
            </Panel>
          )}

          {invitations && (
            <Pager
              count={invitationCount}
              skip={invitationSkip}
              pageSize={invitationPageSize}
              onSkipChange={(next) => setUrlState({ invSkip: String(next) })}
              onPageSizeChange={(next) =>
                setUrlState({ invLimit: String(next), invSkip: URL_DEFAULTS.invSkip })
              }
              pageSizeOptions={[25, 50, 100]}
            />
          )}
        </>
      )}
    </div>
  );
}
