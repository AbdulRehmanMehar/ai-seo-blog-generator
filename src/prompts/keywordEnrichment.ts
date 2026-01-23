export function keywordEnrichmentPrompt(args: { keywords: string[] }) {
  return {
    system:
      'You are an SEO analyst for B2B software development consulting. Return grounded estimates; prefer conservative ranges.',
    user: `KEYWORDS:\n${JSON.stringify(args.keywords, null, 2)}\n\nTASK:\nFor each keyword, estimate:\n- volume: integer monthly searches (rough estimate)\n- difficulty: 0-100 (rough estimate)\n- cpc: number (USD)\n- intent: one of: \"commercial\", \"founder/CTO\", \"commercial + founder/CTO\", \"informational\"\n\nOUTPUT STRICT JSON ONLY:\n{\n  \"items\": [\n    { \"keyword\": string, \"volume\": number, \"difficulty\": number, \"cpc\": number, \"intent\": string }\n  ]\n}\n\nCRITICAL OUTPUT RULES:\n- Output must be a single JSON object (not an array).\n- Do not wrap the JSON in Markdown fences.\n- The first character must be '{' and the last character must be '}'.\n- No trailing commas, no comments, no extra keys.\n`
  };
}
