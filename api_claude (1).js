import fetch from "node-fetch";

// ── RATE LIMITER (in-memory, per IP) ─────────────────────────────
const requestCounts = new Map();
function rateLimit(ip, limit = 30, windowMs = 60000) {
  const now = Date.now();
  const key = `${ip}-${Math.floor(now / windowMs)}`;
  const count = (requestCounts.get(key) || 0) + 1;
  requestCounts.set(key, count);
  if (requestCounts.size > 2000) {
    const cutoff = Math.floor(now / windowMs) - 2;
    for (const k of requestCounts.keys()) {
      if (k.split("-")[1] < cutoff) requestCounts.delete(k);
    }
  }
  return count > limit;
}

// ── ALLOWED ORIGINS ──────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "https://finansal-stratejist-50o7dg8xx-hanefidemirkiran-4385s-projects.vercel.app",
  "https://finansal-stratejist.vercel.app",
  /^https:\/\/finansal-stratejist.*\.vercel\.app$/,
  "http://localhost:3000",
  "http://localhost:5173",
];

function isAllowedOrigin(origin) {
  if (!origin) return true; // direct/server calls
  return ALLOWED_ORIGINS.some(o =>
    o instanceof RegExp ? o.test(origin) : o === origin
  );
}

// ── INPUT SANITIZER ──────────────────────────────────────────────
function sanitizeSymbol(s) {
  if (!s || typeof s !== "string") return null;
  const clean = s.trim().toUpperCase().replace(/[^A-Z0-9.\-=]/g, "");
  return clean.length > 0 && clean.length <= 20 ? clean : null;
}

// ── FETCH WITH TIMEOUT ───────────────────────────────────────────
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    return r;
  } finally {
    clearTimeout(timer);
  }
}

// ── YAHOO FINANCE FETCHER ────────────────────────────────────────
async function fetchYahoo(yahooSymbol) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
  };

  const endpoints = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=5d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=2d`,
  ];

  let lastError;
  for (const url of endpoints) {
    try {
      const r = await fetchWithTimeout(url, { headers }, 8000);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      if (!meta) throw new Error("Meta boş");

      const price = meta.regularMarketPrice;
      if (!price || price <= 0) throw new Error(`Geçersiz fiyat: ${price}`);

      const prevClose = meta.previousClose || meta.chartPreviousClose || price;
      const dayChange = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;

      return {
        price: Math.round(price * 10000) / 10000,
        prevClose: Math.round(prevClose * 10000) / 10000,
        dayChange: Math.round(dayChange * 100) / 100,
        name: meta.longName || meta.shortName || yahooSymbol,
        currency: meta.currency || "TRY",
        exchange: meta.exchangeName || "",
        marketState: meta.marketState || "CLOSED",
        volume: meta.regularMarketVolume || 0,
        high52: meta.fiftyTwoWeekHigh || null,
        low52: meta.fiftyTwoWeekLow || null,
      };
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(lastError?.message || "Tüm endpointler başarısız");
}

// ── MAIN HANDLER ─────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  } else {
    return res.status(403).json({ error: "Forbidden origin" });
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Rate limiting
  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  if (rateLimit(ip, 40, 60000)) {
    return res.status(429).json({ error: "Çok fazla istek. 1 dakika bekle." });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY eksik" });

  const body = req.body;

  // ── FİYAT ÇEKME ──────────────────────────────────────────────
  if (body.action === "getPrice") {
    const rawSymbol = body.symbol;
    const market = body.market;
    const symbol = sanitizeSymbol(rawSymbol);

    if (!symbol) return res.status(400).json({ error: "Geçersiz sembol" });

    let yahooSymbol;
    if (market === "BIST") {
      yahooSymbol = symbol + ".IS";
    } else if (market === "FX") {
      yahooSymbol = symbol === "USDTRY" ? "USDTRY=X" :
                    symbol === "EURUSD" ? "EURUSD=X" :
                    symbol + "=X";
    } else {
      yahooSymbol = symbol;
    }

    try {
      const data = await fetchYahoo(yahooSymbol);
      // Cache header — fiyat 1dk geçerli
      res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=30");
      return res.status(200).json(data);
    } catch (err) {
      return res.status(404).json({ error: `${symbol} alınamadı: ${err.message}` });
    }
  }

  // ── CLAUDE AI ────────────────────────────────────────────────
  try {
    const { messages, system } = body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Mesaj listesi boş" });
    }
    if (messages.length > 50) {
      return res.status(400).json({ error: "Çok fazla mesaj (max 50)" });
    }

    // Her mesajın içeriği string olmalı
    const sanitizedMessages = messages.map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content).slice(0, 8000), // max 8k char per msg
    }));

    const response = await fetchWithTimeout(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-opus-4-5",
          max_tokens: 4096,
          system: system ? String(system).slice(0, 2000) : "Sen bir finansal stratejistsin. Türkçe yanıt ver.",
          messages: sanitizedMessages,
        }),
      },
      30000 // 30sn AI timeout
    );

    const data = await response.json();
    if (!response.ok) {
      const errMsg = data?.error?.message || JSON.stringify(data);
      return res.status(response.status).json({ error: errMsg });
    }

    const text = (data.content || []).map(b => b.text || "").join("");
    return res.status(200).json({
      text,
      usage: data.usage || null,
      model: data.model || null,
    });

  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({ error: "AI yanıt vermedi (timeout). Tekrar dene." });
    }
    return res.status(500).json({ error: "Sunucu hatası: " + err.message });
  }
}
