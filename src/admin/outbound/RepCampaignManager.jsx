// Sales reps and the campaigns they can dial, in one place.
//
// Campaign access lives on each campaign (allowedRepUids); the server's
// updateOutboundCampaign refuses a rep who has not passed training or been
// waived, so this screen can offer the choice without being the gate. The
// default campaign per seller (outboundDefaults) is where a rep lands
// automatically the moment they pass.

import React, { useEffect, useMemo, useState } from 'react';
import { setRepTrainingExemption, useRoles, useUsers } from '../data';
import { outbound, useCampaigns } from './data';
import { ACCOUNTS, ACCOUNT_IDS } from '../../../functions/accounts.js';

const OPEN = campaign => !['cancelled', 'completed'].includes(campaign.status);

export default function RepCampaignManager({ variant = 'full' }) {
  const { rows: users, loading: usersLoading, error: usersError } = useUsers();
  const { rows: roles, refresh: refreshRoles } = useRoles();
  const { rows: campaigns } = useCampaigns([], true, 'admin');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [defaults, setDefaults] = useState({});

  const reps = useMemo(() => {
    const userById = new Map(users.map(user => [user.id, user]));
    return roles.filter(entry => entry.role === 'outbound_rep').map(entry => {
      const user = userById.get(entry.id) || {};
      const accountIds = Array.isArray(entry.accountIds) ? entry.accountIds : [];
      const passed = Array.isArray(entry.trainingPassedAccountIds) ? entry.trainingPassedAccountIds : [];
      const exempt = Array.isArray(entry.trainingExemptAccountIds) ? entry.trainingExemptAccountIds : [];
      return {
        uid: entry.id,
        name: user.displayName || user.email || entry.email || 'Sales rep',
        email: user.email || entry.email || '',
        accountIds,
        passed,
        exempt,
        ready: accountIds.filter(id => passed.includes(id) || exempt.includes(id))
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }, [roles, users]);

  const openCampaigns = useMemo(() => campaigns.filter(OPEN), [campaigns]);
  const campaignsFor = uid => openCampaigns.filter(campaign => (campaign.allowedRepUids || []).includes(uid));
  // Sellers that have reps or campaigns are the ones worth a default picker.
  const sellerIds = useMemo(() => ACCOUNT_IDS.filter(id =>
    reps.some(rep => rep.accountIds.includes(id)) || openCampaigns.some(campaign => campaign.accountId === id)),
  [reps, openCampaigns]);
  const sellerKey = sellerIds.join(',');

  useEffect(() => {
    if (variant !== 'full') return undefined;
    let active = true;
    sellerIds.forEach(accountId => outbound.getDefaultCampaign(accountId)
      .then(result => { if (active) setDefaults(current => ({ ...current, [accountId]: result?.campaign || null })); })
      .catch(() => {}));
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sellerKey, variant]);

  const run = async (key, task, success) => {
    setBusy(key);
    setNotice({ kind: '', text: '' });
    try {
      const result = await task();
      setNotice({ kind: 'success', text: typeof success === 'function' ? success(result) : success });
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Could not save that change.' });
    } finally {
      setBusy('');
    }
  };

  const changeCampaign = (rep, campaign, add) => run(rep.uid, async () => {
    const current = Array.isArray(campaign.allowedRepUids) ? campaign.allowedRepUids : [];
    const allowedRepUids = add ? [...new Set([...current, rep.uid])] : current.filter(uid => uid !== rep.uid);
    await outbound.updateCampaign(campaign.id, { allowedRepUids });
  }, add ? `${rep.name} can now dial ${campaign.name}.` : `${rep.name} was removed from ${campaign.name}.`);

  const changeDefault = (accountId, campaignId) => {
    const campaign = openCampaigns.find(entry => entry.id === campaignId);
    if (campaignId && !window.confirm(
      `New ${ACCOUNTS[accountId]?.label || accountId} reps will be added to "${campaign?.name}" as soon as they pass.\n\n`
      + 'This also adds every rep who has already passed or been waived for this seller. Continue?'
    )) return;
    return run(`default:${accountId}`, async () => {
      const result = await outbound.setDefaultCampaign(accountId, campaignId);
      setDefaults(current => ({ ...current, [accountId]: result?.campaign || null }));
      await refreshRoles();
      return result;
    }, result => (result?.campaign
      ? `New reps who pass now go to ${result.campaign.name}.${result.assignedExistingEligibleReps ? ` ${result.assignedExistingEligibleReps} trained rep(s) were added too.` : ''}`
      : 'No automatic campaign. New reps wait for you to add them.'));
  };

  // Admin-only on the server too (setRepTrainingExemption). Skipping lets the rep
  // be added to campaigns right away; requiring it again takes that back.
  const changeExemption = (rep, accountId, exempt) => {
    const seller = ACCOUNTS[accountId]?.label || accountId;
    if (exempt && !window.confirm(
      `Let ${rep.name} skip ${seller} training?\n\nThey can be added to campaigns and start dialing without passing the practice calls.`
    )) return undefined;
    return run(`training:${rep.uid}:${accountId}`, async () => {
      await setRepTrainingExemption(rep.uid, accountId, exempt);
      await refreshRoles();
    }, exempt ? `${rep.name} can skip ${seller} training.` : `${rep.name} must complete ${seller} training again.`);
  };

  const waiting = reps.filter(rep => rep.ready.some(accountId =>
    !campaignsFor(rep.uid).some(campaign => campaign.accountId === accountId)));

  const TrainingCell = ({ rep }) => !rep.accountIds.length
    ? <span>No seller assigned</span>
    : <div className="rep-training-list">{rep.accountIds.map(accountId => {
      const label = ACCOUNTS[accountId]?.label || accountId;
      const skipped = rep.exempt.includes(accountId);
      const passed = rep.passed.includes(accountId);
      const saving = busy === `training:${rep.uid}:${accountId}`;
      return <div className="rep-training-row" key={accountId} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '2px 0' }}>
        <span>{skipped ? `${label}: training skipped by admin` : passed ? `${label}: training passed` : `${label}: in training`}</span>
        {!passed && <button type="button" className="btn-admin" disabled={Boolean(busy)}
                            onClick={() => changeExemption(rep, accountId, !skipped)}>
          {saving ? 'Saving…' : skipped ? 'Require training' : 'Skip training'}
        </button>}
      </div>;
    })}</div>;

  const Picker = ({ rep, showChips = true }) => {
    const mine = campaignsFor(rep.uid);
    const addable = openCampaigns.filter(campaign => rep.ready.includes(campaign.accountId) && !mine.includes(campaign));
    const saving = busy === rep.uid;
    return <div className="rep-campaigns">
      {showChips && (mine.length
        ? <div className="chip-row">{mine.map(campaign => <span className="rep-campaign-chip" key={campaign.id}>
          {campaign.name}
          <button type="button" disabled={saving} aria-label={`Remove ${rep.name} from ${campaign.name}`}
                  onClick={() => changeCampaign(rep, campaign, false)}>×</button>
        </span>)}</div>
        : <span className="cell-dim">No campaign yet</span>)}
      {!rep.ready.length
        ? <small className="cell-dim">Can be added after training is passed or skipped.</small>
        : addable.length
          ? <select className="admin-select" value="" disabled={saving} aria-label={`Add ${rep.name} to a campaign`}
                    onChange={event => {
                      const campaign = addable.find(entry => entry.id === event.target.value);
                      if (campaign) changeCampaign(rep, campaign, true);
                    }}>
            <option value="">{saving ? 'Saving…' : '+ Add to campaign'}</option>
            {addable.map(campaign => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
          </select>
          : !mine.length && <small className="cell-dim">No open campaign for this seller yet.</small>}
    </div>;
  };

  const message = notice.text && <p className={notice.kind === 'error' ? 'admin-error' : 'rep-manager-notice'} role="status">{notice.text}</p>;

  const waitingCard = waiting.length > 0 && <div className="admin-card rep-waiting-card">
    <div className="card-head">
      <div>
        <h3>Waiting for a campaign <span className="cell-dim">{waiting.length}</span></h3>
        <p>These reps passed training (or you skipped it for them) but have nothing to dial yet. Pick a campaign and they can start calling.</p>
      </div>
    </div>
    <ul className="rep-waiting-list">
      {waiting.map(rep => <li key={rep.uid}>
        <div><strong>{rep.name}</strong><span className="cell-dim">{rep.email}</span></div>
        <Picker rep={rep} showChips={false} />
      </li>)}
    </ul>
  </div>;

  if (variant === 'waiting') return <>{message}{waitingCard}</>;

  return <div className="rep-manager">
    {message}
    {usersError && <p className="admin-error">{usersError}</p>}

    <div className="admin-card">
      <div className="card-head">
        <div>
          <h3>Automatic campaign for new reps</h3>
          <p>When a rep passes training they are added to this campaign right away. You can still add them to any other campaign below.</p>
        </div>
      </div>
      {!sellerIds.length ? <p className="cell-dim">No sellers have reps or campaigns yet.</p>
        : <div className="rep-default-list">
          {sellerIds.map(accountId => {
            const choices = openCampaigns.filter(campaign => campaign.accountId === accountId);
            const current = defaults[accountId];
            return <label className="rep-default-row" key={accountId}>
              <span>{ACCOUNTS[accountId]?.label || accountId}</span>
              <select className="admin-select" value={current?.id || ''} disabled={busy === `default:${accountId}` || current === undefined}
                      onChange={event => changeDefault(accountId, event.target.value)}>
                <option value="">{current === undefined ? 'Loading…' : 'None, I’ll add reps myself'}</option>
                {choices.map(campaign => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
              </select>
            </label>;
          })}
        </div>}
    </div>

    {waitingCard}

    <div className="admin-card">
      <div className="card-head">
        <div>
          <h3>Reps <span className="cell-dim">{reps.length}</span></h3>
          <p>Every sales rep, where they are in training, and the campaigns they can dial.</p>
        </div>
      </div>
      {usersLoading && !reps.length ? <p role="status">Loading reps…</p>
        : !reps.length ? <p className="cell-dim">No sales reps yet. Approve someone as an outbound rep in Users.</p>
          : <div className="admin-table-scroll">
            <table className="admin-table">
              <thead><tr><th>Rep</th><th>Training</th><th>Campaigns</th></tr></thead>
              <tbody>{reps.map(rep => <tr key={rep.uid}>
                <td><div className="cell-strong">{rep.name}</div><div className="cell-dim">{rep.email}</div></td>
                <td className="cell-dim cell-wrap"><TrainingCell rep={rep} /></td>
                <td><Picker rep={rep} /></td>
              </tr>)}</tbody>
            </table>
          </div>}
    </div>
  </div>;
}
