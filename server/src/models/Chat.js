const { Schema, model } = require('mongoose');

const chatSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    telegramAccountId: { type: Schema.Types.ObjectId, ref: 'TelegramAccount', required: true, index: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true, index: true },
    agentId: { type: Schema.Types.ObjectId, ref: 'Agent', index: true },
    externalChatId: { type: String, required: true }, // Telegram-side chat/peer id
    title: { type: String }, // Telegram chat title or contact name
    lastMessageAt: { type: Date, index: true },
    lastMessagePreview: { type: String },
    unreadCount: { type: Number, default: 0 },
    isArchived: { type: Boolean, default: false, index: true },
    isBlocked: { type: Boolean, default: false, index: true },
    isTransferred: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

chatSchema.index({ orgId: 1, telegramAccountId: 1, externalChatId: 1 }, { unique: true });

module.exports = model('Chat', chatSchema);
