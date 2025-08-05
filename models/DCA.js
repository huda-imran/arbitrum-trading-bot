const { Schema, model } = require('mongoose');

const DCASchema = new Schema({
    counter: Number,
    pool: Number
});

module.exports = model('DCAState', DCASchema);