import fetch from "node-fetch";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY bulunamadi" });

  // ── FİYAT ÇEKME ──────────────────────────────────────────────
  if (req.body.action === "getPrice") {
    const { symbol, market } = req.body;

    let yahooSymbol;
    if (market === "BIST") {
      yahooSymbol = symbol + ".IS";
    } else if (market === "FX") {
      yahooSymbol = symbol === "USDTRY" ? "USDTRY=X" : symbol + "=X";
    } else {
      yahooSymbol = symbol;
    }

    const tryFetch = async (baseUrl) => {
      const r = await fetch(baseUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) throw new Error("Fiyat bos");
      return {
        price: meta.regularMarketPrice,
        prevClose: meta.previousClose || meta.chartPreviousClose || meta.regularMarketPrice,
        name: meta.longName || meta.shortName || symbol,
        currency: meta.currency || "TL",
      };
    };

    try {
      const data = await tryFetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=5d`
      ).catch(() =>
        tryFetch(
          `https://query2.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=2d`
        )
      );
      return res.status(200).json(data);
    } catch (err) {
      return res.status(404).json({ error: `${symbol} alinamadi: ${err.message}` });
    }
  }

  // ── CLAUDE AI ────────────────────────────────────────────────
  try {
    const { messages, system } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Mesaj listesi bos" });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-5",
        max_tokens: 4096,
        system: system || "Sen bir finansal stratejistsin. Türkçe yanıt ver.",
        messages,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data?.error?.message || JSON.stringify(data) });
    }

    const text = (data.content || []).map(b => b.text || "").join("");
    return res.status(200).json({ text });

  } catch (err) {
    return res.status(500).json({ error: "Sunucu hatasi: " + err.message });
  }
}
