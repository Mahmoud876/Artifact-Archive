export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.6-luna";
export const DEFAULT_OPENROUTER_MAX_OUTPUT_TOKENS = 8_000;

export function creditAwareOpenRouterLimit(message: string, currentLimit: number) {
  const match = message.match(/can only afford\s+(\d+)/i);
  const affordable = match ? Number(match[1]) : Number.NaN;
  if (!Number.isFinite(affordable) || affordable < 256 || affordable >= currentLimit) return null;
  return Math.max(256, Math.floor(affordable * 0.9));
}

/** Models an authenticated operator is allowed to select from the browser. */
export function configuredOpenRouterModels() {
  const configured = [
    process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
    ...String(process.env.OPENROUTER_MODELS || "").split(","),
  ];
  return [...new Set(configured.map((name) => name.trim()).filter(Boolean))];
}
