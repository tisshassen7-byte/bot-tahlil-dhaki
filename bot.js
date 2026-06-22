/**
 * بوت تحليل Pocket Option - سوق حقيقي فقط
 * الأزواج: جميع أزواج الفوركس الرئيسية والثانوية الموثوقة
 * وقت العمل: 24/7
 */

const TelegramBot = require("node-telegram-bot-api");
const http = require("http");
const fetch = require("node-fetch");

// ─── Environment Variables ────────────────────────────────────────────────────
const token   = process.env.TELEGRAM_TOKEN;
const apiKey  = process.env.TWELVE_API_KEY;
const OWNER_ID = parseInt(process.env.OWNER_ID, 10); // معرّف المالك الوحيد المسموح له

if (!token)   throw new Error("TELEGRAM_TOKEN غير موجود في البيئة");
if (!apiKey)  throw new Error("TWELVE_API_KEY غير موجود في البيئة");
if (!OWNER_ID || isNaN(OWNER_ID)) throw new Error("OWNER_ID غير موجود في البيئة — أضف معرّف Telegram الخاص بك");

// ─── Access Guard ─────────────────────────────────────────────────────────────
function isOwner(chatId) {
  return chatId === OWNER_ID;
}

// ─── Bot Initialization ───────────────────────────────────────────────────────
const bot = new TelegramBot(token, { polling: true });

// ─── State ────────────────────────────────────────────────────────────────────
const sessions = {}; // جلسة كل مستخدم
// التوقيت ثابت: Europe/Paris (يشمل التوقيت الصيفي تلقائياً)
function parisNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Paris" }));
}
function parisTimeStr(now = new Date()) {
  return now.toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
}

// ─── Keep-alive Server (Railway) ──────────────────────────────────────────────
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is alive");
  })
  .listen(process.env.PORT || 8080);

// ─── Constants ────────────────────────────────────────────────────────────────
// أزواج الفوركس المتاحة على Pocket Option و TwelveData
const ALLOWED_ASSETS = [
  // ── الأزواج الرئيسية (Majors)
  "EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF",
  "USD/CAD", "AUD/USD", "NZD/USD",
  // ── EUR crosses
  "EUR/JPY", "EUR/GBP", "EUR/CHF", "EUR/CAD", "EUR/AUD", "EUR/NZD",
  // ── GBP crosses
  "GBP/JPY", "GBP/CHF", "GBP/CAD", "GBP/AUD", "GBP/NZD",
  // ── AUD crosses
  "AUD/JPY", "AUD/CAD", "AUD/CHF", "AUD/NZD",
  // ── NZD crosses
  "NZD/JPY", "NZD/CAD", "NZD/CHF",
  // ── أخرى
  "CAD/JPY", "CAD/CHF", "CHF/JPY",
];

// فترات زمنية عالية الخطر (UTC) - أخبار اقتصادية متكررة
const HIGH_IMPACT_UTC_RANGES = [
  { h: 8, m: 28, endH: 8, endM: 35 }, // بداية الجلسة الأوروبية + أخبار
  { h: 12, m: 28, endH: 12, endM: 35 }, // قبل الجلسة الأمريكية
  { h: 13, m: 25, endH: 13, endM: 40 }, // فتح سوق نيويورك + أخبار
  { h: 15, m: 0, endH: 15, endM: 5 }, // أخبار أمريكية متكررة
  { h: 18, m: 0, endH: 18, endM: 5 }, // إغلاق لندن
];

const MIN_CONFIDENCE = 58; // حد أدنى للثقة (رُفع بخطوة صغيرة فقط عن الأصلي 57)
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

// ─── Candle Quality (آخر شمعة مغلقة — index -2 — وليس الشمعة الحية) ──────────
function candleQuality(candles) {
  // نستخدم الشمعة المغلقة الأخيرة (قبل الأخيرة) لتجنب ضوضاء الشمعة الحية
  const c    = candles[candles.length - 2];
  const prev = candles[candles.length - 3];
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low || 0.000001;
  const bodyRatio = body / range;

  // شمعة قوية: اتجاه واضح + جسم ≥ 45% + أغلقت في اتجاه الحركة
  const bullish     = c.close > c.open && c.close > prev.close && bodyRatio >= 0.45;
  const bearish     = c.close < c.open && c.close < prev.close && bodyRatio >= 0.45;

  // شمعة ضعيفة: اتجاه بسيط بجسم ≥ 30% (لا يشترط التفوق على الإغلاق السابق)
  const bullishWeak = !bullish && c.close > c.open && bodyRatio >= 0.30;
  const bearishWeak = !bearish && c.close < c.open && bodyRatio >= 0.30;

  return { bullish, bearish, bullishWeak, bearishWeak, bodyRatio };
}

// ─── Multi-candle Trend Confirmation (شموع مغلقة فقط — آخر 5 مغلقة) ──────────
function trendConfirmation(candles) {
  // نستثني الشمعة الحية الأخيرة، نأخذ 5 شموع مغلقة قبلها
  const last5 = candles.slice(-6, -1);
  let upCount = 0, downCount = 0;
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
    log("WARN", "twelvedata_retry", { symbol, err: err.message });
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

  // ── ميل EMA9 (زخم قصير المدى — مقارنة الشمعة المغلقة بالسابقة لها)
  const ema9Prev  = ema(closes.slice(0, -1), 9); // EMA9 على الشمعة المغلقة قبل الأخيرة
  const ema9Slope = ema9 !== null && ema9Prev !== null ? ema9 - ema9Prev : 0;

  // ── Scoring
  let buyScore = 0, sellScore = 0;
  const buyReasons = [], sellReasons = [];

  // ── [1] ترند EMA — أساس التحليل (قوي=35، معتدل=20)
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

  // طرح عند EMAs متلاصقة جداً (السوق في حالة تردد)
  if (emaSep < 0.00005) {
    buyScore  -= 8;
    sellScore -= 8;
  }

  // ── [2] RSI — نطاقات أصلية واسعة (لا تُضيَّق في الترند)
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
  // عقوبة تشبع حاد فقط في غياب الترند (أصلية)
  if (r > 90 && !anyUp)   buyScore  -= 15;
  if (r < 10 && !anyDown) sellScore -= 15;

  // ── [3] ميل EMA9 — مكافأة إضافية صغيرة فقط (لا عقوبة)
  if (ema9Slope > 0) {
    buyScore  += 5;
    buyReasons.push("EMA9 صاعد");
  } else if (ema9Slope < 0) {
    sellScore += 5;
    sellReasons.push("EMA9 هابط");
  }

  // ── [4] الشمعة المغلقة الأخيرة — تأكيد وليس شرطاً، بدون أي عقوبة
  // شمعة قوية = +15 (نفس الأصل) | شمعة ضعيفة = +5 مكافأة إضافية فقط
  if (candle.bullish) {
    buyScore  += 15;
    buyReasons.push("شمعة مغلقة صاعدة قوية");
  } else if (candle.bullishWeak) {
    buyScore  += 5;
    buyReasons.push("شمعة مغلقة صاعدة");
  }
  if (candle.bearish) {
    sellScore += 15;
    sellReasons.push("شمعة مغلقة هابطة قوية");
  } else if (candle.bearishWeak) {
    sellScore += 5;
    sellReasons.push("شمعة مغلقة هابطة");
  }
  // شمعة مخالفة أو محايدة → لا عقوبة (كما في الأصل)

  // ── [5] مكافأة الزخم المتوافق: ترند + RSI + شمعة (أصلية + تشمل الضعيفة)
  if (anyUp   && rsiBuyOk  && (candle.bullish || candle.bullishWeak)) {
    buyScore  += 7;
    buyReasons.push("زخم متوافق");
  }
  if (anyDown && rsiSellOk && (candle.bearish || candle.bearishWeak)) {
    sellScore += 7;
    sellReasons.push("زخم متوافق");
  }

  // ── [6] تأكيد متعدد الشموع المغلقة (3 من 5 مغلقة)
  if (trendConf.upCount >= 3) {
    buyScore  += 12;
    buyReasons.push(`${trendConf.upCount}/5 شموع مغلقة صاعدة`);
  }
  if (trendConf.downCount >= 3) {
    sellScore += 12;
    sellReasons.push(`${trendConf.downCount}/5 شموع مغلقة هابطة`);
  }

  // ── [7] دعم ومقاومة
  if (!nearResistance) {
    buyScore  += 10;
    buyReasons.push("بعيد عن مقاومة");
  } else if (!anyUp) {
    buyScore  -= 12;
  }
  if (!nearSupport) {
    sellScore += 10;
    sellReasons.push("بعيد عن دعم");
  } else if (!anyDown) {
    sellScore -= 12;
  }

  // ── [8] تذبذب معتدل (سوق نشط وليس عنيفاً)
  if (volRatio >= 0.00015 && volRatio <= 0.003) {
    buyScore  += 8;
    sellScore += 8;
  }

  // ── صفر مطلق ضد الترند القوي فقط (لا تعكس ترنداً قوياً)
  if (strongDown) buyScore  = 0;
  if (strongUp)   sellScore = 0;
  // في الترند المعتدل: اخفض العكسية بدلاً من صفرها
  if (modDown && buyScore  > 10) buyScore  = 10;
  if (modUp   && sellScore > 10) sellScore = 10;

  // ── Final Decision
  const dominant      = buyScore > sellScore ? "BUY" : "SELL";
  const dominantScore = dominant === "BUY" ? buyScore  : sellScore;
  const opposite      = dominant === "BUY" ? sellScore : buyScore;
  const reasons       = dominant === "BUY" ? buyReasons : sellReasons;

  if (dominantScore < MIN_CONFIDENCE)
    return noTrade(`⚪ الثقة غير كافية (${dominantScore}%) — الجودة أهم من الكمية`);
  if (dominantScore - opposite < 7)
    return noTrade("⚪ إشارة متعارضة: لا أفضلية واضحة بين BUY و SELL");

  const confidence = Math.min(93, dominantScore);
  return {
    signal:     dominant === "BUY" ? "🟢 BUY" : "🔴 SELL",
    confidence,
    grade:      grade(confidence),
    reason:     reasons.join(" ✦ "),
    noTrade:    false,
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

// ─── Welcome Image ────────────────────────────────────────────────────────────
// صورة ترحيبية بأسلوب سايبر-تداول — استبدلها برابط صورتك الخاصة إن أردت
const WELCOME_IMAGE_URL =
  "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1280&q=80";

// ─── UI Helpers ───────────────────────────────────────────────────────────────
function sendWelcome(chatId) {
  const caption = [
    "📡 *رادار السوق*",
    "━━━━━━━━━━━━━━━━━━",
    "منصة تحليل الفوركس الاحترافية",
    "سوق حقيقي · توقيت فرنسا · خاص بك",
    "━━━━━━━━━━━━━━━━━━",
    "⚠️ للتحليل فقط — القرار النهائي عليك أنت.",
  ].join("\n");

  return bot.sendPhoto(chatId, WELCOME_IMAGE_URL, {
    caption,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "▶️ ابدأ الآن", callback_data: "show_menu" }],
      ],
    },
  }).catch(() =>
    // إذا فشل تحميل الصورة، أرسل النص مباشرة
    bot.sendMessage(chatId, caption, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "▶️ ابدأ الآن", callback_data: "show_menu" }],
        ],
      },
    }),
  );
}

function mainMenu(chatId) {
  return bot.sendMessage(
    chatId,
    "📡 *رادار السوق* — القائمة الرئيسية",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📊 تحليل زوج فردي", callback_data: "start_analysis" }],
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



// ─── Suggested Entry Time (5min candle logic) ─────────────────────────────────
function suggestedEntry() {
  const paris = parisNow();
  const mins = paris.getMinutes();
  const secs = paris.getSeconds();
  const posInCandle = mins % 5; // 0..4: موقع داخل الشمعة الحالية

  // أول دقيقتين من الشمعة → دخول فوري
  if (posInCandle === 0 || (posInCandle === 1 && secs < 30)) {
    return { label: "الآن 🟢", waitMins: 0 };
  }

  // انتظر فتح الشمعة التالية
  const minsToNext = 5 - posInCandle;
  const next = new Date(paris.getTime() + minsToNext * 60 * 1000);
  const timeStr = `${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`;
  const waitLabel = minsToNext === 1 ? "دقيقة واحدة" : `${minsToNext} دقائق`;
  return { label: `${timeStr} (خلال ${waitLabel}) ⏳`, waitMins: minsToNext };
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isOwner(chatId)) { log("WARN", "blocked_user", { chatId }); return; }
  sessions[chatId] = {};
  log("INFO", "/start", { chatId });
  sendWelcome(chatId);
});

// ─── Callback Handler ─────────────────────────────────────────────────────────
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = q.data;

  if (!isOwner(chatId)) {
    log("WARN", "blocked_callback", { chatId });
    await bot.answerCallbackQuery(q.id).catch(() => {});
    return;
  }
  await bot.answerCallbackQuery(q.id).catch(() => {});
  if (!sessions[chatId]) sessions[chatId] = {};

  if (data === "home" || data === "show_menu") return mainMenu(chatId);
  if (data === "start_analysis") return assetMenu(chatId);

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

    const entry = suggestedEntry();
    const replyText = result.noTrade
      ? `📊 نتيجة التحليل — ${asset}\n\nالنتيجة: ${result.signal}\n\n📌 السبب: ${result.reason}\n\n━━━━━━━━━━━━━━━━━━\n🎯 المنصة: Pocket Option — سوق حقيقي\n⚠️ القرار النهائي عليك أنت.`
      : `📊 نتيجة التحليل — ${asset}\n\nالنتيجة: ${result.signal}\n⏰ وقت الدخول: ${entry.label}\n\n🎯 نسبة الثقة: ${result.confidence}%\n🏅 التقييم: ${result.grade}\n\n✅ الأسباب: ${result.reason}\n\n━━━━━━━━━━━━━━━━━━\n🎯 المنصة: Pocket Option — سوق حقيقي\n⚠️ القرار النهائي عليك أنت. لا تعتمد على إشارة واحدة.`;

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

log("INFO", "bot_started", { note: "Pocket Option analysis bot is running — private mode" });
