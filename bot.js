
const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const fetch = require('node-fetch');

const token = process.env.TELEGRAM_TOKEN;
const apiKey = process.env.TWELVE_API_KEY;

const bot = new TelegramBot(token, { polling: false, filepath: false });
const sessions = {};

http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot alive');
}).listen(process.env.PORT || 8080);

(async () => {
  await bot.deleteWebHook({ drop_pending_updates: true });
  bot.startPolling();
})();

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

function mainMenu(chatId) {
  return bot.sendMessage(chatId, '🏠 القائمة الرئيسية\nاختر ما تريد:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🚀 ابدأ التحليل', callback_data: 'start_analysis' }],
        [{ text: 'ℹ️ طريقة الاستخدام', callback_data: 'help' }]
      ]
    }
  });
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
}function getVolatility(closes) {
  const recent = closes.slice(-12);
  const high = Math.max(...recent);
  const low = Math.min(...recent);
  return ((high - low) / low) * 100;
}

function candleStrength(closes) {
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const diff = Math.abs(last - prev);

  if (diff > 0.0012) return 'strong';
  if (diff > 0.0005) return 'medium';
  return 'weak';
}

function supportResistance(closes) {
  const recent = closes.slice(-30);
  const high = Math.max(...recent);
  const low = Math.min(...recent);
  const last = closes[closes.length - 1];

  return {
    nearResistance: ((high - last) / last) < 0.0025,
    nearSupport: ((last - low) / last) < 0.0025,
    rangePercent: ((high - low) / low) * 100
  };
}

function trendDirection(closes) {
  const ema20 = ema(closes.slice(-40), 20);
  const ema50 = ema(closes.slice(-70), 50);
  const ema200 = ema(closes.slice(-220), 200);
  const last = closes[closes.length - 1];

  if (last > ema20 && ema20 > ema50 && ema50 > ema200) return 'up';
  if (last < ema20 && ema20 < ema50 && ema50 < ema200) return 'down';
  return 'mixed';
}

function multiConfirm(closes) {
  const shortTrend = trendDirection(closes.slice(-80));
  const longTrend = trendDirection(closes);

  if (shortTrend === 'up' && longTrend === 'up') return 'up';
  if (shortTrend === 'down' && longTrend === 'down') return 'down';
  return 'mixed';
}

function grade(score) {
  if (score >= 85) return 'A+';
  if (score >= 76) return 'A';
  if (score >= 68) return 'B';
  return 'NO TRADE';
}

function entryTiming(duration) {
  if (duration === '30s') return 'ادخل مع بداية الحركة مباشرة';
  if (duration === '1m') return 'ادخل مع الشمعة الجديدة';
  return 'ادخل بعد تأكيد الحركة';
}async function getSignal(symbol, market, duration) {
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1min&outputsize=220&apikey=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!data.values || data.values.length < 200) {
      return {
        signal: '⚪ لا توجد فرصة',
        grade: 'NO TRADE',
        timing: 'لا تدخل',
        reason: 'بيانات غير كافية'
      };
    }

    const closes = data.values.map(v => Number(v.close)).reverse();

    const direction = multiConfirm(closes);
    const rsi14 = rsi(closes, 14);
    const volatility = getVolatility(closes);
    const strength = candleStrength(closes);
    const sr = supportResistance(closes);

    let score = 50;
    let reasons = [];

    if (direction === 'up') {
      score += 18;
      reasons.push('اتجاه صاعد');
    } else if (direction === 'down') {
      score += 18;
      reasons.push('اتجاه هابط');
    } else {
      score -= 20;
      reasons.push('اتجاه غير واضح');
    }

    if (direction === 'up' && rsi14 > 52 && rsi14 < 70) {
      score += 12;
      reasons.push('RSI مناسب للشراء');
    }

    if (direction === 'down' && rsi14 < 48 && rsi14 > 30) {
      score += 12;
      reasons.push('RSI مناسب للبيع');
    }

    if (strength === 'strong') score += 8;
    if (strength === 'weak') score -= 12;

    if (volatility < 0.008) {
      return {
        signal: '⚪ لا توجد فرصة',
        grade: 'NO TRADE',
        timing: 'لا تدخل',
        reason: 'السوق ضعيف'
      };
    }

    if (sr.rangePercent < 0.015) score -= 12;
    if (direction === 'up' && sr.nearResistance) score -= 12;
    if (direction === 'down' && sr.nearSupport) score -= 12;

    if (market === 'OTC') score -= 6;

    score = Math.max(0, Math.min(100, Math.round(score)));

    let signal = '⚪ لا توجد فرصة';
    if (direction === 'up' && score >= 68) signal = '🟢 BUY';
    if (direction === 'down' && score >= 68) signal = '🔴 SELL';

    if (market === 'OTC' && score < 72) signal = '⚪ لا توجد فرصة';

    const g = signal.includes('لا توجد') ? 'NO TRADE' : grade(score);

    return {
      signal,
      grade: g,
      timing: signal.includes('لا توجد') ? 'لا تدخل' : entryTiming(duration),
      reason: reasons.slice(0, 3).join(' + ') || 'الشروط غير كافية'
    };
  } catch (err) {
    console.log(err);
    return {
      signal: '⚪ لا توجد فرصة',
      grade: 'NO TRADE',
      timing: 'لا تدخل',
      reason: 'خطأ في جلب البيانات'
    };
  }
  }bot.onText(/\/start/i, (msg) => {
  sessions[msg.chat.id] = {};
  mainMenu(msg.chat.id);
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (!sessions[chatId]) sessions[chatId] = {};
  await bot.answerCallbackQuery(query.id).catch(() => {});

  if (data === 'home') return mainMenu(chatId);

  if (data === 'help') {
    return bot.sendMessage(chatId,
`ℹ️ طريقة الاستخدام:

1️⃣ اضغط ابدأ التحليل
2️⃣ اختر السوق
3️⃣ اختر الزوج
4️⃣ اختر المدة
5️⃣ خذ القرار من النتيجة`,
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
          [{ text: '🔥 OTC', callback_data: 'market_OTC' }],
          [{ text: '📈 سوق حقيقي', callback_data: 'market_REAL' }],
          [{ text: '🏠 الرئيسية', callback_data: 'home' }]
        ]
      }
    });
  }

  if (data.startsWith('market_')) {
    sessions[chatId].market = data.includes('OTC') ? 'OTC' : 'سوق حقيقي';

    const buttons = [];
    for (let i = 0; i < assets.length; i += 2) {
      buttons.push(
        assets.slice(i, i + 2).map(asset => ({
          text: asset,
          callback_data: 'asset_' + asset
        }))
      );
    }
    buttons.push([{ text: '🏠 الرئيسية', callback_data: 'home' }]);

    return bot.sendMessage(chatId, '💱 اختر الزوج:', {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  if (data.startsWith('asset_')) {
    sessions[chatId].asset = data.replace('asset_', '');

    const buttons = durations.map(d => [
      { text: d.label, callback_data: 'duration_' + d.value }
    ]);
    buttons.push([{ text: '🏠 الرئيسية', callback_data: 'home' }]);

    return bot.sendMessage(chatId, '⏱️ اختر مدة الصفقة:', {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  if (data.startsWith('duration_')) {
    sessions[chatId].duration = data.replace('duration_', '');

    const s = sessions[chatId];
    const durationLabel = durations.find(d => d.value === s.duration)?.label || s.duration;

    await bot.sendMessage(chatId, '⏳ جاري تحليل الصفقة...');

    const result = await getSignal(s.asset, s.market, s.duration);

    return bot.sendMessage(chatId,
`📊 نتيجة التحليل

السوق: ${s.market}
الزوج: ${s.asset}
المدة: ${durationLabel}

النتيجة: ${result.signal}

🏅 التقييم: ${result.grade}
⏳ وقت الدخول: ${result.timing}
✅ السبب: ${result.reason}

⚠️ القرار النهائي عليك.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '↩️ تحليل جديد', callback_data: 'start_analysis' }],
            [{ text: '🏠 الرئيسية', callback_data: 'home' }]
          ]
        }
      }
    );
  }
});

console.log('Bot stable realistic version running...');
