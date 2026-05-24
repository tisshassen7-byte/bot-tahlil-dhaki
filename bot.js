const TelegramBot = require("node-telegram-bot-api");
const http = require("http");
const fetch = require("node-fetch");

const token = process.env.TELEGRAM_TOKEN;
const apiKey = process.env.TWELVE_API_KEY;

if (!token) throw new Error("TELEGRAM_TOKEN غير موجود");
if (!apiKey) throw new Error("TWELVE_API_KEY غير موجود");

const bot = new TelegramBot(token, { polling: true });
const sessions = {};

http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bot alive");
}).listen(process.env.PORT || 8080);

const assets = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "EUR/JPY",
  "GBP/JPY",
  "AUD/USD",
  "USD/CAD",
  "USD/CHF",
  "AUD/JPY",
  "EUR/GBP"
];

const durations = [
  { label: "30 ثانية", value: "30s", interval: "1min" },
  { label: "1 دقيقة", value: "1m", interval: "1min" },
  { label: "5 دقائق", value: "5m", interval: "5min" },
  { label: "15 دقيقة", value: "15m", interval: "15min" },
  { label: "30 دقيقة", value: "30m", interval: "30min" }
];

function mainMenu(chatId) {
  return bot.sendMessage(chatId, "🏠 القائمة الرئيسية", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 تحليل", callback_data: "start_analysis" }]
      ]
    }
  });
}

function chunkButtons(list, prefix, perRow = 2) {
  const rows = [];
  for (let i = 0; i < list.length; i += perRow) {
    rows.push(
      list.slice(i, i + perRow).map(x => ({
        text: x,
        callback_data: `${prefix}${x}`
      }))
    );
  }
  return rows;
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function sma(values, period) {
  if (values.length < period) return null;
  const arr = values.slice(-period);
  return arr.reduce((a, b) => a + b, 0) / period;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    trs.push(tr);
  }

  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function candleQuality(candles) {
  const c = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low || 0.000001;
  const bodyRatio = body / range;

  const bullish = c.close > c.open && c.close > prev.close && bodyRatio >= 0.45;
  const bearish = c.close < c.open && c.close < prev.close && bodyRatio >= 0.45;

  return { bullish, bearish, bodyRatio };
}

function supportResistanceZone(closes, last) {
  const recent = closes.slice(-35);
  const high = Math.max(...recent);
  const low = Math.min(...recent);

  const nearResistance = (high - last) / last < 0.0012;
  const nearSupport = (last - low) / last < 0.0012;

  return { high, low, nearResistance, nearSupport };
}

function timeRiskFilter() {
  const now = new Date();
  const minute = now.getUTCMinutes();

  // فلتر زمني بسيط: تجنب أول وآخر 3 دقائق من الساعة بسبب تذبذب محتمل
  if (minute <= 2 || minute >= 57) {
    return {
      blocked: true,
      reason: "منطقة زمنية حساسة: بداية/نهاية الساعة"
    };
  }

  return { blocked: false, reason: "" };
}

function grade(confidence) {
  if (confidence >= 88) return "A+";
  if (confidence >= 80) return "A";
  if (confidence >= 70) return "B+";
  if (confidence >= 62) return "B";
  return "C";
}

function entryText(duration) {
  if (duration === "30s") return "انتظر 10 إلى 15 ثانية وادخل إذا بقي الاتجاه ثابت";
  if (duration === "1m") return "انتظر 35 إلى 45 ثانية وادخل في آخر 15 ثانية";
  if (duration === "5m") return "انتظر شمعة تأكيد قصيرة ثم ادخل";
  return "ادخل فقط إذا بقي الاتجاه والتأكيد كما هو";
}

async function getCandles(symbol, interval) {
  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=120` +
    `&apikey=${apiKey}`;

  const res = await fetch(url, { timeout: 12000 });
  const data = await res.json();

  if (data.status === "error") {
    throw new Error(data.message || "TwelveData error");
  }

  if (!data.values || data.values.length < 70) {
    throw new Error("بيانات غير كافية");
  }

  return data.values.reverse().map(x => ({
    open: Number(x.open),
    high: Number(x.high),
    low: Number(x.low),
    close: Number(x.close)
  })).filter(x =>
    Number.isFinite(x.open) &&
    Number.isFinite(x.high) &&
    Number.isFinite(x.low) &&
    Number.isFinite(x.close)
  );
}

async function analyze(symbol, market, durationValue) {
  try {
    const duration = durations.find(d => d.value === durationValue) || durations[1];
    const candles = await getCandles(symbol, duration.interval);
    const closes = candles.map(c => c.close);

    const last = closes[closes.length - 1];

    const ema9 = ema(closes, 9);
    const ema21 = ema(closes, 21);
    const ema50 = ema(closes, 50);
    const ema100 = ema(closes, 100);
    const r = rsi(closes, 14);
    const averageRange = atr(candles, 14);
    const avgClose = sma(closes, 20);

    if (!ema9 || !ema21 || !ema50 || !ema100 || !r || !averageRange || !avgClose) {
      return noTrade("بيانات التحليل غير كافية");
    }

    const sr = supportResistanceZone(closes, last);
    const candle = candleQuality(candles);
    const timeFilter = timeRiskFilter();

    const volatilityRatio = averageRange / avgClose;

    const tooDead = volatilityRatio < 0.00012;
    const tooWild = volatilityRatio > 0.0045;

    const strongUp =
      last > ema21 &&
      ema9 > ema21 &&
      ema21 > ema50 &&
      ema50 > ema100;

    const strongDown =
      last < ema21 &&
      ema9 < ema21 &&
      ema21 < ema50 &&
      ema50 < ema100;

    const weakMarket =
      Math.abs(ema21 - ema50) / last < 0.00018;

    if (timeFilter.blocked && market === "سوق حقيقي") {
      return noTrade(timeFilter.reason);
    }

    if (tooDead) {
      return noTrade("السوق ميت: الحركة ضعيفة ولا تستحق الدخول");
    }

    if (tooWild) {
      return noTrade("السوق عنيف: تذبذب عالي وخطر");
    }

    if (weakMarket) {
      return noTrade("No Trade Zone: الترند غير واضح");
    }

    let buyScore = 0;
    let sellScore = 0;
    const buyReasons = [];
    const sellReasons = [];

    if (strongUp) {
      buyScore += 30;
      buyReasons.push("ترند صاعد قوي");
    }

    if (strongDown) {
      sellScore += 30;
      sellReasons.push("ترند هابط قوي");
    }

    if (r >= 52 && r <= 67) {
      buyScore += 20;
      buyReasons.push("RSI مناسب للشراء بدون تشبع");
    }

    if (r <= 48 && r >= 33) {
      sellScore += 20;
      sellReasons.push("RSI مناسب للبيع بدون تشبع");
    }

    if (candle.bullish) {
      buyScore += 20;
      buyReasons.push("شمعة شراء قوية");
    }

    if (candle.bearish) {
      sellScore += 20;
      sellReasons.push("شمعة بيع قوية");
    }

    if (!sr.nearResistance) {
      buyScore += 15;
      buyReasons.push("بعيد عن مقاومة قريبة");
    }

    if (!sr.nearSupport) {
      sellScore += 15;
      sellReasons.push("بعيد عن دعم قريب");
    }

    if (volatilityRatio >= 0.00018 && volatilityRatio <= 0.0028) {
      buyScore += 10;
      sellScore += 10;
    }

    if (market === "OTC") {
      buyScore -= 5;
      sellScore -= 5;

      if (r > 55 && strongUp) buyScore += 8;
      if (r < 45 && strongDown) sellScore += 8;
    }

    if (strongDown) buyScore = 0;
    if (strongUp) sellScore = 0;

    if (sr.nearResistance) buyScore -= 20;
    if (sr.nearSupport) sellScore -= 20;

    const minScore = market === "OTC" ? 72 : 68;

    if (buyScore >= minScore && buyScore > sellScore + 8) {
      return {
        signal: "🟢 BUY",
        confidence: Math.min(94, buyScore),
        grade: grade(buyScore),
        entry: entryText(durationValue),
        reason: buyReasons.join(" + ")
      };
    }

    if (sellScore >= minScore && sellScore > buyScore + 8) {
      return {
        signal: "🔴 SELL",
        confidence: Math.min(94, sellScore),
        grade: grade(sellScore),
        entry: entryText(durationValue),
        reason: sellReasons.join(" + ")
      };
    }

    return noTrade("الشروط غير مكتملة: لا توجد أفضلية قوية");
  } catch (err) {
    console.error("Analyze error:", err.message);
    return noTrade("خطأ في جلب البيانات أو التحليل");
  }
}

function noTrade(reason) {
  return {
    signal: "⚪ لا توجد فرصة",
    confidence: 0,
    grade: "-",
    entry: "لا تدخل",
    reason
  };
}

bot.onText(/\/start/i, msg => {
  sessions[msg.chat.id] = {};
  mainMenu(msg.chat.id);
});

bot.on("callback_query", async q => {
  const chatId = q.message.chat.id;
  const data = q.data;

  if (!sessions[chatId]) sessions[chatId] = {};

  await bot.answerCallbackQuery(q.id).catch(() => {});

  if (data === "home") {
    return mainMenu(chatId);
  }

  if (data === "start_analysis") {
    return bot.sendMessage(chatId, "📊 اختر السوق:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔥 OTC", callback_data: "market_OTC" }],
          [{ text: "📈 سوق حقيقي", callback_data: "market_REAL" }],
          [{ text: "🏠 الرئيسية", callback_data: "home" }]
        ]
      }
    });
  }

  if (data.startsWith("market_")) {
    sessions[chatId].market = data === "market_OTC" ? "OTC" : "سوق حقيقي";

    return bot.sendMessage(chatId, "💱 اختر الزوج:", {
      reply_markup: {
        inline_keyboard: [
          ...chunkButtons(assets, "asset_", 2),
          [{ text: "🏠 الرئيسية", callback_data: "home" }]
        ]
      }
    });
  }

  if (data.startsWith("asset_")) {
    sessions[chatId].asset = data.replace("asset_", "");

    return bot.sendMessage(chatId, "⏱️ اختر مدة الصفقة:", {
      reply_markup: {
        inline_keyboard: [
          ...durations.map(d => [{ text: d.label, callback_data: `duration_${d.value}` }]),
          [{ text: "🏠 الرئيسية", callback_data: "home" }]
        ]
      }
    });
  }

  if (data.startsWith("duration_")) {
    sessions[chatId].duration = data.replace("duration_", "");

    const s = sessions[chatId];

    if (!s.market || !s.asset || !s.duration) {
      return bot.sendMessage(chatId, "⚠️ الاختيارات ناقصة. ارجع للقائمة الرئيسية.", {
        reply_markup: {
          inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]]
        }
      });
    }

    const durationLabel = durations.find(d => d.value === s.duration)?.label || s.duration;

    await bot.sendMessage(chatId, "⌛ جاري تحليل الصفقة...");

    const result = await analyze(s.asset, s.market, s.duration);

    return bot.sendMessage(chatId,
`📊 نتيجة التحليل

السوق: ${s.market}
الأصل: ${s.asset}
المدة: ${durationLabel}

النتيجة: ${result.signal}

🎯 نسبة الثقة: ${result.confidence}%
🏅 التقييم: ${result.grade}
⌛ وقت الدخول: ${result.entry}

✅ التأكيد: ${result.reason}

⚠️ القرار النهائي عليك.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔁 تحليل جديد", callback_data: "start_analysis" }],
            [{ text: "🏠 الرئيسية", callback_data: "home" }]
          ]
        }
      }
    );
  }
});

process.on("unhandledRejection", err => {
  console.error("Unhandled rejection:", err);
});

process.on("uncaughtException", err => {
  console.error("Uncaught exception:", err);
});
