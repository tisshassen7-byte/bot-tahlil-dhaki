const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const fetch = require('node-fetch');

const token = process.env.TELEGRAM_TOKEN;
const apiKey = process.env.TWELVE_API_KEY;

const bot = new TelegramBot(token, { polling: true, filepath: false });
const sessions = {};

http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot alive');
}).listen(process.env.PORT || 8080);

const assets = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'EUR/GBP',
  'AUD/USD', 'NZD/USD', 'USD/CAD', 'USD/CHF',
  'GBP/JPY', 'EUR/JPY', 'AUD/JPY', 'CAD/JPY'
];

const durations = [
  { label: '30 ثانية', value: '30s' },
  { label: '1 دقيقة', value: '1m' },
  { label: '5 دقائق', value: '5m' }
];

function menu(chatId) {
  return bot.sendMessage(chatId, '🏠 القائمة الرئيسية', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🚀 ابدأ التحليل', callback_data: 'start' }]
      ]
    }
  });
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsi(values, period = 14) {
  let gain = 0, loss = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss += Math.abs(d);
  }
  const rs = (gain / period) / ((loss / period) || 0.000001);
  return 100 - 100 / (1 + rs);
}

async function analyze(symbol, market) {
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1min&outputsize=80&apikey=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!data.values || data.values.length < 50) {
      return { signal: '⚪ لا توجد فرصة', reason: 'بيانات غير كافية' };
    }

    const closes = data.values.map(x => Number(x.close)).reverse();
    const last = closes.at(-1);
    const prev = closes.at(-2);

    const e20 = ema(closes.slice(-40), 20);
    const e50 = ema(closes.slice(-60), 50);
    const r = rsi(closes);

    const recent = closes.slice(-20);
    const high = Math.max(...recent);
    const low = Math.min(...recent);

    const nearRes = (high - last) / last < 0.0015;
    const nearSup = (last - low) / last < 0.0015;

    const candleUp = last > prev;
    const candleDown = last < prev;

    let buy = last > e20 && e20 > e50 && r > 50 && r < 70 && candleUp && !nearRes;
    let sell = last < e20 && e20 < e50 && r < 50 && r > 30 && candleDown && !nearSup;

    if (market === 'OTC') {
      buy = buy && r > 54;
      sell = sell && r < 46;
    }

    if (buy) return { signal: '🟢 BUY', reason: 'اتجاه صاعد + RSI مناسب + بعيد عن مقاومة' };
    if (sell) return { signal: '🔴 SELL', reason: 'اتجاه هابط + RSI مناسب + بعيد عن دعم' };

    return { signal: '⚪ لا توجد فرصة', reason: 'الشروط غير مكتملة' };
  } catch {
    return { signal: '⚪ لا توجد فرصة', reason: 'خطأ في جلب البيانات' };
  }
}

bot.onText(/\/start/i, msg => {
  sessions[msg.chat.id] = {};
  menu(msg.chat.id);
});

bot.on('callback_query', async q => {
  const chatId = q.message.chat.id;
  const data = q.data;
  if (!sessions[chatId]) sessions[chatId] = {};
  await bot.answerCallbackQuery(q.id).catch(() => {});

  if (data === 'home') return menu(chatId);

  if (data === 'start') {
    return bot.sendMessage(chatId, '📊 اختر السوق:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔥 OTC', callback_data: 'market_OTC' }],
          [{ text: '📈 سوق حقيقي', callback_data: 'market_REAL' }]
        ]
      }
    });
  }

  if (data.startsWith('market_')) {
    sessions[chatId].market = data.includes('OTC') ? 'OTC' : 'سوق حقيقي';
    const buttons = [];
    for (let i = 0; i < assets.length; i += 2) {
      buttons.push(assets.slice(i, i + 2).map(a => ({ text: a, callback_data: 'asset_' + a })));
    }
    return bot.sendMessage(chatId, '💱 اختر الزوج:', {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  if (data.startsWith('asset_')) {
    sessions[chatId].asset = data.replace('asset_', '');
    return bot.sendMessage(chatId, '⏱️ اختر المدة:', {
      reply_markup: {
        inline_keyboard: durations.map(d => [{ text: d.label, callback_data: 'time_' + d.value }])
      }
    });
  }

  if (data.startsWith('time_')) {
    sessions[chatId].duration = data.replace('time_', '');
    const s = sessions[chatId];
    const durationLabel = durations.find(d => d.value === s.duration)?.label || s.duration;

    await bot.sendMessage(chatId, '⏳ جاري التحليل...');

    const result = await analyze(s.asset, s.market);

    return bot.sendMessage(chatId, `📊 نتيجة التحليل

السوق: ${s.market}
الزوج: ${s.asset}
المدة: ${durationLabel}

النتيجة: ${result.signal}

✅ السبب: ${result.reason}
⚠️ القرار النهائي عليك.`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '↩️ تحليل جديد', callback_data: 'start' }],
          [{ text: '🏠 الرئيسية', callback_data: 'home' }]
        ]
      }
    });
  }
});bot.on('polling_error', e => console.log('polling_error:', e.message));
console.log('Bot clean simple version running...');
