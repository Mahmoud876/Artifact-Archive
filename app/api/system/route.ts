type OllamaTags = { models?: Array<{ name?: string; details?: { families?: string[] } }> };
type DetectorHealth = { status?: string; model?: string; device?: string; cuda?: string; loaded?: boolean };

async function readOllama(base: string) {
  try {
    const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(6_000) });
    if (!response.ok) return { ok: false, base, models: [], error: `Ollama returned ${response.status}.` };
    const payload = await response.json() as OllamaTags;
    const models = (payload.models ?? [])
      .map((entry) => entry.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0)
      .sort((left, right) => left.localeCompare(right));
    return { ok: true, base, models };
  } catch (error) {
    return { ok: false, base, models: [], error: error instanceof Error ? error.message : "Ollama is unreachable." };
  }
}

async function readDetector(base: string) {
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(6_000) });
    if (!response.ok) return { ok: false, base, error: `The detector returned ${response.status}.` };
    const payload = await response.json() as DetectorHealth;
    return { ok: true, base, status: payload.status, model: payload.model, device: payload.device, cuda: payload.cuda };
  } catch (error) {
    return { ok: false, base, error: error instanceof Error ? error.message : "The detector is unreachable." };
  }
}

export async function GET() {
  const qwenBase = (process.env.QWEN_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
  const visionBase = (process.env.VISION_BASE_URL || "http://127.0.0.1:8788").replace(/\/$/, "");
  const [ollama, detector] = await Promise.all([
    readOllama(qwenBase),
    readDetector(visionBase),
  ]);

  return Response.json({
    ollama,
    detector,
    analysis: { configured: Boolean(process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY) },
    defaults: { model: process.env.QWEN_MODEL || "qwen2.5vl:7b" },
  }, { headers: { "cache-control": "no-store" } });
}
