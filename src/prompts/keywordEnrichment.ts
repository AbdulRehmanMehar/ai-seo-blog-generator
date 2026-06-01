export function keywordEnrichmentPrompt(args: { keywords: string[] }) {
  return {
    system:
      `You are an SEO analyst specialising in ONE niche: legacy software modernization and pre-acquisition / pre-Series-B technical debt cleanup for SaaS, HealthTech, and Fintech companies.

TARGET BUYERS: CTOs/VPs of Engineering at aging B2B SaaS companies (Series B window) and SaaS founders ($2M–$15M ARR) preparing for acquisition with legacy .NET or aging codebases.

When estimating CPC, bias upward for keywords that signal: "acquisition", "due diligence", "valuation", "Series B", "legacy .NET modernization", "pre-exit". These buyers have large budgets and high LTV — advertisers pay a premium.
Return grounded, conservative estimates.`,
    user: `KEYWORDS:
${JSON.stringify(args.keywords, null, 2)}

TASK:
For each keyword, estimate:
- volume as integer monthly searches (conservative estimate)
- difficulty as 0–100
- cpc as number in USD (bias upward for acquisition/valuation/due-diligence keywords — buyers here pay $50k–$300k engagements)
- intent as one of: "transactional" | "commercial" | "informational" — use "transactional" for keywords that signal active buying like "hire", "cost", "before acquisition", "due diligence"

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
