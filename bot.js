const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

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
  'GBP/JPY', 'EUR/JPY', 'AUD/JPY', 'CAD/JPY',
  'BTC/USD', 'ETH/USD', 'LTC/USD'
];

const durations = [
  { label: '30 ثانية', value: '30s' },
  { label: '1 دقيقة', value: '1m' },
  { label: '5 دقائق', value: '5m' },
  { label: '15 دقيقة', value: '15m' },
  { label: '30 دقيقة', value: '30m' }
];

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

function sma(values, period) {
  const part = values.slice(-period);
  return part.reduce((a, b) => a + b, 0) / part.length;
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let result = values[0];
  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}

function rsi(values, period = 14) {
  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period || 0.000001;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function entryTiming(duration) {
  const now = new Date();
  const sec = now.getSeconds();

  let candle = 60;
  let window = 12;

  if (duration === '30s') {
    candle = 30;
    window = 6;
  }

  const passed = sec % candle;
  const remaining = candle - passed;
  const wait = remaining > window ? remaining - window : 0;

  if (wait === 0) return `الآن داخل أفضل منطقة دخول`;
  return `انتظر ${wait} ثانية تقريبًا، وادخل في آخر ${window} ثانية من الشمعة`;
}

async function getSignal(symbol, market, duration) {
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1min&outputsize=220&apikey=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!data.values || data.values.length < 200) {
      return {
        signal: '⚪ لا توجد فرصة متاحة',
        confidence: 0,
        timing: 'لا تدخل',
        confirm: 'بيانات غير كافية'
      };
    }

    const closes = data.values.map(v => Number(v.close)).reverse();
    const last = closes[closes.length - 1];

    const ema20 = ema(closes.slice(-60), 20);
    const ema50 = ema(closes.slice(-100), 50);
    const ema200 = ema(closes.slice(-220), 200);
    const rsi14 = rsi(closes, 14);

    let confidence = 50;
    let signal = '⚪ لا توجد فرصة متاحة';
    let confirm = 'الشروط غير مكتملة';

    const upTrend = last > ema20 && ema20 > ema50 && ema50 > ema200;
    const downTrend = last < ema20 && ema20 < ema50 && ema50 < ema200;

    if (upTrend && rsi14 > 55 && rsi14 < 75) {
      confidence = 70 + Math.min(15, Math.round(rsi14 - 55));
      signal = '🟢 BUY';
      confirm = 'الاتجاه صاعد والشروط الأساسية مكتملة';
    }

    if (downTrend && rsi14 < 45 && rsi14 > 25) {
      confidence = 70 + Math.min(15, Math.round(45 - rsi14));
      signal = '🔴 SELL';
      confirm = 'الاتجاه هابط والشروط الأساسية مكتملة';
    }

    if (market === 'OTC' && confidence < 75) {
      signal = '⚪ لا توجد فرصة متاحة';
      confirm = 'OTC يحتاج ثقة أعلى، الشروط غير كافية';
    }

    if (confidence < 70) {
      signal = '⚪ لا توجد فرصة متاحة';
    }

    return {
      signal,
      confidence,
      timing: signal.includes('لا توجد') ? 'لا تدخل' : entryTiming(duration),
      confirm
    };

  } catch (err) {
    console.log(err);
    return {
      signal: '⚪ لا توجد فرصة متاحة',
      confidence: 0,
      timing: 'لا تدخل',
      confirm: 'حدث خطأ في جلب البيانات'
    };
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

  if (data === 'home') return mainMenu(chatId);

  if (data === 'help') {
    return bot.sendMessage(chatId,
`ℹ️ طريقة الاستخدام:

1️⃣ اضغط ابدأ التحليل
2️⃣ اختر نوع السوق
3️⃣ اختر الأصل
4️⃣ اختر المدة
5️⃣ انتظر النتيجة مع الثقة ووقت الدخول`,
      { reply_markup: { inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]] } }
    );
  }

  if (data === 'start_analysis') {
    return bot.sendMessage(chatId, '📊 اختر نوع السوق:', {
      reply_markup: {
        inline_keyboard: [
          [{
});
