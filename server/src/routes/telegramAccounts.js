const express = require('express');
const mongoose = require('mongoose');
const TelegramAccount = require('../models/TelegramAccount');
const { requireAuth } = require('../middleware/auth');
const { deleteAccountData } = require('../services/cleanupService');

const router = express.Router();
router.use(requireAuth);

function buildAccountQuery(id, orgId) {
  if (mongoose.Types.ObjectId.isValid(id)) {
    return {
      $or: [
        { _id: new mongoose.Types.ObjectId(id), orgId },
        { telegramUserId: String(id), orgId },
      ],
    };
  }
  return { telegramUserId: String(id), orgId };
}

/**
 * Records or updates a Telegram account linked by an agent or owner.
 *
 * Metadata only: the MTProto session string never reaches the server.
 * See docs/BUILD_SPEC.md §2 and §7.2.
 */
router.post('/', async (req, res) => {
  const { telegramUserId, displayName, phoneMasked, username } = req.body || {};

  if (!telegramUserId) {
    return res.status(400).json({ error: 'telegramUserId is required' });
  }

  const updateFields = {
    orgId: req.auth.orgId,
    ownerType: req.auth.role,
    ownerRefId: req.auth.sub,
    telegramUserId,
    displayName,
    phoneMasked,
    status: 'active',
    linkedAt: new Date(),
  };

  if (username) {
    updateFields.username = String(username).replace(/^@/, '').trim();
  }

  try {
    const existing = await TelegramAccount.findOne({
      orgId: req.auth.orgId,
      telegramUserId: String(telegramUserId),
    });

    if (existing && existing.status === 'active') {
      // An account may only be linked to ONE user at a time. If a different
      // user in the org already owns it, reject. But the SAME owner may re-link
      // (e.g. after losing the local MTProto session) — update the existing
      // record in place instead of creating a duplicate or forcing an unlink
      // (which would wipe chat history).
      if (String(existing.ownerRefId) !== String(req.auth.sub)) {
        return res.status(409).json({
          error: 'This Telegram account is already linked to another user in your organization',
        });
      }

      Object.assign(existing, updateFields);
      const account = await existing.save();
      return res.status(200).json({ telegramAccount: account });
    }

    let account;
    if (existing) {
      Object.assign(existing, updateFields);
      account = await existing.save();
    } else {
      account = await TelegramAccount.create(updateFields);
    }

    return res.status(201).json({ telegramAccount: account });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ error: 'This Telegram account is already linked' });
    }
    console.error('[telegram-accounts] link error:', err.message);
    return res.status(500).json({ error: 'Failed to link Telegram account' });
  }
});

/**
 * Lists all Telegram accounts in the org (for owner) or for the user (for agent).
 */
router.get('/', async (req, res) => {
  const query = { orgId: req.auth.orgId, status: 'active' };
  if (req.auth.role !== 'owner') {
    query.ownerRefId = req.auth.sub;
  }
  const accounts = await TelegramAccount.find(query).sort({ linkedAt: -1 });
  return res.json({ telegramAccounts: accounts });
});

router.get('/org-accounts', async (req, res) => {
  const accounts = await TelegramAccount.find({ orgId: req.auth.orgId, status: 'active' })
    .select('_id displayName phoneMasked username telegramUserId ownerRefId ownerType')
    .sort({ linkedAt: -1 });
  return res.json({ telegramAccounts: accounts });
});

router.get('/mine', async (req, res) => {
  const accounts = await TelegramAccount.find({
    orgId: req.auth.orgId,
    ownerRefId: req.auth.sub,
    status: 'active',
  });
  return res.json({ telegramAccounts: accounts });
});

router.delete('/:id', async (req, res) => {
  try {
    const account = await TelegramAccount.findOne(buildAccountQuery(req.params.id, req.auth.orgId));
    if (!account) return res.status(404).json({ error: 'Not found' });
    if (String(account.ownerRefId) !== String(req.auth.sub) && req.auth.role !== 'owner') {
      return res.status(403).json({ error: 'Not your account' });
    }
    account.status = 'revoked';
    await account.save();

    // Cascade: remove this account's chats + messages so the admin view stays clean.
    await deleteAccountData(req.auth.orgId, account._id);

    return res.json({ ok: true });
  } catch (err) {
    if (err instanceof mongoose.Error.CastError) {
      return res.status(400).json({ error: 'Invalid account id' });
    }
    console.error('[telegram-accounts] unlink error:', err.message);
    return res.status(500).json({ error: 'Failed to unlink Telegram account' });
  }
});

module.exports = router;
