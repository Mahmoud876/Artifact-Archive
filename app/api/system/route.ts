export async function GET() {
  return Response.json({
    analysis: { configured: Boolean(process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY) },
    defaults: { model: process.env.QWEN_MODEL || "qwen2.5vl:7b" },
  }, { headers: { "cache-control": "no-store" } });
}
