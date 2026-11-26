const express = require('express');
const mongoose = require('mongoose');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const Contact = require('../models/Contact');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function buildChatQuery(id, orgId) {
  if (mongoose.Types.ObjectId.isValid(id)) {
    return {
      $or: [
        { _id: new mongoose.Types.ObjectId(id), orgId },
        { externalChatId: String(id), orgId },
      ],
    };
  }
  return { externalChatId: String(id), orgId };
}

/**
 * GET /chats/repeated-ids
 * Returns all chat IDs (both _id and externalChatId) that belong to contacts
 * seen across 2+ DISTINCT Telegram accounts within the same org.
 * Uses only server-stored DB data — no live Telegram session needed.
 * Archived chats are EXCLUDED from collision detection.
 */
router.get('/repeated-ids', async (req, res) => {
  const orgOid = new mongoose.Types.ObjectId(req.auth.orgId);

  // Load all ACTIVE (non-archived) chats for this org, with contact identifiers
  const activeChats = await Chat.find({ orgId: orgOid, isArchived: { $ne: true } })
    .select('_id externalChatId contactId telegramAccountId agentId')
    .populate('contactId', 'telegramUserId phoneNumber username _id')
    .populate('telegramAccountId', '_id displayName phoneMasked username telegramUserId')
    .lean();

  // Map: contactKey -> Set of distinct telegramAccountId strings
  const keyToAccounts = new Map(); // key -> Set<accId>
  // Map: contactKey -> Set of chat DB IDs
  const keyToChats = new Map(); // key -> [{_id, externalChatId, telegramAccountId}]

  // Repeats are keyed ONLY by the Telegram-unique contact id (telegramUserId).
  // Name, username, phone and chat-id keys are intentionally excluded so a
  // repeat requires the same Telegram account id in 2+ accounts.
  const getKeys = (c) =>
    c.contactId?.telegramUserId ? [`tg:${String(c.contactId.telegramUserId).trim()}`] : [];

  for (const c of activeChats) {
    const accId = String(c.telegramAccountId?._id || c.telegramAccountId || '');
    if (!accId) continue;
    const keys = getKeys(c);
    for (const k of keys) {
      if (!keyToAccounts.has(k)) keyToAccounts.set(k, new Set());
      keyToAccounts.get(k).add(accId);
      if (!keyToChats.has(k)) keyToChats.set(k, []);
      keyToChats.get(k).push(c);
    }
  }

  // Build the result: chatId -> collisionText (account labels)
  const repeatedChatIds = new Set();
  const collisionMap = {}; // chatId (string) -> collision description

  // Find the populated account object for an account id among the chats that
  // share a key (every chat on a key points at the same account id set).
  const findAccountObj = (key, accId) => {
    for (const s of keyToChats.get(key) || []) {
      if (String(s.telegramAccountId?._id || s.telegramAccountId) === accId) {
        return s.telegramAccountId;
      }
    }
    return null;
  };

  // Precompute each account label once per key. Deriving labels per repeated
  // chat would scan keyToChats again for every account of every repeated chat
  // (O(n^2)); precomputing keeps the whole build O(keys).
  const keyLabels = new Map(); // key -> string[] (one label per distinct account, deduped)
  for (const [k, accSet] of keyToAccounts) {
    if (accSet.size < 2) continue; // only keys spanning 2+ accounts matter
    const labels = [];
    for (const accId of accSet) {
      const accObj = findAccountObj(k, accId);
      if (accObj && typeof accObj === 'object') {
        const phone = accObj.phoneMasked || '';
        const user = accObj.username ? `@${String(accObj.username).replace(/^@/, '')}` : '';
        // Show the full Telegram username when the account has one; fall back
        // to the phone mask (or display name) only when there is no username.
        const label = user || phone || accObj.displayName || `Account ${accId.slice(-4)}`;
        if (label && !labels.includes(label)) labels.push(label);
      } else {
        const label = `Account …${accId.slice(-4)}`;
        if (!labels.includes(label)) labels.push(label);
      }
    }
    keyLabels.set(k, labels);
  }

  for (const c of activeChats) {
    const keys = getKeys(c);
    // Repeated when any of its keys spans 2+ distinct accounts
    const isRepeated = keys.some((k) => (keyToAccounts.get(k)?.size || 0) >= 2);
    if (!isRepeated) continue;

    // Collect the deduped account labels from every repeated key
    const accountLabels = [];
    for (const k of keys) {
      for (const label of keyLabels.get(k) || []) {
        if (!accountLabels.includes(label)) accountLabels.push(label);
      }
    }

    const colText = accountLabels.length >= 2 ? accountLabels.join(' & ') : 'Multiple accounts';
    const chatIdStr = String(c._id);
    const extStr = String(c.externalChatId || '');

    repeatedChatIds.add(chatIdStr);
    if (extStr) repeatedChatIds.add(extStr);
    collisionMap[chatIdStr] = colText;
    if (extStr) collisionMap[extStr] = colText;
  }

  // Number of distinct repeated clients (contacts spanning 2+ accounts),
  // NOT the number of chat threads/ids. Used for the UI counters so a
  // client appearing in N chats still counts as a single repeated client.
  const repeatedClientCount = Array.from(keyToAccounts.values()).filter((s) => s.size >= 2).length;

  return res.json({
    repeatedChatIds: Array.from(repeatedChatIds),
    collisionMap,
    repeatedCount: repeatedClientCount,
  });
});

router.get('/', async (req, res) => {
  const { scope = 'mine', filter = 'all', q } = req.query;

  if (scope === 'all' && req.auth.role !== 'owner') {
    return res.status(403).json({ error: 'Only owner role may request scope=all' });
  }

  const subId = new mongoose.Types.ObjectId(req.auth.sub);
  const orgOid = new mongoose.Types.ObjectId(req.auth.orgId);
  const query = { orgId: orgOid };

  if (filter === 'archived') {
    query.isArchived = true;
  } else if (req.query.includeArchived === 'true') {
    // Return all chats so client has full state of both active and archived
  } else {
    query.isArchived = { $ne: true };
  }

  if (scope === 'mine') {
    const TelegramAccount = require('../models/TelegramAccount');
    const myAccounts = await TelegramAccount.find({ orgId: orgOid, ownerRefId: subId }).select('_id');
    const myAccountIds = myAccounts.map((a) => a._id);
    query.$or = [{ agentId: subId }, { telegramAccountId: { $in: myAccountIds } }];
  }

  let chats = await Chat.find(query)
    .sort({ lastMessageAt: -1 })
    .limit(1000)
    .populate({
      path: 'contactId',
      populate: [
        { path: 'linkedAgents', select: 'displayName username' },
        { path: 'linkedAccounts', select: 'displayName phoneMasked ownerRefId ownerType username telegramUserId' },
      ],
    })
    .populate('agentId', 'displayName username role')
    .populate('telegramAccountId', 'displayName phoneMasked ownerRefId ownerType username telegramUserId');

  if (filter === 'unread') {
    chats = chats.filter((c) => (c.unreadCount || 0) > 0);
  } else if (filter === 'repeated') {
    // Load all active chats in org to build collision map across accounts
    const activeChats = await Chat.find({ orgId: orgOid, isArchived: { $ne: true } })
      .select('_id externalChatId contactId telegramAccountId')
      .populate('contactId', 'telegramUserId phoneNumber username _id')
      .lean();

    // Map: identity key -> set of distinct telegramAccountIds.
    // Repeats are keyed ONLY by the Telegram-unique contact id — not names,
    // usernames, phones or chat ids.
    const keyToAccounts = new Map();
    for (const ac of activeChats) {
      const accId = String(ac.telegramAccountId || '');
      if (!accId) continue;
      const keys = [ac.contactId?.telegramUserId ? `tg:${String(ac.contactId.telegramUserId).trim()}` : null].filter(Boolean);
      for (const k of keys) {
        if (!keyToAccounts.has(k)) keyToAccounts.set(k, new Set());
        keyToAccounts.get(k).add(accId);
      }
    }

    chats = chats.filter((c) => {
      if (c.isArchived) return false;
      const keys = [c.contactId?.telegramUserId ? `tg:${String(c.contactId.telegramUserId).trim()}` : null].filter(Boolean);
      for (const k of keys) {
        const accSet = keyToAccounts.get(k);
        if (accSet && accSet.size >= 2) return true;
      }
      return false;
    });
  } else if (filter === 'blocked') {
    chats = chats.filter((c) => c.isBlocked || c.contactId?.isBlocked);
  } else if (filter === 'mine') {
    // scope=mine already filtered by query; this is a belt-and-suspenders local pass
    // (no extra local filtering needed — scope handles it)
  }

  if (q && q !== 'undefined') {
    const needle = q.toLowerCase();
    chats = chats.filter(
      (c) =>
        c.lastMessagePreview?.toLowerCase().includes(needle) ||
        c.title?.toLowerCase().includes(needle) ||
        c.contactId?.displayName?.toLowerCase().includes(needle) ||
        c.contactId?.savedName?.toLowerCase().includes(needle) ||
        c.contactId?.firstName?.toLowerCase().includes(needle) ||
        c.contactId?.lastName?.toLowerCase().includes(needle) ||
        c.contactId?.username?.toLowerCase().includes(needle) ||
        c.contactId?.phoneNumber?.includes(needle)
    );
  }

  return res.json({ chats });
});

router.patch('/:id/archive', async (req, res) => {
  const { isArchived } = req.body || {};
  const chat = await Chat.findOne(buildChatQuery(req.params.id, req.auth.orgId));
  if (!chat) return res.status(404).json({ error: 'Not found' });

  chat.isArchived = isArchived !== undefined ? Boolean(isArchived) : !chat.isArchived;
  await chat.save();

  // Re-evaluate duplicate status for the contact based strictly on ACTIVE (non-archived) chats
  if (chat.contactId) {
    const activeChats = await Chat.find({
      orgId: req.auth.orgId,
      contactId: chat.contactId,
      isArchived: { $ne: true },
    }).select('telegramAccountId agentId');

    const activeAccIds = new Set(activeChats.map((c) => String(c.telegramAccountId || '')).filter(Boolean));
    const activeAgentIds = new Set(activeChats.map((c) => String(c.agentId || '')).filter(Boolean));

    const isDup = activeAccIds.size > 1 || activeAgentIds.size > 1;
    const Contact = require('../models/Contact');
    await Contact.updateOne({ _id: chat.contactId }, { duplicateFlag: isDup });
  }

  return res.json({ ok: true, isArchived: chat.isArchived, chat });
});

router.patch('/:id/block', async (req, res) => {
  const { isBlocked } = req.body || {};
  const chat = await Chat.findOne(buildChatQuery(req.params.id, req.auth.orgId)).populate('contactId');
  if (!chat) return res.status(404).json({ error: 'Not found' });

  chat.isBlocked = isBlocked !== undefined ? Boolean(isBlocked) : !chat.isBlocked;
  await chat.save();

  if (chat.contactId) {
    chat.contactId.isBlocked = chat.isBlocked;
    await chat.contactId.save();
  }

  return res.json({ ok: true, isBlocked: chat.isBlocked, chat });
});

router.get('/:id/messages', async (req, res) => {
  const chat = await Chat.findOne(buildChatQuery(req.params.id, req.auth.orgId));
  if (!chat) return res.status(404).json({ error: 'Not found' });

  if (req.auth.role === 'agent') {
    const isDirectAgent = String(chat.agentId) === String(req.auth.sub);
    const TelegramAccount = require('../models/TelegramAccount');
    const myAccount = await TelegramAccount.findOne({ _id: chat.telegramAccountId, ownerRefId: req.auth.sub });
    if (!isDirectAgent && !myAccount) {
      return res.status(403).json({ error: 'Not your chat' });
    }
  }

  const { before, limit = 100 } = req.query;
  const query = { chatId: chat._id };
  if (before) query.sentAt = { $lt: new Date(Number(before)) };

  const messages = await Message.find(query)
    .sort({ sentAt: -1 })
    .limit(Math.min(Number(limit) || 100, 300));

  return res.json({ messages: messages.reverse() });
});

router.post('/:id/owner-reply', async (req, res) => {
  if (req.auth.role !== 'owner') {
    return res.status(403).json({ error: 'Only owner role may use this endpoint' });
  }
  const { text, mediaRef, telegramMessageId, sentAt } = req.body || {};
  if ((!text && !mediaRef) || !telegramMessageId) {
    return res.status(400).json({ error: 'text or mediaRef, and telegramMessageId are required' });
  }

  const chat = await Chat.findOne(buildChatQuery(req.params.id, req.auth.orgId));
  if (!chat) return res.status(404).json({ error: 'Not found' });

  // This endpoint only RECORDS that the owner's client already sent the
  // message via the owner's own linked Telegram account. The server never
  // sends Telegram messages itself and never touches an agent's session.
  // See docs/BUILD_SPEC.md §2 and §6.
  const message = await Message.create({
    chatId: chat._id,
    orgId: req.auth.orgId,
    direction: 'out',
    senderType: 'owner',
    senderId: req.auth.sub,
    text: text || '',
    mediaRef: mediaRef || undefined,
    telegramMessageId: String(telegramMessageId),
    sentAt: sentAt ? new Date(sentAt) : new Date(),
  });

  chat.lastMessageAt = message.sentAt;
  chat.lastMessagePreview = (text || (mediaRef ? '[Photo]' : '')).slice(0, 140);
  await chat.save();

  return res.status(201).json({ message });
});

module.exports = router;
