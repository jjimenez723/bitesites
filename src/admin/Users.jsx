// Account approval and role assignment.
//
// Two separate things live here, and conflating them is the usual way portals
// get this wrong:
//
//   * `users/{uid}.status` — a profile flag the account holder sets to
//     "pending" when they sign up. It grants nothing.
//   * `roles/{uid}` — the actual access-control record. Only an admin can write
//     it, which is exactly why nobody can promote themselves.
//
// Approving someone means doing both, so this screen always does them together
// and an approved account is never left without a role.

import React, { useMemo, useState } from 'react';
import { useUsers, useRoles, setRole, toDate } from './data';
import { Pill } from './Panel';

const when = value => {
  const date = toDate(value);
  return date ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
};

export default function Users() {
  const { rows: users, loading, error, refresh } = useUsers();
  const { rows: roles, refresh: refreshRoles } = useRoles();
  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState('');

  const roleFor = useMemo(() => {
    const map = new Map();
    for (const entry of roles) map.set(entry.id, entry.role);
    return map;
  }, [roles]);

  const act = async (id, run) => {
    setBusyId(id);
    setNotice('');
    try {
      await run();
      await Promise.all([refresh(), refreshRoles()]);
    } catch (err) {
      // The callable's own messages are written to be read — the self-revoke
      // guard in particular explains what to do instead — so pass them through
      // rather than flattening everything to "something went wrong".
      setNotice(err?.message || 'Could not update the account.');
    } finally {
      setBusyId(null);
    }
  };

  // Both directions go through the one callable, which moves the role document
  // and the auth claim together. Nothing here writes roles/{uid} directly.
  const grant = (user, role) => act(user.id, () => setRole(user.id, role));
  const revoke = user => act(user.id, () => setRole(user.id, 'none'));

  const pending = users.filter(user => !roleFor.get(user.id));
  const active = users.filter(user => roleFor.get(user.id));

  const Table = ({ rows, showActions = true }) => (
    <div className="admin-table-scroll">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Account</th>
            <th>Company</th>
            <th>Access</th>
            <th>Joined</th>
            {showActions && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map(user => {
            const role = roleFor.get(user.id) || '';
            const busy = busyId === user.id;
            return (
              <tr key={user.id}>
                <td>
                  <div className="cell-strong">{user.displayName || user.email}</div>
                  <div className="cell-dim">{user.email}</div>
                </td>
                <td className="cell-dim cell-wrap">{user.company || '—'}</td>
                <td>
                  {role
                    ? <Pill kind={role}>{role}</Pill>
                    : <span className="cell-dim">no access</span>}
                </td>
                <td className="cell-dim">{when(user.createdAt)}</td>
                {showActions && (
                  <td>
                    <div className="chip-row" style={{ justifyContent: 'flex-end' }}>
                      {role !== 'client' && (
                        <button className="btn-admin" type="button" disabled={busy}
                                onClick={() => grant(user, 'client')}>
                          Client
                        </button>
                      )}
                      {role !== 'admin' && (
                        <button className="btn-admin" type="button" disabled={busy}
                                onClick={() => grant(user, 'admin')}>
                          Admin
                        </button>
                      )}
                      {role && (
                        <button className="btn-admin danger" type="button" disabled={busy}
                                onClick={() => revoke(user)}>
                          Revoke
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>Users</h1>
          <p className="admin-topbar-sub">Approve accounts and assign access.</p>
        </div>
        <div className="admin-topbar-spacer" />
        <div className="admin-filters">
          <button className="btn-admin" type="button" onClick={() => { refresh(); refreshRoles(); }}>
            Refresh
          </button>
        </div>
      </header>

      <div className={`admin-body ${loading ? 'is-refreshing' : ''}`}>
        {error && <p className="admin-error">{error}</p>}
        {notice && <p className="admin-error">{notice}</p>}

        {!users.length && !loading && !error && (
          <div className="admin-card">
            <div className="admin-empty">
              <strong>No accounts yet</strong>
              Anyone who signs up appears here with no access until you grant a role.
            </div>
          </div>
        )}

        {pending.length > 0 && (
          <div className="admin-card">
            <div className="card-head">
              <div>
                <h3>Awaiting access <span className="cell-dim">{pending.length}</span></h3>
                <p>These accounts exist but can see nothing until a role is assigned.</p>
              </div>
            </div>
            <Table rows={pending} />
          </div>
        )}

        {active.length > 0 && (
          <div className="admin-card">
            <div className="card-head">
              <div>
                <h3>With access <span className="cell-dim">{active.length}</span></h3>
              </div>
            </div>
            <Table rows={active} />
          </div>
        )}

        <p className="admin-note">
          Changing access here calls a server function that writes the <code>roles</code> document
          and the matching auth claim together, then invalidates the person's existing sessions —
          so a revoke takes effect immediately rather than at the end of their current token.
          You cannot change your own admin access from this screen; use <code>npm run role</code> for that.
        </p>
      </div>
    </>
  );
}
