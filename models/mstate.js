const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  userId:   { type: String, required: true, unique: true },
  verified: { type: mongoose.Schema.Types.Mixed, default: {} },
});
module.exports = mongoose.model('MState', schema);
