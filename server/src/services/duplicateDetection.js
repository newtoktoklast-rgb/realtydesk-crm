const Contact = require('../models/Contact');

/**
 * Finds or creates a Contact for an incoming synced lead, and flags it as
 * a duplicate when it is already linked to a different agent within the
 * same org. Matching is by Telegram user id, username, or phone number —
 * any one of these matching an existing contact counts as the same person.
 *
 * See docs/BUILD_SPEC.md section 8 for the logic spec this implements.
 */
async function upsertContactAndDetectDuplicate({
  orgId,
  agentId,
  telegramAccountId,
  telegramUserId,
  username,
  phoneNumber,
  avatarUrl,
  displayName,
  savedName,
  firstName,
  lastName,
  isBlocked,
}) {
  // Match by unique Telegram client identifiers: numeric Telegram User ID, verified phone number,
  // or globally unique Telegram username handle (@username).
  // Display names (first/last name) are NOT used to avoid false collisions.
  const cleanUsername = username ? String(username).replace(/^@/, '').trim().toLowerCase() : null;
  const cleanPhone = phoneNumber ? String(phoneNumber).trim().replace(/[\s\-\(\)]/g, '') : null;
  const cleanTgId = telegramUserId ? String(telegramUserId).trim() : null;

  const orConditions = [];
  if (cleanTgId) orConditions.push({ telegramUserId: cleanTgId });
  if (cleanPhone) orConditions.push({ phoneNumber: cleanPhone });
  if (cleanUsername) orConditions.push({ username: new RegExp(`^${cleanUsername}$`, 'i') });

  let contact = orConditions.length
    ? await Contact.findOne({ orgId, $or: orConditions })
    : null;

  if (!contact) {
    contact = await Contact.create({
      orgId,
      telegramUserId: cleanTgId || undefined,
      username: cleanUsername || undefined,
      phoneNumber: cleanPhone || undefined,
      avatarUrl,
      displayName,
      savedName,
      firstName,
      lastName,
      isBlocked: Boolean(isBlocked),
      firstSeenByAgentId: agentId,
      linkedAgents: agentId ? [agentId] : [],
      linkedAccounts: telegramAccountId ? [telegramAccountId] : [],
    });
    return { contact, duplicate: false, otherAgents: [] };
  }

  // Fill in any newly-learned identifiers and names
  let changed = false;
  if (telegramUserId && !contact.telegramUserId) {
    contact.telegramUserId = telegramUserId;
    changed = true;
  }
  if (username && !contact.username) {
    contact.username = username;
    changed = true;
  }
  if (phoneNumber && !contact.phoneNumber) {
    contact.phoneNumber = phoneNumber;
    changed = true;
  }
  if (avatarUrl && contact.avatarUrl !== avatarUrl) {
    contact.avatarUrl = avatarUrl;
    changed = true;
  }
  if (displayName && contact.displayName !== displayName) {
    contact.displayName = displayName;
    changed = true;
  }
  // Auto-save presets only apply to brand-new contacts. Never overwrite a
  // saved name that already exists (whether set by Telegram or by an agent).
  if (savedName && !contact.savedName && contact.savedName !== savedName) {
    contact.savedName = savedName;
    changed = true;
  }
  if (firstName && contact.firstName !== firstName) {
    contact.firstName = firstName;
    changed = true;
  }
  if (lastName && contact.lastName !== lastName) {
    contact.lastName = lastName;
    changed = true;
  }
  if (isBlocked !== undefined && contact.isBlocked !== Boolean(isBlocked)) {
    contact.isBlocked = Boolean(isBlocked);
    changed = true;
  }

  if (!contact.linkedAgents) contact.linkedAgents = [];
  if (!contact.linkedAccounts) contact.linkedAccounts = [];

  const otherAgents = agentId
    ? contact.linkedAgents.filter((id) => String(id) !== String(agentId))
    : contact.linkedAgents;

  if (agentId && !contact.linkedAgents.some((id) => String(id) === String(agentId))) {
    contact.linkedAgents.push(agentId);
    changed = true;
  }

  if (telegramAccountId && !contact.linkedAccounts.some((id) => String(id) === String(telegramAccountId))) {
    contact.linkedAccounts.push(telegramAccountId);
    changed = true;
  }

  // Contact is repeated if linked to multiple Telegram accounts (even of the same agent)
  // OR linked to multiple distinct agents — ONLY considering active (non-archived) chats!
  const Chat = require('../models/Chat');
  const activeChats = await Chat.find({
    orgId,
    contactId: contact._id,
    isArchived: { $ne: true },
  }).select('telegramAccountId agentId');

  const activeAccIds = new Set(activeChats.map((c) => String(c.telegramAccountId || '')).filter(Boolean));
  if (telegramAccountId) activeAccIds.add(String(telegramAccountId));
  const activeAgentIds = new Set(activeChats.map((c) => String(c.agentId || '')).filter(Boolean));
  if (agentId) activeAgentIds.add(String(agentId));

  const isRepeated = activeAccIds.size > 1 || activeAgentIds.size > 1;

  if (contact.duplicateFlag !== isRepeated) {
    contact.duplicateFlag = isRepeated;
    changed = true;
  }

  if (changed) await contact.save();

  return {
    contact,
    duplicate: isRepeated,
    otherAgents,
  };
}

module.exports = { upsertContactAndDetectDuplicate };
