import { useEffect, useLayoutEffect, useState, useRef, memo, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import { Avatar } from '../components/Avatar';
import BrandMark from '../components/BrandMark';
import { getCachedAvatar, subscribeAvatarUpdates } from '../lib/avatarCache';
import { deleteSession } from '../lib/secureStorage';
import {
  getLiveClient,
  fetchLiveTelegramChats,
  fetchLiveTelegramMessages,
  sendLiveTelegramMessage,
  subscribeLiveTelegramUpdates,
  mirrorLiveChatToCRM,
  LiveChat,
  LiveMessage,
} from '../lib/telegramLiveService';
import { TelegramClient } from 'telegram';
import {
  MenuIcon,
  ChevronLeftIcon,
  SearchIcon,
  CloseIcon,
  CheckCheckIcon,
  SendIcon,
  PaperclipIcon,
  PhotoIcon,
  ArchiveIcon,
  UnarchiveIcon,
  NotesIcon,
  PhoneIcon,
  BuildingIcon,
  LightningIcon,
  AlertTriangleIcon,
  TrashIcon,
  RepeatIcon,
} from '../components/Icons';

function formatTelegramTime(dateStr?: string) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function ChatSkeletons({ count = 8 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <li key={i} className="chat-skeleton-item">
          <div className="chat-skeleton-avatar skeleton-shimmer" />
          <div className="chat-skeleton-content">
            <div className="chat-skeleton-top">
              <div
                className="chat-skeleton-name skeleton-shimmer"
                style={{ width: `${38 + (i % 4) * 12}%` }}
              />
              <div className="chat-skeleton-time skeleton-shimmer" />
            </div>
            <div className="chat-skeleton-bottom">
              <div
                className="chat-skeleton-preview skeleton-shimmer"
                style={{ width: `${55 + (i % 3) * 15}%` }}
              />
            </div>
          </div>
        </li>
      ))}
    </>
  );
}

function MessageSkeletons({ count = 6 }: { count?: number }) {
  return (
    <div className="thread-skeleton-container">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={`message-skeleton-bubble ${i % 2 === 0 ? 'in' : 'out'}`}>
          <div
            className="message-skeleton-line skeleton-shimmer"
            style={{ width: `${60 + (i % 3) * 18}%` }}
          />
          {i % 2 !== 0 && (
            <div
              className="message-skeleton-line skeleton-shimmer"
              style={{ width: `${35 + (i % 2) * 20}%` }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function ContactNotesDrawer({
  contactId,
  contactInfo,
  onClose,
  notify,
}: {
  contactId?: string;
  contactInfo?: any;
  onClose: () => void;
  notify: (message: string, kind?: 'error' | 'success') => void;
}) {
  const [notes, setNotes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [newNote, setNewNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!contactId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    api
      .contactNotes(contactId)
      .then((res: { notes: any[] }) => setNotes(res.notes || []))
      .catch((err: any) => console.warn('Could not load notes:', err))
      .finally(() => setLoading(false));
  }, [contactId]);

  async function handleAddNote(e: React.FormEvent) {
    e.preventDefault();
    if (!newNote.trim() || !contactId) return;
    setSubmitting(true);
    try {
      const res = await api.addContactNote(contactId, newNote.trim());
      setNotes((prev) => [res.note, ...prev]);
      setNewNote('');
      notify('Note saved', 'success');
    } catch (err: any) {
      notify(err.message || 'Failed to save note');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="notes-drawer-backdrop" onClick={onClose}>
      <div className="notes-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="notes-drawer-header">
          <div>
            <h3>Lead Dossier & Notes</h3>
            <span>
              {contactInfo?.savedName || contactInfo?.displayName || 'Lead Notes'}
            </span>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close Notes" aria-label="Close Lead Dossier & Notes">
            <CloseIcon size={18} />
          </button>
        </div>

        <div className="notes-drawer-body">
          <form onSubmit={handleAddNote} className="note-form">
            <textarea
              rows={3}
              placeholder="Record lead budget, property criteria, timeline, or call notes…"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              disabled={submitting}
            />
            <button type="submit" className="primary-btn small-btn" disabled={submitting || !newNote.trim()}>
              {submitting ? 'Saving…' : 'Add Note'}
            </button>
          </form>

          <div className="notes-list">
            {loading ? (
              <p className="loading-notes">Loading CRM notes…</p>
            ) : notes.length === 0 ? (
              <p className="empty-notes">No CRM notes recorded yet.</p>
            ) : (
              notes.map((n) => (
                <div key={n._id} className="note-card">
                  <p className="note-text">{n.text}</p>
                  <div className="note-meta">
                    <span className="note-author">{n.authorId?.displayName || 'Agent'}</span>
                    <span className="note-date">{new Date(n.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function getChatDisplayName(chat: any): string {
  if (!chat) return 'Telegram Contact';
  if (chat.contactId?.savedName?.trim()) return chat.contactId.savedName.trim();
  const first = chat.contactId?.firstName?.trim();
  const last = chat.contactId?.lastName?.trim();
  const fullName = [first, last].filter(Boolean).join(' ');
  if (fullName) return fullName;
  if (chat.contactId?.displayName?.trim() && !chat.contactId.displayName.startsWith('@')) {
    return chat.contactId.displayName.trim();
  }
  if (chat.title?.trim() && !chat.title.startsWith('@')) return chat.title.trim();
  if (chat.contactName?.trim() && !chat.contactName.startsWith('@')) return chat.contactName.trim();
  if (chat.contactId?.phoneNumber?.trim()) return chat.contactId.phoneNumber.trim();
  if (chat.contactId?.username?.trim()) return `@${chat.contactId.username.replace(/^@/, '')}`;
  return chat.title || 'Telegram User';
}

function getChatAccountId(chat: any): string {
  return String(chat?.telegramAccountId?._id || chat?.telegramAccountId || '');
}

function getChatKey(chat: any): string {
  return `${getChatAccountId(chat)}_${String(chat?.externalChatId || chat?._id || '')}`;
}

// On narrow screens the thread overlays the list, so we must not auto-open a
// conversation on load — the user should land on the conversation list instead.
function isNarrowViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches;
}

/**
 * Merges live MTProto dialogs with CRM DB chats. A chat is only matched inside
 * the same Telegram account, so the same contact appearing in two accounts is
 * never collapsed into the wrong account's conversation.
 */
function mergeLiveAndDbChats(liveChats: any[], dbChats: any[]): any[] {
  const enriched = liveChats.map((liveChat) => {
    const match = dbChats.find((m: any) => {
      if (getChatAccountId(m) !== getChatAccountId(liveChat)) return false;
      return (
        m.externalChatId === liveChat.externalChatId ||
        (m.contactId?.telegramUserId &&
          liveChat.contactId?.telegramUserId &&
          String(m.contactId.telegramUserId) === String(liveChat.contactId.telegramUserId)) ||
        (m.contactId?.phoneNumber &&
          liveChat.contactId?.phoneNumber &&
          m.contactId.phoneNumber === liveChat.contactId.phoneNumber)
      );
    });

    if (match) {
      return {
        ...liveChat,
        _id: match._id || liveChat._id,
        isArchived: Boolean(match.isArchived !== undefined ? match.isArchived : liveChat.isArchived),
        agentId: match.agentId || liveChat.agentId,
        telegramAccountId: liveChat.telegramAccountId || match.telegramAccountId,
        contactId: {
          ...liveChat.contactId,
          _id: match.contactId?._id || liveChat.contactId?._id,
          duplicateFlag: match.contactId?.duplicateFlag ?? liveChat.contactId?.duplicateFlag,
          linkedAgents: match.contactId?.linkedAgents || (liveChat.contactId as any)?.linkedAgents,
          linkedAccounts: match.contactId?.linkedAccounts || (liveChat.contactId as any)?.linkedAccounts,
        },
      };
    }
    return liveChat;
  });

  const seen = new Set(enriched.map(getChatKey));
  const combined = [...enriched];
  for (const c of dbChats) {
    const key = getChatKey(c);
    if (!seen.has(key)) {
      seen.add(key);
      combined.push(c);
    }
  }
  return combined.length > 0 ? combined : dbChats;
}

type DraftAttachment = { file: File; dataUrl: string };
type DraftEntry = { text: string; attachment: DraftAttachment | null };

/**
 * Per-conversation unsent drafts. ChatThread remounts when the selected chat
 * changes, so drafts are kept here (keyed by the stable external chat id) to
 * survive navigation instead of being silently destroyed.
 */
const draftStore = new Map<string, DraftEntry>();

function RepeatedIndicator({
  collisionInfo,
  size = 'sm',
}: {
  collisionInfo?: string;
  size?: 'sm' | 'md';
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; placement: 'below' | 'above' } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);

  const accounts = useMemo(() => {
    if (!collisionInfo) return [];
    return collisionInfo.split(' & ').map((s) => s.trim()).filter(Boolean);
  }, [collisionInfo]);

  // The popover is portaled to <body> and positioned with fixed coordinates so it
  // is never clipped by the scrolling chat list or `content-visibility` containment.
  const updatePosition = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const width = popRef.current?.offsetWidth || 275;
    const height = popRef.current?.offsetHeight || 170;
    const margin = 8;
    const left = Math.max(margin, Math.min(rect.left - 8, window.innerWidth - width - margin));
    let placement: 'below' | 'above' = 'below';
    // Overlap the pill slightly: the popover is portaled to <body> and is NOT
    // inside the wrap, so a positive gap leaves a dead zone between the pill
    // and the card where the wrap has already left (its mouseleave starts the
    // close timer) but the card hasn't been entered yet.
    let top = rect.bottom - 2;
    if (top + height > window.innerHeight - margin && rect.top - height + 2 > margin) {
      placement = 'above';
      top = rect.top - height + 2;
    }
    setPos({ top, left, placement });
  }, []);

  useLayoutEffect(() => {
    if (isOpen) updatePosition();
  }, [isOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = () => updatePosition();
    window.addEventListener('scroll', handler, true);
    window.addEventListener('resize', handler);
    return () => {
      window.removeEventListener('scroll', handler, true);
      window.removeEventListener('resize', handler);
    };
  }, [isOpen, updatePosition]);

  useEffect(() => {
    if (!isPinned) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setIsPinned(false);
      setIsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsPinned(false);
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [isPinned]);

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  const open = () => {
    window.clearTimeout(hideTimer.current);
    setIsOpen(true);
  };
  const scheduleClose = () => {
    if (isPinned) return;
    window.clearTimeout(hideTimer.current);
    // Generous delay so moving from the pill into the card doesn't close it
    // while the pointer is still travelling to the (overlapping) card.
    hideTimer.current = window.setTimeout(() => setIsOpen(false), 300);
  };
  const togglePin = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    window.clearTimeout(hideTimer.current);
    setIsPinned((prev) => {
      const next = !prev;
      setIsOpen(next);
      return next;
    });
  };

  return (
    <div
      ref={wrapRef}
      className={`repeated-indicator-wrap size-${size} ${isOpen ? 'hovered' : ''}`}
      onMouseEnter={open}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className="repeated-icon-pill"
        title="Repeated lead — click or hover for details"
        onClick={togglePin}
      >
        <RepeatIcon size={size === 'md' ? 13 : 11} className="repeated-svg-icon" />
      </button>

      {isOpen &&
        createPortal(
          <div
            ref={popRef}
            className={`repeated-detail-popover placement-${pos?.placement || 'below'}`}
            style={
              pos
                ? { position: 'fixed', top: pos.top, left: pos.left }
                : { position: 'fixed', top: -9999, left: -9999 }
            }
            onMouseEnter={() => window.clearTimeout(hideTimer.current)}
            onMouseLeave={scheduleClose}
            onClick={(e) => e.stopPropagation()}
            role="tooltip"
          >
            <div className="popover-arrow" />
            <div className="popover-header">
              <div className="popover-badge">
                <RepeatIcon size={12} />
                <span>Repeated Lead</span>
              </div>
              <span className="popover-count">{accounts.length || 2} accounts</span>
            </div>

            <p className="popover-desc">
              Same client active across multiple Telegram accounts:
            </p>

            <div className="popover-accounts-list">
              {accounts.map((acc, i) => (
                <div key={i} className="popover-account-item">
                  <span className="popover-account-dot" />
                  <span className="popover-account-name">{acc}</span>
                </div>
              ))}
            </div>

            <div className="popover-footer">
              <span>Archived chats are excluded • Coordinate replies internally</span>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

const ChatItem = memo(function ChatItem({
  chat,
  isSelected,
  isRepeated,
  collisionInfo,
  scope,
  onSelect,
}: {
  chat: any;
  isSelected: boolean;
  isRepeated?: boolean;
  collisionInfo?: string;
  scope: 'mine' | 'all';
  onSelect: (id: string) => void;
}) {
  const contactName = getChatDisplayName(chat);
  const isBlocked = Boolean(chat.isBlocked || chat.contactId?.isBlocked);

  const avatarUrl =
    chat.contactId?.avatarUrl ||
    getCachedAvatar(chat.externalChatId || chat.contactId?.telegramUserId);

  return (
    <li
      className={`chat-item ${isSelected ? 'selected' : ''} ${isBlocked ? 'is-blocked-chat' : ''} ${
        chat.unreadCount > 0 ? 'is-unread' : ''
      }`}
      onClick={() => onSelect(chat._id || chat.externalChatId)}
      role="button"
      tabIndex={0}
      aria-label="Open conversation"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(chat._id || chat.externalChatId);
        }
      }}
    >
      <div className="chat-avatar-wrap">
        <Avatar
          name={contactName}
          id={chat.externalChatId || chat.contactId?.telegramUserId}
          photoUrl={avatarUrl}
          size={46}
        />
      </div>
      <div className="chat-main-wrap">
        <div className="chat-row-top">
          <div className="contact-title-group">
            <span className="contact-name">{contactName}</span>
            {isRepeated && !chat.isArchived && (
              <RepeatedIndicator collisionInfo={collisionInfo} />
            )}
          </div>
          {chat.lastMessageAt && (
            <span className="chat-time">
              {formatTelegramTime(chat.lastMessageAt)}
            </span>
          )}
        </div>

        <div className="chat-row-bottom">
          <p className="chat-preview">
            {chat.lastMessagePreview === '[Media]' || chat.lastMessagePreview === '[Photo]' || chat.lastMessagePreview?.startsWith('data:image') ? (
              <span className="chat-preview-media">
                <PhotoIcon size={13} /> Photo
              </span>
            ) : (
              chat.lastMessagePreview || 'No messages yet'
            )}
          </p>
          <div className="chat-row-badges">
            {isBlocked && (
              <span className="blocked-tag" title="Blocked Contact">
                Blocked
              </span>
            )}
            {scope === 'all' && chat.agentId?.displayName && (
              <span className="agent-tag">{chat.agentId.displayName}</span>
            )}
            {chat.isArchived && (
              <span className="archived-tag" title="Archived">
                <ArchiveIcon size={10} style={{ marginRight: '3px' }} />
                Archived
              </span>
            )}
            {chat.unreadCount > 0 && <span className="unread-count">{chat.unreadCount}</span>}
          </div>
        </div>
      </div>
    </li>
  );
});

type Filter = 'all' | 'unread' | 'mine' | 'repeated' | 'blocked' | 'archived';
type Props = {
  role: 'agent' | 'owner';
  onAddTelegram?: () => void;
};

export default function Inbox({ role, onAddTelegram }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [chats, setChats] = useState<any[]>([]);
  const [loadingChats, setLoadingChats] = useState(true);
  const [scope, setScope] = useState<'mine' | 'all'>(role === 'owner' ? 'all' : 'mine');
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  const [templates, setTemplates] = useState<any[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [newTemplateTitle, setNewTemplateTitle] = useState('');
  const [newTemplateBody, setNewTemplateBody] = useState('');
  const [showCreateTemplate, setShowCreateTemplate] = useState(false);
  const [telegramAccounts, setTelegramAccounts] = useState<any[]>([]);
  const [, setAllOrgAccounts] = useState<any[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [, setAvatarRev] = useState(0);
  const [connectedAccounts, setConnectedAccounts] = useState(0);
  const [missingSessionAccounts, setMissingSessionAccounts] = useState<any[]>([]);
  const [syncProgress, setSyncProgress] = useState<{ done: number; total: number } | null>(null);
  const [toast, setToast] = useState<{ message: string; kind: 'error' | 'success' } | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const notify = useCallback((message: string, kind: 'error' | 'success' = 'error') => {
    window.clearTimeout(toastTimer.current);
    setToast({ message, kind });
    toastTimer.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  // Server-authoritative repeated-client detection
  // These come from /chats/repeated-ids which checks DB-stored chats across accounts in the org.
  const [serverRepeatedIds, setServerRepeatedIds] = useState<Set<string>>(new Set());
  const [serverCollisionMap, setServerCollisionMap] = useState<Map<string, string>>(new Map());
  // Monotonic counter so a stale repeated-ids response can't overwrite newer data.
  const repeatedFetchSeq = useRef(0);

  // Stop applying responses after unmount.
  useEffect(() => () => {
    repeatedFetchSeq.current += 1;
  }, []);

  const fetchRepeatedIds = useCallback(async () => {
    const seq = ++repeatedFetchSeq.current;
    try {
      const res = await api.listRepeatedChatIds();
      if (seq !== repeatedFetchSeq.current) return; // stale response; a newer fetch is in flight or done
      setServerRepeatedIds(new Set(res.repeatedChatIds));
      setServerCollisionMap(new Map(Object.entries(res.collisionMap)));
    } catch (err) {
      if (seq !== repeatedFetchSeq.current) return;
      console.warn('[Inbox] Could not load repeated-ids from server:', err);
    }
  }, []);

  // Debounce search queries
  useEffect(() => {
    if (query !== debouncedQuery) {
      setIsSearching(true);
    }
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
      setIsSearching(false);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    return subscribeAvatarUpdates(() => {
      setAvatarRev((r) => r + 1);
    });
  }, []);

  // Fetch the signed-in user's own accounts plus the org-wide account directory.
  // Owners can see the whole directory; every user only ever syncs their own
  // accounts, because MTProto sessions live solely in the local keychain.
  const fetchAccounts = async () => {
    try {
      const [ownRes, orgRes] = await Promise.all([
        api.myTelegramAccounts(),
        api.listOrgTelegramAccounts().catch(() => ({ telegramAccounts: [] })),
      ]);
      const accounts = ownRes.telegramAccounts || [];
      const orgAccounts = orgRes.telegramAccounts || [];
      setTelegramAccounts(accounts);
      setAllOrgAccounts(orgAccounts.length > 0 ? orgAccounts : accounts);
      return accounts;
    } catch (err) {
      console.warn('Error fetching telegram accounts:', err);
      return [];
    }
  };

  const handleUnlink = async (id: string, name: string) => {
    if (!window.confirm(`Are you sure you want to disconnect Telegram account "${name}"?`)) return;
    try {
      // Drop the local MTProto session too — the account is revoked, so its
      // keychain entry should not linger (the session is only usable on this
      // device anyway).
      await deleteSession(id);
      await api.unlinkTelegramAccount(id);
      await fetchAccounts();
      loadChats(false);
    } catch (err: any) {
      notify(err.message || 'Failed to unlink account');
    }
  };

  const handleToggleArchive = async (chatId: string, currentArchived: boolean) => {
    try {
      await api.toggleArchiveChat(chatId, !currentArchived);
      setChats((prev) =>
        prev.map((c) =>
          c._id === chatId || c.externalChatId === chatId
            ? { ...c, isArchived: !currentArchived }
            : c
        )
      );
      // Re-fetch repeated IDs from server since archiving changes collision status
      fetchRepeatedIds();
    } catch (err: any) {
      notify(err.message || 'Failed to update archive status');
    }
  };

  // Refreshes the chat list. Each account is resolved to its own local MTProto
  // client, so chats always come from the account that actually owns them.
  const loadChats = useCallback(async (showLoading = false) => {
    if (showLoading) setLoadingChats(true);
    try {
      const accounts = telegramAccounts.length > 0 ? telegramAccounts : await fetchAccounts();

      const liveChatsPromises = accounts.map(async (acc) => {
        try {
          const accClient = await getLiveClient(acc._id);
          if (accClient && accClient.connected) {
            const dialogs = await fetchLiveTelegramChats(accClient, acc._id, 300);
            return {
              connected: true,
              chats: dialogs.map((d) => ({
                ...d,
                telegramAccountId: acc._id,
                telegramAccount: acc,
              })),
            };
          }
        } catch (err) {
          console.warn(`[Inbox] Live fetch note for account ${acc._id}:`, err);
        }
        return { connected: false, chats: [] as any[] };
      });

      const [liveResults, dbRes] = await Promise.all([
        Promise.all(liveChatsPromises),
        api
          .listChats({ scope, q: debouncedQuery || undefined, includeArchived: true })
          .catch(() => ({ chats: [] })),
      ]);

      setConnectedAccounts(liveResults.filter((r) => r.connected).length);
      const finalChats = mergeLiveAndDbChats(
        liveResults.flatMap((r) => r.chats),
        dbRes.chats || []
      );
      setChats(finalChats);
      setSelectedChatId((curr) => {
        if (curr && finalChats.some((c) => c._id === curr || c.externalChatId === curr)) return curr;
        if (isNarrowViewport()) return null;
        return finalChats.length > 0 ? finalChats[0]._id || finalChats[0].externalChatId : null;
      });
      // Refresh server-authoritative repeated-IDs after chats load
      fetchRepeatedIds();
    } catch (err) {
      console.warn('[Inbox] Error loading chats:', err);
    } finally {
      if (showLoading) setLoadingChats(false);
    }
  }, [telegramAccounts, scope, debouncedQuery, fetchRepeatedIds]);

  // Initial mount: load accounts, connect every account's local client, bulk-sync
  // dialog metadata to the DB, and subscribe to live updates per account.
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    let isCancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    // Immediately fetch whatever is already in the DB (fast, no Telegram session needed)
    fetchRepeatedIds();

    // Poll every 30 s so the badge stays current across all agents in the org
    pollTimer = setInterval(() => {
      if (isCancelled) return;
      fetchRepeatedIds();
      // Owner view is pull-based: the server is served via Vercel, which has
      // no long-lived connections, so refresh the org-wide chat list on a
      // poll instead of using a WebSocket.
      if (role === 'owner') {
        api
          .listChats({ scope, includeArchived: true })
          .then((res) => setChats(res.chats || []))
          .catch(() => {});
      }
    }, 30_000);

    (async () => {
      const accounts = await fetchAccounts();
      if (isCancelled) return;

      setLoadingChats(true);
      try {
        // Resolve a device-local MTProto client for each of the user's accounts.
        const liveResults = await Promise.all(
          accounts.map(async (acc) => {
            try {
              const cl = await getLiveClient(acc._id);
              if (!cl || !cl.connected) {
                return { acc, dialogs: [], cl: null as TelegramClient | null };
              }
              const dialogs = await fetchLiveTelegramChats(cl, acc._id, 300);
              return { acc, dialogs, cl };
            } catch (err) {
              console.warn(`[Inbox] Live fetch note for account ${acc._id}:`, err);
              return { acc, dialogs: [], cl: null as TelegramClient | null };
            }
          })
        );
        if (isCancelled) return;

        const missing = liveResults
          .filter((r) => !r.cl || !r.cl.connected)
          .map((r) => r.acc);
        setMissingSessionAccounts(missing);
        if (missing.length > 0) {
          notify(
            `Could not connect to Telegram for ${missing
              .map((a: any) => a.displayName || a.phoneMasked || a._id)
              .join(', ')}. The local session may be missing or expired — please re-link the account.`,
            'error'
          );
        }

        setConnectedAccounts(liveResults.filter((r) => r.cl && r.cl.connected).length);

        // Subscribe to live updates per account. Each update is matched against
        // chats from the SAME account so identical peer ids across accounts
        // never update the wrong conversation.
        for (const { acc, cl } of liveResults) {
          if (!cl || !cl.connected) continue;
          const accountId = String(acc._id);
          const cleanup = subscribeLiveTelegramUpdates(cl, (msg, peerId) => {
            const text = msg.message || (msg.media ? '[Photo]' : '');
            const sentAt = new Date().toISOString();
            const isOut = Boolean(msg.out);

            setChats((prev) => {
              const idx = prev.findIndex((c) => {
                const cAcc = getChatAccountId(c);
                if (cAcc && cAcc !== accountId) return false;
                return c.externalChatId === peerId || c._id === peerId;
              });
              if (idx < 0) return prev;
              const target = prev[idx];
              const updated = {
                ...target,
                lastMessagePreview: text,
                lastMessageAt: sentAt,
                unreadCount: isOut ? 0 : (target.unreadCount || 0) + 1,
              };
              const rest = prev.filter((_, i) => i !== idx);
              return [updated, ...rest];
            });
          });
          cleanups.push(cleanup);
        }

        const dbRes = await api
          .listChats({ scope, includeArchived: true })
          .catch(() => ({ chats: [] }));
        if (isCancelled) return;

        const liveChats = liveResults.flatMap(({ acc, dialogs }) =>
          dialogs.map((d) => ({ ...d, telegramAccountId: acc._id, telegramAccount: acc }))
        );
        const dbChats = dbRes.chats || [];

        // ── BULK STARTUP SYNC ─────────────────────────────────────────────────────
        // Push all live dialog metadata (contact info + archive flag, NO messages)
        // to the server DB in one batched request per account.
        // This ensures every contact exists in MongoDB so the server's
        // /chats/repeated-ids can correctly detect cross-account collisions
        // even on a fresh install or for agents who've never opened a chat.
        // Runs in the background — does NOT block the UI from rendering.
        (async () => {
          const totalChats = liveResults.reduce((n, r) => n + (r.dialogs?.length || 0), 0);
          if (totalChats > 0) setSyncProgress({ done: 0, total: totalChats });
          for (const { acc, dialogs } of liveResults) {
            if (isCancelled || dialogs.length === 0) continue;
            try {
              const items = dialogs.map((d) => ({
                chatExternalId: d.externalChatId,
                contact: {
                  telegramUserId: d.contactId?.telegramUserId,
                  username: d.contactId?.username,
                  phoneNumber: d.contactId?.phoneNumber,
                  avatarUrl: d.contactId?.avatarUrl,
                  displayName: d.contactId?.displayName,
                  savedName: d.contactId?.savedName,
                  firstName: d.contactId?.firstName,
                  lastName: d.contactId?.lastName,
                  isBlocked: d.isBlocked,
                },
                isArchived: d.isArchived,
                messages: [], // contact+chat upsert only; no message payload needed
              }));
              await api.syncBatchMessages({ telegramAccountId: acc._id, items });
              if (!isCancelled) {
                setSyncProgress((p) => (p ? { done: p.done + items.length, total: p.total } : null));
              }
            } catch (syncErr: any) {
              console.warn(`[Inbox] Bulk sync note for ${acc.phoneMasked || acc._id}:`, syncErr.message);
            }
          }
          // After all accounts are synced, re-fetch repeated IDs — now they are accurate
          if (!isCancelled) {
            setSyncProgress(null);
            fetchRepeatedIds();
          }
        })();
        // ── END BULK STARTUP SYNC ─────────────────────────────────────────────────

        const finalChats = mergeLiveAndDbChats(liveChats, dbChats);
        setChats(finalChats);
        setSelectedChatId((curr) => {
          if (curr && finalChats.some((c) => c._id === curr || c.externalChatId === curr)) return curr;
          if (isNarrowViewport()) return null;
          return finalChats.length > 0 ? finalChats[0]._id || finalChats[0].externalChatId : null;
        });
      } catch (err) {
        console.warn('[Inbox] Real-time setup note:', err);
        const res = await api.listChats({ scope, includeArchived: true }).catch(() => ({ chats: [] }));
        if (!isCancelled) setChats(res.chats || []);
      } finally {
        if (!isCancelled) setLoadingChats(false);
      }
    })();

    return () => {
      isCancelled = true;
      if (pollTimer) clearInterval(pollTimer);
      for (const cleanup of cleanups) cleanup();
    };
  }, [role, scope]);

  // Server-authoritative repeated detection: use serverRepeatedIds (fetched from /chats/repeated-ids)
  // The in-memory useMemo is removed — all duplicate detection is DB-driven from the server.
  const repeatedChatIds = serverRepeatedIds;
  const collisionMap = serverCollisionMap;

  // Filter & Search — purely local; server always returns all chats (includeArchived=true)
  const filteredChats = chats.filter((c) => {
    // If an account is selected in the multi-account tab bar, only show chats for that account
    if (selectedAccountId) {
      const cAccId = String(c.telegramAccountId?._id || c.telegramAccountId || '');
      if (cAccId && cAccId !== String(selectedAccountId)) {
        return false;
      }
    }

    // Archived visibility: only show archived in archived filter; hide everywhere else
    if (filter === 'archived' && !c.isArchived) return false;
    if (filter !== 'archived' && c.isArchived) return false;

    if (filter === 'unread' && !(c.unreadCount > 0)) return false;
    if (filter === 'blocked' && !(c.isBlocked || c.contactId?.isBlocked)) return false;

    // Repeated: check server-authoritative set (keyed by both _id and externalChatId)
    if (filter === 'repeated') {
      const isRep =
        repeatedChatIds.has(String(c._id || '')) ||
        repeatedChatIds.has(String(c.externalChatId || ''));
      if (!isRep || c.isArchived) return false;
    }

    // Mine: show only chats belonging to my telegram accounts
    if (filter === 'mine') {
      const myAccIds = new Set(telegramAccounts.map((a: any) => String(a._id)));
      const chatAccId = String(c.telegramAccountId?._id || c.telegramAccountId || '');
      if (!myAccIds.has(chatAccId)) return false;
    }

    if (debouncedQuery.trim()) {
      const q = debouncedQuery.toLowerCase();
      const name = getChatDisplayName(c).toLowerCase();
      const prev = (c.lastMessagePreview || '').toLowerCase();
      const user = (c.contactId?.username || '').toLowerCase();
      const phone = (c.contactId?.phoneNumber || '');
      if (!name.includes(q) && !prev.includes(q) && !user.includes(q) && !phone.includes(q)) {
        return false;
      }
    }
    return true;
  });

  const unreadCount = chats.filter((c) => c.unreadCount > 0 && !c.isArchived).length;

  const handleSelectChat = useCallback((id: string) => {
    setSelectedChatId(id);
    setChats((prev) =>
      prev.map((c) => (c._id === id || c.externalChatId === id ? { ...c, unreadCount: 0 } : c))
    );
  }, []);

  // Load templates
  useEffect(() => {
    api
      .listTemplates()
      .then((res) => setTemplates(res.templates))
      .catch(() => { });
  }, []);

  const selectedChat = chats.find((c) => c._id === selectedChatId || c.externalChatId === selectedChatId);

  async function handleCreateTemplate(e: React.FormEvent) {
    e.preventDefault();
    if (!newTemplateTitle.trim() || !newTemplateBody.trim()) return;
    try {
      const res = await api.createTemplate(newTemplateTitle.trim(), newTemplateBody.trim());
      setTemplates((prev) => [res.template, ...prev]);
      setNewTemplateTitle('');
      setNewTemplateBody('');
      setShowCreateTemplate(false);
      notify('Quick reply saved', 'success');
    } catch (err: any) {
      notify(err.message || 'Failed to create template');
    }
  }

  return (
    <div className={`inbox-container ${selectedChatId ? 'has-active-chat' : ''}`}>
      {/* Telegram Slide-out Navigation Drawer */}
      {drawerOpen && (
        <div className="tg-drawer-backdrop" onClick={() => setDrawerOpen(false)} />
      )}
      <div className={`tg-drawer ${drawerOpen ? 'open' : ''}`}>
        <div className="tg-drawer-header">
          <div className="tg-drawer-user-info">
            <Avatar
              name={telegramAccounts[0]?.displayName || (role === 'owner' ? 'Owner' : 'Agent')}
              id={telegramAccounts[0]?.telegramUserId}
              photoUrl={getCachedAvatar(telegramAccounts[0]?.telegramUserId || telegramAccounts[0]?._id)}
              size={48}
            />
            <div className="tg-drawer-user-meta">
              <div className="tg-drawer-name">
                {telegramAccounts[0]?.displayName || (role === 'owner' ? 'Brokerage Owner' : 'Sales Agent')}
              </div>
              {telegramAccounts[0]?.phoneMasked && (
                <div className="tg-drawer-sub">{telegramAccounts[0].phoneMasked}</div>
              )}
              <span className={`role-badge ${role}`}>{role === 'owner' ? 'Owner' : 'Agent'}</span>
            </div>
          </div>
          <button className="tg-drawer-close" onClick={() => setDrawerOpen(false)} title="Close menu" aria-label="Close navigation menu">
            <CloseIcon size={18} />
          </button>
        </div>

        <div className="tg-drawer-content">
          <div className="tg-drawer-section">
            <div className="tg-drawer-section-title">
              <PhoneIcon size={14} />
              <span>Connected accounts ({telegramAccounts.length})</span>
            </div>
            {telegramAccounts.length === 0 ? (
              <p className="tg-drawer-empty">No Telegram accounts connected.</p>
            ) : (
              <div className="tg-drawer-accounts">
                {telegramAccounts.map((acc) => (
                  <div
                    key={acc._id}
                    className={`tg-drawer-account-item ${selectedAccountId === acc._id ? 'selected' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Select ${acc.displayName || acc.phoneMasked || acc.telegramUserId}`}
                    onClick={() => {
                      setSelectedAccountId(acc._id);
                      setDrawerOpen(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedAccountId(acc._id);
                        setDrawerOpen(false);
                      }
                    }}
                  >
                    <div className="tg-drawer-account-left">
                      <Avatar
                        name={acc.displayName || acc.phoneMasked || acc.telegramUserId}
                        id={acc.telegramUserId}
                        photoUrl={getCachedAvatar(acc.telegramUserId || acc._id)}
                        size={34}
                      />
                      <div className="tg-acc-meta">
                        <div className="tg-acc-name">{acc.displayName || `Account ${acc.phoneMasked || ''}`}</div>
                        <div className="tg-acc-sub">
                          {acc.phoneMasked || 'Telegram'}
                          <span className="tg-acc-id">ID {acc.telegramUserId}</span>
                        </div>
                      </div>
                    </div>
                    <button
                      className="tg-unlink-btn"
                      title="Disconnect account"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleUnlink(acc._id, acc.displayName || acc.phoneMasked || acc.telegramUserId);
                      }}
                    >
                      <TrashIcon size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {onAddTelegram && (
              <button
                className="secondary-btn small-btn full-width drawer-add-account"
                onClick={() => { setDrawerOpen(false); onAddTelegram(); }}
              >
                Add another account
              </button>
            )}
          </div>

          <div className="tg-drawer-section">
            <div className="tg-drawer-section-title">
              <span>Telegram connection</span>
            </div>
            <div className={`tg-drawer-status-card ${connectedAccounts > 0 ? '' : 'is-offline'}`}>
              <div className="tg-drawer-status-row">
                <span className={connectedAccounts > 0 ? 'live-pulse-dot' : 'offline-dot'} />
                <span className="tg-drawer-status-label">
                  {connectedAccounts > 0
                    ? `Live · ${connectedAccounts} account${connectedAccounts === 1 ? '' : 's'} connected`
                    : 'Not connected'}
                </span>
              </div>
              <p>
                {connectedAccounts > 0
                  ? 'Messages update live from your linked Telegram accounts. No manual syncing needed.'
                  : 'Link a Telegram account to send and receive messages live. Until then you are viewing saved history.'}
              </p>
            </div>
          </div>

          {role === 'owner' && (
            <div className="tg-drawer-section">
              <div className="tg-drawer-section-title">
                <BuildingIcon size={14} />
                <span>Chat visibility</span>
              </div>
              <div className="scope-toggle">
                <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>
                  Org-Wide
                </button>
                <button className={scope === 'mine' ? 'active' : ''} onClick={() => setScope('mine')}>
                  My Chats
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {missingSessionAccounts.length > 0 && (
        <div className="error-box session-warning-banner" role="alert">
          <span>
            Could not connect to Telegram for{' '}
            {missingSessionAccounts
              .map((a: any) => a.displayName || a.phoneMasked || a.telegramUserId)
              .join(', ')}
            . The local session may be missing or expired. Please re-link the account.
          </span>
          {onAddTelegram && (
            <button className="secondary-btn small-btn" onClick={onAddTelegram}>
              Re-link
            </button>
          )}
        </div>
      )}
      <aside className="chat-list-panel">
        <div className="chat-list-header">
          <div className="list-title-row">
            <button
              className="tg-hamburger-btn"
              onClick={() => setDrawerOpen(true)}
              title="Open navigation menu"
              aria-label="Open navigation menu"
            >
              <MenuIcon size={18} />
            </button>
            <h1 className="list-title">Inbox</h1>
            <span className="list-count">
              {filteredChats.length} {filteredChats.length === 1 ? 'chat' : 'chats'}
            </span>
            <div
              className={`live-status-pill ${connectedAccounts > 0 ? '' : 'offline'}`}
              title={
                connectedAccounts > 0
                  ? 'Live Telegram connection active'
                  : 'No Telegram account connected — showing saved history'
              }
            >
              <span className={connectedAccounts > 0 ? 'live-pulse-dot' : 'offline-dot'} />
              <span>{connectedAccounts > 0 ? 'Live' : 'Offline'}</span>
            </div>
          </div>

          <div className="tg-search-row">
            <div className="tg-search-input-wrap">
              <SearchIcon size={16} className="tg-search-icon" />
              <input
                className="tg-search-input"
                placeholder="Search conversations"
                aria-label="Search conversations"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {isSearching ? (
                <span className="inline-btn-spinner dark tg-search-spinner" />
              ) : query ? (
                <button className="tg-search-clear" onClick={() => setQuery('')} aria-label="Clear search">
                  <CloseIcon size={13} />
                </button>
              ) : null}
            </div>
          </div>

          {/* Top Banner Counter: Shows how many clients are repeated */}
          {repeatedChatIds.size > 0 && (
            <div
              className={`repeated-top-counter-bar ${filter === 'repeated' ? 'is-active-filter' : ''}`}
              onClick={() => setFilter(filter === 'repeated' ? 'all' : 'repeated')}
              title={filter === 'repeated' ? 'Click to show all chats' : 'Click to view all repeated clients'}
            >
              <div className="repeated-counter-left">
                <RepeatIcon size={14} className="repeated-counter-icon" />
                <span>
                  <strong>
                    {repeatedChatIds.size} {repeatedChatIds.size === 1 ? 'client' : 'clients'} repeated
                  </strong>{' '}
                  across accounts
                </span>
              </div>
              <span className="repeated-counter-action">
                {filter === 'repeated' ? 'Show all' : 'View all'}
              </span>
            </div>
          )}

          {/* Multi-account switcher tabs to toggle or view all connected accounts */}
          {telegramAccounts.length > 1 && (
            <div className="tg-account-tabs">
              <button
                className={`tg-account-pill ${!selectedAccountId ? 'active' : ''}`}
                onClick={() => setSelectedAccountId(null)}
              >
                All Accounts
              </button>
              {telegramAccounts.map((acc) => (
                <button
                  key={acc._id}
                  className={`tg-account-pill ${selectedAccountId === acc._id ? 'active' : ''}`}
                  onClick={() => setSelectedAccountId(acc._id)}
                >
                  {acc.displayName || acc.phoneMasked || 'Account'}
                </button>
              ))}
            </div>
          )}

          <div className="filter-tabs tg-filter-tabs">
            {(['all', 'unread', 'mine', 'repeated', 'blocked', 'archived'] as Filter[]).map((f) => (
              <button
                key={f}
                className={filter === f ? 'active' : ''}
                onClick={() => setFilter(f)}
              >
                {f === 'repeated' ? (
                  <>
                    Repeated
                    {repeatedChatIds.size > 0 && (
                      <span className="filter-pill-badge-count red">{repeatedChatIds.size}</span>
                    )}
                  </>
                ) : f === 'blocked' ? (
                  'Blocked'
                ) : f === 'archived' ? (
                  'Archived'
                ) : (
                  f[0].toUpperCase() + f.slice(1)
                )}
              </button>
            ))}
          </div>
        </div>

        {syncProgress && syncProgress.total > 0 && (
          <div className="sync-progress-bar" role="status" aria-live="polite">
            <span className="sync-progress-text">
              Re-syncing with Telegram… {syncProgress.done}/{syncProgress.total} chats
            </span>
            <div className="sync-progress-track">
              <div
                className="sync-progress-fill"
                style={{ transform: `scaleX(${Math.min(1, syncProgress.done / syncProgress.total)})` }}
              />
            </div>
          </div>
        )}

        <ul className="chat-items">
          {loadingChats ? (
            <ChatSkeletons count={8} />
          ) : filteredChats.length === 0 ? (
            <li className="no-chats-msg">
              <p>
                {query.trim()
                  ? `No conversations match “${query.trim()}”.`
                  : filter === 'all'
                    ? 'No conversations yet.'
                    : 'Nothing in this view.'}
              </p>
            </li>
          ) : (
            filteredChats.map((chat) => {
              const chatId = chat._id || chat.externalChatId;
              return (
                <ChatItem
                  key={chatId}
                  chat={chat}
                  isSelected={chat._id === selectedChatId || chat.externalChatId === selectedChatId}
                  isRepeated={repeatedChatIds.has(chatId)}
                  collisionInfo={collisionMap.get(chatId)}
                  scope={scope}
                  onSelect={handleSelectChat}
                />
              );
            })
          )}
        </ul>
      </aside>

      <main className="thread-view-panel">
        {selectedChatId && selectedChat ? (
          <ChatThread
            key={selectedChatId}
            chat={selectedChat}
            telegramAccounts={telegramAccounts}
            serverRepeatedIds={serverRepeatedIds}
            serverCollisionMap={serverCollisionMap}
            totalRepeatedCount={repeatedChatIds.size}
            role={role}
            templates={templates}
            showTemplates={showTemplates}
            setShowTemplates={setShowTemplates}
            setShowCreateTemplate={setShowCreateTemplate}
            toggleNotes={() => setShowNotes(!showNotes)}
            onToggleArchive={() => handleToggleArchive(selectedChat._id, Boolean(selectedChat.isArchived))}
            onMessageSent={() => loadChats(false)}
            notify={notify}
            onBack={() => setSelectedChatId(null)}
          />
        ) : (
          <div className="thread-empty-wrapper">
            <div className="thread-empty-card">
              <div className="thread-empty-emblem-wrap">
                <div className="thread-empty-emblem">
                  <BrandMark size={26} />
                </div>
              </div>

              <div className={`thread-empty-status-pill ${connectedAccounts > 0 ? '' : 'offline'}`}>
                <span className={connectedAccounts > 0 ? 'live-pulse-dot' : 'offline-dot'} />
                <span>{connectedAccounts > 0 ? 'Live Telegram sync' : 'Viewing saved history'}</span>
              </div>

              <h2 className="thread-empty-title">Select a conversation</h2>
              <p className="thread-empty-subtitle">
                Pick a client or lead to read the thread, answer property requests, and keep the
                dossier up to date.
              </p>

              <div className="thread-empty-hints">
                <div className="thread-empty-hint-chip">
                  <strong>{chats.filter((c) => !c.isArchived).length}</strong>
                  <span>conversations</span>
                </div>
                <div className="thread-empty-hint-chip">
                  <strong>{unreadCount}</strong>
                  <span>unread</span>
                </div>
                <div className="thread-empty-hint-chip">
                  <strong>{repeatedChatIds.size}</strong>
                  <span>repeated clients</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {showNotes && selectedChat && (
        <ContactNotesDrawer
          contactId={selectedChat.contactId?._id}
          contactInfo={selectedChat.contactId}
          onClose={() => setShowNotes(false)}
          notify={notify}
        />
      )}

      {showCreateTemplate && (
        <div className="modal-overlay">
          <div className="modal-card">
            <h3>Create Shared Quick-Reply Template</h3>
            <form onSubmit={handleCreateTemplate}>
              <label>
                Template Title
                <input
                  placeholder="e.g. Schedule Showing"
                  value={newTemplateTitle}
                  onChange={(e) => setNewTemplateTitle(e.target.value)}
                  required
                />
              </label>
              <label>
                Message Body
                <textarea
                  rows={4}
                  placeholder="Hi! Would you like to tour the property this weekend?"
                  value={newTemplateBody}
                  onChange={(e) => setNewTemplateBody(e.target.value)}
                  required
                />
              </label>
              <div className="button-group">
                <button type="submit" className="primary-btn">
                  Save Template
                </button>
                <button type="button" className="secondary-btn" onClick={() => setShowCreateTemplate(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {toast && (
        <div className={`app-toast ${toast.kind}`} role="status">
          <span className="app-toast-icon">
            {toast.kind === 'success' ? <CheckCheckIcon size={15} /> : <AlertTriangleIcon size={15} />}
          </span>
          <span className="app-toast-message">{toast.message}</span>
          <button className="app-toast-close" onClick={() => setToast(null)} aria-label="Dismiss">
            <CloseIcon size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

function ChatThread({
  chat,
  telegramAccounts = [],
  serverRepeatedIds = new Set<string>(),
  serverCollisionMap = new Map<string, string>(),
  totalRepeatedCount,
  role,
  templates,
  showTemplates,
  setShowTemplates,
  setShowCreateTemplate,
  toggleNotes,
  onToggleArchive,
  onMessageSent,
  notify,
  onBack,
}: {
  chat: any;
  telegramAccounts?: any[];
  serverRepeatedIds?: Set<string>;
  serverCollisionMap?: Map<string, string>;
  totalRepeatedCount?: number;
  role: 'agent' | 'owner';
  templates: any[];
  showTemplates: boolean;
  setShowTemplates: (val: boolean) => void;
  setShowCreateTemplate: (val: boolean) => void;
  toggleNotes: () => void;
  onToggleArchive: () => void;
  onMessageSent: () => void;
  notify: (message: string, kind?: 'error' | 'success') => void;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<any[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState<number | undefined>(undefined);
  const [oldestId, setOldestId] = useState<number | undefined>(undefined);
  const draftKey = String(chat.externalChatId || chat._id || '');
  const [draft, setDraftState] = useState(() => draftStore.get(draftKey)?.text ?? '');
  const [sending, setSending] = useState(false);
  const [previewMedia, setPreviewMedia] = useState<string | null>(null);
  const [attachment, setAttachmentState] = useState<DraftAttachment | null>(
    () => draftStore.get(draftKey)?.attachment ?? null
  );

  // Write-through so an unsent draft survives switching to another conversation.
  const setDraft = (text: string) => {
    setDraftState(text);
    const att = draftStore.get(draftKey)?.attachment ?? null;
    if (!text && !att) draftStore.delete(draftKey);
    else draftStore.set(draftKey, { text, attachment: att });
  };
  const setAttachment = (att: DraftAttachment | null) => {
    setAttachmentState(att);
    const text = draftStore.get(draftKey)?.text ?? '';
    if (!text && !att) draftStore.delete(draftKey);
    else draftStore.set(draftKey, { text, attachment: att });
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesAreaRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const shouldScrollToBottomRef = useRef(true);

  // Each conversation must be read/sent through the MTProto client that owns it.
  const chatAccountId = String(chat.telegramAccountId?._id || chat.telegramAccountId || '');
  const [chatClient, setChatClient] = useState<TelegramClient | null>(null);

  // Outgoing messages belong to the viewer only when this chat's account is one
  // of their own linked accounts. Otherwise they were sent by the account owner.
  const isOwnAccount = telegramAccounts.some((a: any) => String(a._id) === chatAccountId);
  const outgoingSenderType: 'agent' | 'owner' =
    role === 'owner' && isOwnAccount ? 'owner' : 'agent';

  useEffect(() => {
    let cancelled = false;
    setChatClient(null);
    if (!chatAccountId) return;
    getLiveClient(chatAccountId)
      .then((client) => {
        if (!cancelled) setChatClient(client && client.connected ? client : null);
      })
      .catch(() => {
        if (!cancelled) setChatClient(null);
      });
    return () => {
      cancelled = true;
    };
  }, [chatAccountId]);

  // Repeated detection is server-authoritative: GET /chats/repeated-ids scans
  // DB chats across accounts and returns a set of repeated chat ids (both _id
  // and externalChatId) plus per-chat collision labels. Reading the server data
  // directly avoids a client-side O(n) scan of every chat per thread.
  const collisionTargets = useMemo(() => {
    if (chat.isArchived) return [];
    const id = String(chat._id || '');
    const info =
      serverCollisionMap.get(id) ??
      (chat.externalChatId ? serverCollisionMap.get(String(chat.externalChatId)) : undefined);
    if (!info) return [];
    return info.split(' & ').map((s) => s.trim()).filter(Boolean);
  }, [serverCollisionMap, chat]);

  // A chat thread shows the repeated-lead banner when the server flags the chat
  // (its contact or chat id appears in 2+ distinct Telegram accounts).
  const isRepeatedLead = Boolean(!chat.isArchived && serverRepeatedIds.has(String(chat._id || chat.externalChatId || '')));

  const fetchMessages = async (isInitial = false) => {
    try {
      if (isInitial) {
        setLoadingMessages(true);
        shouldScrollToBottomRef.current = true;
      }
      let msgs: any[] = [];
      const peer = chat.entity || chat.inputEntity || chat.externalChatId;

      if (chatClient && chatClient.connected && peer) {
        const res = await fetchLiveTelegramMessages(
          chatClient,
          peer,
          { limit: 100 },
          (msgId, dataUrl) => {
            setMessages((prev) =>
              prev.map((m) => (m.telegramMessageId === msgId ? { ...m, mediaRef: dataUrl } : m))
            );
          }
        );
        msgs = res.messages.map((m: any) =>
          m.direction === 'out' ? { ...m, senderType: outgoingSenderType } : m
        );
        setHasMore(res.hasMore);
        setTotalCount(res.total);
        setOldestId(res.oldestId);
      }

      if (!msgs || msgs.length === 0) {
        const res = await api.chatMessages(chat._id).catch(() => ({ messages: [] }));
        msgs = res.messages || [];
        setHasMore(msgs.length >= 100);
        if (msgs.length > 0) setOldestId(new Date(msgs[0].sentAt).getTime());
      }

      setMessages(msgs);
      api.markChatRead(chat._id).catch(() => { });
    } catch (err) {
      console.warn('Error loading messages:', err);
      try {
        const res = await api.chatMessages(chat._id).catch(() => ({ messages: [] }));
        setMessages(res.messages || []);
      } catch { }
    } finally {
      if (isInitial) setLoadingMessages(false);
    }
  };

  const loadOlderMessages = async () => {
    if (loadingMore || !hasMore || !oldestId) return;
    const peer = chat.entity || chat.inputEntity || chat.externalChatId;

    setLoadingMore(true);
    shouldScrollToBottomRef.current = false;
    const prevScrollHeight = messagesAreaRef.current?.scrollHeight || 0;
    const prevScrollTop = messagesAreaRef.current?.scrollTop || 0;

    try {
      // Live Telegram path
      if (chatClient && chatClient.connected && peer) {
        const res = await fetchLiveTelegramMessages(
          chatClient,
          peer,
          { limit: 100, offsetId: oldestId },
          (msgId, dataUrl) => {
            setMessages((prev) =>
              prev.map((m) => (m.telegramMessageId === msgId ? { ...m, mediaRef: dataUrl } : m))
            );
          }
        );

        if (res.messages && res.messages.length > 0) {
          const olderMessages = res.messages.map((m: any) =>
            m.direction === 'out' ? { ...m, senderType: outgoingSenderType } : m
          );
          setMessages((prev) => {
            const existingIds = new Set(prev.map((m) => m.telegramMessageId || m._id));
            const newUnique = olderMessages.filter((m) => !existingIds.has(m.telegramMessageId || m._id));
            return [...newUnique, ...prev];
          });
          setHasMore(res.hasMore);
          if (res.oldestId) setOldestId(res.oldestId);
          if (res.total) setTotalCount(res.total);

          requestAnimationFrame(() => {
            if (messagesAreaRef.current) {
              const newScrollHeight = messagesAreaRef.current.scrollHeight;
              messagesAreaRef.current.scrollTop = newScrollHeight - prevScrollHeight + prevScrollTop;
            }
          });
        } else {
          setHasMore(false);
        }
        return;
      }

      // Server DB path (no live session): paginate by sentAt timestamp
      const res = await api.chatMessages(chat._id, oldestId, 100).catch(() => ({ messages: [] }));
      const older = res.messages || [];
      if (older.length > 0) {
        setMessages((prev) => {
          const existingIds = new Set(prev.map((m) => m.telegramMessageId || m._id));
          const newUnique = older.filter((m) => !existingIds.has(m.telegramMessageId || m._id));
          return [...newUnique, ...prev];
        });
        setHasMore(older.length >= 100);
        if (older.length > 0) setOldestId(new Date(older[0].sentAt).getTime());

        requestAnimationFrame(() => {
          if (messagesAreaRef.current) {
            const newScrollHeight = messagesAreaRef.current.scrollHeight;
            messagesAreaRef.current.scrollTop = newScrollHeight - prevScrollHeight + prevScrollTop;
          }
        });
      } else {
        setHasMore(false);
      }
    } catch (err) {
      console.warn('Error loading older messages:', err);
    } finally {
      setLoadingMore(false);
    }
  };

  const loadEntireHistory = async () => {
    if (loadingAll || !hasMore) return;
    setLoadingAll(true);
    shouldScrollToBottomRef.current = false;
    let currentOldestId = oldestId;
    let keepGoing = true;
    const peer = chat.entity || chat.inputEntity || chat.externalChatId;

    while (keepGoing && currentOldestId && chatClient && chatClient.connected && peer) {
      try {
        const res = await fetchLiveTelegramMessages(
          chatClient,
          peer,
          { limit: 100, offsetId: currentOldestId },
          (msgId, dataUrl) => {
            setMessages((prev) =>
              prev.map((m) => (m.telegramMessageId === msgId ? { ...m, mediaRef: dataUrl } : m))
            );
          }
        );

        if (res.messages && res.messages.length > 0) {
          const olderMessages = res.messages.map((m: any) =>
            m.direction === 'out' ? { ...m, senderType: outgoingSenderType } : m
          );
          setMessages((prev) => {
            const existingIds = new Set(prev.map((m) => m.telegramMessageId || m._id));
            const newUnique = olderMessages.filter((m) => !existingIds.has(m.telegramMessageId || m._id));
            return [...newUnique, ...prev];
          });
          currentOldestId = res.oldestId;
          keepGoing = res.hasMore;
          if (res.oldestId) setOldestId(res.oldestId);
        } else {
          keepGoing = false;
        }
      } catch {
        keepGoing = false;
      }
    }
    setHasMore(false);
    setLoadingAll(false);
  };

  useEffect(() => {
    fetchMessages(true);

    // Live real-time incoming messages directly appended to this thread
    let cleanup: (() => void) | undefined;
    if (chatClient && chatClient.connected) {
      cleanup = subscribeLiveTelegramUpdates(chatClient, (msg, peerId) => {
        if (peerId === chat.externalChatId || peerId === String(chat.entity?.id)) {
          const msgId = String(msg.id);
          const liveMsg: LiveMessage = {
            _id: msgId,
            telegramMessageId: msgId,
            direction: msg.out ? 'out' : 'in',
            senderType: msg.out ? outgoingSenderType : 'contact',
            text: msg.message || '',
            sentAt: new Date((msg.date || Date.now() / 1000) * 1000).toISOString(),
            rawMedia: msg.media,
          };
          setMessages((prev) => {
            // The optimistic copy appended after sending arrives here too.
            if (prev.some((m) => String(m.telegramMessageId) === msgId)) return prev;
            return [...prev, liveMsg];
          });
          // Mirror to the server so the owner's poll-based view sees it too.
          mirrorLiveChatToCRM(chatAccountId, chat, [liveMsg]).catch(() => {});
        }
      });
    }

    return () => {
      if (cleanup) cleanup();
    };
  }, [chat._id, chat.externalChatId, chatClient, outgoingSenderType]);

  // Lazy-load older messages when the top sentinel scrolls into view.
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const area = messagesAreaRef.current;
    if (!sentinel || !area) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          loadOlderMessages();
        }
      },
      { root: area, rootMargin: '200px 0px 0px 0px', threshold: 0 }
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [hasMore, messages.length, loadingMore]);

  useEffect(() => {
    if (shouldScrollToBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length]);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setAttachment({ file, dataUrl: reader.result });
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  async function handleSend() {
    if ((!draft.trim() && !attachment) || sending) return;
    const textToSend = draft.trim();
    const mediaToSend = attachment?.dataUrl;
    setSending(true);

    try {
      const peer = chat.entity || chat.inputEntity || chat.externalChatId;

      if (chatClient && chatClient.connected && peer && textToSend) {
        // Send directly through Telegram MTProto in real time, from the account
        // that actually owns this conversation.
        const sent = await sendLiveTelegramMessage(chatClient, peer, textToSend);
        const outgoing: LiveMessage = {
          ...sent,
          senderType: outgoingSenderType,
        };
        setMessages((prev) => {
          if (prev.some((m) => String(m.telegramMessageId) === String(outgoing.telegramMessageId))) {
            return prev;
          }
          return [...prev, outgoing];
        });
        mirrorLiveChatToCRM(chatAccountId, chat, [outgoing]).catch(() => { });
      } else if (role === 'owner') {
        const msgId = String(Date.now());
        await api.recordOwnerReply(chat._id, textToSend || (mediaToSend ? '[Photo]' : ''), msgId, mediaToSend);
        await fetchMessages();
      } else {
        const msgId = String(Date.now());
        await api.syncMessages({
          telegramAccountId: chatAccountId,
          chatExternalId: chat.externalChatId,
          contact: {
            telegramUserId: chat.contactId?.telegramUserId,
            username: chat.contactId?.username,
            phoneNumber: chat.contactId?.phoneNumber,
          },
          messages: [
            {
              telegramMessageId: msgId,
              direction: 'out',
              senderType: 'agent',
              text: textToSend,
              mediaRef: mediaToSend,
              sentAt: new Date().toISOString(),
            },
          ],
        });
        await fetchMessages();
      }

      setDraft('');
      setAttachment(null);
      onMessageSent();
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      if (errMsg.includes('USER_IS_BLOCKED') || errMsg.includes('YOU_BLOCKED_USER')) {
        notify('This contact has blocked you (or is blocked). The chat is now flagged.');
        chat.isBlocked = true;
        api.toggleBlockChat(chat._id, true).catch(() => { });
        onMessageSent();
      } else {
        notify(err.message || 'Failed to send message');
      }
    } finally {
      setSending(false);
    }
  }

  const contactName = getChatDisplayName(chat);
  const isBlocked = Boolean(chat.isBlocked || chat.contactId?.isBlocked);

  return (
    <div className={`chat-thread-wrapper ${isBlocked ? 'is-blocked-thread' : ''}`}>
      <div className="thread-header">
        <button
          type="button"
          className="thread-back-btn"
          onClick={onBack}
          title="Back to conversations"
          aria-label="Back to conversations"
        >
          <ChevronLeftIcon size={20} />
        </button>
        <div className="thread-contact-info">
          <Avatar
            name={contactName}
            id={chat.externalChatId || chat.contactId?.telegramUserId}
            photoUrl={chat.contactId?.avatarUrl || getCachedAvatar(chat.externalChatId || chat.contactId?.telegramUserId)}
            size={42}
          />
          <div className="thread-contact-meta">
            <div className="thread-title-row">
              <h3 className="thread-contact-title">{contactName}</h3>
              {isRepeatedLead && (
                <RepeatedIndicator collisionInfo={collisionTargets.join(' & ')} size="md" />
              )}
              {isBlocked && (
                <span className="blocked-badge" title="Blocked Contact">
                  Blocked
                </span>
              )}
              {chat.isArchived && (
                <span className="archived-badge">
                  <ArchiveIcon size={11} style={{ marginRight: '3px' }} />
                  Archived
                </span>
              )}
            </div>
            <div className="thread-contact-sub">
              {chat.agentId?.displayName && (
                <span className="agent-badge">Assigned: {chat.agentId.displayName}</span>
              )}
              {chat.contactId?.username && (
                <span className="thread-username-sub">@{chat.contactId.username.replace(/^@/, '')}</span>
              )}
              {chat.contactId?.phoneNumber && (
                <span className="thread-phone-sub">{chat.contactId.phoneNumber}</span>
              )}
            </div>
          </div>
        </div>
        <div className="thread-header-actions">
          <button
            className={`secondary-btn small-btn ${isBlocked ? 'unblock-action-btn' : 'block-action-btn'}`}
            onClick={async () => {
              if (!isBlocked) {
                const ok = window.confirm(
                  `Block ${contactName}? They will not be able to message you, and this chat will be flagged.`
                );
                if (!ok) return;
              }
              try {
                await api.toggleBlockChat(chat._id, !isBlocked);
                chat.isBlocked = !isBlocked;
                notify(isBlocked ? 'Contact unblocked' : 'Contact blocked', 'success');
                onMessageSent();
              } catch (err: any) {
                notify(err.message || 'Failed to toggle block');
              }
            }}
          >
            {isBlocked ? 'Unblock' : 'Block'}
          </button>
          <button
            className="secondary-btn small-btn"
            onClick={onToggleArchive}
            title={chat.isArchived ? 'Move to active chats' : 'Archive this conversation'}
          >
            {chat.isArchived ? <UnarchiveIcon size={13} /> : <ArchiveIcon size={13} />}
            <span className="btn-label">{chat.isArchived ? 'Unarchive' : 'Archive'}</span>
          </button>
          <button className="secondary-btn small-btn" onClick={toggleNotes} title="Open lead notes">
            <NotesIcon size={13} />
            <span className="btn-label">Notes</span>
          </button>
        </div>
      </div>

      {isBlocked && (
        <div className="blocked-chat-alert-banner">
          <span className="blocked-alert-icon">
            <AlertTriangleIcon size={16} />
          </span>
          <div className="blocked-alert-content">
            <strong>Blocked Contact</strong>
            <span>Messages cannot be exchanged while blocked. Click "Unblock" above if you wish to resume chatting.</span>
          </div>
        </div>
      )}

      {isRepeatedLead && (
        <div className="repeated-thread-bar">
          <div className="repeated-thread-bar-content">
            <RepeatIcon size={14} className="repeated-bar-icon" />
            <span className="repeated-bar-text">
              <strong>Repeated Lead:</strong> Also active in{' '}
              <span className="repeated-bar-targets">
                {collisionTargets.join(' • ')}
              </span>
            </span>
          </div>
          <span className="repeated-bar-hint">Coordinate replies internally</span>
        </div>
      )}

      {previewMedia && (
        <div className="media-preview-overlay" onClick={() => setPreviewMedia(null)}>
          <div className="media-preview-dialog" onClick={(e) => e.stopPropagation()}>
            <button className="media-preview-close" onClick={() => setPreviewMedia(null)} aria-label="Close media preview">
              <CloseIcon size={20} />
            </button>
            <img src={previewMedia} alt="Preview" className="media-preview-img-full" />
          </div>
        </div>
      )}

      <div className="messages-area" ref={messagesAreaRef} aria-live="polite" aria-atomic="false">
        {hasMore && <div ref={topSentinelRef} className="lazy-sentinel" aria-hidden="true" />}
        {hasMore && (
          <div className="load-older-banner">
            <button
              type="button"
              className="load-older-btn"
              onClick={loadOlderMessages}
              disabled={loadingMore || loadingAll}
            >
              {loadingMore ? (
                <>
                  <span className="inline-btn-spinner" /> Loading earlier messages…
                </>
              ) : (
                `Load earlier messages (${totalCount ? `${messages.length} of ${totalCount}` : `${messages.length} loaded`})`
              )}
            </button>
            <button
              type="button"
              className="load-all-btn"
              onClick={loadEntireHistory}
              disabled={loadingMore || loadingAll}
              title="Load complete conversation history from the very beginning"
            >
              {loadingAll ? 'Loading entire chat…' : 'Load entire chat'}
            </button>
          </div>
        )}

        {!hasMore && messages.length > 0 && (
          <div className="chat-beginning-indicator">
            <span>Beginning of conversation ({messages.length} messages)</span>
          </div>
        )}

        {loadingMessages ? (
          <MessageSkeletons />
        ) : messages.length === 0 ? (
          <div className="no-messages-placeholder">No messages in this chat yet. Start the conversation below.</div>
        ) : (
          messages.map((m) => (
            <div key={m._id || m.telegramMessageId} className={`message-bubble ${m.direction}`}>
              {m.mediaRef ? (
                <div className="bubble-media-wrapper" onClick={() => setPreviewMedia(m.mediaRef)}>
                  <img
                    src={m.mediaRef}
                    alt="Photo"
                    className="bubble-media-img"
                    loading="lazy"
                    onError={(e) => {
                      (e.target as HTMLElement).style.display = 'none';
                    }}
                  />
                </div>
              ) : (m.text === '[Media]' || m.text === '[Photo]' || m.text?.startsWith('[Photo')) ? (
                <div className="bubble-media-placeholder">
                  <div className="placeholder-icon-wrap">
                    <PhotoIcon size={20} className="placeholder-icon" />
                  </div>
                  <span>Photo</span>
                </div>
              ) : null}
              {m.text && m.text !== '[Media]' && m.text !== '[Photo]' && !m.text.startsWith('[Photo') && (
                <p className="bubble-text">{m.text}</p>
              )}
              <div className="bubble-footer">
                <span className="msg-time">
                  {new Date(m.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                {m.direction === 'out' && (
                  <CheckCheckIcon size={14} className="msg-check" />
                )}
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="composer-wrapper">
        {attachment && (
          <div className="composer-attachment-preview">
            <img src={attachment.dataUrl} className="composer-attachment-thumb" alt="Attachment" />
            <div className="composer-attachment-info">
              <span className="composer-attachment-name">{attachment.file.name}</span>
              <span style={{ fontSize: '11px', color: '#64748b' }}>Ready to send photo</span>
            </div>
            <button
              type="button"
              className="composer-attachment-remove"
              onClick={() => setAttachment(null)}
              title="Remove attachment"
            >
              <CloseIcon size={15} />
            </button>
          </div>
        )}

        {showTemplates && (
          <div className="templates-popup">
            <div className="templates-popup-header">
              <span>Quick Replies</span>
              <button
                type="button"
                className="text-btn"
                onClick={() => {
                  setShowTemplates(false);
                  setShowCreateTemplate(true);
                }}
              >
                + New Template
              </button>
            </div>
            <div className="templates-list">
              {templates.length === 0 ? (
                <p className="empty-templates-hint">No saved templates yet.</p>
              ) : (
                templates.map((tpl) => (
                  <button
                    key={tpl._id}
                    type="button"
                    className="template-item-btn"
                    onClick={() => {
                      setDraft(tpl.body);
                      setShowTemplates(false);
                    }}
                  >
                    <strong>{tpl.title}</strong>
                    <span>{tpl.body.slice(0, 50)}…</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        <div className="composer-row">
          <input
            type="file"
            ref={fileInputRef}
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />
          <button
            type="button"
            className="composer-attach-btn"
            title="Attach photo"
            onClick={() => fileInputRef.current?.click()}
          >
            <PaperclipIcon size={18} />
          </button>
          <button
            type="button"
            className="secondary-btn template-toggle-btn"
            title="Insert quick reply template"
            onClick={() => setShowTemplates(!showTemplates)}
          >
            <LightningIcon size={14} style={{ marginRight: '4px' }} />
            Template
          </button>
          <input
            className="message-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
            aria-label="Type a message"
            placeholder={role === 'owner' ? "Reply as Owner (stepped in)…" : "Type a message…"}
            disabled={sending}
          />
          <button
            type="button"
            className="primary-btn send-btn"
            onClick={handleSend}
            disabled={sending || (!draft.trim() && !attachment)}
          >
            {sending ? (
              <span className="inline-btn-spinner" />
            ) : (
              <SendIcon size={15} />
            )}
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
