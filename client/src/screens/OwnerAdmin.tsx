import { useEffect, useState } from 'react';
import { api } from '../api/client';

export default function OwnerAdmin() {
  const [tab, setTab] = useState<'agents' | 'codes' | 'duplicates'>('agents');
  const [agents, setAgents] = useState<any[]>([]);
  const [activationCodes, setActivationCodes] = useState<any[]>([]);
  const [duplicateChats, setDuplicateChats] = useState<any[]>([]);
  const [maxUses, setMaxUses] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // New sub-user form state
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [creatingAgent, setCreatingAgent] = useState(false);

  useEffect(() => {
    loadAgents();
    loadCodes();
    loadDuplicates();
  }, []);

  async function loadAgents() {
    try {
      const res = await api.listAgents();
      setAgents(res.agents || []);
    } catch (err: any) {
      console.warn('Failed to load agents:', err);
    }
  }

  async function loadCodes() {
    try {
      const res = await api.listActivationCodes();
      setActivationCodes(res.activationCodes || []);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function loadDuplicates() {
    try {
      const res = await api.listChats({ scope: 'all', filter: 'repeated' });
      setDuplicateChats(res.chats || []);
    } catch (err: any) {
      console.warn('Failed to load duplicates:', err);
    }
  }

  async function handleCreateAgent(e: React.FormEvent) {
    e.preventDefault();
    if (!newDisplayName.trim() || !newUsername.trim() || !newPassword) return;

    setCreatingAgent(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await api.createAgent({
        displayName: newDisplayName.trim(),
        username: newUsername.trim().toLowerCase(),
        password: newPassword,
      });
      setSuccess(`Sub-user "${res.agent.displayName}" (@${res.agent.username}) created successfully! They can now sign in.`);
      setNewDisplayName('');
      setNewUsername('');
      setNewPassword('');
      await loadAgents();
    } catch (err: any) {
      setError(err.message || 'Failed to create sub-user');
    } finally {
      setCreatingAgent(false);
    }
  }

  async function handleDeleteAgent(id: string, name: string) {
    if (!window.confirm(`Are you sure you want to delete sub-user "${name}"?`)) return;
    try {
      await api.deleteAgent(id);
      setSuccess(`Sub-user "${name}" deleted.`);
      await loadAgents();
    } catch (err: any) {
      setError(err.message || 'Failed to delete sub-user');
    }
  }

  async function handleCreateCode(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await api.createActivationCode(maxUses);
      setSuccess(`Created new activation code: ${res.activationCode.code}`);
      await loadCodes();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="owner-admin">
      <div className="admin-header">
        <h1>Organization</h1>
        <p className="subtitle">
          Sub-users, activation codes and cross-agent duplicate leads for this brokerage.
        </p>
        <div className="admin-tabs">
          <button className={tab === 'agents' ? 'active' : ''} onClick={() => setTab('agents')}>
            Sub-users
            <span className="tab-count">{agents.length}</span>
          </button>
          <button className={tab === 'duplicates' ? 'active' : ''} onClick={() => setTab('duplicates')}>
            Duplicate leads
            <span className="tab-count">{new Set(duplicateChats.map((c) => c.contactId?.telegramUserId || c.contactId?._id || c._id)).size}</span>
          </button>
          <button className={tab === 'codes' ? 'active' : ''} onClick={() => setTab('codes')}>
            Activation codes
            <span className="tab-count">{activationCodes.length}</span>
          </button>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}
      {success && <div className="success-box">{success}</div>}

      {/* TAB 1: SUB-USERS / AGENTS */}
      {tab === 'agents' && (
        <div className="admin-content">
          <div className="card code-generator-card">
            <h3>Create a sub-user</h3>
            <p className="subtitle">
              Give a sales agent their own login. Sub-users see only their own chats; the owner
              sees every chat in the brokerage.
            </p>
            <form onSubmit={handleCreateAgent} className="inline-form admin-create-form">
              <label>
                Full name
                <input
                  placeholder="e.g. Sarah Jenkins"
                  value={newDisplayName}
                  onChange={(e) => setNewDisplayName(e.target.value)}
                  required
                />
              </label>
              <label>
                Username
                <input
                  placeholder="e.g. sarah_agent"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  required
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  placeholder="Create password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                />
              </label>
              <div className="form-submit">
                <button type="submit" className="primary-btn" disabled={creatingAgent}>
                  {creatingAgent ? 'Creating…' : 'Create sub-user'}
                </button>
              </div>
            </form>
          </div>

          <div className="card">
            <h3>Team members</h3>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Username</th>
                  <th>Access</th>
                  <th>Telegram accounts</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {agents.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="empty-cell">
                      No sub-users yet. Create one above to give an agent their own login.
                    </td>
                  </tr>
                ) : (
                  agents.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <strong>{a.displayName}</strong>
                      </td>
                      <td>
                        <code className="code-badge">@{a.username || 'code-user'}</code>
                      </td>
                      <td>
                        <span className="status-pill">Own chats only</span>
                      </td>
                      <td>
                        {a.telegramAccounts && a.telegramAccounts.length > 0 ? (
                          a.telegramAccounts.map((tg: any) => (
                            <span key={tg.id} className="code-badge account-chip">
                              {tg.displayName || tg.phoneMasked || 'Telegram'}
                            </span>
                          ))
                        ) : (
                          <span className="cell-muted">None linked</span>
                        )}
                      </td>
                      <td>{new Date(a.createdAt).toLocaleDateString()}</td>
                      <td>
                        <button
                          type="button"
                          className="secondary-btn small-btn danger-btn"
                          onClick={() => handleDeleteAgent(a.id, a.displayName)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: ACTIVATION CODES */}
      {tab === 'codes' && (
        <div className="admin-content">
          <div className="card code-generator-card">
            <h3>Generate an activation code</h3>
            <p className="subtitle">
              An alternative to creating the login yourself: an agent redeems the code to enroll in
              this brokerage.
            </p>
            <form onSubmit={handleCreateCode} className="inline-form">
              <label>
                Max uses
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={maxUses}
                  onChange={(e) => setMaxUses(parseInt(e.target.value) || 1)}
                  required
                />
              </label>
              <div className="form-submit">
                <button type="submit" className="primary-btn" disabled={loading}>
                  {loading ? 'Generating…' : 'Generate code'}
                </button>
              </div>
            </form>
          </div>

          <div className="card">
            <h3>Activation codes</h3>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Uses</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {activationCodes.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="empty-cell">
                      No activation codes yet. Generate one above to invite an agent.
                    </td>
                  </tr>
                ) : (
                  activationCodes.map((c) => {
                    const isExhausted = c.usesCount >= c.maxUses;
                    return (
                      <tr key={c._id}>
                        <td>
                          <code className="code-badge">{c.code}</code>
                        </td>
                        <td className="num">
                          {c.usesCount} / {c.maxUses}
                        </td>
                        <td>
                          <span className={`status-pill ${isExhausted ? 'exhausted' : 'active'}`}>
                            {isExhausted ? 'Used up' : 'Active'}
                          </span>
                        </td>
                        <td>{new Date(c.createdAt).toLocaleDateString()}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: DUPLICATE LEADS */}
      {tab === 'duplicates' && (
        <div className="admin-content">
          <div className="card">
            <h3>Cross-agent duplicate leads</h3>
            <p className="subtitle">
              Leads that more than one agent has contacted. Agree who owns the follow-up before
              replying.
            </p>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Contact</th>
                  <th>Current agent</th>
                  <th>Last message</th>
                  <th>Last active</th>
                </tr>
              </thead>
              <tbody>
                {duplicateChats.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="empty-cell">
                      No duplicate leads detected.
                    </td>
                  </tr>
                ) : (
                  duplicateChats.map((c) => (
                    <tr key={c._id}>
                      <td>
                        <strong>{c.contactId?.username || c.contactId?.phoneNumber || 'Contact'}</strong>
                        <span className="dup-badge">Repeated</span>
                      </td>
                      <td>{c.agentId?.displayName || 'Unassigned'}</td>
                      <td>{c.lastMessagePreview || 'No messages'}</td>
                      <td>{c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString() : '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
