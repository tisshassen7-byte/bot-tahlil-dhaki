
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const userStates = {};

bot.on('message', async (msg) => {
  if (msg.from.is_bot) return;

  const chatId = msg.chat.id;
  const text = msg.text;

  if (text === '/start') {
    userStates[chatId] = {};

    bot.sendMessage(chatId, '🤖 مرحبًا يا حسان\nاختر نوع السوق:', {
      reply_markup: {
        keyboard: [
          ['📈 سوق حقيقي', '🔥 OTC']
        ],
        resize_keyboard: true
      }
    });
    return;
  }

  if (text === '📈 سوق حقيقي' || text === '🔥 OTC') {
    userStates[chatId].market = text;

    bot.sendMessage(chatId, 'اختر الأصل:', {
      reply_markup: {
        keyboard: [
          ['EUR/USD', 'GBP/USD'],
          ['USD/JPY', 'BTC/USD'],
          ['🔙 رجوع']
        ],
        resize_keyboard: true
      }
    });
    return;
  }

  if (['EUR/USD','GBP/USD','USD/JPY','BTC/USD'].includes(text)) {
    userStates[chatId].asset = text;

    bot.sendMessage(chatId, 'اختر مدة الصفقة:', {
      reply_markup: {
        keyboard: [
          ['30 ثانية', '1 دقيقة'],
          ['2 دقيقة', '5 دقائق'],
          ['🔙 رجوع']
        ],
        resize_keyboard: true
      }
    });
    return;
  }

  if (['30 ثانية','1 دقيقة','2 دقيقة','5 دقائق'].includes(text)) {
    const signals = ['🟢 BUY', '🔴 SELL', '⚪ لا توجد فرصة'];
    const signal = signals[Math.floor(Math.random() * signals.length)];

    bot.sendMessage(chatId, `📊 التحليل جاهز:\n\n${signal}`, {
      reply_markup: {
        keyboard: [
          ['🔁 تحليل جديد'],
          ['🏠 الرئيسية']
        ],if (text === '🆕 تحليل جديد') {
  bot.sendMessage(chatId, 'اختر نوع السوق:', {
    reply_markup: {
      keyboard: [
        ['💎 OTC', '📈 سوق حقيقي']
      ],
      resize_keyboard: true
    }
  });
  return;
}
});
        resize_keyboard: true
      }
    });
    return;
  }

  if (text === '🔁 تحليل جديد') {
    bot.sendMessage(chatId, 'اختر نوع السوق:', {
      reply_markup: {
        keyboard: [
