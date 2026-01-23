export function serpKeywordExtractionPrompt(args: {
  seed: string;
  organicResults: Array<{ title?: string; snippet?: string; url?: string }>;
}) {
  return {
    system:
      'You are an SEO researcher for B2B software development consulting. Extract realistic long-tail search queries and questions from SERP snippets. Do not invent facts and only derive phrases from the provided titles and snippets.',
    user: `SEED:
${args.seed}

SERP ORGANIC RESULTS with title, snippet, and url:
${JSON.stringify(
      args.organicResults,
      null,
      2
    )}

TASK:
- Generate 8-15 unique keyword ideas as search queries closely related to the seed.
- Prefer commercial, founder, or CTO oriented queries when plausible.
- Include some question-style queries.
- Keep each item 3-12 words.

OUTPUT STRICT JSON ONLY:
{
  "items": [string]
}
`
  };
}
