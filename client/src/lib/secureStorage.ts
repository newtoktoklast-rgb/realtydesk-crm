/**
 * Local-only secure storage for Telegram MTProto session strings and JWTs.
 *
 * SECURITY BOUNDARY (docs/BUILD_SPEC.md §2):
 * Session material saved through this module NEVER leaves this device.
 * It is not sent to the RealtyDesk server in any request. The server only
 * ever receives the `telegramAccountId` correlation handle (see api/client.ts),
 * which this module uses as the lookup key.
 *
 * Backing store: OS keychain via Tauri's keyring commands (Windows Credential
 * Manager under the hood). Browser/dev previews without a Tauri runtime use
 * sessionStorage only, so secrets are not persisted to disk.
 */

import { invoke } from '@tauri-apps/api/core';

const SERVICE_NAME = 'realtydesk-telegram-session';
const AUTH_SERVICE_NAME = 'realtydesk-auth';

function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
}

async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>, timeoutMs = 5000): Promise<T | null> {
  try {
    return await Promise.race([
      invoke<T>(cmd, args).catch((err) => {
        console.warn(`[secureStorage] invoke('${cmd}') failed:`, err);
        return null;
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch {
    return null;
  }
}

const memoryStore = new Map<string, string>();

/**
 * In the packaged desktop app we NEVER mirror secrets to web storage.
 * Only browser/dev previews (where there is no OS keychain) use sessionStorage,
 * which is scoped to the current tab and cleared when it closes.
 */
function getDevStorage(): Storage | null {
  if (isTauriEnvironment()) return null;
  try {
    if (typeof sessionStorage === 'undefined') return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

function fallbackGet(service: string, account: string): string | null {
  const key = `${service}:${account}`;
  const storage = getDevStorage();
  if (storage) {
    try {
      const value = storage.getItem(key);
      if (value !== null) return value;
    } catch {
      // fall through to memory
    }
  }
  return memoryStore.get(key) ?? null;
}

function fallbackSet(service: string, account: string, secret: string): void {
  const key = `${service}:${account}`;
  const storage = getDevStorage();
  if (storage) {
    try {
      storage.setItem(key, secret);
      return;
    } catch {
      // fall through to memory
    }
  }
  memoryStore.set(key, secret);
}

function fallbackDelete(service: string, account: string): void {
  const key = `${service}:${account}`;
  const storage = getDevStorage();
  if (storage) {
    try {
      storage.removeItem(key);
    } catch {
      // ignore
    }
  }
  memoryStore.delete(key);
}

export async function saveSession(telegramAccountId: string, sessionString: string): Promise<void> {
  if (isTauriEnvironment()) {
    await safeInvoke('keyring_set', {
      service: SERVICE_NAME,
      account: telegramAccountId,
      secret: sessionString,
    });
    return;
  }
  fallbackSet(SERVICE_NAME, telegramAccountId, sessionString);
}

export async function loadSession(telegramAccountId: string): Promise<string | null> {
  if (isTauriEnvironment()) {
    const value = await safeInvoke<string>('keyring_get', {
      service: SERVICE_NAME,
      account: telegramAccountId,
    });
    return value || null;
  }
  return fallbackGet(SERVICE_NAME, telegramAccountId);
}

export async function deleteSession(telegramAccountId: string): Promise<void> {
  if (isTauriEnvironment()) {
    await safeInvoke('keyring_delete', {
      service: SERVICE_NAME,
      account: telegramAccountId,
    });
    return;
  }
  fallbackDelete(SERVICE_NAME, telegramAccountId);
}

export async function saveAuthTokens(accessToken: string, refreshToken: string): Promise<void> {
  if (isTauriEnvironment()) {
    await Promise.all([
      safeInvoke('keyring_set', { service: AUTH_SERVICE_NAME, account: 'accessToken', secret: accessToken }),
      safeInvoke('keyring_set', { service: AUTH_SERVICE_NAME, account: 'refreshToken', secret: refreshToken }),
    ]);
    return;
  }
  fallbackSet(AUTH_SERVICE_NAME, 'accessToken', accessToken);
  fallbackSet(AUTH_SERVICE_NAME, 'refreshToken', refreshToken);
}

export async function loadAuthTokens(): Promise<{ accessToken: string | null; refreshToken: string | null }> {
  if (isTauriEnvironment()) {
    const [accessToken, refreshToken] = await Promise.all([
      safeInvoke<string>('keyring_get', { service: AUTH_SERVICE_NAME, account: 'accessToken' }),
      safeInvoke<string>('keyring_get', { service: AUTH_SERVICE_NAME, account: 'refreshToken' }),
    ]);
    return { accessToken, refreshToken };
  }
  return {
    accessToken: fallbackGet(AUTH_SERVICE_NAME, 'accessToken'),
    refreshToken: fallbackGet(AUTH_SERVICE_NAME, 'refreshToken'),
  };
}

export async function clearAuthTokens(): Promise<void> {
  if (isTauriEnvironment()) {
    await Promise.all([
      safeInvoke('keyring_delete', { service: AUTH_SERVICE_NAME, account: 'accessToken' }),
      safeInvoke('keyring_delete', { service: AUTH_SERVICE_NAME, account: 'refreshToken' }),
    ]);
    return;
  }
  fallbackDelete(AUTH_SERVICE_NAME, 'accessToken');
  fallbackDelete(AUTH_SERVICE_NAME, 'refreshToken');
}
