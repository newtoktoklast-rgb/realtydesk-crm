/**
 * Wrapper around GramJS (MTProto) for the `+ Add Telegram` flow and
 * ongoing message sync. Runs entirely on the client. The session string
 * this module produces is handed to secureStorage.ts and NEVER to
 * api/client.ts. See docs/BUILD_SPEC.md §2 and §7.2.
 */

import '../polyfills';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { computeCheck } from 'telegram/Password';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { saveSession, loadSession } from './secureStorage';
import QRCode from 'qrcode';

const API_ID = Number(import.meta.env.VITE_TELEGRAM_API_ID || 0);
const API_HASH = import.meta.env.VITE_TELEGRAM_API_HASH || '';

export interface LoginHandlers {
  onCodeRequested: () => Promise<string>;
  onPasswordRequested?: () => Promise<string>;
}

export type LogEntry = {
  time: string;
  text: string;
  type: 'info' | 'warn' | 'error' | 'success';
};

export type LogCallback = (entry: LogEntry) => void;

export function isTelegramConfigured(): boolean {
  return Boolean(API_ID && API_HASH);
}

/**
 * Normalizes phone numbers: strips spaces, parentheses, dashes, and ensures a leading '+'
 */
export function normalizePhoneNumber(phone: string): string {
  let cleaned = phone.trim().replace(/[\s\-\(\)]/g, '');
  if (!cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  }
  return cleaned;
}

/**
 * Step 1: Requests Telegram verification code using GramJS MTProto.
 * Returns the connected client instance, the phoneCodeHash, and whether
 * the code was sent to the user's Telegram app (isCodeViaApp).
 */
export async function requestTelegramPhoneCode(
  phoneNumber: string,
  onLog?: LogCallback
): Promise<{
  client: TelegramClient | null;
  phoneCodeHash: string;
  isCodeViaApp: boolean;
  phoneNumber: string;
  isDemo?: boolean;
}> {
  const log = (text: string, type: 'info' | 'warn' | 'error' | 'success' = 'info') => {
    const time = new Date().toLocaleTimeString();
    if (onLog) onLog({ time, text, type });
  };

  const cleanPhone = normalizePhoneNumber(phoneNumber);
  log(`Normalizing target phone number: "${phoneNumber}" → "${cleanPhone}"`, 'info');

  if (!isTelegramConfigured()) {
    log('API_ID / API_HASH not found in client/.env. Operating in Demo Simulation Mode.', 'warn');
    const demoTelegramId = 'tg_' + Math.abs(cleanPhone.split('').reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) | 0, 0));
    return {
      client: null,
      phoneCodeHash: 'demo_code_hash_' + demoTelegramId,
      isCodeViaApp: false,
      phoneNumber: cleanPhone,
      isDemo: true,
    };
  }

  log(`API Configuration verified: App ID=${API_ID}, Hash=${API_HASH.slice(0, 6)}...`, 'info');
  log(`Establishing secure MTProto WebSocket connection (device: Desktop Windows, WSS=true)...`, 'info');

  const session = new StringSession('');
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
    useWSS: true, // Secure WebSocket connection
    deviceModel: 'Telegram Desktop',
    systemVersion: 'Windows 11',
    appVersion: '5.6.3 x64',
    langCode: 'en',
    systemLangCode: 'en',
  });

  try {
    (client as any).setLogLevel('debug');
  } catch {}

  try {
    await client.connect();
    const dcId = (client as any).session?.dcId || 'default';
    log(`Connected to Telegram MTProto Gateway! Initial DataCenter: DC ${dcId}`, 'success');

    log(`Dispatching auth.sendCode request for ${cleanPhone}...`, 'info');
    const sendResult = await client.sendCode(
      { apiId: API_ID, apiHash: API_HASH },
      cleanPhone,
      false
    );

    const isApp = Boolean(sendResult.isCodeViaApp);
    log(`sendCode response received!`, 'success');
    log(`Target Phone: ${cleanPhone}`, 'info');
    log(`Delivery Channel: ${isApp ? '📱 TELEGRAM IN-APP SERVICE CHAT (Not SMS)' : '💬 SMS TEXT MESSAGE'}`, isApp ? 'warn' : 'info');
    log(`Phone Code Hash: ${sendResult.phoneCodeHash ? sendResult.phoneCodeHash.slice(0, 8) + '...' : 'none'}`, 'info');

    if (isApp) {
      log(`⚠️ Telegram detected an active session for ${cleanPhone}. The login code has been sent directly to the official "Telegram" chat on your active app/device.`, 'warn');
    }

    return {
      client,
      phoneCodeHash: sendResult.phoneCodeHash,
      isCodeViaApp: isApp,
      phoneNumber: cleanPhone,
      isDemo: false,
    };
  } catch (err: any) {
    const errorMsg = err?.errorMessage || err?.message || String(err);
    log(`sendCode call failed: ${errorMsg}`, 'error');
    if (err?.seconds) {
      log(`FLOOD_WAIT restriction: Telegram requires waiting ${err.seconds} seconds before requesting again.`, 'error');
    }
    throw err;
  }
}

/**
 * Step 2: Submits the verification code to Telegram.
 * Handles 2FA requirements and throws user-friendly errors on invalid/expired codes
 * without terminating the client connection.
 */
export async function submitTelegramCode(
  client: TelegramClient | null,
  phoneNumber: string,
  phoneCodeHash: string,
  code: string,
  isDemo?: boolean,
  onLog?: LogCallback
): Promise<{
  success: boolean;
  needsPassword?: boolean;
  telegramUserId?: string;
  sessionString?: string;
}> {
  const log = (text: string, type: 'info' | 'warn' | 'error' | 'success' = 'info') => {
    const time = new Date().toLocaleTimeString();
    if (onLog) onLog({ time, text, type });
  };

  const cleanCode = code.trim().replace(/\D/g, '');
  if (!cleanCode) {
    throw new Error('Please enter the verification code.');
  }

  log(`Submitting ${cleanCode.length}-digit verification code for ${phoneNumber}...`, 'info');

  if (isDemo || !client) {
    const demoTelegramId = 'tg_' + Math.abs(phoneNumber.split('').reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) | 0, 0));
    const demoSession = 'demo-session-' + demoTelegramId;
    await saveSession(demoTelegramId, demoSession);
    log(`Demo authentication completed. Simulated User ID: ${demoTelegramId}`, 'success');
    return {
      success: true,
      telegramUserId: demoTelegramId,
      sessionString: demoSession,
    };
  }

  try {
    log(`Invoking auth.SignIn MTProto method...`, 'info');
    const result = await client.invoke(
      new Api.auth.SignIn({
        phoneNumber,
        phoneCodeHash,
        phoneCode: cleanCode,
      })
    );

    let user: any = null;
    if (result && 'user' in result) {
      user = (result as any).user;
    } else {
      user = await client.getMe();
    }

    const telegramUserId = String(user.id);
    log(`Code successfully accepted by Telegram! Authenticated User ID: ${telegramUserId} (${user.firstName || ''} ${user.lastName || ''} @${user.username || 'no-username'})`, 'success');
    const sessionString = client.session.save() as unknown as string;
    // Session is saved locally by AddTelegram.finalizeLink(), keyed by the
    // server account id (reconnect() uses the same id).
    log(`Authenticated as ${telegramUserId}.`, 'success');

    return {
      success: true,
      telegramUserId,
      sessionString,
    };
  } catch (err: any) {
    log(`Code verification failed: ${err?.errorMessage || err?.message}`, 'error');
    const msg = String(err?.errorMessage || err?.message || '');
    if (msg.includes('SESSION_PASSWORD_NEEDED')) {
      log(`Telegram account has 2-Step Cloud Verification enabled. Cloud password required.`, 'warn');
      return {
        success: false,
        needsPassword: true,
      };
    }
    if (msg.includes('PHONE_CODE_INVALID')) {
      throw new Error('Invalid verification code. Please check the code in your Telegram app and try again.');
    }
    if (msg.includes('PHONE_CODE_EXPIRED')) {
      throw new Error('Verification code has expired. Please go back and request a new code.');
    }
    throw new Error(err?.errorMessage || err?.message || 'Verification failed. Please check the code.');
  }
}

/**
 * Step 3: Submits cloud 2-step verification password if required.
 */
export async function submitTelegram2FAPassword(
  client: TelegramClient | null,
  password: string,
  onLog?: LogCallback
): Promise<{
  success: boolean;
  telegramUserId: string;
  sessionString: string;
}> {
  const log = (text: string, type: 'info' | 'warn' | 'error' | 'success' = 'info') => {
    const time = new Date().toLocaleTimeString();
    if (onLog) onLog({ time, text, type });
  };

  if (!client) {
    throw new Error('Telegram client is not connected.');
  }

  try {
    log(`Requesting 2FA SRP challenge parameters (account.GetPassword)...`, 'info');
    const passwordSrpResult: any = await client.invoke(new Api.account.GetPassword());

    log(`Computing Secure Remote Password (SRP) cryptographic check...`, 'info');
    const passwordSrpCheck = await computeCheck(passwordSrpResult, password);

    log(`Submitting auth.CheckPassword to Telegram...`, 'info');
    const authResult: any = await client.invoke(
      new Api.auth.CheckPassword({
        password: passwordSrpCheck,
      })
    );

    let user: any = authResult?.user;
    if (!user) {
      user = await client.getMe();
    }

    const telegramUserId = String(user.id);
    log(`2FA Password verified! Authenticated User ID: ${telegramUserId} (${user.firstName || ''} ${user.lastName || ''})`, 'success');
    const sessionString = client.session.save() as unknown as string;
    // Session is saved locally by AddTelegram.finalizeLink(), keyed by the
    // server account id (reconnect() uses the same id).
    log(`2FA verified for user ${telegramUserId}.`, 'success');

    return {
      success: true,
      telegramUserId,
      sessionString,
    };
  } catch (err: any) {
    log(`2FA Password verification error: ${err?.errorMessage || err?.message}`, 'error');
    const msg = String(err?.errorMessage || err?.message || '');
    if (msg.includes('PASSWORD_HASH_INVALID')) {
      throw new Error('Incorrect 2-step verification password. Please try again.');
    }
    if (msg.includes('FLOOD_WAIT')) {
      throw new Error('Too many attempts. Telegram requires waiting a few minutes.');
    }
    throw new Error(err?.errorMessage || err?.message || 'Password verification failed.');
  }
}

/**
 * QR Code Login flow using Telegram MTProto auth.ExportLoginToken.
 * Bypasses SMS gateways, VoIP carrier restrictions, and third-party code filters completely.
 */
export async function startTelegramQrLogin(
  onQrCode: (qrDataUrl: string) => void,
  onPasswordNeeded?: () => Promise<string>,
  onLog?: LogCallback
): Promise<{
  client: TelegramClient;
  telegramUserId: string;
  sessionString: string;
  user: any;
}> {
  const log = (text: string, type: 'info' | 'warn' | 'error' | 'success' = 'info') => {
    const time = new Date().toLocaleTimeString();
    if (onLog) onLog({ time, text, type });
  };

  log('Initializing Telegram MTProto client for QR Code scan...', 'info');

  const session = new StringSession('');
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
    useWSS: true,
    deviceModel: 'Desktop Windows',
    systemVersion: 'Windows 11',
    appVersion: '1.0.0',
  });

  try {
    (client as any).setLogLevel('debug');
  } catch {}

  log('Connecting to Telegram MTProto Gateway via secure WebSocket...', 'info');
  await client.connect();
  log('Connected! Requesting live QR Login Token from Telegram...', 'success');

  const user = await client.signInUserWithQrCode(
    { apiId: API_ID, apiHash: API_HASH },
    {
      qrCode: async ({ token, expires }) => {
        log(`Live QR login token generated! Expires at ${new Date(expires * 1000).toLocaleTimeString()}.`, 'info');
        const base64Url = Buffer.from(token)
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
        const tgUri = `tg://login?token=${base64Url}`;
        const dataUrl = await QRCode.toDataURL(tgUri, {
          width: 256,
          margin: 2,
          color: {
            dark: '#0f172a',
            light: '#ffffff',
          },
        });
        onQrCode(dataUrl);
        log(`QR Code displayed on screen. Open Telegram on your phone ➔ Settings ➔ Devices ➔ Link Desktop Device to scan.`, 'success');
      },
      password: async () => {
        log(`Two-Step verification password required for this account.`, 'warn');
        if (onPasswordNeeded) {
          return await onPasswordNeeded();
        }
        throw new Error('Two-Step verification password required.');
      },
      onError: (err: any) => {
        log(`QR scan notification: ${err?.errorMessage || err?.message || err}`, 'warn');
      },
    }
  );
  const authUser: any = user;

  const telegramUserId = String(authUser.id);
  const sessionString = client.session.save() as unknown as string;
  // Session is saved locally by AddTelegram.finalizeLink(), keyed by the
  // server account id (reconnect() uses the same id).
  log(`QR Code successfully scanned! Authenticated User: ${authUser.firstName || ''} ${authUser.lastName || ''} (@${authUser.username || 'no-username'}) ID: ${telegramUserId}`, 'success');

  return {
    client,
    telegramUserId,
    sessionString,
    user,
  };
}

/**
 * Legacy wrapper for backward compatibility.
 */
export async function loginWithPhone(
  phoneNumber: string,
  handlers: LoginHandlers
): Promise<{ client: TelegramClient | null; telegramUserId: string; telegramAccountId: string; sessionString?: string; isDemo?: boolean }> {
  const req = await requestTelegramPhoneCode(phoneNumber);
  if (req.isDemo || !req.client) {
    await handlers.onCodeRequested();
    const demoTelegramId = 'tg_' + Math.abs(req.phoneNumber.split('').reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) | 0, 0));
    const demoSession = 'demo-session-' + demoTelegramId;
    await saveSession(demoTelegramId, demoSession);
    return { client: null, telegramUserId: demoTelegramId, telegramAccountId: demoTelegramId, sessionString: demoSession, isDemo: true };
  }

  const code = await handlers.onCodeRequested();
  const verifyRes = await submitTelegramCode(req.client, req.phoneNumber, req.phoneCodeHash, code);

  if (verifyRes.needsPassword && handlers.onPasswordRequested) {
    const password = await handlers.onPasswordRequested();
    const pwRes = await submitTelegram2FAPassword(req.client, password);
    return {
      client: req.client,
      telegramUserId: pwRes.telegramUserId,
      telegramAccountId: pwRes.telegramUserId,
      sessionString: pwRes.sessionString,
      isDemo: false,
    };
  }

  return {
    client: req.client,
    telegramUserId: verifyRes.telegramUserId!,
    telegramAccountId: verifyRes.telegramUserId!,
    sessionString: verifyRes.sessionString,
    isDemo: false,
  };
}

const clientCache = new Map<string, TelegramClient>();
// One in-flight connection per account. Without this, two callers (e.g. the
// inbox and a chat thread mounting at the same time) could open two MTProto
// sockets with the same auth key — Telegram then pushes updates to only one of
// them, and handlers attached to the other never fire.
const pendingConnections = new Map<string, Promise<TelegramClient | null>>();

/**
 * Registers an already-authenticated client (the one used during `+ Add
 * Telegram`) as the app-wide client for that account. Reusing the same
 * instance matters: its update loop is already running and Telegram keeps
 * pushing updates to this socket instead of a second, handler-less one.
 */
export function adoptTelegramClient(telegramAccountId: string, client: TelegramClient): void {
  if (!client) return;
  const existing = clientCache.get(telegramAccountId);
  if (existing && existing !== client) {
    try { void existing.destroy(); } catch {}
  }
  clientCache.set(telegramAccountId, client);
  startKeepAlive();
}

export function getCachedTelegramClient(telegramAccountId: string): TelegramClient | null {
  return clientCache.get(telegramAccountId) || null;
}

export async function destroyTelegramClient(telegramAccountId: string): Promise<void> {
  const client = clientCache.get(telegramAccountId);
  clientCache.delete(telegramAccountId);
  if (client) {
    try { await client.destroy(); } catch {}
  }
  if (clientCache.size === 0 && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
  }
}

// GramJS/Telegram can silently stop pushing updates on an otherwise healthy but
// idle socket (notably for groups/channels). Sending a tiny amount of real API
// traffic periodically keeps the update stream alive. One shared timer covers
// every cached account, regardless of how many subscriptions exist.
let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

function startKeepAlive(): void {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(async () => {
    for (const client of clientCache.values()) {
      if (!client.connected) continue;
      try {
        await Promise.race([
          client.getDialogs({ limit: 1 }),
          new Promise((resolve) => setTimeout(resolve, 8000)),
        ]);
      } catch {
        // A failed keep-alive is harmless; the watchdog reconnects if needed.
      }
    }
  }, 45_000);
}

/**
 * Connects a client and makes sure Telegram actually starts pushing updates.
 * `updates.GetState` registers this connection for update delivery — without
 * it some sessions stay connected but never receive live events.
 */
async function activateClient(client: TelegramClient): Promise<boolean> {
  try {
    if (!client.connected) {
      await client.connect();
    }
    if (!client.connected) return false;
    // Caches the self input peer (needed by the event dispatcher) and confirms
    // the session is still authorised.
    await client.getMe();
    try {
      await client.invoke(new Api.updates.GetState());
    } catch {}
    return client.connected;
  } catch (err) {
    console.warn('[telegram] Failed to activate client:', err);
    return false;
  }
}

export async function getActiveTelegramClient(telegramAccountId: string): Promise<TelegramClient | null> {
  const cached = clientCache.get(telegramAccountId);
  if (cached) {
    if (cached.connected) {
      startKeepAlive();
      return cached;
    }
    // Reconnect the SAME instance so already-registered event handlers survive.
    if (await activateClient(cached)) return cached;
  }
  const newClient = await reconnect(telegramAccountId);
  if (newClient) clientCache.set(telegramAccountId, newClient);
  return newClient;
}

/**
 * Reconnects using a session saved locally in the OS keychain.
 * The server never holds or returns Telegram session material.
 */
export async function reconnect(telegramAccountId: string): Promise<TelegramClient | null> {
  const inFlight = pendingConnections.get(telegramAccountId);
  if (inFlight) return inFlight;

  const promise = (async (): Promise<TelegramClient | null> => {
    // Prefer the existing instance so live event handlers keep working.
    const cached = clientCache.get(telegramAccountId);
    if (cached) {
      if (await activateClient(cached)) return cached;
      clientCache.delete(telegramAccountId);
      try { await cached.destroy(); } catch {}
    }

    const sessionString = await loadSession(telegramAccountId);

    if (!sessionString) return null;

    if (!isTelegramConfigured() || sessionString.startsWith('demo-session-')) {
      return null;
    }

    try {
      const client = new TelegramClient(new StringSession(sessionString), API_ID, API_HASH, {
        connectionRetries: 3,
        useWSS: true,
        deviceModel: 'Desktop Windows',
        systemVersion: 'Windows 11',
        appVersion: '1.0.0',
      });
      const ok = await activateClient(client);
      if (!ok) {
        console.warn('[telegram] reconnect: client.connected is false for account:', telegramAccountId);
        try { await client.destroy(); } catch {}
        return null;
      }
      clientCache.set(telegramAccountId, client);
      startKeepAlive();
      return client;
    } catch (err) {
      console.warn('[telegram] reconnect failed for account:', telegramAccountId, err);
      return null;
    }
  })();

  pendingConnections.set(telegramAccountId, promise);
  try {
    return await promise;
  } finally {
    pendingConnections.delete(telegramAccountId);
  }
}

/**
 * Sends a text message through this client's own Telegram account.
 */
export async function sendMessage(client: TelegramClient | null, peer: string, text: string): Promise<{ id: string }> {
  if (client && client.connected) {
    const result = await client.sendMessage(peer, { message: text });
    return { id: String(result.id) };
  }
  return { id: String(Date.now()) };
}

/**
 * Listens for new messages on an active Telegram client and invokes callback for sync.
 */
export function setupUpdateListener(
  client: TelegramClient,
  onMessage: (message: {
    telegramMessageId: string;
    chatExternalId: string;
    text: string;
    direction: 'in' | 'out';
    senderUserId: string;
    date: Date;
  }) => void
): () => void {
  if (!client) return () => {};

  const handler = (event: NewMessageEvent) => {
    const msg = event.message;
    if (!msg || !msg.message) return;

    const chatExternalId = String(msg.chatId || msg.peerId);
    const telegramMessageId = String(msg.id);
    const direction = msg.out ? 'out' : 'in';
    const senderUserId = String(msg.senderId || '');

    onMessage({
      telegramMessageId,
      chatExternalId,
      text: msg.message,
      direction,
      senderUserId,
      date: new Date(msg.date * 1000),
    });
  };

  client.addEventHandler(handler, new NewMessage({}));

  return () => {
    client.removeEventHandler(handler, new NewMessage({}));
  };
}

