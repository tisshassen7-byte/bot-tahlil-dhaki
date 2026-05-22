
process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

const token = process.env.TELEGRAM_TOKEN;
const apiKey = process.env.TWELVE_API_KEY;

const bot = new TelegramBot(token, { polling: false, filepath: false });

(async () => {
  await bot.deleteWebHook({ drop_pending_updates: true });
  await bot.startPolling();
})();

const sessions = {};
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot alive');
}).listen(process.env.PORT || 8080);

const assets = [
  'EUR/USD',
  'GBP/USD',
  'USD/JPY',
  'EUR/GBP',
  'AUD/USD',
  'NZD/USD',
  'USD/CAD',
  'USD/CHF',
  'GBP/JPY',
  'EUR/JPY',
  'AUD/JPY',
  'CAD/JPY'
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

function getGrade(confidence) {
  if (confidence >= 92) return 'A+';
  if (confidence >= 82) return 'A';
  if (confidence >= 64) return 'B';
  return 'NO TRADE';
}function entryTiming(duration) {
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

  if (wait === 0) return 'الآن داخل أفضل منطقة دخول';

  return `انتظر ${wait} ثانية تقريبًا، وادخل في آخر ${window} ثانية`;
}

function getVolatility(closes) {
  const recent = closes.slice(-10);
  const high = Math.max(...recent);
  const low = Math.min(...recent);
  return ((high - low) / low) * 100;
}

function candleStrength(closes) {
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const prev2 = closes[closes.length - 3];

  const move1 = Math.abs(last - prev);
  const move2 = Math.abs(prev - prev2);

  if (move1 > move2 * 1.25 && move1 > 0.0008) return 'strong';
  if (move1 > 0.0004) return 'medium';
  return 'weak';
}

function getSupportResistance(closes) {
  const recent = closes.slice(-40);
  const support = Math.min(...recent);
  const resistance = Math.max(...recent);
  const last = closes[closes.length - 1];

  const range = resistance - support || 0.000001;
  const nearSupport = ((last - support) / range) < 0.15;
  const nearResistance = ((resistance - last) / range) < 0.15;

  return {
    support,
    resistance,
    nearSupport,
    nearResistance,
    rangePercent: (range / last) * 100
  };
}

function detectFakeBreakout(closes) {
  const recent = closes.slice(-12);
  const last = closes[closes.length - 1];
  const prevHigh = Math.max(...recent.slice(0, -1));
  const prevLow = Math.min(...recent.slice(0, -1));

  if (last > prevHigh) return 'up_breakout';
  if (last < prevLow) return 'down_breakout';

  return 'none';
}

function trendDirection(closes) {
  const last = closes[closes.length - 1];
  const ema20 = ema(closes.slice(-60), 20);
  const ema50 = ema(closes.slice(-100), 50);
  const ema200 = ema(closes.slice(-220), 200);

  if (last > ema20 && ema20 > ema50 && ema50 > ema200) return 'up';
  if (last < ema20 && ema20 < ema50 && ema50 < ema200) return 'down';

  return 'mixed';
    }function multiTimeframeConfirm(closes) {
  const shortCloses = closes.slice(-60);
  const midCloses = closes.slice(-120);
  const longCloses = closes.slice(-220);

  const shortTrend = trendDirection(shortCloses);
  const midTrend = trendDirection(midCloses);
  const longTrend = trendDirection(longCloses);

  if (shortTrend === 'up' && midTrend === 'up') {
    return {
      direction: 'up',
      score: longTrend === 'up' ? 18 : 12,
      text: 'تأكيد فريمات متعددة صاعد'
    };
  }

  if (shortTrend === 'down' && midTrend === 'down') {
    return {
      direction: 'down',
      score: longTrend === 'down' ? 18 : 12,
      text: 'تأكيد فريمات متعددة هابط'
    };
  }

  return {
    direction: 'mixed',
    score: -10,
    text: 'الفريمات غير متفقة'
  };
}

function calculateScore({ direction, rsi14, volatility, strength, sr, breakout, market }) {
  let score = 50;
  const reasons = [];

  if (direction === 'up') {
    score += 12;
    reasons.push('اتجاه صاعد');
  }

  if (direction === 'down') {
    score += 12;
    reasons.push('اتجاه هابط');
  }

  if (direction === 'mixed') {
    score -= 18;
    reasons.push('الاتجاه غير واضح');
  }

  if (direction === 'up' && rsi14 > 53 && rsi14 < 72) {
    score += 12;
    reasons.push('RSI مناسب للشراء');
  }

  if (direction === 'down' && rsi14 < 47 && rsi14 > 28) {
    score += 12;
    reasons.push('RSI مناسب للبيع');
  }

  if (rsi14 >= 72 || rsi14 <= 28) {
    score -= 12;
    reasons.push('RSI في منطقة خطرة');
  }

  if (strength === 'strong') {
    score += 10;
    reasons.push('شمعة قوية');
  } else if (strength === 'medium') {
    score += 4;
    reasons.push('شمعة متوسطة');
  } else {
    score -= 10;
    reasons.push('شمعة ضعيفة');
  }

  if (volatility < 0.006) {
    score -= 20;
    reasons.push('السوق ضعيف جدًا');
  } else if (volatility < 0.012) {
    score -= 8;
    reasons.push('تذبذب ضعيف');
  } else if (volatility > 0.08) {
    score += 6;
    reasons.push('زخم جيد');
  }

  if (sr.rangePercent < 0.012) {
    score -= 18;
    reasons.push('سوق ضيق / رينج');
  }

  if (direction === 'up' && sr.nearResistance) {
    score -= 10;
    reasons.push('قريب من مقاومة');
  }

  if (direction === 'down' && sr.nearSupport) {
    score -= 10;
    reasons.push('قريب من دعم');
  }

  if (breakout === 'up_breakout' || breakout === 'down_breakout') {
    score -= 6;
    reasons.push('احتمال كسر كاذب');
  }

  if (market === 'OTC') {
    score -= 4;
    reasons.push('فلتر OTC صارم');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  return { score, reasons };async function getSignal(symbol, market, duration) {
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1min&outputsize=220&apikey=${apiKey}`;

    const res = await fetch(url);
    const data = await res.json();

    if (!data.values || data.values.length < 200) {
      return {
        signal: '⚪ لا توجد فرصة متاحة',
        confidence: 0,
        grade: 'NO TRADE',
        timing: 'لا تدخل',
        confirm: 'بيانات غير كافية'
      };
    }

    const closes = data.values.map(v => Number(v.close)).reverse();
    const last = closes[closes.length - 1];

    const rsi14 = rsi(closes, 14);
    const volatility = getVolatility(closes);
    const strength = candleStrength(closes);
    const sr = getSupportResistance(closes);
    const breakout = detectFakeBreakout(closes);
    const mtf = multiTimeframeConfirm(closes);

    const direction = mtf.direction;

    const analysis = calculateScore({
      direction,
      rsi14,
      volatility,
      strength,
      sr,
      breakout,
      market
    });

    let confidence = analysis.score + mtf.score;
    confidence = Math.max(0, Math.min(100, Math.round(confidence)));

    let signal = '⚪ لا توجد فرصة متاحة';

    if (direction === 'up' && confidence >= 58) {
      signal = '🟢 BUY';
    }

    if (direction === 'down' && confidence >= 58) {
      signal = '🔴 SELL';
    }

    if (market === 'OTC' && confidence < 70) {
      signal = '⚪ لا توجد فرصة متاحة';
    }

    if (confidence < 58) {
      signal = '⚪ لا توجد فرصة متاحة';
    }

    const grade = getGrade(confidence);

    let confirm = analysis.reasons.slice(0, 4).join(' + ');
    if (!confirm) confirm = 'الشروط غير مكتملة';

    if (signal.includes('لا توجد')) {
      return {
        signal,
        confidence,
        grade: 'NO TRADE',
        timing: 'لا تدخل',
        confirm
      };
    }

    return {
      signal,
      confidence,
      grade,
      timing: entryTiming(duration),
      confirm
    };

  } catch (err) {
    console.log(err);

    return {
      signal: '⚪ لا توجد فرصة متاحة',
      confidence: 0,
      grade: 'NO TRADE',
      timing: 'لا تدخل',
      confirm: 'حدث خطأ في جلب البيانات'
    };
  }
}

bot.onText(/\/start/, (msg) => {
  sessions[msg.chat.id] = {};
  mainMenu(msg.chat.id);
});
}bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (!sessions[chatId]) sessions[chatId] = {};

  if (data === 'home') {
    return mainMenu(chatId);
  }

  if (data === 'help') {
    return bot.sendMessage(
      chatId,
`ℹ️ طريقة الاستخدام:

1️⃣ اضغط ابدأ التحليل
2️⃣ اختر نوع السوق
3️⃣ اختر الأصل
4️⃣ اختر المدة
5️⃣ البوت يعطيك:
BUY / SELL / لا توجد فرصة
مع نسبة الثقة ووقت الدخول`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏠 الرئيسية', callback_data: 'home' }]
          ]
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

    return bot.sendMessage(chatId, '💱 اختر الأصل:', {
      reply_markup: {
        inline_keyboard: buttons
      }
    });
  }

  if (data.startsWith('asset_')) {
    sessions[chatId].asset = data.replace('asset_', '');

    const buttons = durations.map(d => [
      { text: d.label, callback_data: 'duration_' + d.value }
    ]);

    buttons.push([{ text: '🏠 الرئيسية', callback_data: 'home' }]);

    return bot.sendMessage(chatId, '⏱️ اختر مدة الصفقة:', {
      reply_markup: {
        inline_keyboard: buttons
      }
    });
  }

  if (data.startsWith('duration_')) {
    sessions[chatId].duration = data.replace('duration_', '');

    const s = sessions[chatId];
    const durationLabel =
      durations.find(d => d.value === s.duration)?.label || s.duration;

    await bot.sendMessage(chatId, '⏳ جاري تحليل الصفقة...');

    const result = await getSignal(s.asset, s.market, s.duration);

    return bot.sendMessage(
      chatId,
`📊 نتيجة التحليل

السوق: ${s.market}
الأصل: ${s.asset}
المدة: ${durationLabel}

النتيجة: ${result.signal}

🎯 نسبة الثقة: ${result.confidence}%
🏅 التقييم: ${result.grade}
⏳ وقت الدخول: ${result.timing}
✅ التأكيد: ${result.confirm}

⚠️ القرار النهائي عليك.`,
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

console.log('Bot professional version running...');
