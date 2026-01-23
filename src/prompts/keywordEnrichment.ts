export function keywordEnrichmentPrompt(args: { keywords: string[] }) {
  return {
    system:
      'You are an SEO analyst for B2B software development consulting. Return grounded estimates and prefer conservative ranges.',
    user: `KEYWORDS:
${JSON.stringify(args.keywords, null, 2)}

TASK:
For each keyword, estimate:
- volume as integer monthly searches with rough estimate
- difficulty as 0-100 with rough estimate
- cpc as number in USD
- intent as one of commercial, founder or CTO, commercial plus founder or CTO, informational

OUTPUT STRICT JSON ONLY:
{
  "items": [
    { "keyword": string, "volume": number, "difficulty": number, "cpc": number, "intent": string }
  ]
}

CRITICAL OUTPUT RULES:
- Output must be a single JSON object not an array.
- Do not wrap the JSON in Markdown fences.
- The first character must be curly brace and the last character must be curly brace.
- No trailing commas, no comments, no extra keys.
`
  };
}
