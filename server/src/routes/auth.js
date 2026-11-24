const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');

const ActivationCode = require('../models/ActivationCode');
const Agent = require('../models/Agent');
const Owner = require('../models/Owner');
const { deleteAgentChatsOnLogout } = require('../services/cleanupService');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../services/tokenService');

const router = express.Router();

// Activation-code redemption is a brute-force target; rate-limit it hard.
const redeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/activation-code/redeem', redeemLimiter, async (req, res) => {
  const { code, displayName } = req.body || {};
  if (!code || !displayName) {
    return res.status(400).json({ error: 'code and displayName are required' });
  }

  try {
    const activation = await ActivationCode.findOne({ code });
    if (!activation || !activation.isRedeemable()) {
      return res.status(401).json({ error: 'Invalid or expired activation code' });
    }

    const agent = await Agent.create({
      orgId: activation.orgId,
      displayName,
      activationCodeUsed: code,
      lastSeenAt: new Date(),
    });

    activation.usesCount += 1;
    await activation.save();

    const payload = { sub: String(agent._id), role: 'agent', orgId: String(activation.orgId) };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    return res.status(201).json({
      accessToken,
      refreshToken,
      agent: { id: agent._id, displayName: agent.displayName, orgId: activation.orgId },
    });
  } catch (err) {
    console.error('[auth] Redeem error:', err.message);
    return res.status(503).json({
      error: 'Database connection failed. Please ensure your IP is whitelisted in MongoDB Atlas.',
    });
  }
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

router.post('/owner/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const owner = await Owner.findOne({ email: email.toLowerCase() });
    if (!owner) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const ok = await bcrypt.compare(password, owner.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const Organization = require('../models/Organization');
    const org = await Organization.findOne({ ownerId: owner._id });

    const payload = { sub: String(owner._id), role: 'owner', orgId: org ? String(org._id) : null };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    return res.json({
      accessToken,
      refreshToken,
      owner: { id: owner._id, displayName: owner.displayName, email: owner.email, orgId: org?._id },
    });
  } catch (err) {
    console.error('[auth] Login error:', err.message);
    return res.status(503).json({
      error: 'Database connection failed. Please ensure your IP is whitelisted in MongoDB Atlas (Network Access -> Add 0.0.0.0/0).',
    });
  }
});

router.post('/agent/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const cleanUsername = username.trim().toLowerCase();
    const agent = await Agent.findOne({ username: cleanUsername });
    if (!agent || !agent.passwordHash) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (agent.status === 'inactive') {
      return res.status(403).json({ error: 'This agent account has been deactivated' });
    }

    const ok = await bcrypt.compare(password, agent.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    agent.lastSeenAt = new Date();
    await agent.save();

    const payload = { sub: String(agent._id), role: 'agent', orgId: String(agent.orgId) };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    return res.json({
      accessToken,
      refreshToken,
      agent: {
        id: agent._id,
        displayName: agent.displayName,
        username: agent.username,
        role: 'agent',
        orgId: agent.orgId,
      },
    });
  } catch (err) {
    console.error('[auth] Agent login error:', err.message);
    return res.status(503).json({ error: 'Database connection failed' });
  }
});

router.post('/logout', requireAuth, async (req, res) => {
  try {
    if (req.auth.role === 'agent') {
      await deleteAgentChatsOnLogout(req.auth.orgId, req.auth.sub);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[auth] logout error:', err.message);
    return res.status(500).json({ error: 'Logout failed' });
  }
});

// Refresh: verify the agent still exists so a deleted agent is forced out.
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required' });
  try {
    const decoded = verifyRefreshToken(refreshToken);
    if (decoded.role === 'agent') {
      const agent = await Agent.findOne({ _id: decoded.sub, orgId: decoded.orgId });
      if (!agent) return res.status(401).json({ error: 'Account no longer exists' });
    }
    const payload = { sub: decoded.sub, role: decoded.role, orgId: decoded.orgId };
    return res.json({ accessToken: signAccessToken(payload) });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

module.exports = router;
