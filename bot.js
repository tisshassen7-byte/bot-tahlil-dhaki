/**
 * بوت تحليل Pocket Option - سوق حقيقي فقط
 * الأزواج: EUR/USD, GBP/USD, USD/JPY, EUR/JPY
 * وقت العمل: 20:00 - 00:00 بتوقيت المستخدم (UTC+3 افتراضي)
 */

const TelegramBot = require("node-telegram-bot-api");
const http = require("http");
const fetch = require("node-fetch");

// ─── Environment Variables ────────────────────────────────────────────────────
const token = process.env.TELEGRAM_TOKEN;
const apiKey = process.env.TWELVE_API_KEY;

if (!token) throw new Error("TELEGRAM_TOKEN غير موجود في البيئة");
if (!apiKey) throw new Error("TWELVE_API_KEY غير موجود في البيئة");

// ─── Bot Initialization ───────────────────────────────────────────────────────
const bot = new TelegramBot(token, { polling: true });

// ─── State ────────────────────────────────────────────────────────────────────
const sessions = {}; // جلسة كل مستخدم
const userSettings = {}; // إعدادات المستخدم (timezone offset)

// ─── Keep-alive Server (Railway) ──────────────────────────────────────────────
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is alive");
  })
  .listen(process.env.PORT || 8080);

// ─── Constants ────────────────────────────────────────────────────────────────
const ALLOWED_ASSETS = ["EUR/USD", "GBP/USD", "USD/JPY", "EUR/JPY"];

// فترات زمنية عالية الخطر (UTC) - أخبار اقتصادية متكررة
const HIGH_IMPACT_UTC_RANGES = [
  { h: 8, m: 28, endH: 8, endM: 35 }, // بداية الجلسة الأوروبية + أخبار
  { h: 12, m: 28, endH: 12, endM: 35 }, // قبل الجلسة الأمريكية
  { h: 13, m: 25, endH: 13, endM: 40 }, // فتح سوق نيويورك + أخبار
  { h: 15, m: 0, endH: 15, endM: 5 }, // أخبار أمريكية متكررة
  { h: 18, m: 0, endH: 18, endM: 5 }, // إغلاق لندن
];

const MIN_CONFIDENCE = 60; // حد أدنى للثقة
const ANALYSIS_INTERVAL = "5min"; // إطار زمني ثابت للتحليل

// ─── Logging ──────────────────────────────────────────────────────────────────
function log(level, msg, extra = {}) {
  const ts = new Date().toISOString();
  const out = { ts, level, msg, ...extra };
  if (level === "ERROR") {
    process.stderr.write(JSON.stringify(out) + "\n");
  } else {
    process.stdout.write(JSON.stringify(out) + "\n");
  }
}

// ─── Timezone Helpers ─────────────────────────────────────────────────────────
function getUserOffset(chatId) {
  return userSettings[chatId]?.utcOffset ?? 3; // UTC+3 افتراضي
}

function getUserHour(chatId) {
  const offset = getUserOffset(chatId);
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  return { hour: (utcH + offset + 24) % 24, minute: utcM };
}

// ─── News Filter (UTC-based) ──────────────────────────────────────────────────
function isNewsTime() {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const totalMin = utcH * 60 + utcM;
  for (const r of HIGH_IMPACT_UTC_RANGES) {
    const start = r.h * 60 + r.m;
    const end = r.endH * 60 + r.endM;
    if (totalMin >= start && totalMin <= end) return true;
  }
  return false;
}

// ─── Candle Edge Filter ───────────────────────────────────────────────────────
function isCandleEdge() {
  const m = new Date().getUTCMinutes();
  return m <= 1 || m >= 58;
}

// ─── Technical Indicators ─────────────────────────────────────────────────────
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    trs.push(
      Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose),
      ),
    );
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function sma(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── Candle Quality ───────────────────────────────────────────────────────────
function candleQuality(candles) {
  const c = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low || 0.000001;
  const bodyRatio = body / range;
  const bullish = c.close > c.open && c.close > prev.close && bodyRatio >= 0.5;
  const bearish = c.close < c.open && c.close < prev.close && bodyRatio >= 0.5;
  return { bullish, bearish, bodyRatio };
}

// ─── Multi-candle Trend Confirmation ─────────────────────────────────────────
function trendConfirmation(candles) {
  const last5 = candles.slice(-5);
  let upCount = 0,
    downCount = 0;
  for (const c of last5) {
    if (c.close > c.open) upCount++;
    else if (c.close < c.open) downCount++;
  }
  return { upCount, downCount };
}

// ─── Support / Resistance ─────────────────────────────────────────────────────
function supportResistance(closes, last) {
  const recent = closes.slice(-50);
  const high = Math.max(...recent);
  const low = Math.min(...recent);
  const nearResistance = (high - last) / last < 0.001;
  const nearSupport = (last - low) / last < 0.001;
  return { high, low, nearResistance, nearSupport };
}

// ─── Grade ────────────────────────────────────────────────────────────────────
function grade(score) {
  if (score >= 90) return "A";
  if (score >= 78) return "B";
  return "C";
}

// ─── Fetch Candles from TwelveData (with one auto-retry) ─────────────────────
async function fetchOnce(symbol) {
  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${ANALYSIS_INTERVAL}` +
    `&outputsize=130` +
    `&apikey=${apiKey}`;

  const res = await fetch(url, { timeout: 14000 });
  const data = await res.json();

  if (data.status === "error") {
    throw new Error(`TwelveData: ${data.message || "خطأ غير معروف"}`);
  }
  if (!data.values || data.values.length < 80) {
    throw new Error("بيانات غير كافية من TwelveData");
  }
  return data;
}

async function getCandles(symbol) {
  let data;
  try {
    data = await fetchOnce(symbol);
  } catch (err) {
    logger.warn({ symbol, err: err.message }, "TwelveData fetch failed — retrying once");
    await new Promise((r) => setTimeout(r, 3000));
    data = await fetchOnce(symbol);
  }

  return data.values
    .reverse()
    .map((x) => ({
      open: Number(x.open),
      high: Number(x.high),
      low: Number(x.low),
      close: Number(x.close),
    }))
    .filter(
      (x) =>
        Number.isFinite(x.open) &&
        Number.isFinite(x.high) &&
        Number.isFinite(x.low) &&
        Number.isFinite(x.close),
    );
}

// ─── Core Analysis Engine ─────────────────────────────────────────────────────
async function analyze(symbol) {
  const candles = await getCandles(symbol);
  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1];

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const ema100 = ema(closes, 100);
  const r = rsi(closes, 14);
  const avgATR = atr(candles, 14);
  const avgSMA = sma(closes, 20);

  if (
    !ema9 ||
    !ema21 ||
    !ema50 ||
    !ema100 ||
    r === null ||
    !avgATR ||
    !avgSMA
  ) {
    return noTrade("⛔ بيانات المؤشرات غير كافية للتحليل");
  }

  // ── Volatility
  const volRatio = avgATR / avgSMA;
  const tooDead = volRatio < 0.0001;
  const tooWild = volRatio > 0.005;

  // ── Trend Detection — مستويان: قوي (4 EMAs) ومعتدل (3 EMAs)
  const strongUp =
    ema9 > ema21 && ema21 > ema50 && ema50 > ema100 && last > ema50;

  const strongDown =
    ema9 < ema21 && ema21 < ema50 && ema50 < ema100 && last < ema50;

  // ترند معتدل: EMA9>21>50 بدون اشتراط EMA100
  const modUp   = !strongUp   && ema9 > ema21 && ema21 > ema50 && last > ema21;
  const modDown = !strongDown && ema9 < ema21 && ema21 < ema50 && last < ema21;

  const anyUp   = strongUp   || modUp;
  const anyDown = strongDown || modDown;

  // فجوة EMA21-EMA50 — للطرح فقط، لا للحجب المطلق
  const emaSep = Math.abs(ema21 - ema50) / last;

  const { nearResistance, nearSupport } = supportResistance(closes, last);
  const candle = candleQuality(candles);
  const trendConf = trendConfirmation(candles);

  // ── Hard filters (خطر حقيقي فقط)
  if (tooDead)
    return noTrade("⚪ السوق راكد: الحركة ضعيفة جداً ولا تستحق الدخول");
  if (tooWild) return noTrade("🔴 تذبذب شديد: الخطر عالٍ جداً");
  if (!anyUp && !anyDown)
    return noTrade("⚪ لا يوجد اتجاه: EMAs متشابكة في جميع الاتجاهات");

  // ── Scoring
  let buyScore = 0,
    sellScore = 0;
  const buyReasons = [],
    sellReasons = [];

  // ترند قوي = 35 | معتدل = 20
  if (strongUp) {
    buyScore += 35;
    buyReasons.push("ترند صاعد قوي (EMA 9>21>50>100)");
  } else if (modUp) {
    buyScore += 20;
    buyReasons.push("ترند صاعد معتدل (EMA 9>21>50)");
  }
  if (strongDown) {
    sellScore += 35;
    sellReasons.push("ترند هابط قوي (EMA 9<21<50<100)");
  } else if (modDown) {
    sellScore += 20;
    sellReasons.push("ترند هابط معتدل (EMA 9<21<50)");
  }

  // طرح بسيط عند EMAs قريبة جداً (لا حجب)
  if (emaSep < 0.00005) {
    buyScore  -= 8;
    sellScore -= 8;
  }

  // RSI — نطاق واسع في الترند
  const rsiBuyOk  = anyUp   ? (r >= 38 && r <= 90) : (r >= 45 && r <= 72);
  const rsiSellOk = anyDown ? (r >= 10 && r <= 62) : (r >= 28 && r <= 55);
  if (rsiBuyOk) {
    buyScore += 18;
    buyReasons.push(`RSI=${r.toFixed(0)} مناسب شراء`);
  }
  if (rsiSellOk) {
    sellScore += 18;
    sellReasons.push(`RSI=${r.toFixed(0)} مناسب بيع`);
  }
  // عقوبة عند تشبع حاد جداً فقط في غياب الترند
  if (r > 90 && !anyUp)   buyScore  -= 15;
  if (r < 10 && !anyDown) sellScore -= 15;

  // جودة الشمعة الأخيرة
  if (candle.bullish) {
    buyScore += 15;
    buyReasons.push("شمعة صاعدة قوية");
  }
  if (candle.bearish) {
    sellScore += 15;
    sellReasons.push("شمعة هابطة قوية");
  }

  // تأكيد متعدد الشموع (3 من 5)
  if (trendConf.upCount >= 3) {
    buyScore += 12;
    buyReasons.push(`${trendConf.upCount}/5 شموع صاعدة`);
  }
  if (trendConf.downCount >= 3) {
    sellScore += 12;
    sellReasons.push(`${trendConf.downCount}/5 شموع هابطة`);
  }

  // دعم ومقاومة — عقوبة مخففة وفقط في غياب أي ترند
  if (!nearResistance) {
    buyScore += 10;
    buyReasons.push("بعيد عن مقاومة");
  } else if (!anyUp) {
    buyScore -= 12;
  }
  if (!nearSupport) {
    sellScore += 10;
    sellReasons.push("بعيد عن دعم");
  } else if (!anyDown) {
    sellScore -= 12;
  }

  // تذبذب معتدل
  if (volRatio >= 0.00015 && volRatio <= 0.003) {
    buyScore += 8;
    sellScore += 8;
  }

  // ── صفر مطلق ضد الترند القوي فقط
  if (strongDown) buyScore = 0;
  if (strongUp)   sellScore = 0;
  // في الترند المعتدل: اخفض النقاط العكسية بدلاً من صفرها
  if (modDown && buyScore  > 10) buyScore  = 10;
  if (modUp   && sellScore > 10) sellScore = 10;

  // ── Final Decision
  const dominant = buyScore > sellScore ? "BUY" : "SELL";
  const dominantScore = dominant === "BUY" ? buyScore : sellScore;
  const opposite = dominant === "BUY" ? sellScore : buyScore;
  const reasons = dominant === "BUY" ? buyReasons : sellReasons;

  if (dominantScore < MIN_CONFIDENCE)
    return noTrade(
      `⚪ الثقة غير كافية (${dominantScore}%) — الجودة أهم من الكمية`,
    );
  if (dominantScore - opposite < 8)
    return noTrade("⚪ إشارة متعارضة: لا أفضلية واضحة بين BUY و SELL");

  const confidence = Math.min(93, dominantScore);
  return {
    signal: dominant === "BUY" ? "🟢 BUY" : "🔴 SELL",
    confidence,
    grade: grade(confidence),
    reason: reasons.join(" ✦ "),
    noTrade: false,
  };
}

function noTrade(reason) {
  return {
    signal: "⚪ NO TRADE",
    confidence: 0,
    grade: "-",
    reason,
    noTrade: true,
  };
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────
function mainMenu(chatId) {
  return bot.sendMessage(
    chatId,
    "🏠 القائمة الرئيسية — بوت تحليل Pocket Option",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📊 تحليل زوج", callback_data: "start_analysis" }],
          [{ text: "⏰ إعداد التوقيت", callback_data: "set_timezone" }],
        ],
      },
    },
  );
}

function assetMenu(chatId) {
  const rows = [];
  for (let i = 0; i < ALLOWED_ASSETS.length; i += 2) {
    rows.push(
      ALLOWED_ASSETS.slice(i, i + 2).map((a) => ({
        text: a,
        callback_data: `asset_${a}`,
      })),
    );
  }
  rows.push([{ text: "🏠 الرئيسية", callback_data: "home" }]);
  return bot.sendMessage(chatId, "💱 اختر الزوج (سوق حقيقي فقط):", {
    reply_markup: { inline_keyboard: rows },
  });
}

function timezoneMenu(chatId) {
  const offsets = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 8];
  const rows = [];
  for (let i = 0; i < offsets.length; i += 4) {
    rows.push(
      offsets.slice(i, i + 4).map((o) => ({
        text: `UTC${o >= 0 ? "+" : ""}${o}`,
        callback_data: `tz_${o}`,
      })),
    );
  }
  rows.push([{ text: "🏠 الرئيسية", callback_data: "home" }]);
  const current = getUserOffset(chatId);
  return bot.sendMessage(
    chatId,
    `⏰ اختر فارق توقيتك عن UTC\nالحالي: UTC+${current}`,
    { reply_markup: { inline_keyboard: rows } },
  );
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/i, (msg) => {
  const chatId = msg.chat.id;
  sessions[chatId] = {};
  log("INFO", "/start", { chatId });
  mainMenu(chatId);
});

// ─── Callback Handler ─────────────────────────────────────────────────────────
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = q.data;

  await bot.answerCallbackQuery(q.id).catch(() => {});
  if (!sessions[chatId]) sessions[chatId] = {};

  if (data === "home") return mainMenu(chatId);
  if (data === "start_analysis") return assetMenu(chatId);
  if (data === "set_timezone") return timezoneMenu(chatId);

  // ── Timezone Selection
  if (data.startsWith("tz_")) {
    const offset = parseInt(data.replace("tz_", ""), 10);
    if (!isNaN(offset)) {
      userSettings[chatId] = { utcOffset: offset };
      log("INFO", "timezone_set", { chatId, offset });
      return bot.sendMessage(
        chatId,
        `✅ تم ضبط توقيتك على UTC${offset >= 0 ? "+" : ""}${offset}`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]],
          },
        },
      );
    }
  }

  // ── Asset Selection → Analysis
  if (data.startsWith("asset_")) {
    const asset = data.replace("asset_", "");

    if (!ALLOWED_ASSETS.includes(asset)) {
      return bot.sendMessage(chatId, "⚠️ هذا الزوج غير مدعوم.", {
        reply_markup: {
          inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]],
        },
      });
    }

    // News filter
    if (isNewsTime()) {
      return bot.sendMessage(
        chatId,
        "📰 فلتر الأخبار: يُحتمل وجود خبر اقتصادي مؤثر الآن.\n⚠️ NO TRADE — انتظر 10 دقائق وأعد المحاولة.",
        {
          reply_markup: {
            inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]],
          },
        },
      );
    }

    // Candle edge
    if (isCandleEdge()) {
      return bot.sendMessage(
        chatId,
        "⏱️ أنت في بداية أو نهاية الشمعة. انتظر دقيقتين وأعد التحليل للحصول على إشارة أدق.",
        {
          reply_markup: {
            inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]],
          },
        },
      );
    }

    sessions[chatId].asset = asset;
    log("INFO", "analysis_requested", { chatId, asset });

    await bot.sendMessage(chatId, `⌛ جاري تحليل ${asset}...`);

    let result;
    try {
      result = await analyze(asset);
    } catch (err) {
      log("ERROR", "analysis_failed", { chatId, asset, error: err.message });
      return bot.sendMessage(
        chatId,
        "❌ خطأ في جلب بيانات السوق. تحقق من مفتاح TwelveData أو حاول لاحقاً.",
        {
          reply_markup: {
            inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]],
          },
        },
      );
    }

    log("INFO", "analysis_done", {
      chatId,
      asset,
      signal: result.signal,
      confidence: result.confidence,
      grade: result.grade,
    });

    const replyText = result.noTrade
      ? `📊 نتيجة التحليل — ${asset}\n\nالنتيجة: ${result.signal}\n\n📌 السبب: ${result.reason}\n\n━━━━━━━━━━━━━━━━━━\n🎯 المنصة: Pocket Option — سوق حقيقي\n⚠️ القرار النهائي عليك أنت.`
      : `📊 نتيجة التحليل — ${asset}\n\nالنتيجة: ${result.signal}\n\n🎯 نسبة الثقة: ${result.confidence}%\n🏅 التقييم: ${result.grade}\n\n✅ الأسباب: ${result.reason}\n\n━━━━━━━━━━━━━━━━━━\n🎯 المنصة: Pocket Option — سوق حقيقي\n⚠️ القرار النهائي عليك أنت. لا تعتمد على إشارة واحدة.`;

    return bot.sendMessage(chatId, replyText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔁 تحليل زوج آخر", callback_data: "start_analysis" }],
          [{ text: "🏠 الرئيسية", callback_data: "home" }],
        ],
      },
    });
  }
});

// ─── Global Error Handlers ────────────────────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  log("ERROR", "unhandledRejection", { reason: String(reason) });
});

process.on("uncaughtException", (err) => {
  log("ERROR", "uncaughtException", { error: err.message, stack: err.stack });
});

log("INFO", "bot_started", { note: "Pocket Option analysis bot is running" });
