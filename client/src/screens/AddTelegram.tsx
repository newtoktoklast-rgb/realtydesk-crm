import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  requestTelegramPhoneCode,
  submitTelegramCode,
  submitTelegram2FAPassword,
  startTelegramQrLogin,
  isTelegramConfigured,
  normalizePhoneNumber,
  adoptTelegramClient,
  LogEntry,
} from '../lib/telegram';
import { TelegramClient } from 'telegram';
import { syncAccountChats } from '../lib/telegramSync';
import { saveSession } from '../lib/secureStorage';
import { api } from '../api/client';
import { RepeatIcon } from '../components/Icons';

type Props = {
  onLinked: (telegramAccountId: string) => void;
  onCancel?: () => void;
};

/**
 * `+ Add Telegram` flow (docs/BUILD_SPEC.md §7.2). Works identically for
 * an agent or the owner — whichever role is logged in, the new account
 * gets linked to THAT user, never anyone else's.
 */
export default function AddTelegram({ onLinked, onCancel }: Props) {
  const [authMethod, setAuthMethod] = useState<'phone' | 'qr'>('phone');
  const [step, setStep] = useState<'phone' | 'code' | 'password'>('phone');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [isCodeViaApp, setIsCodeViaApp] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showTerminal, setShowTerminal] = useState(false);
  const [copiedLogs, setCopiedLogs] = useState(false);
  const telegramConfigured = isTelegramConfigured();

  const clientRef = useRef<TelegramClient | null>(null);
  const terminalEndRef = useRef<HTMLDivElement | null>(null);
  const passwordResolverRef = useRef<((pw: string) => void) | null>(null);
  const authDataRef = useRef<{
    phoneCodeHash: string;
    phoneNumber: string;
    isDemo?: boolean;
  } | null>(null);

  const addLog = useCallback((entry: LogEntry) => {
    setLogs((prev) => [...prev, entry]);
  }, []);

  useEffect(() => {
    if (showTerminal) {
      terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs.length, showTerminal]);

  function handleCopyLogs() {
    const text = logs.map((l) => `[${l.time}] [${l.type.toUpperCase()}] ${l.text}`).join('\n');
    navigator.clipboard.writeText(text);
    setCopiedLogs(true);
    setTimeout(() => setCopiedLogs(false), 2000);
  }

  // QR Code Login Flow
  const initiateQrLogin = useCallback(async () => {
    if (qrLoading || busy) return;
    setQrLoading(true);
    setQrDataUrl(null);
    setError(null);
    setStatusMessage('Connecting to Telegram...');
    addLog({ time: new Date().toLocaleTimeString(), text: 'Starting Telegram QR Login session...', type: 'info' });

    try {
      const result = await startTelegramQrLogin(
        (dataUrl) => {
          setQrDataUrl(dataUrl);
          setStatusMessage(null);
          setQrLoading(false);
        },
        () => {
          return new Promise<string>((resolve) => {
            setStep('password');
            passwordResolverRef.current = resolve;
          });
        },
        addLog
      );

      clientRef.current = result.client;
      await finalizeLink(result.telegramUserId, result.sessionString);
    } catch (err: any) {
      console.error('[AddTelegram] QR login error:', err);
      setError(err?.errorMessage || err?.message || 'QR login session ended.');
      setQrLoading(false);
      setStatusMessage(null);
    }
  }, [qrLoading, busy, addLog]);

  useEffect(() => {
    if (authMethod === 'qr' && !qrDataUrl && !qrLoading && step === 'phone') {
      initiateQrLogin();
    }
  }, [authMethod, qrDataUrl, qrLoading, step, initiateQrLogin]);

  // Step 1: Request Code
  async function handleRequestCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    setStatusMessage('Connecting to Telegram...');
    addLog({ time: new Date().toLocaleTimeString(), text: `Initiating code request for ${phoneNumber}...`, type: 'info' });

    try {
      const result = await requestTelegramPhoneCode(phoneNumber, addLog);
      clientRef.current = result.client;
      authDataRef.current = {
        phoneCodeHash: result.phoneCodeHash,
        phoneNumber: result.phoneNumber,
        isDemo: result.isDemo,
      };
      setIsCodeViaApp(result.isCodeViaApp);
      setStep('code');
      setCodeInput('');
      setStatusMessage(null);
    } catch (err: any) {
      console.error('[AddTelegram] Request code failed:', err);
      setError(err?.errorMessage || err?.message || 'Failed to send verification code. Please check the phone number.');
      setStatusMessage(null);
    } finally {
      setBusy(false);
    }
  }

  // Step 2: Submit Code
  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    if (!authDataRef.current) {
      setError('Session expired. Please re-enter your phone number.');
      setStep('phone');
      return;
    }

    const cleanCode = codeInput.trim().replace(/\D/g, '');
    if (!cleanCode) {
      setError('Please enter the verification code.');
      return;
    }

    setError(null);
    setBusy(true);
    setStatusMessage('Verifying code with Telegram...');

    try {
      const verifyRes = await submitTelegramCode(
        clientRef.current,
        authDataRef.current.phoneNumber,
        authDataRef.current.phoneCodeHash,
        cleanCode,
        authDataRef.current.isDemo,
        addLog
      );

      if (verifyRes.needsPassword) {
        setStep('password');
        setPasswordInput('');
        setStatusMessage(null);
        setBusy(false);
        return;
      }

      await finalizeLink(verifyRes.telegramUserId!, verifyRes.sessionString);
    } catch (err: any) {
      console.error('[AddTelegram] Verify code failed:', err);
      // Stay on 'code' step so user can fix and retry!
      setError(err?.errorMessage || err?.message || 'Invalid verification code. Please check and try again.');
      setStatusMessage(null);
      setBusy(false);
    }
  }

  // Step 3: Submit 2FA Password
  async function handleVerifyPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!passwordInput) {
      setError('Please enter your 2-step verification password.');
      return;
    }

    if (passwordResolverRef.current) {
      const resolver = passwordResolverRef.current;
      passwordResolverRef.current = null;
      resolver(passwordInput);
      setBusy(true);
      setStatusMessage('Verifying 2-step password with Telegram...');
      return;
    }

    setError(null);
    setBusy(true);
    setStatusMessage('Verifying 2-step password with Telegram...');

    try {
      const pwRes = await submitTelegram2FAPassword(clientRef.current, passwordInput, addLog);
      await finalizeLink(pwRes.telegramUserId, pwRes.sessionString);
    } catch (err: any) {
      console.error('[AddTelegram] 2FA password verification failed:', err);
      setError(err?.errorMessage || err?.message || 'Incorrect password. Please try again.');
      setStatusMessage(null);
    } finally {
      setBusy(false);
    }
  }

  // Finalize link & transition to Inbox
  async function finalizeLink(telegramUserId: string, sessionString?: string) {
    setStatusMessage('Linking Telegram account to CRM...');
    addLog({ time: new Date().toLocaleTimeString(), text: `Registering account ${telegramUserId} with CRM server...`, type: 'info' });

    const phoneStr = authDataRef.current?.phoneNumber || phoneNumber;
    let tgUsername: string | undefined;
    let tgDisplayName: string | undefined;
    try {
      if (clientRef.current) {
        const me: any = await clientRef.current.getMe();
        if (me?.username) tgUsername = `@${me.username.replace(/^@/, '')}`;
        const nameParts = [me?.firstName, me?.lastName].filter(Boolean).join(' ').trim();
        if (nameParts) tgDisplayName = nameParts;
      }
    } catch {}

    let linkRes;
    try {
      linkRes = await api.linkTelegramAccount({
        telegramUserId,
        displayName: tgDisplayName || `Account ${maskPhone(phoneStr)}`,
        username: tgUsername,
        phoneMasked: maskPhone(phoneStr),
      });
    } catch (linkErr: any) {
      // e.g. the account is already linked in this org — surface it instead
      // of dumping the user back on the code step.
      setError(linkErr?.message || 'Failed to link Telegram account');
      setStatusMessage(null);
      setBusy(false);
      return;
    }

    const serverAccountId = linkRes.telegramAccount?._id || telegramUserId;
    const accountOwnerType = linkRes.telegramAccount?.ownerType === 'owner' ? 'owner' : 'agent';
    addLog({ time: new Date().toLocaleTimeString(), text: `CRM Account record created: ${serverAccountId}`, type: 'success' });

    if (sessionString) {
      // Session stays local only, keyed by the server-side correlation id.
      await saveSession(serverAccountId, sessionString);

      // Reuse the live, already-authenticated client for the inbox. Opening a
      // second connection with the same auth key would make Telegram push
      // updates to only one socket — often the one without event handlers.
      if (clientRef.current) {
        adoptTelegramClient(serverAccountId, clientRef.current);
      }

      // Background dialog sync without blocking the UI transition
      if (clientRef.current) {
        addLog({ time: new Date().toLocaleTimeString(), text: `Starting background message and dialog sync...`, type: 'info' });
        syncAccountChats(clientRef.current, serverAccountId, undefined, false, accountOwnerType).catch((syncErr) => {
          console.warn('[AddTelegram] Background dialog sync notice:', syncErr);
        });
      }
    }

    setStatusMessage('Connected successfully!');
    addLog({ time: new Date().toLocaleTimeString(), text: `Account linked! Redirecting to inbox...`, type: 'success' });
    onLinked(serverAccountId);
  }

  function handleBackToPhone() {
    setError(null);
    setStatusMessage(null);
    setStep('phone');
  }

  return (
    <div className="add-telegram">
      <div className="card">
        <h1>Add a Telegram account</h1>
        <p className="subtitle">
          Link a Telegram account so its conversations sync to this workspace while the session
          stays on this device.
        </p>

        {!telegramConfigured && (
          <div className="info-banner">
            <strong>Demo simulation mode:</strong> Telegram API credentials are not set in{' '}
            <code>client/.env</code>. You can enter any phone number and any verification code to
            connect.
          </div>
        )}

        {/* Method Switcher Tabs (Only on initial step) */}
        {step === 'phone' && (
          <div className="auth-method-tabs">
            <button
              type="button"
              className={`auth-tab-btn ${authMethod === 'phone' ? 'active' : ''}`}
              onClick={() => setAuthMethod('phone')}
            >
              Phone and code
            </button>
            <button
              type="button"
              className={`auth-tab-btn ${authMethod === 'qr' ? 'active' : ''}`}
              onClick={() => setAuthMethod('qr')}
            >
              Scan QR code
            </button>
          </div>
        )}

        {/* OPTION 1: QR Code Login */}
        {step === 'phone' && authMethod === 'qr' && (
          <div className="qr-login-container">
            <div className="qr-code-box">
              {qrDataUrl ? (
                <div className="qr-image-wrapper">
                  <img src={qrDataUrl} alt="Telegram login QR code" className="qr-code-img" />
                </div>
              ) : (
                <div className="qr-loading-box">
                  <span className="spinner" />
                  <p className="form-hint">Generating your Telegram login QR code…</p>
                </div>
              )}
            </div>

            <div className="qr-instructions">
              <h4>How to link with a QR code</h4>
              <ol>
                <li>
                  Open <strong>Telegram</strong> on your phone
                </li>
                <li>
                  Go to <strong>Settings → Devices → Link Desktop Device</strong>
                </li>
                <li>Point your phone's camera at this code</li>
              </ol>
            </div>

            <div className="button-group">
              <button
                type="button"
                className="secondary-btn"
                onClick={initiateQrLogin}
                disabled={qrLoading}
              >
                <RepeatIcon size={13} />
                Refresh QR code
              </button>
              {onCancel && (
                <button type="button" className="secondary-btn" onClick={onCancel} disabled={busy}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}

        {/* OPTION 2: Traditional Phone number */}
        {step === 'phone' && authMethod === 'phone' && (
          <form onSubmit={handleRequestCode}>
            <label>
              Telegram phone number
              <span className="form-hint">Include the country code, for example +1 or +44.</span>
              <input
                type="tel"
                placeholder="+1 555 123 4567"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                required
                autoFocus
              />
            </label>
            <div className="button-group">
              <button type="submit" className="primary-btn" disabled={busy}>
                {busy ? 'Connecting to Telegram…' : 'Send code'}
              </button>
              {onCancel && (
                <button type="button" className="secondary-btn" onClick={onCancel} disabled={busy}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}

        {/* STEP 2: Verification Code */}
        {step === 'code' && (
          <form onSubmit={handleVerifyCode}>
            <div className={`info-banner ${isCodeViaApp ? 'is-success' : ''}`}>
              <strong>{isCodeViaApp ? 'Check the Telegram app' : 'Check your SMS'}</strong>
              <br />
              {isCodeViaApp ? (
                <>
                  Telegram sent the login code to your <strong>Telegram app</strong>, not by SMS.
                  Open Telegram and read the code in the official service chat.
                </>
              ) : (
                <>
                  Telegram sent an SMS with your code to{' '}
                  <strong>{maskPhone(authDataRef.current?.phoneNumber || phoneNumber)}</strong>.
                </>
              )}
            </div>

            <label>
              Verification code
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                placeholder="12345"
                className="code-input"
                required
                autoFocus
              />
            </label>

            <div className="button-group">
              <button type="submit" className="primary-btn" disabled={busy}>
                {busy ? 'Verifying…' : 'Verify and link'}
              </button>
              <button
                type="button"
                className="secondary-btn"
                onClick={handleBackToPhone}
                disabled={busy}
              >
                Change number
              </button>
            </div>
          </form>
        )}

        {/* STEP 3: 2-Step Cloud Password */}
        {step === 'password' && (
          <form onSubmit={handleVerifyPassword}>
            <div className="info-banner is-notice">
              <strong>Two-step verification is on.</strong> This account is protected by a cloud
              password in addition to the login code.
            </div>

            <label>
              2-step verification password
              <input
                type="password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder="Cloud password"
                required
                autoFocus
              />
            </label>

            <div className="button-group">
              <button type="submit" className="primary-btn" disabled={busy}>
                {busy ? 'Confirming…' : 'Confirm password'}
              </button>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => setStep('code')}
                disabled={busy}
              >
                Back
              </button>
            </div>
          </form>
        )}

        {statusMessage && (
          <div className="info-banner is-progress" role="status">
            <span className="spinner" />
            <span>{statusMessage}</span>
          </div>
        )}

        {error && <div className="error-box">{error}</div>}

        {/* Connection log (collapsed by default; expand for troubleshooting) */}
        <div className="telegram-live-debug-terminal">
          <div className="debug-terminal-header">
            <div className="debug-terminal-title">
              <strong>Connection log</strong>
              <span className="debug-log-count">{logs.length} events</span>
            </div>
            <div className="debug-terminal-actions">
              <button
                type="button"
                className="debug-terminal-btn"
                onClick={handleCopyLogs}
                disabled={logs.length === 0}
                title="Copy all logs to clipboard"
              >
                {copiedLogs ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                className="debug-terminal-btn"
                onClick={() => setLogs([])}
                disabled={logs.length === 0}
                title="Clear logs"
              >
                Clear
              </button>
              <button
                type="button"
                className="debug-terminal-btn"
                onClick={() => setShowTerminal(!showTerminal)}
              >
                {showTerminal ? 'Collapse' : 'Expand'}
              </button>
            </div>
          </div>

          {showTerminal && (
            <div className="debug-terminal-body">
              {logs.length === 0 ? (
                <div className="debug-terminal-placeholder">
                  Waiting for Telegram connection events... Enter your phone and click "Send Code" to see live debug stream.
                </div>
              ) : (
                logs.map((log, index) => (
                  <div key={index} className={`debug-terminal-row debug-row-${log.type}`}>
                    <span className="debug-row-time">[{log.time}]</span>
                    <span className="debug-row-tag">{log.type.toUpperCase()}</span>
                    <span className="debug-row-text">{log.text}</span>
                  </div>
                ))
              )}
              <div ref={terminalEndRef} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-4)}`;
}
