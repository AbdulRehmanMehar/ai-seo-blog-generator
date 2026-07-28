export function serpKeywordExtractionPrompt(args: {
  seed: string;
  organicResults: Array<{ title?: string; snippet?: string; url?: string }>;
}) {
  return {
    system:
      `You are an SEO researcher specialising in ONE niche: removing digital friction for growing businesses through modern software, workflow automation, and practical AI.

TARGET BUYERS: owners of growing service businesses (hospitality, clinics, real estate, recruiting, e-commerce, home services; 15-150 staff), non-technical founders of digital products, and operations leads — buyers of $20k-$50k engagements who decide directly.

NICHE LOCK: Only extract keywords directly relevant to:
- Booking, scheduling, intake, and customer-portal friction
- Disconnected tools, integrations, and double data entry
- Manual workflows and reporting ready for automation or AI assistants
- Slow or aging websites and web apps hurting customer experience
- MVP builds/rebuilds and rescuing stalled products for non-technical founders
- Choosing and working with a technology partner at this budget level

REJECT any keyword aimed at enterprise buyers: defense, bank compliance (KYC/AML), pharma, Fortune 500 IT, Series B / acquisition / technical due diligence, or anything whose natural stakes are millions of dollars.

Do not invent facts — only derive phrases from the provided titles and snippets.`,
    user: `SEED:
${args.seed}

SERP ORGANIC RESULTS with title, snippet, and url:
${JSON.stringify(args.organicResults, null, 2)}

TASK:
- Generate 8–15 unique keyword ideas as search queries closely related to the seed AND within the niche.
- Prefer queries that signal buying intent: "custom booking system for", "automate client intake", "connect X to Y", "hire developer for", "replace spreadsheets with", "AI assistant for small business"
- Include question-style queries a business owner, founder, or ops manager would literally type at 11pm when they have a problem.
- Keep each item 3–12 words.
- SKIP any keyword outside the niche definition.

OUTPUT STRICT JSON ONLY:
{
  "items": [string]
}
`
  };
}
