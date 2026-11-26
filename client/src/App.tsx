import { useState, useEffect } from 'react';
import Login from './screens/Login';
import AddTelegram from './screens/AddTelegram';
import Inbox from './screens/Inbox';
import OwnerAdmin from './screens/OwnerAdmin';
import { loadAuthTokens, clearAuthTokens } from './lib/secureStorage';
import { api, tryRefresh, registerAuthFailureHandler } from './api/client';
import { SettingsIcon } from './components/Icons';
import BrandMark from './components/BrandMark';
import { check as checkForUpdate } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

type Role = 'agent' | 'owner';
type View = 'inbox' | 'add_telegram' | 'owner_admin';

/** The three real things boot does, in order. Nothing decorative. */
const BOOT_STAGES = ['Reading local keychain', 'Refreshing session', 'Loading workspace'];
const BOOT_PROGRESS = [0.16, 0.52, 0.86];

function parseJwtPayload(token: string): any {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const jsonPayload = decodeURIComponent(
      atob(padded)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(jsonPayload);
  } catch {
    return null;
  }
}

export default function App() {
  const [role, setRole] = useState<Role | null>(null);
  const [currentView, setCurrentView] = useState<View>('inbox');
  const [hasLinkedTelegram, setHasLinkedTelegram] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [bootStage, setBootStage] = useState(0);
  const [bootStalled, setBootStalled] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<any>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      return localStorage.getItem('rd_theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('rd_theme', theme);
    } catch {}
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  // Force logout if the server rejects our session (e.g. admin deleted the account).
  useEffect(() => {
    registerAuthFailureHandler(() => {
      clearAuthTokens().finally(() => {
        setRole(null);
        setHasLinkedTelegram(false);
        setCurrentView('inbox');
      });
    });
    return () => registerAuthFailureHandler(() => {});
  }, []);

  // Check for app updates (desktop only). Non-blocking; failures are silent.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
        const update = await checkForUpdate();
        if (!cancelled && update) setPendingUpdate(update);
      } catch (err) {
        console.warn('[App] Update check failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Auto-restore session on boot with reliable token refresh
  useEffect(() => {
    let active = true;

    // Honest escape hatch if the network hangs — the bar stops moving, so offer a way out.
    const stallTimer = setTimeout(() => {
      if (active) setBootStalled(true);
    }, 4000);

    // Safety watchdog: ensure splash never hangs indefinitely
    const watchdog = setTimeout(() => {
      if (active) {
        console.warn('[App] Session restoration watchdog fired, proceeding to UI');
        setCheckingAuth(false);
      }
    }, 6000);

    async function initAuth() {
      try {
        const { accessToken: initialAccessToken, refreshToken } = await loadAuthTokens();
        let accessToken = initialAccessToken;
        if (active) setBootStage(1);

        // Auto-refresh access token if expired or about to expire within 30s
        if (refreshToken) {
          let isExpired = true;
          if (accessToken) {
            const p = parseJwtPayload(accessToken);
            if (p && p.exp && p.exp * 1000 > Date.now() + 30000) {
              isExpired = false;
            }
          }
          if (isExpired) {
            const ok = await tryRefresh();
            if (ok) {
              const tokens = await loadAuthTokens();
              accessToken = tokens.accessToken;
            }
          }
        }

        if (active) setBootStage(2);

        if (accessToken && active) {
          const payload = parseJwtPayload(accessToken);
          if (payload && payload.role) {
            setRole(payload.role);
            if (payload.role === 'owner') {
              // Owners start in the Inbox and can link an account from there.
              setCurrentView('inbox');
            } else {
              // Agent / Sub-user: check if they have connected accounts
              try {
                const accountsRes = await api.myTelegramAccounts();
                if (active) {
                  if (accountsRes.telegramAccounts && accountsRes.telegramAccounts.length > 0) {
                    setHasLinkedTelegram(true);
                    setCurrentView('inbox');
                  } else {
                    setCurrentView('add_telegram');
                  }
                }
              } catch (err) {
                console.warn('[App] Accounts fetch non-fatal notice:', err);
                if (active) setCurrentView('inbox');
              }
            }
          }
        }
      } catch (err) {
        console.warn('[App] Session restoration failed:', err);
      } finally {
        clearTimeout(watchdog);
        clearTimeout(stallTimer);
        if (active) {
          setCheckingAuth(false);
        }
      }
    }

    initAuth();

    return () => {
      active = false;
      clearTimeout(watchdog);
      clearTimeout(stallTimer);
    };
  }, []);

  async function handleLogout() {
    // Keep Telegram sessions and synced chats intact across CRM sign-out;
    // sessions are only removed when explicitly disconnected in the profile drawer.
    await clearAuthTokens();
    setRole(null);
    setHasLinkedTelegram(false);
    setCurrentView('inbox');
  }

  function handleLoginSuccess(userRole: Role) {
    setRole(userRole);
    if (userRole === 'owner') {
      // Owners start in the Inbox and can link an account from there.
      setCurrentView('inbox');
      return;
    }

    // Agent / Sub-user: show Add Telegram if first time (0 accounts), else straight to inbox
    api
      .myTelegramAccounts()
      .then((res) => {
        if (res.telegramAccounts && res.telegramAccounts.length > 0) {
          setHasLinkedTelegram(true);
          setCurrentView('inbox');
        } else {
          setCurrentView('add_telegram');
        }
      })
      .catch(() => {
        setCurrentView('add_telegram');
      });
  }

  if (checkingAuth) {
    return (
      <div className="loading-screen" role="status" aria-live="polite">
        <BrandMark size={46} className="boot-mark" title="RealtyDesk" />
        <div className="boot-copy">
          <div className="boot-wordmark">RealtyDesk</div>
          <p className="boot-stage">{BOOT_STAGES[bootStage]}</p>
        </div>
        <div className="boot-progress" aria-hidden="true">
          <div
            className="boot-progress-fill"
            style={{ '--boot-progress': String(BOOT_PROGRESS[bootStage]) } as React.CSSProperties}
          />
        </div>
        {bootStalled && (
          <button
            onClick={() => {
              clearAuthTokens().finally(() => {
                setRole(null);
                setCheckingAuth(false);
              });
            }}
            className="boot-reset"
          >
            Taking longer than usual? Reset session
          </button>
        )}
      </div>
    );
  }

  if (!role) {
    return <Login onLoggedIn={handleLoginSuccess} />;
  }

  return (
    <div className="app-shell">
      {pendingUpdate && (
        <div className="update-banner" role="status">
          <span>
            Update <strong>{pendingUpdate.version}</strong> is available.
          </span>
          <button
            className="update-btn"
            disabled={installingUpdate}
            onClick={async () => {
              try {
                setInstallingUpdate(true);
                await pendingUpdate.downloadAndInstall();
                await relaunch();
              } catch (err) {
                console.error('[App] Update install failed:', err);
                setInstallingUpdate(false);
              }
            }}
          >
            {installingUpdate ? 'Installing…' : 'Update now'}
          </button>
          <button
            className="update-dismiss"
            disabled={installingUpdate}
            onClick={() => setPendingUpdate(null)}
            aria-label="Dismiss update"
          >
            Later
          </button>
        </div>
      )}
      <header className="app-header">
        <button
          type="button"
          className="brand"
          onClick={() => setCurrentView('inbox')}
          title={role === 'owner' ? 'RealtyDesk - Click to return to Inbox' : 'RealtyDesk'}
        >
          <BrandMark size={20} className="brand-mark" />
          <span className="brand-name">RealtyDesk</span>
        </button>
        <span className={`role-badge ${role}`}>{role === 'owner' ? 'Owner' : 'Agent'}</span>

        <nav className="header-nav">
          {role === 'owner' && (
            <button
              className={`nav-btn ${currentView === 'owner_admin' ? 'active' : ''}`}
              onClick={() => setCurrentView(currentView === 'owner_admin' ? 'inbox' : 'owner_admin')}
            >
              <SettingsIcon size={15} />
              <span>{currentView === 'owner_admin' ? 'Back to inbox' : 'Organization admin'}</span>
            </button>
          )}
        </nav>

        <div className="header-actions">
          <button
            type="button"
            className="logout-btn"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
          <button className="logout-btn" onClick={handleLogout} title="Log out">
            Sign out
          </button>
        </div>
      </header>

      <main className="app-body">
        {currentView === 'add_telegram' && (
          <AddTelegram
            onLinked={() => {
              setHasLinkedTelegram(true);
              setCurrentView('inbox');
            }}
            onCancel={
              role === 'owner' || hasLinkedTelegram ? () => setCurrentView('inbox') : undefined
            }
          />
        )}

        {currentView === 'inbox' && (
          <Inbox role={role} onAddTelegram={() => setCurrentView('add_telegram')} />
        )}

        {currentView === 'owner_admin' && role === 'owner' && (
          <OwnerAdmin />
        )}
      </main>
    </div>
  );
}
