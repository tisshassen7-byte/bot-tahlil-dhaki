import TelegramBot from "node-telegram-bot-api";
import fetch from "node-fetch";
import { logger } from "./lib/logger";

const token = process.env["TELEGRAM_TOKEN"];
const apiKey = process.env["TWELVE_API_KEY"];
const OWNER_ID = parseInt(process.env["OWNER_ID"] ?? "", 10);

if (!token) throw new Error("TELEGRAM_TOKEN غير موجود في البيئة");
if (!apiKey) throw new Error("TWELVE_API_KEY غير موجود في البيئة");
if (!OWNER_ID || isNaN(OWNER_ID)) throw new Error("OWNER_ID غير موجود في البيئة — أضف معرّف Telegram الخاص بك");

const bot = new TelegramBot(token, { polling: true });

const sessions = {};

function parisTimeStr(now: Date = new Date()): string {
  return now.toLocaleTimeString("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const ALLOWED_ASSETS = [
  "EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF",
  "USD/CAD", "AUD/USD", "NZD/USD",
  "EUR/JPY", "EUR/GBP", "EUR/CHF", "EUR/CAD", "EUR/AUD",
  "GBP/JPY", "GBP/CHF", "GBP/CAD", "GBP/AUD",
  "AUD/JPY", "AUD/CAD", "CAD/JPY", "CHF/JPY", "NZD/JPY",
];

const TOP_10_PAIRS = [
  "EUR/USD", "GBP/USD", "USD/JPY", "EUR/JPY",
  "GBP/JPY", "AUD/USD", "USD/CAD", "USD/CHF",
  "EUR/GBP", "NZD/USD",
];

const HIGH_IMPACT_UTC_RANGES = [
  { h: 8,  m: 28, endH: 8,  endM: 35 },
  { h: 12, m: 28, endH: 12, endM: 35 },
  { h: 13, m: 25, endH: 13, endM: 40 },
  { h: 15, m: 0,  endH: 15, endM: 5  },
  { h: 18, m: 0,  endH: 18, endM: 5  },
];

const MIN_CONFIDENCE = 57;
const ANALYSIS_INTERVAL = "5min";

function isOwner(chatId: number): boolean {
  return chatId === OWNER_ID;
}

function isNewsTime(): boolean {
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

function isCandleEdge(): boolean {
  const m = new Date().getUTCMinutes();
  return m <= 1 || m >= 58;
}

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    e = (values[i] ?? 0) * k + e * (1 - k);
  }
  return e;
}

function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = (values[i] ?? 0) - (values[i - 1] ?? 0);
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
}

function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function candleQuality(candles: Candle[]) {
  const c = candles[candles.length - 1]!;
  const prev = candles[candles.length - 2]!;
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low || 0.000001;
  const bodyRatio = body / range;
  const bullish = c.close > c.open && c.close > prev.close && bodyRatio >= 0.5;
  const bearish = c.close < c.open && c.close < prev.close && bodyRatio >= 0.5;
  return { bullish, bearish, bodyRatio };
}

function trendConfirmation(candles: Candle[]) {
  const last5 = candles.slice(-5);
  let upCount = 0, downCount = 0;
  for (const c of last5) {
    if (c.close > c.open) upCount++;
    else if (c.close < c.open) downCount++;
  }
  return { upCount, downCount };
}

function supportResistance(closes: number[], last: number) {
  const recent = closes.slice(-50);
  const high = Math.max(...recent);
  const low = Math.min(...recent);
  const nearResistance = (high - last) / last < 0.001;
  const nearSupport = (last - low) / last < 0.001;
  return { high, low, nearResistance, nearSupport };
}

function grade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 78) return "B";
  return "C";
}

interface TwelveDataValue {
  open: string;
  high: string;
  low: string;
  close: string;
}

interface TwelveDataResponse {
  status?: string;
  message?: string;
  values?: TwelveDataValue[];
}

async function fetchOnce(symbol: string): Promise<TwelveDataResponse> {
  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${ANALYSIS_INTERVAL}` +
    `&outputsize=130` +
    `&apikey=${apiKey}`;

  const res = await fetch(url);
  const data = (await res.json()) as TwelveDataResponse;

  if (data.status === "error") {
    throw new Error(`TwelveData: ${data.message ?? "خطأ غير معروف"}`);
  }
  if (!data.values || data.values.length < 80) {
    throw new Error("بيانات غير كافية من TwelveData");
  }
  return data;
}

async function getCandles(symbol: string): Promise<Candle[]> {
  let data: TwelveDataResponse;
  try {
    data = await fetchOnce(symbol);
  } catch (err) {
    logger.warn({ symbol, err }, "twelvedata_retry");
    await new Promise((r) => setTimeout(r, 3000));
    data = await fetchOnce(symbol);
  }

  return (data.values ?? [])
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

interface AnalysisResult {
  signal: string;
  confidence: number;
  grade: string;
  reason: string;
  noTrade: boolean;
}

function noTrade(reason: string): AnalysisResult {
  return { signal: "⚪ NO TRADE", confidence: 0, grade: "-", reason, noTrade: true };
}

async function analyze(symbol: string): Promise<AnalysisResult> {
  const candles = await getCandles(symbol);
  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1]!;

  const ema9   = ema(closes, 9);
  const ema21  = ema(closes, 21);
  const ema50  = ema(closes, 50);
  const ema100 = ema(closes, 100);
  const r      = rsi(closes, 14);
  const avgATR = atr(candles, 14);
  const avgSMA = sma(closes, 20);

  if (!ema9 || !ema21 || !ema50 || !ema100 || r === null || !avgATR || !avgSMA) {
    return noTrade("⛔ بيانات المؤشرات غير كافية للتحليل");
  }

  const volRatio = avgATR / avgSMA;
  const tooDead  = volRatio < 0.0001;
  const tooWild  = volRatio > 0.005;

  const strongUp   = ema9 > ema21 && ema21 > ema50 && ema50 > ema100 && last > ema50;
  const strongDown = ema9 < ema21 && ema21 < ema50 && ema50 < ema100 && last < ema50;
  const modUp      = !strongUp   && ema9 > ema21 && ema21 > ema50 && last > ema21;
  const modDown    = !strongDown && ema9 < ema21 && ema21 < ema50 && last < ema21;
  const anyUp      = strongUp   || modUp;
  const anyDown    = strongDown || modDown;
  const emaSep     = Math.abs(ema21 - ema50) / last;

  const { nearResistance, nearSupport } = supportResistance(closes, last);
  const candle    = candleQuality(candles);
  const trendConf = trendConfirmation(candles);

  if (tooDead)           return noTrade("⚪ السوق راكد: الحركة ضعيفة جداً ولا تستحق الدخول");
  if (tooWild)           return noTrade("🔴 تذبذب شديد: الخطر عالٍ جداً");
  if (!anyUp && !anyDown) return noTrade("⚪ لا يوجد اتجاه: EMAs متشابكة في جميع الاتجاهات");

  let buyScore = 0, sellScore = 0;
  const buyReasons: string[] = [], sellReasons: string[] = [];

  if (strongUp)        { buyScore  += 35; buyReasons.push("ترند صاعد قوي (EMA 9>21>50>100)"); }
  else if (modUp)      { buyScore  += 20; buyReasons.push("ترند صاعد معتدل (EMA 9>21>50)"); }
  if (strongDown)      { sellScore += 35; sellReasons.push("ترند هابط قوي (EMA 9<21<50<100)"); }
  else if (modDown)    { sellScore += 20; sellReasons.push("ترند هابط معتدل (EMA 9<21<50)"); }

  if (emaSep < 0.00005) { buyScore -= 8; sellScore -= 8; }

  const rsiBuyOk  = anyUp   ? (r >= 38 && r <= 90) : (r >= 45 && r <= 72);
  const rsiSellOk = anyDown ? (r >= 10 && r <= 62) : (r >= 28 && r <= 55);
  if (rsiBuyOk)  { buyScore  += 18; buyReasons.push(`RSI=${r.toFixed(0)} مناسب شراء`); }
  if (rsiSellOk) { sellScore += 18; sellReasons.push(`RSI=${r.toFixed(0)} مناسب بيع`); }
  if (r > 90 && !anyUp)   buyScore  -= 15;
  if (r < 10 && !anyDown) sellScore -= 15;

  if (candle.bullish) { buyScore  += 15; buyReasons.push("شمعة صاعدة قوية"); }
  if (candle.bearish) { sellScore += 15; sellReasons.push("شمعة هابطة قوية"); }

  if (anyUp   && rsiBuyOk  && candle.bullish) { buyScore  += 7; buyReasons.push("زخم متوافق"); }
  if (anyDown && rsiSellOk && candle.bearish) { sellScore += 7; sellReasons.push("زخم متوافق"); }

  if (trendConf.upCount   >= 3) { buyScore  += 12; buyReasons.push(`${trendConf.upCount}/5 شموع صاعدة`); }
  if (trendConf.downCount >= 3) { sellScore += 12; sellReasons.push(`${trendConf.downCount}/5 شموع هابطة`); }

  if (!nearResistance)       { buyScore  += 10; buyReasons.push("بعيد عن مقاومة"); }
  else if (!anyUp)             buyScore  -= 12;
  if (!nearSupport)          { sellScore += 10; sellReasons.push("بعيد عن دعم"); }
  else if (!anyDown)           sellScore -= 12;

  if (volRatio >= 0.00015 && volRatio <= 0.003) { buyScore += 8; sellScore += 8; }

  if (strongDown) buyScore  = 0;
  if (strongUp)   sellScore = 0;
  if (modDown && buyScore  > 10) buyScore  = 10;
  if (modUp   && sellScore > 10) sellScore = 10;

  const dominant      = buyScore > sellScore ? "BUY" : "SELL";
  const dominantScore = dominant === "BUY" ? buyScore  : sellScore;
  const opposite      = dominant === "BUY" ? sellScore : buyScore;
  const reasons       = dominant === "BUY" ? buyReasons : sellReasons;

  if (dominantScore < MIN_CONFIDENCE) {
    return noTrade(`⚪ الثقة غير كافية (${dominantScore}%) — الجودة أهم من الكمية`);
  }
  if (dominantScore - opposite < 6) {
    return noTrade("⚪ إشارة متعارضة: لا أفضلية واضحة بين BUY و SELL");
  }

  const confidence = Math.min(93, dominantScore);
  return {
    signal:   dominant === "BUY" ? "🟢 BUY" : "🔴 SELL",
    confidence,
    grade:    grade(confidence),
    reason:   reasons.join(" ✦ "),
    noTrade:  false,
  };
}

const WELCOME_IMAGE_URL =
  "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1280&q=80";

function sendWelcome(chatId: number) {
  const caption = [
    "📡 *رادار السوق*",
    "━━━━━━━━━━━━━━━━━━",
    "منصة تحليل الفوركس الاحترافية",
    "سوق حقيقي · توقيت فرنسا · خاص بك",
    "━━━━━━━━━━━━━━━━━━",
    "⚠️ للتحليل فقط — القرار النهائي عليك أنت.",
  ].join("\n");

  return bot
    .sendPhoto(chatId, WELCOME_IMAGE_URL, {
      caption,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "▶️ ابدأ الآن", callback_data: "show_menu" }]],
      },
    })
    .catch(() =>
      bot.sendMessage(chatId, caption, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "▶️ ابدأ الآن", callback_data: "show_menu" }]],
        },
      }),
    );
}

function mainMenu(chatId: number) {
  return bot.sendMessage(chatId, "📡 *رادار السوق* — القائمة الرئيسية", {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔍 مسح أقوى 10 أزواج",  callback_data: "scan_all"       }],
        [{ text: "📊 تحليل زوج فردي",      callback_data: "start_analysis" }],
      ],
    },
  });
}

function assetMenu(chatId: number) {
  const rows: { text: string; callback_data: string }[][] = [];
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

function formatTop10Results(
  buys:  { asset: string; result: AnalysisResult }[],
  sells: { asset: string; result: AnalysisResult }[],
): string {
  const time = parisTimeStr();
  let msg = `📡 *رادار السوق — مسح أقوى 10 أزواج*\n🕒 ${time} (باريس)\n━━━━━━━━━━━━━━━━━━\n`;

  if (buys.length) {
    msg += `\n🟢 *إشارات شراء (${buys.length}):*\n`;
    for (const { asset, result } of buys) {
      msg += `• ${asset} — ${result.confidence}% [${result.grade}]\n`;
    }
  }
  if (sells.length) {
    msg += `\n🔴 *إشارات بيع (${sells.length}):*\n`;
    for (const { asset, result } of sells) {
      msg += `• ${asset} — ${result.confidence}% [${result.grade}]\n`;
    }
  }
  if (!buys.length && !sells.length) {
    msg += "\n⚪ لا توجد إشارات قابلة للتداول في الوقت الحالي.";
  }

  msg += "\n━━━━━━━━━━━━━━━━━━\n⚠️ القرار النهائي عليك أنت.";
  return msg;
}

async function scanAllPairs(
  chatId: number,
  statusMsgId: number,
  pairs: string[],
): Promise<{ buys: { asset: string; result: AnalysisResult }[]; sells: { asset: string; result: AnalysisResult }[] }> {
  const buys:  { asset: string; result: AnalysisResult }[] = [];
  const sells: { asset: string; result: AnalysisResult }[] = [];
  const total = pairs.length;

  for (let i = 0; i < total; i++) {
    const asset = pairs[i]!;

    if (i % 4 === 0) {
      await bot
        .editMessageText(`🔍 جاري مسح الأزواج... ${i}/${total}\n⏳ يرجى الانتظار`, {
          chat_id: chatId,
          message_id: statusMsgId,
        })
        .catch(() => {});
    }

    try {
      const result = await analyze(asset);
      if (!result.noTrade) {
        if (result.signal.includes("BUY")) buys.push({ asset, result });
        else sells.push({ asset, result });
      }
      await new Promise((r) => setTimeout(r, 1200));
    } catch (err) {
      logger.warn({ asset, err }, "scan_pair_failed");
    }
  }

  return { buys, sells };
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isOwner(chatId)) { logger.warn({ chatId }, "blocked_user"); return; }
  if (!sessions[chatId]) sessions[chatId] = {};
  logger.info({ chatId }, "/start");
  await sendWelcome(chatId);
});

bot.onText(/\/menu/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isOwner(chatId)) { logger.warn({ chatId }, "blocked_user"); return; }
  if (!sessions[chatId]) sessions[chatId] = {};
  await mainMenu(chatId);
});

bot.onText(/\/scan/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isOwner(chatId)) { logger.warn({ chatId }, "blocked_user"); return; }
  if (!sessions[chatId]) sessions[chatId] = {};

  if (isNewsTime()) {
    return bot.sendMessage(
      chatId,
      "📰 فلتر الأخبار: يُحتمل وجود خبر اقتصادي مؤثر الآن.\n⚠️ تجنب المسح خلال فترات الأخبار.",
      { reply_markup: { inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]] } },
    );
  }

  const statusMsg = await bot.sendMessage(
    chatId,
    `🔍 جاري مسح أقوى 10 أزواج... 0/${TOP_10_PAIRS.length}\n⏳ يرجى الانتظار (~${Math.ceil(TOP_10_PAIRS.length * 1.2 / 60)} دقيقة)`,
  );
  const statusMsgId = statusMsg.message_id;
  logger.info({ chatId }, "/scan");

  let buys, sells;
  try {
    ({ buys, sells } = await scanAllPairs(chatId, statusMsgId, TOP_10_PAIRS));
  } catch (err) {
    logger.error({ chatId, err }, "scan_command_failed");
    return bot.editMessageText(
      "❌ خطأ أثناء المسح. تحقق من مفتاح TwelveData وأعد المحاولة.",
      {
        chat_id: chatId,
        message_id: statusMsgId,
        reply_markup: { inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]] },
      },
    );
  }

  logger.info({ chatId, buys: buys.length, sells: sells.length }, "scan_done");

  return bot.editMessageText(formatTop10Results(buys, sells), {
    chat_id: chatId,
    message_id: statusMsgId,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔄 مسح مجدداً",       callback_data: "scan_all"       }],
        [{ text: "📊 تحليل زوج فردي",   callback_data: "start_analysis" }],
        [{ text: "🏠 الرئيسية",          callback_data: "home"           }],
      ],
    },
  });
});

bot.on("callback_query", async (q): Promise<void> => {
  const chatId = q.message?.chat.id;
  if (!chatId) return;
  const data = q.data ?? "";

  if (!isOwner(chatId)) {
    logger.warn({ chatId }, "blocked_callback");
    await bot.answerCallbackQuery(q.id).catch(() => {});
    return;
  }
  await bot.answerCallbackQuery(q.id).catch(() => {});
  if (!sessions[chatId]) sessions[chatId] = {};

  if (data === "home" || data === "show_menu") { await mainMenu(chatId); return; }
  if (data === "start_analysis") { await assetMenu(chatId); return; }

  if (data === "scan_all") {
    if (isNewsTime()) {
      await bot.sendMessage(
        chatId,
        "📰 فلتر الأخبار: يُحتمل وجود خبر اقتصادي مؤثر الآن.\n⚠️ تجنب المسح خلال فترات الأخبار.",
        { reply_markup: { inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]] } },
      );
      return;
    }

    const statusMsg = await bot.sendMessage(
      chatId,
      `🔍 جاري مسح أقوى 10 أزواج... 0/${TOP_10_PAIRS.length}\n⏳ يرجى الانتظار (~${Math.ceil(TOP_10_PAIRS.length * 1.2 / 60)} دقيقة)`,
    );
    const statusMsgId = statusMsg.message_id;
    logger.info({ chatId, total: TOP_10_PAIRS.length }, "scan_all_started");

    let buys, sells;
    try {
      ({ buys, sells } = await scanAllPairs(chatId, statusMsgId, TOP_10_PAIRS));
    } catch (err) {
      logger.error({ chatId, err }, "scan_all_failed");
      await bot.editMessageText(
        "❌ خطأ أثناء المسح. تحقق من مفتاح TwelveData وأعد المحاولة.",
        {
          chat_id: chatId,
          message_id: statusMsgId,
          reply_markup: { inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]] },
        },
      );
      return;
    }

    logger.info({ chatId, buys: buys.length, sells: sells.length }, "scan_all_done");

    await bot.editMessageText(formatTop10Results(buys, sells), {
      chat_id: chatId,
      message_id: statusMsgId,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 مسح مجدداً",     callback_data: "scan_all"       }],
          [{ text: "📊 تحليل زوج فردي", callback_data: "start_analysis" }],
          [{ text: "🏠 الرئيسية",        callback_data: "home"           }],
        ],
      },
    });
    return;
  }

  if (data.startsWith("asset_")) {
    const asset = data.replace("asset_", "");

    if (!ALLOWED_ASSETS.includes(asset)) {
      await bot.sendMessage(chatId, "⚠️ هذا الزوج غير مدعوم.", {
        reply_markup: { inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]] },
      });
      return;
    }

    if (isNewsTime()) {
      await bot.sendMessage(
        chatId,
        "📰 فلتر الأخبار: يُحتمل وجود خبر اقتصادي مؤثر الآن.\n⚠️ NO TRADE — انتظر 10 دقائق وأعد المحاولة.",
        { reply_markup: { inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]] } },
      );
      return;
    }

    if (isCandleEdge()) {
      await bot.sendMessage(
        chatId,
        "⏱️ أنت في بداية أو نهاية الشمعة. انتظر دقيقتين وأعد التحليل للحصول على إشارة أدق.",
        { reply_markup: { inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]] } },
      );
      return;
    }

    sessions[chatId]!.asset = asset;
    logger.info({ chatId, asset }, "analysis_requested");
    await bot.sendMessage(chatId, `⌛ جاري تحليل ${asset}...`);

    let result: AnalysisResult;
    try {
      result = await analyze(asset);
    } catch (err) {
      logger.error({ chatId, asset, err }, "analysis_failed");
      await bot.sendMessage(
        chatId,
        "❌ خطأ في جلب بيانات السوق. تحقق من مفتاح TwelveData أو حاول لاحقاً.",
        { reply_markup: { inline_keyboard: [[{ text: "🏠 الرئيسية", callback_data: "home" }]] } },
      );
      return;
    }

    logger.info(
      { chatId, asset, signal: result.signal, confidence: result.confidence, grade: result.grade },
      "analysis_done",
    );

    const replyText = result.noTrade
      ? `📊 نتيجة التحليل — ${asset}\n\nالنتيجة: ${result.signal}\n\n📌 السبب: ${result.reason}\n\n━━━━━━━━━━━━━━━━━━\n🎯 المنصة: Pocket Option — سوق حقيقي\n⚠️ القرار النهائي عليك أنت.`
      : `📊 نتيجة التحليل — ${asset}\n\nالنتيجة: ${result.signal}\n\n🎯 نسبة الثقة: ${result.confidence}%\n🏅 التقييم: ${result.grade}\n\n✅ الأسباب: ${result.reason}\n\n━━━━━━━━━━━━━━━━━━\n🎯 المنصة: Pocket Option — سوق حقيقي\n⚠️ القرار النهائي عليك أنت. لا تعتمد على إشارة واحدة.`;

    await bot.sendMessage(chatId, replyText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔁 تحليل زوج آخر", callback_data: "start_analysis" }],
          [{ text: "🏠 الرئيسية",       callback_data: "home"           }],
        ],
      },
    });
  }
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason: String(reason) }, "unhandledRejection");
});

process.on("uncaughtException", (err) => {
  logger.error({ error: (err as Error).message, stack: (err as Error).stack }, "uncaughtException");
});

logger.info({ note: "Pocket Option analysis bot is running — private mode" }, "bot_started");

export default bot;
