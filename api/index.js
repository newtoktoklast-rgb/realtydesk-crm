const { createApp } = require('../server/src/app');

// Serverless function handler for Vercel
const app = createApp();

module.exports = app;
