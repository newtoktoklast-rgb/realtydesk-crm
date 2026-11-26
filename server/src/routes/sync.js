const express = require('express');
const mongoose = require('mongoose');
const TelegramAccount = require('../models/TelegramAccount');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const { requireAuth } = require('../middleware/auth');
const { upsertContactAndDetectDuplicate } = require('../services/duplicateDetection');

const router = express.Router();
router.use(requireAuth);

function resolveMessageSender(message, auth) {
  const requested = ['contact', 'agent', 'owner'].includes(message.senderType)
    ? message.senderType
    : 'contact';

  // An agent may never attribute a synced message to the owner.
  const senderType = requested === 'owner' && auth.role !== 'owner' ? 'agent' : requested;
  const senderId = senderType === 'agent' || senderType === 'owner' ? auth.sub : message.senderId;
  return { senderType, senderId };
}

/**
 * One-way sync push from a client that has already sent/received messages
 * via its own local MTProto session. The server only ever receives message
 * content/metadata here — never credentials. See docs/BUILD_SPEC.md §6.
 *
 * Body shape:
 * {
 *   telegramAccountId,
 *   chatExternalId,
 *   contact: { telegramUserId, username, phoneNumber },
 *   messages: [{ telegramMessageId, direction, senderType, text, mediaRef, sentAt }]
 * }
 */
router.post('/messages', async (req, res) => {
  const { telegramAccountId, chatExternalId, contact, isArchived, messages } = req.body || {};

  if (!telegramAccountId || !chatExternalId || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'telegramAccountId, chatExternalId, messages[] are required' });
  }

  const account = await TelegramAccount.findOne({ _id: telegramAccountId, orgId: req.auth.orgId });
  if (!account) return res.status(404).json({ error: 'Unknown telegramAccountId for this org' });
  if (String(account.ownerRefId) !== String(req.auth.sub)) {
    return res.status(403).json({ error: 'telegramAccountId does not belong to the authenticated user' });
  }

  const agentId = req.auth.sub;

  const { contact: contactDoc, duplicate, otherAgents } = await upsertContactAndDetectDuplicate({
    orgId: req.auth.orgId,
    agentId,
    telegramAccountId,
    telegramUserId: contact?.telegramUserId,
    username: contact?.username,
    phoneNumber: contact?.phoneNumber,
    avatarUrl: contact?.avatarUrl,
    displayName: contact?.displayName,
    savedName: contact?.savedName,
    firstName: contact?.firstName,
    lastName: contact?.lastName,
    isBlocked: contact?.isBlocked,
  });

  let chat = await Chat.findOne({
    orgId: req.auth.orgId,
    telegramAccountId,
    externalChatId: chatExternalId,
  });

  if (!chat) {
    chat = await Chat.create({
      orgId: req.auth.orgId,
      telegramAccountId,
      contactId: contactDoc._id,
      agentId,
      externalChatId: chatExternalId,
      title: contact?.displayName || contact?.savedName || undefined,
      isArchived: Boolean(isArchived),
      isBlocked: Boolean(contact?.isBlocked),
    });
  } else {
    if (isArchived !== undefined) chat.isArchived = Boolean(isArchived);
    if (contact?.isBlocked !== undefined) chat.isBlocked = Boolean(contact.isBlocked);
    if (contact?.displayName || contact?.savedName) {
      chat.title = contact.displayName || contact.savedName;
    }
  }

  let lastMessageAt = chat.lastMessageAt;
  let lastMessagePreview = chat.lastMessagePreview;
  let unreadIncrement = 0;

  const messageOps = [];
  for (const m of messages) {
    if (!m.telegramMessageId || !m.sentAt) continue;
    const { senderType, senderId } = resolveMessageSender(m, req.auth);
    const sentAt = new Date(m.sentAt);
    if (!lastMessageAt || sentAt > lastMessageAt) {
      lastMessageAt = sentAt;
      lastMessagePreview = (m.text || '').slice(0, 140);
    }
    if (m.direction !== 'out') unreadIncrement += 1;

    messageOps.push({
      updateOne: {
        filter: { chatId: chat._id, telegramMessageId: String(m.telegramMessageId) },
        update: {
          $setOnInsert: {
            chatId: chat._id,
            orgId: req.auth.orgId,
            direction: m.direction === 'out' ? 'out' : 'in',
            senderType,
            senderId,
            telegramMessageId: String(m.telegramMessageId),
            sentAt,
          },
          $set: {
            ...(m.text !== undefined ? { text: m.text } : {}),
            ...(m.mediaRef ? { mediaRef: m.mediaRef } : {}),
          },
        },
        upsert: true,
      },
    });
  }

  if (messageOps.length > 0) {
    try {
      await Message.bulkWrite(messageOps, { ordered: false });
    } catch (bulkErr) {
      console.warn('[sync] message bulkWrite notice:', bulkErr.message);
    }
  }

  chat.lastMessageAt = lastMessageAt;
  chat.lastMessagePreview = lastMessagePreview;
  chat.unreadCount = (chat.unreadCount || 0) + unreadIncrement;
  if (
    !chat.isArchived &&
    (/(?:https?:\/\/)?t\.me\//i.test(lastMessagePreview || '') ||
      messages.some((m) => /(?:https?:\/\/)?t\.me\//i.test(m.text || '')))
  ) {
    chat.isTransferred = true;
  }
  await chat.save();

  account.lastSyncAt = new Date();
  await account.save();

  return res.json({
    chatId: chat._id,
    contactId: contactDoc._id,
    duplicate,
    otherAgents,
  });
});

/**
 * Batch sync endpoint: syncs multiple chats and their messages in one fast request.
 */
router.post('/batch-messages', async (req, res) => {
  const { telegramAccountId, items } = req.body || {};
  if (!telegramAccountId || !Array.isArray(items)) {
    return res.status(400).json({ error: 'telegramAccountId and items[] are required' });
  }

  const account = await TelegramAccount.findOne({ _id: telegramAccountId, orgId: req.auth.orgId });
  if (!account) return res.status(404).json({ error: 'Unknown telegramAccountId for this org' });
  if (String(account.ownerRefId) !== String(req.auth.sub)) {
    return res.status(403).json({ error: 'telegramAccountId does not belong to the authenticated user' });
  }

  const agentId = req.auth.sub;
  let chatsSynced = 0;

  for (const item of items) {
    const { chatExternalId, contact, isArchived, messages = [] } = item;
    if (!chatExternalId) continue;

    try {
      const { contact: contactDoc } = await upsertContactAndDetectDuplicate({
        orgId: req.auth.orgId,
        agentId,
        telegramAccountId,
        telegramUserId: contact?.telegramUserId,
        username: contact?.username,
        phoneNumber: contact?.phoneNumber,
        avatarUrl: contact?.avatarUrl,
        displayName: contact?.displayName,
        savedName: contact?.savedName,
        firstName: contact?.firstName,
        lastName: contact?.lastName,
        isBlocked: contact?.isBlocked,
      });

      let chat = await Chat.findOne({
        orgId: req.auth.orgId,
        telegramAccountId,
        externalChatId: chatExternalId,
      });

      if (!chat) {
        chat = await Chat.create({
          orgId: req.auth.orgId,
          telegramAccountId,
          contactId: contactDoc._id,
          agentId,
          externalChatId: chatExternalId,
          title: contact?.displayName || contact?.savedName || undefined,
          isArchived: Boolean(isArchived),
          isBlocked: Boolean(contact?.isBlocked),
        });
      } else {
        if (isArchived !== undefined) chat.isArchived = Boolean(isArchived);
        if (contact?.isBlocked !== undefined) chat.isBlocked = Boolean(contact.isBlocked);
        if (contact?.displayName || contact?.savedName) {
          chat.title = contact.displayName || contact.savedName;
        }
      }

      let lastMessageAt = chat.lastMessageAt;
      let lastMessagePreview = chat.lastMessagePreview;
      let unreadIncrement = 0;

      if (item.lastMessageAt) {
        const itemDate = new Date(item.lastMessageAt);
        if (!lastMessageAt || itemDate > lastMessageAt) {
          lastMessageAt = itemDate;
        }
      }
      if (item.lastMessagePreview && !lastMessagePreview) {
        lastMessagePreview = item.lastMessagePreview.slice(0, 140);
      }
      if (item.unreadCount !== undefined) {
        chat.unreadCount = item.unreadCount;
      }

      const messageOps = [];
      for (const m of messages) {
        if (!m.telegramMessageId || !m.sentAt) continue;
        const { senderType, senderId } = resolveMessageSender(m, req.auth);
        const sentAt = new Date(m.sentAt);
        if (!lastMessageAt || sentAt > lastMessageAt) {
          lastMessageAt = sentAt;
          lastMessagePreview = (m.text || '').slice(0, 140);
        }
        if (m.direction !== 'out') unreadIncrement += 1;

        messageOps.push({
          updateOne: {
            filter: { chatId: chat._id, telegramMessageId: String(m.telegramMessageId) },
            update: {
              $setOnInsert: {
                chatId: chat._id,
                orgId: req.auth.orgId,
                direction: m.direction === 'out' ? 'out' : 'in',
                senderType,
                senderId,
                text: m.text,
                mediaRef: m.mediaRef,
                telegramMessageId: String(m.telegramMessageId),
                sentAt,
              },
            },
            upsert: true,
          },
        });
      }

      if (messageOps.length > 0) {
        try {
          await Message.bulkWrite(messageOps, { ordered: false });
        } catch (bulkErr) {
          console.warn('[sync/batch] bulkWrite notice:', bulkErr.message);
        }
      }

      chat.lastMessageAt = lastMessageAt;
      chat.lastMessagePreview = lastMessagePreview;
      chat.unreadCount = (chat.unreadCount || 0) + unreadIncrement;
      if (
        !chat.isArchived &&
        (item.isTransferred ||
          /(?:https?:\/\/)?t\.me\//i.test(lastMessagePreview || '') ||
          messages.some((m) => /(?:https?:\/\/)?t\.me\//i.test(m.text || '')))
      ) {
        chat.isTransferred = true;
      }
      await chat.save();
      chatsSynced++;
    } catch (chatErr) {
      console.warn('[sync/batch] item error:', chatErr.message);
    }
  }

  account.lastSyncAt = new Date();
  await account.save();

  return res.json({ ok: true, chatsSynced });
});

router.post('/chats/:chatId/read', async (req, res) => {
  try {
    const isOid = mongoose.Types.ObjectId.isValid(req.params.chatId);
    const query = isOid
      ? { $or: [{ _id: new mongoose.Types.ObjectId(req.params.chatId), orgId: req.auth.orgId }, { externalChatId: String(req.params.chatId), orgId: req.auth.orgId }] }
      : { externalChatId: String(req.params.chatId), orgId: req.auth.orgId };

    const chat = await Chat.findOne(query);
    if (!chat) return res.status(404).json({ error: 'Not found' });
    chat.unreadCount = 0;
    await chat.save();
    return res.json({ ok: true });
  } catch (err) {
    console.warn('[sync] mark read error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
