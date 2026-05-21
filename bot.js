const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(token, { polling: true });

bot.on('message', async (msg) => {
  if (msg.from && msg.from.is_bot) return;

  try {
    await bot.sendMessage(msg.chat.id, '🔥 البوت خدام يا حسان');
  } catch (err) {
    console.log(err);
  }
});
