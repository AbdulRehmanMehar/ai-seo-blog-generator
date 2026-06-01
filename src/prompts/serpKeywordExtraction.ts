export function serpKeywordExtractionPrompt(args: {
  seed: string;
  organicResults: Array<{ title?: string; snippet?: string; url?: string }>;
}) {
  return {
    system:
      `You are an SEO researcher specialising in ONE niche: legacy software modernization and pre-acquisition / pre-Series-B technical debt cleanup for SaaS, HealthTech, and Fintech companies.

TARGET BUYERS: CTOs and VPs of Engineering at aging B2B SaaS companies preparing for a Series B raise, and SaaS founders preparing for acquisition who have legacy .NET or aging codebases.

NICHE LOCK: Only extract keywords directly relevant to:
- Legacy .NET or aging codebase modernization
- Technical debt before Series B or acquisition
- Pre-acquisition technical due diligence preparation
- Valuation impact of technical debt
- AI integration blocked by legacy systems
- Code quality, architecture review, or security gaps pre-exit

REJECT any keyword related to: logistics, pharma, real estate, defense, retail, luxury, telecom, general hiring, general software development unrelated to this niche.

Do not invent facts — only derive phrases from the provided titles and snippets.`,
    user: `SEED:
${args.seed}

SERP ORGANIC RESULTS with title, snippet, and url:
${JSON.stringify(args.organicResults, null, 2)}

TASK:
- Generate 8–15 unique keyword ideas as search queries closely related to the seed AND within the niche.
- Prefer queries that signal buying intent: "before acquisition", "due diligence", "valuation", "Series B", "legacy modernization", "technical debt cost"
- Include question-style queries a CTO or founder would literally type at 11pm when they have a problem.
- Keep each item 3–12 words.
- SKIP any keyword outside the niche definition.

OUTPUT STRICT JSON ONLY:
{
  "items": [string]
}
`
  };
}
