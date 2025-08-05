const { Schema, model } = require('mongoose');

const EntrySchema = new Schema({
    symbol: String,
    totalCostUSD: Number,
    totalAmount: Number
});

module.exports = model('Entry', EntrySchema);