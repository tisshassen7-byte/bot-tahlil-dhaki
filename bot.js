const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_TOKEN;
const apiKey = process.env.TWELVE_API_KEY;

const bot = new TelegramBot(token, { polling: true });
const sessions = {};

const assets = ['EUR/USD', 'GBP/USD', 'EUR/GBP', 'USD/JPY', 'AUD/JPY', 'CAD/JPY'];
const durations = ['1 دقيقة', '5 دقائق', '15 دقيقة', '30 دقيقة'];

function mainMenu(chatId) {
  bot.sendMessage(chatId, '🏠 القائمة الرئيسية\nاختر ما تريد:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🚀 ابدأ التحليل', callback_data: 'start_analysis' }],
        [{ text: 'ℹ️ طريقة الاستخدام', callback_data: 'help' }]
      ]
    }
  });
}

async function getSignal(symbol) {
  try {
    const cleanSymbol = symbol.replace('/', '/');
    const url = `https://api.twelvedata.com/time_series?symbol=${cleanSymbol}&interval=1min&outputsize=30&apikey=${apiKey}`;

    const res = await fetch(url);
    const data = await res.json();

    if (!data.values || data.values.length < 20) {
      return '⚪ لا توجد فرصة متاحة';
    }

    const closes = data.values.map(v => Number(v.close)).reverse();
    const last = closes[closes.length - 1];

    const avg5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const avg20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;

    const gains = [];
    const losses = [];

    for (let i = closes.length - 15; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains.push(diff);
      else losses.push(Math.abs(diff));
    }

    const avgGain = gains.length ? gains.reduce((a, b) => a + b, 0) / 14 : 0;
    const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / 14 : 0.000001;
    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));

    if (last > avg5 && avg5 > avg20 && rsi > 55 && rsi < 75) {
      return '🟢 BUY';
    }

    if (last < avg5 && avg5 < avg20 && rsi < 45 && rsi > 25) {
      return '🔴 SELL';
    }

    return '⚪ لا توجد فرصة متاحة';
  } catch (e) {
    console.log(e);
    return '⚪ لا توجد فرصة متاحة';
  }
}

bot.onText(/\/start/, (msg) => {
  sessions[msg.chat.id] = {};
  mainMenu(msg.chat.id);
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (!sessions[chatId]) sessions[chatId] = {};

  if (data === 'home') {
    return mainMenu(chatId);
  }

  if (data === 'help') {
    return bot.sendMessage(chatId,
      'ℹ️ طريقة الاستخدام:\n\n1️⃣ ابدأ التحليل\n2️⃣ اختر نوع السوق\n3️⃣ اختر الأصل\n4️⃣ اختر المدة\n5️⃣ انتظر النتيجة: BUY / SELL / لا توجد فرصة',
      {
        reply_markup: {
          inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]]
        }
      }
    );
  }

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
    sessions[chatId].market = data === 'market_otc' ? 'OTC' : 'سوق حقيقي';

    return bot.sendMessage(chatId, '💱 اختر الأصل:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'EUR/USD', callback_data: 'asset_EUR/USD' }, { text: 'GBP/USD', callback_data: 'asset_GBP/USD' }],
          [{ text: 'EUR/GBP', callback_data: 'asset_EUR/GBP' }, { text: 'USD/JPY', callback_data: 'asset_USD/JPY' }],
          [{ text: 'AUD/JPY', callback_data: 'asset_AUD/JPY' }, { text: 'CAD/JPY', callback_data: 'asset_CAD/JPY' }],
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
          [{ text: '1 دقيقة', callback_data: 'time_1 دقيقة' }, { text: '5 دقائق', callback_data: 'time_5 دقائق' }],
          [{ text: '15 دقيقة', callback_data: 'time_15 دقيقة' }, { text: '30 دقيقة', callback_data: 'time_30 دقيقة' }],
          [{ text: '🏠 الرئيسية', callback_data: 'home' }]
        ]
      }
    });
  }

  if (data.startsWith('time_')) {
    sessions[chatId].time = data.replace('time_', '');

    const s = sessions[chatId];

    await bot.sendMessage(chatId, '⏳ جاري تحليل الصفقة...');

    const signal = await getSignal(s.asset);

    return bot.sendMessage(chatId,
`📊 نتيجة التحليل

السوق: ${s.market}
الأصل: ${s.asset}
المدة: ${s.time}

النتيجة: ${signal}

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
  }
});

console.log('Bot real analysis running...');
