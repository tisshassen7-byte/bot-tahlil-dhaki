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
// جميع أزواج الفوركس الرئيسية والثانوية الموثوقة على Pocket Option و TwelveData
const ALLOWED_ASSETS = [
  // ── الأزواج الرئيسية (Majors)
  "EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF",
  "USD/CAD", "AUD/USD", "NZD/USD",
  // ── الأزواج الثانوية — EUR crosses
  "EUR/JPY", "EUR/GBP", "EUR/CHF", "EUR/CAD", "EUR/AUD",
  // ── الأزواج الثانوية — GBP crosses
  "GBP/JPY", "GBP/CHF", "GBP/CAD", "GBP/AUD",
  // ── الأزواج الثانوية — أخرى
  "AUD/JPY", "AUD/CAD", "CAD/JPY", "CHF/JPY", "NZD/JPY",
];

// أقوى 10 أزواج فوركس — تُستخدم في المسح اليدوي
const TOP_10_PAIRS = [
  "EUR/USD", "GBP/USD", "USD/JPY", "EUR/JPY",
  "GBP/JPY", "AUD/USD", "USD/CAD", "USD/CHF",
  "EUR/GBP", "NZD/USD",
];

// فترات زمنية عالية الخطر (UTC) - أخبار اقتصادية متكررة
const HIGH_IMPACT_UTC_RANGES = [
  { h: 8, m: 28, endH: 8, endM: 35 }, // بداية الجلسة الأوروبية + أخبار
  { h: 12, m: 28, endH: 12, endM: 35 }, // قبل الجلسة الأمريكية
  { h: 13, m: 25, endH: 13, endM: 40 }, // فتح سوق نيويورك + أخبار
  { h: 15, m: 0, endH: 15, endM: 5 }, // أخبار أمريكية متكررة
  { h: 18, m: 0, endH: 18, endM: 5 }, // إغلاق لندن
];

const MIN_CONFIDENCE = 65; // حد أدنى للثقة — مرفوع لتقليل الإشارات الضعيفة
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

// ─── Quiet Session Filter (ناعم — لا يحجب الإشارات) ──────────────────────────
// جلسات منخفضة السيولة بتوقيت UTC:
//   00:00–06:59 → فجوة آسيوية (انتشار واسع على الأزواج الأوروبية)
//   21:00–23:59 → ما بعد إغلاق نيويورك (حجم خفيف جداً)
function quietSession() {
  const h = new Date().getUTCHours();
  const isQuiet = h < 7 || h >= 21;
  const warning = isQuiet
    ? "⚠️ جلسة هادئة — سيولة منخفضة، الإشارة أقل موثوقية"
    : null;
  return { isQuiet, warning };
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

// ─── Synthetic Higher-Timeframe (no extra API call) ──────────────────────────
// يجمع كل groupSize شموع 5-دقائق في شمعة واحدة محاكاة للإطار الأعلى (15 دقيقة)
function syntheticHTF(candles, groupSize = 3) {
  const grouped = [];
  for (let i = 0; i + groupSize <= candles.length; i += groupSize) {
    const g = candles.slice(i, i + groupSize);
    grouped.push({
      open:  g[0].open,
      high:  Math.max(...g.map((c) => c.high)),
      low:   Math.min(...g.map((c) => c.low)),
      close: g[g.length - 1].close,
    });
  }
  return grouped;
}

// يحدد اتجاه الإطار الأعلى باستخدام EMA9 و EMA21 على الشموع المحاكاة
function htfBias(candles5min) {
  const htf = syntheticHTF(candles5min, 3); // 5min → ~15min
  if (htf.length < 22) return { htfUp: false, htfDown: false, htfClear: false };
  const htfCloses = htf.map((c) => c.close);
  const htfE9  = ema(htfCloses, 9);
  const htfE21 = ema(htfCloses, 21);
  if (!htfE9 || !htfE21) return { htfUp: false, htfDown: false, htfClear: false };
  const htfLast = htfCloses[htfCloses.length - 1];
  const htfUp   = htfE9 > htfE21 && htfLast > htfE21;
  const htfDown = htfE9 < htfE21 && htfLast < htfE21;
  return { htfUp, htfDown, htfClear: htfUp || htfDown };
}

// ─── Suggested Expiry (توصية مدة الصفقة) ─────────────────────────────────────
// يعطي توصية عربية بناءً على التذبذب وقوة الترند
function suggestExpiry(volRatio, isStrongTrend) {
  // سوق هادئ جداً: السعر يتحرك ببطء — دقيقة واحدة غير كافية
  if (volRatio < 0.0002) return "5 دقائق";
  // تذبذب مرتفع جداً: السوق صاخب — تقليل وقت التعرض
  if (volRatio > 0.002)  return "دقيقة واحدة";
  // تذبذب معتدل: يُفضَّل 5 دقائق مع ترند قوي، دقيقة مع ترند معتدل
  return isStrongTrend ? "5 دقائق" : "دقيقة واحدة";
}

// ─── Candle Quality ───────────────────────────────────────────────────────────
function candleQuality(candles) {
  const c = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low || 0.000001;
  const bodyRatio = body / range;
  const bullish = c.close > c.open && c.close > prev.close && bodyRatio >= 0.55; // مرفوع: شمعة صاعدة أقوى
  const bearish = c.close < c.open && c.close < prev.close && bodyRatio >= 0.55; // مرفوع: شمعة هابطة أقوى
  return { bullish, bearish, bodyRatio };
}

// ─── Candle Pattern Detector (تأكيد فقط — لا تُطلق إشارة منفردة) ─────────────
function candlePatterns(candles) {
  if (candles.length < 2) return [];
  const c    = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const cBody      = Math.abs(c.close - c.open);
  const cRange     = c.high - c.low || 0.000001;
  const cBodyTop   = Math.max(c.open, c.close);
  const cBodyBot   = Math.min(c.open, c.close);
  const cUpperWick = c.high  - cBodyTop;
  const cLowerWick = cBodyBot - c.low;

  const prevBodyTop = Math.max(prev.open, prev.close);
  const prevBodyBot = Math.min(prev.open, prev.close);

  const found = [];

  // ── ابتلاع صاعد: شمعة صاعدة تبتلع جسم الشمعة الهابطة السابقة
  if (
    c.close > c.open &&
    prev.close < prev.open &&
    cBodyBot <= prevBodyBot &&
    cBodyTop >= prevBodyTop &&
    cBody > 0.5 * cRange       // جسم قوي
  ) {
    found.push({ name: "ابتلاع صاعد", bullish: true, score: 10 });
  }

  // ── ابتلاع هابط: شمعة هابطة تبتلع جسم الشمعة الصاعدة السابقة
  if (
    c.close < c.open &&
    prev.close > prev.open &&
    cBodyTop >= prevBodyTop &&
    cBodyBot <= prevBodyBot &&
    cBody > 0.5 * cRange
  ) {
    found.push({ name: "ابتلاع هابط", bullish: false, score: 10 });
  }

  // ── مطرقة / باين بار صاعد: ذيل سفلي طويل، إغلاق في النصف العلوي
  if (
    cLowerWick >= 2 * Math.max(cBody, 0.000001) &&
    cLowerWick > cUpperWick * 2 &&
    c.close > (c.high + c.low) / 2
  ) {
    found.push({ name: "مطرقة / باين بار صاعد", bullish: true, score: 8 });
  }

  // ── نجمة ساقطة / باين بار هابط: ذيل علوي طويل، إغلاق في النصف السفلي
  if (
    cUpperWick >= 2 * Math.max(cBody, 0.000001) &&
    cUpperWick > cLowerWick * 2 &&
    c.close < (c.high + c.low) / 2
  ) {
    found.push({ name: "نجمة ساقطة / باين بار هابط", bullish: false, score: 8 });
  }

  return found;
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

// ─── S/R Zone Detection (مناطق دعم ومقاومة قوية بالقمم والقيعان) ─────────────
// يحدد مناطق ذات لمسات متعددة ويفحص مدى قرب السعر منها
function srZones(candles) {
  const slice = candles.slice(-70); // آخر 70 شمعة
  const last  = slice[slice.length - 1].close;

  // جمع القمم والقيعان المحورية (pivot highs / pivot lows)
  const swingHighs = [];
  const swingLows  = [];
  for (let i = 1; i < slice.length - 1; i++) {
    if (slice[i].high > slice[i - 1].high && slice[i].high > slice[i + 1].high) {
      swingHighs.push(slice[i].high);
    }
    if (slice[i].low < slice[i - 1].low && slice[i].low < slice[i + 1].low) {
      swingLows.push(slice[i].low);
    }
  }

  // تجميع النقاط المتقاربة في مناطق (zone clustering)
  const CLUSTER_PCT = 0.0015; // 0.15% هامش التجميع
  function cluster(points) {
    const zones = [];
    for (const p of points) {
      const z = zones.find((z) => Math.abs(z.price - p) / p < CLUSTER_PCT);
      if (z) { z.price = (z.price + p) / 2; z.touches++; }
      else    { zones.push({ price: p, touches: 1 }); }
    }
    return zones.filter((z) => z.touches >= 2); // منطقة قوية: لمستان أو أكثر
  }

  const PROX = 0.002; // 0.2% قرب السعر من المنطقة
  const resistZones = cluster(swingHighs).filter((z) => z.price > last);
  const supportZones = cluster(swingLows).filter((z) => z.price < last);

  const nearStrongResistance = resistZones.some(
    (z) => (z.price - last) / last < PROX,
  );
  const nearStrongSupport = supportZones.some(
    (z) => (last - z.price) / last < PROX,
  );

  return { nearStrongResistance, nearStrongSupport };
}

// ─── Grade ────────────────────────────────────────────────────────────────────
function grade(score) {
  if (score >= 90) return "A";
  if (score >= 82) return "B"; // رُفع من 78 — Grade B يتطلب إعداداً أنظف
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
  const srCheck = srZones(candles);

  // ── Hard filters (خطر حقيقي فقط)
  if (tooDead)
    return noTrade("⚪ السوق راكد: الحركة ضعيفة جداً ولا تستحق الدخول");
  if (tooWild) return noTrade("🔴 تذبذب شديد: الخطر عالٍ جداً");
  if (!anyUp && !anyDown)
    return noTrade("⚪ لا يوجد اتجاه: EMAs متشابكة في جميع الاتجاهات");
  // EMAs متقاربة جداً بدون ترند قوي = سوق فوضوي
  if (emaSep < 0.00005 && !strongUp && !strongDown)
    return noTrade("⚪ EMAs متشابكة: لا اتجاه واضح — سوق فوضوي");

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

  // RSI — نطاق واسع في الترند
  const rsiBuyOk  = anyUp   ? (r >= 38 && r <= 85) : (r >= 45 && r <= 70);
  const rsiSellOk = anyDown ? (r >= 15 && r <= 62) : (r >= 30 && r <= 55);
  if (rsiBuyOk) {
    buyScore += 18;
    buyReasons.push(`RSI=${r.toFixed(0)} مناسب شراء`);
  }
  if (rsiSellOk) {
    sellScore += 18;
    sellReasons.push(`RSI=${r.toFixed(0)} مناسب بيع`);
  }
  // عقوبة قوية عند تشبع شرائي/بيعي حاد بدون ترند قوي
  if (r > 80 && !strongUp)   buyScore  -= 20;
  if (r < 20 && !strongDown) sellScore -= 20;
  if (r > 90 && !anyUp)      buyScore  -= 15;
  if (r < 10 && !anyDown)    sellScore -= 15;

  // عقوبة شمعة ضعيفة (doji / تردد): إشارة متضاربة
  if (candle.bodyRatio < 0.35) {
    buyScore  -= 14;
    sellScore -= 14;
  }

  // جودة الشمعة الأخيرة
  if (candle.bullish) {
    buyScore += 15;
    buyReasons.push("شمعة صاعدة قوية");
  }
  if (candle.bearish) {
    sellScore += 15;
    sellReasons.push("شمعة هابطة قوية");
  }

  // مكافأة الزخم: ترند + RSI + شمعة متوافقة معاً
  if (anyUp   && rsiBuyOk  && candle.bullish) { buyScore  += 7; buyReasons.push("زخم متوافق"); }
  if (anyDown && rsiSellOk && candle.bearish) { sellScore += 7; sellReasons.push("زخم متوافق"); }

  // تأكيد متعدد الشموع — 4/5 للمكافأة الكاملة، 3/5 للمكافأة الجزئية فقط
  if (trendConf.upCount >= 4) {
    buyScore += 12;
    buyReasons.push(`${trendConf.upCount}/5 شموع صاعدة`);
  } else if (trendConf.upCount === 3) {
    buyScore += 5;
    buyReasons.push(`${trendConf.upCount}/5 شموع صاعدة`);
  }
  if (trendConf.downCount >= 4) {
    sellScore += 12;
    sellReasons.push(`${trendConf.downCount}/5 شموع هابطة`);
  } else if (trendConf.downCount === 3) {
    sellScore += 5;
    sellReasons.push(`${trendConf.downCount}/5 شموع هابطة`);
  }

  // أنماط الشموع — تأكيد فقط، لا تُطلق إشارة منفردة
  // يتم تطبيقها قبل الصفر العكسي للترند، لذا لن تنقذ أي إشارة عكسية
  const patterns = candlePatterns(candles);
  for (const p of patterns) {
    if (p.bullish) { buyScore  += p.score; buyReasons.push(p.name);  }
    else            { sellScore += p.score; sellReasons.push(p.name); }
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

  // ── صفر مطلق ضد الترند — القوي والمعتدل على حدٍّ سواء
  if (strongDown) buyScore = 0;
  if (strongUp)   sellScore = 0;
  // الترند المعتدل: إلغاء كامل للإشارة العكسية (بدلاً من الحد السابق 10)
  if (modDown) buyScore  = 0;
  if (modUp)   sellScore = 0;

  // ── Final Decision
  const dominant = buyScore > sellScore ? "BUY" : "SELL";
  const dominantScore = dominant === "BUY" ? buyScore : sellScore;
  const opposite = dominant === "BUY" ? sellScore : buyScore;
  const reasons = dominant === "BUY" ? buyReasons : sellReasons;

  if (dominantScore < MIN_CONFIDENCE)
    return noTrade(
      `⚪ الثقة غير كافية (${dominantScore}%) — الجودة أهم من الكمية`,
    );
  // فجوة أوسع: فرق أقل من 18 نقطة = إشارة غير حاسمة
  if (dominantScore - opposite < 18)
    return noTrade("⚪ إشارة غير حاسمة: لا أفضلية واضحة بين BUY و SELL");

  // الترند المعتدل يُسقَّف عند 88% — Grade A محجوزة للترند القوي فقط
  const isStrongTrend = dominant === "BUY" ? strongUp : strongDown;
  const rawConfidence = isStrongTrend
    ? Math.min(93, dominantScore)
    : Math.min(88, dominantScore);

  // ── فلتر الإطار الزمني الأعلى (خفيف — بدون طلبات API إضافية)
  // يُشتق اتجاه ~15 دقيقة من تجميع شموع 5 دقائق الموجودة
  const { htfUp, htfDown, htfClear } = htfBias(candles);
  const htfConflict  = (dominant === "BUY"  && htfDown)
                     || (dominant === "SELL" && htfUp);
  const htfConfirms  = (dominant === "BUY"  && htfUp)
                     || (dominant === "SELL" && htfDown);

  let confidence = rawConfidence;
  if (htfConflict) {
    // تعارض مع الإطار الأعلى: خصم خفيف 10 نقاط
    confidence = rawConfidence - 10;
    if (confidence < MIN_CONFIDENCE)
      return noTrade("⚪ تعارض مع اتجاه ~15 دقيقة — إشارة ضعيفة");
  } else if (htfConfirms) {
    // توافق مع الإطار الأعلى: مكافأة خفيفة 4 نقاط
    const ceil = isStrongTrend ? 93 : 88;
    confidence = Math.min(ceil, rawConfidence + 4);
  }
  // إذا كان الإطار الأعلى غير واضح (htfClear=false): لا تغيير

  // ── فلتر الجلسة الهادئة (ناعم — يخفض الثقة فقط، لا يحجب الإشارة)
  const { isQuiet, warning: sessionWarning } = quietSession();
  const finalConfidence = isQuiet
    ? Math.max(0, confidence - 7)
    : confidence;

  // إذا أدى الخصم إلى انخفاض عن الحد الأدنى، أعد التحقق ولكن لا تحجب تلقائياً
  if (finalConfidence < MIN_CONFIDENCE) {
    return noTrade(
      sessionWarning
        ? `⚪ الثقة غير كافية بعد خصم الجلسة الهادئة (${finalConfidence}%)`
        : `⚪ الثقة غير كافية (${finalConfidence}%) — الجودة أهم من الكمية`,
    );
  }

  // ── مناطق الدعم والمقاومة القوية (ناعم — تحذير + خصم خفيف فقط)
  let zoneConfidence = finalConfidence;
  if (dominant === "BUY" && srCheck.nearStrongResistance) {
    reasons.push("⚠️ قريب من مقاومة قوية — توخَّ الحذر");
    zoneConfidence = Math.max(0, finalConfidence - 5);
  } else if (dominant === "SELL" && srCheck.nearStrongSupport) {
    reasons.push("⚠️ قريب من دعم قوي — توخَّ الحذر");
    zoneConfidence = Math.max(0, finalConfidence - 5);
  }
  // إذا أسقط الخصم الإشارة، أعد رفضها بتوضيح السبب
  if (zoneConfidence < MIN_CONFIDENCE) {
    return noTrade(`⚪ الثقة غير كافية بعد احتساب المنطقة (${zoneConfidence}%)`);
  }

  return {
    signal: dominant === "BUY" ? "🟢 BUY" : "🔴 SELL",
    confidence: zoneConfidence,
    grade: grade(zoneConfidence),
    reason: reasons.join(" ✦ "),
    expiry: suggestExpiry(volRatio, isStrongTrend),
    sessionWarning,
    meta: {
      trendStrong: dominant === "BUY" ? strongUp : strongDown,
      trendUp:     dominant === "BUY",
      rsi:         r,
      candleDir:   dominant === "BUY" ? candle.bullish : candle.bearish,
      nearZone:    dominant === "BUY" ? srCheck.nearStrongResistance : srCheck.nearStrongSupport,
    },
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

// ─── Signal Checklist (بصري فقط — لا يؤثر على الإشارات) ─────────────────────
function buildChecklist(result) {
  const isBuy = result.signal.includes("BUY");
  const m = result.meta;

  const trendIcon = m.trendStrong ? "✅" : "⚠️";
  const trendText = m.trendStrong
    ? (isBuy ? "ترند صاعد قوي"    : "ترند هابط قوي")
    : (isBuy ? "ترند صاعد معتدل" : "ترند هابط معتدل");

  const rsiOk   = isBuy ? (m.rsi >= 38 && m.rsi <= 85) : (m.rsi >= 15 && m.rsi <= 62);
  const rsiIcon = rsiOk ? "✅" : "⚠️";

  const candleIcon = m.candleDir ? "✅" : "⚠️";
  const candleText = m.candleDir
    ? (isBuy ? "شمعة صاعدة مؤكدة"  : "شمعة هابطة مؤكدة")
    : (isBuy ? "شمعة غير مؤكدة"   : "شمعة غير مؤكدة");

  const zoneIcon = m.nearZone ? "⚠️" : "✅";
  const zoneText = m.nearZone
    ? (isBuy ? "قرب مقاومة قوية" : "قرب دعم قوي")
    : "بعيد عن مناطق خطر";

  const sessionIcon = result.sessionWarning ? "⚠️" : "✅";
  const sessionText = result.sessionWarning ? "جلسة هادئة" : "جلسة نشطة";

  return [
    `📋 ملخص سريع:`,
    `${trendIcon} الترند: ${trendText}`,
    `${rsiIcon} RSI: ${m.rsi.toFixed(0)}`,
    `${candleIcon} الشمعة: ${candleText}`,
    `${zoneIcon} المنطقة: ${zoneText}`,
    `${sessionIcon} الجلسة: ${sessionText}`,
  ].join("\n");
}

// ─── Welcome Image ────────────────────────────────────────────────────────────
// صورة ترحيبية بأسلوب سايبر-تداول — استبدلها برابط صورتك الخاصة إن أردت
const WELCOME_IMAGE_URL =
  "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1280&q=80";

// ─── UI Helpers ───────────────────────────────────────────────────────────────
function sendWelcome(chatId) {
  const caption = [
    "📡 *رادار السوق*",
    "═══════════════════",
    "منصة تحليل الفوركس الاحترافية",
    "سوق حقيقي · توقيت فرنسا · خاص بك",
    "═══════════════════",
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
    [
      "📡 *رادار السوق*",
      "═══════════════════",
      "تحليل فوركس احترافي · 24/7",
      "═══════════════════",
      "اختر الخدمة:",
    ].join("\n"),
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔍 مسح أقوى 10 أزواج", callback_data: "scan_all"       }],
          [{ text: "🔥 صفقة VIP",           callback_data: "vip_trade"      }],
          [{ text: "📊 تحليل زوج فردي",    callback_data: "start_analysis" }],
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
  return bot.sendMessage(
    chatId,
    "📊 *تحليل زوج فردي*\n═══════════════════\nاختر الزوج من السوق الحقيقي:",
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: rows },
    },
  );
}


// ─── Scan All Pairs ───────────────────────────────────────────────────────────
async function scanAllPairs(chatId, statusMsgId, pairs = TOP_10_PAIRS) {
  const buys  = [];
  const sells = [];
  const total = pairs.length;

  for (let i = 0; i < total; i++) {
    const asset = pairs[i];

    // تحديث رسالة التقدم كل 4 أزواج
    if (i % 4 === 0) {
      await bot.editMessageText(
        `🔍 جاري مسح الأزواج...\n⏳ ${i} / ${total} — يرجى الانتظار`,
        { chat_id: chatId, message_id: statusMsgId },
      ).catch(() => {});
    }

    try {
      const result = await analyze(asset);
      // Grade C مُستبعدة من نتائج المسح — الجودة فقط (A و B)
      if (!result.noTrade && result.grade !== "C") {
        const entry = { asset, signal: result.signal, confidence: result.confidence, grade: result.grade, reason: result.reason };
        if (result.signal.includes("BUY"))  buys.push(entry);
        else                                 sells.push(entry);
      }
    } catch {
      // تجاهل أخطاء الأزواج الفردية لإكمال المسح
    }

    // تأخير بسيط لتجنب تجاوز حد معدل TwelveData (8 طلبات/دقيقة مجانية)
    if (i < total - 1) await new Promise((r) => setTimeout(r, 1200));
  }

  return { buys, sells };
}

// ─── VIP Trade Scanner ────────────────────────────────────────────────────────
// يبحث عن أفضل صفقة واحدة بجودة ذهبية (Grade A أو B نظيف فقط)
async function scanVIP(chatId, statusMsgId) {
  const candidates = [];
  const total = TOP_10_PAIRS.length;

  for (let i = 0; i < total; i++) {
    const asset = TOP_10_PAIRS[i];

    if (i % 3 === 0) {
      await bot.editMessageText(
        `🔥 جاري البحث عن صفقة VIP...\n⏳ ${i} / ${total} — يرجى الانتظار`,
        { chat_id: chatId, message_id: statusMsgId },
      ).catch(() => {});
    }

    try {
      const result = await analyze(asset);
      if (!result.noTrade && result.grade !== "C") {
        const isGradeA = result.grade === "A";
        // Grade B مقبول فقط إذا كان نظيفاً: بعيد عن مناطق خطر وجلسة نشطة
        const isCleanB = result.grade === "B"
          && !result.meta.nearZone
          && !result.sessionWarning;

        if (isGradeA || isCleanB) {
          // يُفضَّل Grade A بإضافة نقاط وهمية للترتيب
          const vipScore = isGradeA ? result.confidence + 10 : result.confidence;
          candidates.push({ asset, result, vipScore });
        }
      }
    } catch {
      // تجاهل أخطاء الأزواج الفردية
    }

    if (i < total - 1) await new Promise((r) => setTimeout(r, 1200));
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.vipScore - a.vipScore);
  return candidates[0];
}

// ─── VIP Trade Formatter ──────────────────────────────────────────────────────
function formatVIPResult(asset, result) {
  const SEP   = "═══════════════════";
  const entry = suggestedEntry();
  const ts    = parisTimeStr();

  return [
    `🔥 صفقة VIP`,
    SEP,
    `📅 ${ts} (فرنسا)`,
    ``,
    `💱 الزوج: ${asset}`,
    `الاتجاه: ${result.signal}`,
    ``,
    `🎯 الثقة: ${result.confidence}%   🏅 التقييم: ${result.grade}`,
    `⏱️ مدة الصفقة: ${result.expiry}`,
    `⏰ وقت الدخول: ${entry.label}`,
    ...(result.sessionWarning ? [result.sessionWarning] : []),
    ``,
    `📌 الأسباب:`,
    result.reason,
    ``,
    buildChecklist(result),
    ``,
    SEP,
    `💎 صفقة واحدة · جودة ذهبية`,
    `⚠️ القرار النهائي عليك أنت.`,
  ].join("\n");
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

function formatScanResults(buys, sells) {
  const SEP   = "═══════════════════";
  const ts    = parisTimeStr();
  const entry = suggestedEntry();
  const lines = [`📡 رادار السوق — ${ts} (فرنسا)`, SEP];

  if (buys.length === 0 && sells.length === 0) {
    lines.push("⚪ لا توجد إشارات واضحة الآن على أي زوج.");
    lines.push("💡 جرب المسح مجدداً بعد 10–15 دقيقة.");
  } else {
    lines.push(`⏰ وقت الدخول: ${entry.label}\n`);
    if (buys.length > 0) {
      lines.push(`🟢 BUY (${buys.length} زوج):`);
      buys
        .sort((a, b) => b.confidence - a.confidence)
        .forEach((e) =>
          lines.push(`  ◈ ${e.asset}   ${e.confidence}%  [${e.grade}]`),
        );
    }
    if (sells.length > 0) {
      lines.push(`\n🔴 SELL (${sells.length} زوج):`);
      sells
        .sort((a, b) => b.confidence - a.confidence)
        .forEach((e) =>
          lines.push(`  ◈ ${e.asset}   ${e.confidence}%  [${e.grade}]`),
        );
    }
    lines.push(`\n📊 ${buys.length + sells.length} إشارة من ${ALLOWED_ASSETS.length} زوج`);
  }

  lines.push(`\n${SEP}`);
  lines.push(`🎯 Pocket Option — سوق حقيقي`);
  lines.push(`⚠️ القرار النهائي عليك أنت.`);
  return lines.join("\n");
}

// ─── Top 10 Scan Formatter (future-entry only — hides "now" signals) ──────────
function formatTop10Results(buys, sells) {
  const SEP   = "═══════════════════";
  const ts    = parisTimeStr();
  const entry = suggestedEntry();

  // إذا كان وقت الدخول "الآن"، لا تعرض أي إشارات
  if (entry.waitMins === 0) {
    return [
      `📡 رادار السوق — ${ts} (فرنسا)`,
      SEP,
      `⏳ وقت الدخول الحالي: الآن`,
      ``,
      `لا تُعرض إشارات فورية في المسح التلقائي.`,
      `انتظر فتح الشمعة التالية وأعد المسح.`,
      ``,
      SEP,
      `🎯 Pocket Option — سوق حقيقي`,
    ].join("\n");
  }

  const lines = [
    `📡 رادار السوق — ${ts} (فرنسا)`,
    SEP,
    `⏰ وقت الدخول: ${entry.label}`,
    ``,
  ];

  if (buys.length === 0 && sells.length === 0) {
    lines.push("⚪ لا توجد إشارات واضحة على أقوى 10 أزواج الآن.");
    lines.push("💡 جرب المسح مجدداً بعد 5–10 دقائق.");
  } else {
    if (buys.length > 0) {
      lines.push(`🟢 BUY (${buys.length}):`);
      buys
        .sort((a, b) => b.confidence - a.confidence)
        .forEach((e) => lines.push(`  ◈ ${e.asset}   ${e.confidence}%  [${e.grade}]`));
    }
    if (sells.length > 0) {
      if (buys.length > 0) lines.push(``);
      lines.push(`🔴 SELL (${sells.length}):`);
      sells
        .sort((a, b) => b.confidence - a.confidence)
        .forEach((e) => lines.push(`  ◈ ${e.asset}   ${e.confidence}%  [${e.grade}]`));
    }
    lines.push(``);
    lines.push(`📊 ${buys.length + sells.length} إشارة من ${TOP_10_PAIRS.length} زوج`);
  }

  lines.push(SEP);
  lines.push(`🎯 Pocket Option — سوق حقيقي`);
  lines.push(`⚠️ القرار النهائي عليك أنت.`);
  return lines.join("\n");
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/i, (msg) => {
  const chatId = msg.chat.id;
  if (!isOwner(chatId)) { log("WARN", "blocked_user", { chatId }); return; }
  sessions[chatId] = {};
  log("INFO", "/start", { chatId });
  sendWelcome(chatId);
});

// ─── /scan ────────────────────────────────────────────────────────────────────
bot.onText(/\/scan/i, async (msg) => {
  const chatId = msg.chat.id;
  if (!isOwner(chatId)) { log("WARN", "blocked_user", { chatId }); return; }
  if (!sessions[chatId]) sessions[chatId] = {};

  if (isNewsTime()) {
    return bot.sendMessage(
      chatId,
      "📰 تنبيه — وقت أخبار\n═══════════════════\nيُحتمل وجود خبر اقتصادي مؤثر الآن.\n⚠️ تجنب الدخول خلال فترات الأخبار.",
      { reply_markup: { inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]] } },
    );
  }

  const statusMsg = await bot.sendMessage(
    chatId,
    `🔍 جاري مسح أقوى 10 أزواج...\n⏳ 0 / ${TOP_10_PAIRS.length} — يرجى الانتظار`,
  );
  const statusMsgId = statusMsg.message_id;

  log("INFO", "/scan", { chatId });

  let buys, sells;
  try {
    ({ buys, sells } = await scanAllPairs(chatId, statusMsgId, TOP_10_PAIRS));
  } catch (err) {
    log("ERROR", "scan_command_failed", { chatId, error: err.message });
    return bot.editMessageText(
      "❌ خطأ أثناء المسح\n═══════════════════\nتحقق من مفتاح TwelveData وأعد المحاولة.",
      { chat_id: chatId, message_id: statusMsgId,
        reply_markup: { inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]] } },
    );
  }

  log("INFO", "scan_command_done", { chatId, buys: buys.length, sells: sells.length });

  return bot.editMessageText(formatTop10Results(buys, sells), {
    chat_id: chatId,
    message_id: statusMsgId,
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔄 مسح مجدداً",       callback_data: "scan_all"       }],
        [{ text: "📊 تحليل زوج فردي",   callback_data: "start_analysis" }],
        [{ text: "🏠 الرئيسية",          callback_data: "home"           }],
      ],
    },
  });
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

  // ── Scan All Pairs
  if (data === "scan_all") {
    if (isNewsTime()) {
      return bot.sendMessage(
        chatId,
        "📰 تنبيه — وقت أخبار\n═══════════════════\nيُحتمل وجود خبر اقتصادي مؤثر الآن.\n⚠️ تجنب الدخول خلال فترات الأخبار.",
        { reply_markup: { inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]] } },
      );
    }

    const statusMsg = await bot.sendMessage(
      chatId,
      `🔍 جاري مسح أقوى 10 أزواج...\n⏳ 0 / ${TOP_10_PAIRS.length} — يرجى الانتظار`,
    );
    const statusMsgId = statusMsg.message_id;

    log("INFO", "scan_all_started", { chatId, total: TOP_10_PAIRS.length });

    let buys, sells;
    try {
      ({ buys, sells } = await scanAllPairs(chatId, statusMsgId, TOP_10_PAIRS));
    } catch (err) {
      log("ERROR", "scan_all_failed", { chatId, error: err.message });
      return bot.editMessageText(
        "❌ خطأ أثناء المسح\n═══════════════════\nتحقق من مفتاح TwelveData وأعد المحاولة.",
        { chat_id: chatId, message_id: statusMsgId,
          reply_markup: { inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]] } },
      );
    }

    log("INFO", "scan_all_done", { chatId, buys: buys.length, sells: sells.length });

    return bot.editMessageText(formatTop10Results(buys, sells), {
      chat_id: chatId,
      message_id: statusMsgId,
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 مسح مجدداً",     callback_data: "scan_all"       }],
          [{ text: "🔥 صفقة VIP",        callback_data: "vip_trade"      }],
          [{ text: "📊 تحليل زوج فردي", callback_data: "start_analysis" }],
          [{ text: "🏠 الرئيسية",        callback_data: "home"           }],
        ],
      },
    });
  }

  // ── VIP Trade
  if (data === "vip_trade") {
    if (isNewsTime()) {
      return bot.sendMessage(
        chatId,
        "📰 تنبيه — وقت أخبار\n═══════════════════\nيُحتمل وجود خبر اقتصادي مؤثر الآن.\n⚠️ تجنب الدخول خلال فترات الأخبار.",
        { reply_markup: { inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]] } },
      );
    }

    const statusMsg = await bot.sendMessage(
      chatId,
      `🔥 جاري البحث عن صفقة VIP...\n⏳ 0 / ${TOP_10_PAIRS.length} — يرجى الانتظار`,
    );
    const statusMsgId = statusMsg.message_id;

    log("INFO", "vip_trade_started", { chatId });

    let best;
    try {
      best = await scanVIP(chatId, statusMsgId);
    } catch (err) {
      log("ERROR", "vip_trade_failed", { chatId, error: err.message });
      return bot.editMessageText(
        "❌ خطأ أثناء البحث عن صفقة VIP\n═══════════════════\nتحقق من مفتاح TwelveData وأعد المحاولة.",
        { chat_id: chatId, message_id: statusMsgId,
          reply_markup: { inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]] } },
      );
    }

    log("INFO", "vip_trade_done", { chatId, found: !!best, asset: best?.asset });

    const vipText = best
      ? formatVIPResult(best.asset, best.result)
      : [
          "🔥 صفقة VIP",
          "═══════════════════",
          "🚫 لا توجد صفقة VIP نظيفة الآن",
          "",
          "لم يُعثر على إعداد Grade A أو B نظيف.",
          "جرّب مجدداً بعد 10–15 دقيقة.",
          "═══════════════════",
          "🎯 Pocket Option — سوق حقيقي",
        ].join("\n");

    return bot.editMessageText(vipText, {
      chat_id: chatId,
      message_id: statusMsgId,
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔥 إعادة البحث",    callback_data: "vip_trade"      }],
          [{ text: "🔍 مسح الأزواج",    callback_data: "scan_all"       }],
          [{ text: "🏠 الرئيسية",        callback_data: "home"           }],
        ],
      },
    });
  }

  // ── Asset Selection → Analysis
  if (data.startsWith("asset_")) {
    const asset = data.replace("asset_", "");

    if (!ALLOWED_ASSETS.includes(asset)) {
      return bot.sendMessage(
        chatId,
        "⚠️ الزوج غير مدعوم\n═══════════════════\nهذا الزوج غير متاح في قاعدة البيانات.",
        {
          reply_markup: {
            inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]],
          },
        },
      );
    }

    // News filter
    if (isNewsTime()) {
      return bot.sendMessage(
        chatId,
        "📰 تنبيه — وقت أخبار\n═══════════════════\nيُحتمل وجود خبر اقتصادي مؤثر الآن.\n⚠️ NO TRADE — انتظر 10 دقائق وأعد المحاولة.",
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
        "⏱️ تنبيه — حافة الشمعة\n═══════════════════\nأنت في بداية أو نهاية الشمعة الحالية.\nانتظر دقيقتين وأعد التحليل للحصول على إشارة أدق.",
        {
          reply_markup: {
            inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]],
          },
        },
      );
    }

    sessions[chatId].asset = asset;
    log("INFO", "analysis_requested", { chatId, asset });

    await bot.sendMessage(chatId, `⌛ جاري تحليل ${asset}...\n⏳ يرجى الانتظار`);

    let result;
    try {
      result = await analyze(asset);
    } catch (err) {
      log("ERROR", "analysis_failed", { chatId, asset, error: err.message });
      return bot.sendMessage(
        chatId,
        "❌ خطأ في التحليل\n═══════════════════\nتعذّر جلب بيانات السوق.\nتحقق من مفتاح TwelveData أو حاول لاحقاً.",
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

    const sessionLine = (!result.noTrade && result.sessionWarning)
      ? `\n${result.sessionWarning}` : "";
    const SEP = "═══════════════════";
    const replyText = result.noTrade
      ? `📊 تحليل — ${asset}\n${SEP}\nالنتيجة: ⚪ لا توجد صفقة\n\n📌 السبب:\n${result.reason}\n\n${SEP}\n🎯 Pocket Option — سوق حقيقي\n⚠️ القرار النهائي عليك أنت.`
      : `📊 تحليل — ${asset}\n${SEP}\nالنتيجة: ${result.signal}\n\n🎯 الثقة: ${result.confidence}%   🏅 التقييم: ${result.grade}\n⏱️ مدة الصفقة: ${result.expiry}${sessionLine}\n\n📌 الأسباب:\n${result.reason}\n\n${buildChecklist(result)}\n\n${SEP}\n🎯 Pocket Option — سوق حقيقي\n⚠️ القرار النهائي عليك أنت.`;

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
