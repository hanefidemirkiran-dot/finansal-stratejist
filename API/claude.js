import fetch from "node-fetch";

// ── RATE LIMITER ──────────────────────────────────────────────────
const requestCounts = new Map();
function rateLimit(ip, limit = 60, windowMs = 60000) {
  const now = Date.now();
  const key = `${ip}-${Math.floor(now / windowMs)}`;
  const count = (requestCounts.get(key) || 0) + 1;
  requestCounts.set(key, count);
  if (requestCounts.size > 2000) {
    for (const k of [...requestCounts.keys()]) {
      if (parseInt(k.split("-").pop()) < Math.floor(now / windowMs) - 2) {
        requestCounts.delete(k);
      }
    }
  }
  return count > limit;
}

// ── CORS ─────────────────────────────────────────────────────────
function isAllowedOrigin(origin) {
  if (!origin) return true;
  return (
    origin.includes("localhost") ||
    origin.includes("vercel.app") ||
    origin.includes("127.0.0.1")
  );
}

// ── FETCH WITH TIMEOUT ────────────────────────────────────────────
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── YAHOO FINANCE ─────────────────────────────────────────────────
async function fetchYahoo(yahooSymbol) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
  };

  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=5d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=2d`,
  ];

  let lastErr = "bilinmiyor";
  for (const url of urls) {
    try {
      const r = await fetchWithTimeout(url, { headers }, 10000);
      if (!r.ok) { lastErr = `HTTP ${r.status}`; continue; }
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      if (!meta) { lastErr = "meta boş"; continue; }
      const price = meta.regularMarketPrice;
      if (!price || price <= 0) { lastErr = `fiyat geçersiz: ${price}`; continue; }
      const prevClose = meta.previousClose || meta.chartPreviousClose || price;
      return {
        price:     Math.round(price * 10000) / 10000,
        prevClose: Math.round(prevClose * 10000) / 10000,
        dayChange: prevClose > 0 ? Math.round((price - prevClose) / prevClose * 10000) / 100 : 0,
        name:      meta.longName || meta.shortName || yahooSymbol,
        currency:  meta.currency || "TRY",
        marketState: meta.marketState || "CLOSED",
      };
    } catch (e) { lastErr = e.message; }
  }
  throw new Error(lastErr);
}

// ── MAIN HANDLER ──────────────────────────────────────────────────
export default async function handler(req, res) {
  const origin = req.headers.origin || "";

  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  } else {
    return res.status(403).json({ error: "Forbidden" });
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  // Rate limit
  const ip = (req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  if (rateLimit(ip, 60, 60000)) {
    return res.status(429).json({ error: "Çok fazla istek. 1 dakika bekle." });
  }

  // Body — Vercel serverless bazen req.body parse eder bazen etmez
  let body = req.body;
  if (!body || typeof body !== "object") {
    try {
      const raw = await new Promise((resolve, reject) => {
        let s = "";
        req.on("data", c => { s += c; });
        req.on("end", () => resolve(s));
        req.on("error", reject);
      });
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return res.status(400).json({ error: "Geçersiz JSON body" });
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({
    error: "ANTHROPIC_API_KEY bulunamadı. Vercel Dashboard → Settings → Environment Variables → Redeploy"
  });

  // ── FİYAT ÇEKME ──────────────────────────────────────────────
  if (body.action === "getPrice") {
    const rawSym = String(body.symbol || "").trim().toUpperCase().replace(/[^A-Z0-9.\-=^]/g, "");
    const market = String(body.market || "");
    if (!rawSym || rawSym.length > 20) return res.status(400).json({ error: "Geçersiz sembol" });

    let yahooSym = rawSym;
    if (market === "BIST")    yahooSym = rawSym + ".IS";
    else if (market === "FX") yahooSym = rawSym === "USDTRY" ? "USDTRY=X" : rawSym + "=X";
    else if (market === "INDEX") yahooSym = rawSym; // ^XU100, ^GSPC gibi
    // NYSE / NASDAQ → direkt sembol

    try {
      const data = await fetchYahoo(yahooSym);
      res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30");
      return res.status(200).json(data);
    } catch (err) {
      return res.status(404).json({ error: `${rawSym} alınamadı: ${err.message}` });
    }
  }

  // ── CLAUDE AI ────────────────────────────────────────────────
  const { messages, system } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Mesaj listesi boş" });
  }

  const cleanMsgs = messages.slice(-40).map(m => ({
    role:    m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 10000),
  }));

  try {
    const resp = await fetchWithTimeout(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type":     "application/json",
          "x-api-key":        apiKey,
          "anthropic-version":"2023-06-01",
        },
        body: JSON.stringify({
          model:      "claude-opus-4-5",
          max_tokens: 4096,
          system:     system ? String(system).slice(0, 4000) : "Sen finansal stratejistsin. Türkçe yanıt ver.",
          messages:   cleanMsgs,
        }),
      },
      55000
    );

    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data?.error?.message || JSON.stringify(data) });
    const text = (data.content || []).map(b => b.text || "").join("");
    return res.status(200).json({ text, usage: data.usage });

  } catch (err) {
    if (err.name === "AbortError") return res.status(504).json({ error: "Zaman aşımı (55sn). Tekrar dene." });
    return res.status(500).json({ error: err.message });
  }
}
