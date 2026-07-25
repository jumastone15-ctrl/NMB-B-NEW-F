const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  id:        { type: String, required: true, unique: true },
  name:      { type: String, required: true },
  chatId:    { type: String, required: true },
  source:    { type: String, default: 'db' },
  createdAt: { type: Date },
  expiresAt: { type: Date },
});
module.exports = mongoose.model('MUser', schema);
