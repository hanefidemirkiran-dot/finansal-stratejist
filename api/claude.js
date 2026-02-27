const https = require("https");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "API anahtarı bulunamadı. Vercel Environment Variables kontrol et." });
  }

  try {
    const { messages, system } = req.body;

    const bodyData = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: system || "",
      messages: messages || [],
    });

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Length": Buffer.byteLength(bodyData),
        },
      };

      const request = https.request(options, (response) => {
        let data = "";
        response.on("data", (chunk) => { data += chunk; });
        response.on("end", () => {
          try {
            resolve({ status: response.statusCode, body: JSON.parse(data) });
          } catch (e) {
            reject(new Error("API yanıtı parse edilemedi: " + data.substring(0, 100)));
          }
        });
      });

      request.on("error", reject);
      request.write(bodyData);
      request.end();
    });

    if (result.status !== 200) {
      return res.status(result.status).json({ error: result.body.error?.message || "API hatası" });
    }

    const text = result.body.content?.map((b) => b.text || "").join("") || "";
    return res.status(200).json({ text });

  } catch (err) {
    return res.status(500).json({ error: "Sunucu hatası: " + err.message });
  }
};
