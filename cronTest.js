const cron = require('node-cron');

cron.schedule('* * * * *', () => {
    console.log(`🕒 Cron fired at ${new Date().toLocaleTimeString()}`);
});

console.log('🚀 Dummy cron is running every minute...');