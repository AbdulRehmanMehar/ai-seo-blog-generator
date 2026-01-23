export function serpKeywordExtractionPrompt(args: {
  seed: string;
  organicResults: Array<{ title?: string; snippet?: string; url?: string }>;
}) {
  return {
    system:
      'You are an SEO researcher for B2B software development consulting. Extract realistic long-tail search queries and questions from SERP snippets. Do not invent facts; only derive phrases from the provided titles/snippets.',
    user: `SEED:\n${args.seed}\n\nSERP_ORGANIC_RESULTS (title/snippet/url):\n${JSON.stringify(
      args.organicResults,
      null,
      2
    )}\n\nTASK:\n- Generate 8-15 unique keyword ideas (search queries) closely related to the seed.\n- Prefer commercial / founder / CTO oriented queries when plausible.\n- Include some question-style queries.\n- Keep each item 3-12 words.\n\nOUTPUT STRICT JSON ONLY:\n{\n  \"items\": [string]\n}\n`
  };
}
