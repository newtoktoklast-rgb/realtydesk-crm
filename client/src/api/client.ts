/**
 * Thin REST client for the RealtyDesk server. Every call here sends only
 * metadata/content — never Telegram session material. See
 * docs/BUILD_SPEC.md §2 and §6 for the contract this implements.
 */

import { loadAuthTokens, saveAuthTokens } from '../lib/secureStorage';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000/api/v1';

let authFailureHandler: (() => void) | null = null;
export function registerAuthFailureHandler(handler: () => void) {
  authFailureHandler = handler;
}

async function request<T>(path: string, options: RequestInit = {}, isRetry = false): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error('Request timed out after 10 seconds'));
  }, 10000);

  try {
    const { accessToken } = await loadAuthTokens();
    const res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      signal: options.signal || controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(options.headers || {}),
      },
    });

    if (res.status === 401 && accessToken && !isRetry) {
      // Access token expired — try a refresh once, then retry the request.
      const refreshed = await tryRefresh();
      if (refreshed) {
        return request<T>(path, options, true);
      }
      if (authFailureHandler) authFailureHandler();
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed: ${res.status}`);
    }

    return res.json();
  } catch (err: any) {
    if (err.name === 'AbortError' || err.message?.includes('aborted')) {
      throw new Error('Server request timed out. Please verify the backend server and MongoDB database are reachable.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function tryRefresh(): Promise<boolean> {
  const { refreshToken } = await loadAuthTokens();
  if (!refreshToken) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error('Refresh request timed out after 6 seconds'));
  }, 6000);
  try {
    const res = await fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const { accessToken } = await res.json();
    await saveAuthTokens(accessToken, refreshToken);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  redeemActivationCode: (code: string, displayName: string) =>
    request<{ accessToken: string; refreshToken: string; agent: any }>('/auth/activation-code/redeem', {
      method: 'POST',
      body: JSON.stringify({ code, displayName }),
    }),

  ownerLogin: (email: string, password: string) =>
    request<{ accessToken: string; refreshToken: string; owner: any }>('/auth/owner/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  agentLogin: (username: string, password: string) =>
    request<{ accessToken: string; refreshToken: string; agent: any }>('/auth/agent/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  // Called AFTER MTProto login succeeds. The server records metadata only;
  // the session string stays in the local OS keychain.
  linkTelegramAccount: (payload: {
    telegramUserId: string;
    displayName?: string;
    username?: string;
    phoneMasked?: string;
  }) =>
    request<{ telegramAccount: any }>('/telegram-accounts', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  myTelegramAccounts: () => request<{ telegramAccounts: any[] }>('/telegram-accounts/mine'),

  listOrgTelegramAccounts: () => request<{ telegramAccounts: any[] }>('/telegram-accounts/org-accounts'),

  unlinkTelegramAccount: (id: string) => request<{ ok: true }>(`/telegram-accounts/${id}`, { method: 'DELETE' }),

  syncMessages: (payload: {
    telegramAccountId: string;
    chatExternalId: string;
    contact: {
      telegramUserId?: string;
      username?: string;
      phoneNumber?: string;
      avatarUrl?: string;
      displayName?: string;
      savedName?: string;
      firstName?: string;
      lastName?: string;
      isBlocked?: boolean;
    };
    isArchived?: boolean;
    messages: Array<{
      telegramMessageId: string;
      direction: 'in' | 'out';
      senderType: 'contact' | 'agent' | 'owner';
      senderId?: string;
      text?: string;
      mediaRef?: string;
      sentAt: string;
    }>;
  }) =>
    request<{ chatId: string; contactId: string; duplicate: boolean; otherAgents: string[] }>('/sync/messages', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  syncBatchMessages: (payload: {
    telegramAccountId: string;
    items: Array<{
      chatExternalId: string;
      contact: { telegramUserId?: string; username?: string; phoneNumber?: string; avatarUrl?: string };
      isArchived?: boolean;
      messages: Array<{
        telegramMessageId: string;
        direction: 'in' | 'out';
        senderType: 'contact' | 'agent' | 'owner';
        senderId?: string;
        text?: string;
        mediaRef?: string;
        sentAt: string;
      }>;
    }>;
  }) =>
    request<{ ok: true; chatsSynced: number }>('/sync/batch-messages', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  markChatRead: (chatId: string) => request<{ ok: true }>(`/sync/chats/${chatId}/read`, { method: 'POST' }),

  toggleArchiveChat: (chatId: string, isArchived?: boolean) =>
    request<{ ok: true; isArchived: boolean; chat: any }>(`/chats/${chatId}/archive`, {
      method: 'PATCH',
      body: JSON.stringify({ isArchived }),
    }),

  toggleBlockChat: (chatId: string, isBlocked?: boolean) =>
    request<{ ok: true; isBlocked: boolean; chat: any }>(`/chats/${chatId}/block`, {
      method: 'PATCH',
      body: JSON.stringify({ isBlocked }),
    }),

  markChatTransferred: (chatId: string, isTransferred = true) =>
    request<{ ok: true; isTransferred: boolean; chat: any }>(`/chats/${chatId}/transferred`, {
      method: 'PATCH',
      body: JSON.stringify({ isTransferred }),
    }),

  listChats: (params: {
    scope?: 'mine' | 'all';
    filter?: 'all' | 'repeated' | 'transferred' | 'mine' | 'unread' | 'archived' | 'blocked';
    q?: string;
    includeArchived?: boolean;
  }) => {
    const clean: Record<string, string> = {};
    if (params.scope) clean.scope = params.scope;
    if (params.filter) clean.filter = params.filter;
    if (params.q) clean.q = params.q;
    if (params.includeArchived) clean.includeArchived = 'true';
    const qs = new URLSearchParams(clean).toString();
    return request<{ chats: any[] }>(`/chats?${qs}`);
  },

  /**
   * Returns repeated chat IDs and collision labels based purely on server DB data.
   * A contact is "repeated" when it has active (non-archived) chats across 2+ distinct
   * Telegram accounts within the same org.
   */
  listRepeatedChatIds: () =>
    request<{ repeatedChatIds: string[]; collisionMap: Record<string, string>; repeatedCount?: number }>('/chats/repeated-ids'),

  chatMessages: (chatId: string, before?: number, limit = 100) => {
    const qs = new URLSearchParams({ ...(before ? { before: String(before) } : {}), limit: String(limit) });
    return request<{ messages: any[] }>(`/chats/${chatId}/messages?${qs.toString()}`);
  },

  // Owner's client calls this only AFTER it has sent the message itself via
  // the owner's own linked Telegram account. Server just records it.
  recordOwnerReply: (chatId: string, text: string, telegramMessageId: string, mediaRef?: string) =>
    request<{ message: any }>(`/chats/${chatId}/owner-reply`, {
      method: 'POST',
      body: JSON.stringify({ text, telegramMessageId, mediaRef }),
    }),

  contactNotes: (id: string) => request<{ notes: any[] }>(`/contacts/${id}/notes`),
  addContactNote: (id: string, text: string) =>
    request<{ note: any }>(`/contacts/${id}/notes`, { method: 'POST', body: JSON.stringify({ text }) }),

  listTemplates: () => request<{ templates: any[] }>('/templates'),
  createTemplate: (title: string, body: string) =>
    request<{ template: any }>('/templates', { method: 'POST', body: JSON.stringify({ title, body }) }),

  createActivationCode: (maxUses: number, expiresAt?: string) =>
    request<{ activationCode: any }>('/owner/activation-codes', {
      method: 'POST',
      body: JSON.stringify({ maxUses, expiresAt }),
    }),
  listActivationCodes: () => request<{ activationCodes: any[] }>('/owner/activation-codes'),

  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),

  listAgents: () => request<{ agents: any[] }>('/owner/agents'),
  createAgent: (payload: { username: string; password: string; displayName: string }) =>
    request<{ agent: any }>('/owner/agents', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteAgent: (id: string) => request<{ ok: true; message: string }>(`/owner/agents/${id}`, { method: 'DELETE' }),
};
