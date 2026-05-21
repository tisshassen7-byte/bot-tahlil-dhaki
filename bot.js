const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const sessions = {};

function menu(chatId) {
  bot.sendMessage(chatId, '🏠 القائمة الرئيسية\nاختر ما تريد:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🚀 ابدأ التحليل', callback_data: 'start_analysis' }],
        [{ text: '📊 سجل الإشارات', callback_data: 'history' }],
        [{ text: 'ℹ️ طريقة الاستخدام', callback_data: 'help' }]
      ]
    }
  });
}

bot.onText(/\/start/, (msg) => {
  sessions[msg.chat.id] = {};
  menu(msg.chat.id);
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (!sessions[chatId]) sessions[chatId] = {};

  if (data === 'home') return menu(chatId);

  if (data === 'start_analysis') {
    return bot.sendMessage(chatId, '📊 اختر نوع السوق:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔥 OTC', callback_data: 'market_otc' }],
          [{ text: '📈 سوق حقيقي', callback_data: 'market_real' }],
          [{ text: '🏠 الرئيسية', callback_data: 'home' }]
        ]
      }
    });
  }

  if (data === 'market_otc' || data === 'market_real') {
    sessions[chatId].market = data === 'market_otc' ? 'OTC' : 'حقيقي';

    return bot.sendMessage(chatId, '💱 اختر الأصل:', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'EUR/USD', callback_data: 'asset_EURUSD' },
            { text: 'GBP/USD', callback_data: 'asset_GBPUSD' }
          ],
          [
            { text: 'EUR/GBP', callback_data: 'asset_EURGBP' },
            { text: 'USD/JPY', callback_data: 'asset_USDJPY' }
          ],
          [
            { text: 'AUD/JPY', callback_data: 'asset_AUDJPY' },
            { text: 'CAD/JPY', callback_data: 'asset_CADJPY' }
          ],
          [{ text: '🏠 الرئيسية', callback_data: 'home' }]
        ]
      }
    });
  }

  if (data.startsWith('asset_')) {
    sessions[chatId].asset = data.replace('asset_', '');

    return bot.sendMessage(chatId, '⏱️ اختر مدة الصفقة:', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '1 دقيقة', callback_data: 'time_1m' },
            { text: '5 دقائق', callback_data: 'time_5m' }
          ],
          [
            { text: '15 دقيقة', callback_data: 'time_15m' },
            { text: '30 دقيقة', callback_data: 'time_30m' }
          ],
          [{ text: '🏠 الرئيسية', callback_data: 'home' }]
        ]
      }
    });
  }

  if (data.startsWith('time_')) {
    sessions[chatId].time = data.replace('time_', '');

    await bot.sendMessage(chatId, '⏳ جاري تحليل الصفقة...');

    setTimeout(() => {
      const results = [
        '🟢 BUY',
        '🔴 SELL',
        '⚪ لا توجد فرصة متاحة'
      ];

      const result = results[Math.floor(Math.random() * results.length)];
      const s = sessions[chatId];

      bot.sendMessage(chatId,
`📊 نتيجة التحليل

السوق: ${s.market}
الأصل: ${s.asset}
المدة: ${s.time}

النتيجة: ${result}

⚠️ القرار النهائي عليك، نفّذ وحدك في Pocket Option.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 تحليل جديد', callback_data: 'start_analysis' }],
              [{ text: '🏠 الرئيسية', callback_data: 'home' }]
            ]
          }
        }
      );
    }, 1500);

    return;
  }

  if (data === 'history') {
    return bot.sendMessage(chatId, '📊 سجل الإشارات فارغ حاليًا.', {
      reply_markup: {
        inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]]
      }
    });
  }

  if (data === 'help') {
    return bot.sendMessage(chatId,
`ℹ️ طريقة الاستخدام:

1️⃣ اضغط ابدأ التحليل
2️⃣ اختار OTC أو سوق حقيقي
3️⃣ اختار الأصل
4️⃣ اختار المدة
5️⃣ البوت يعطيك BUY أو SELL أو لا توجد فرصة`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]]
        }
      }
    );
  }
});

console.log('Bot interface running...');
