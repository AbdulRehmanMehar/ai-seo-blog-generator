import { env } from '../config/env.js';

/**
 * Reading-level (CEFR) writing guidance injected into every content-generation prompt.
 *
 * Research note: LLMs default to near-native (C1/C2) complexity and prompting alone is
 * unreliable for low CEFR levels, so this guidance is deliberately concrete (explicit
 * rules + a before/after example) and is BACKED UP by deterministic post-processing in
 * postHumanizer and a readability check in postReviewer. See:
 *  - https://cefrlookup.com/cefr-a2-guide  (A2 = elementary, ~1500-word vocabulary)
 *  - https://arxiv.org/html/2406.03030v1   ("From Tarzan to Tolkien": level control for LLMs)
 */

const A2_GUIDE = `
WRITE IN A2 (ELEMENTARY) ENGLISH — THIS IS A HARD REQUIREMENT
You are writing for a reader at CEFR A2 level. Many readers are not native English
speakers. Your writing must be clear and simple enough for them, while still being
accurate and useful. Simple does NOT mean dumb. Keep the expert substance, just say it
plainly.

SENTENCE RULES
- Keep sentences short. Aim for 10 to 15 words. Never go over 22 words.
- One idea per sentence. If a sentence has two ideas, split it into two sentences.
- Use the active voice. "The team fixed the bug." Not "The bug was fixed by the team."
- Mostly use simple present, simple past, and simple future (will / going to).
- Join ideas with easy words: and, but, so, because, then, also, if.
- Avoid long sentences with many commas, semicolons, or clauses inside clauses.

WORD RULES
- Use common, everyday words. Prefer the simple word over the fancy one.
  use (not utilize), buy (not purchase), help (not facilitate), about (not approximately),
  start (not commence), need (not require), show (not demonstrate), enough (not sufficient),
  get (not obtain), more (not additional), many (not numerous), end (not terminate),
  before (not prior to), because (not due to the fact that).
- Explain any technical term in a few simple words the first time you use it.
- Do not use idioms, slang, or clever wordplay. A non-native reader may not understand them.
- Do not use Latin abbreviations like e.g., i.e., etc. Write "for example", "that is", "and so on".

PUNCTUATION RULES
- Never use em dashes (—) or en dashes (–). Use a full stop, a comma, or the word "and".
- Never use colons (:) in titles or headings.
- No semicolons. Use two short sentences instead.

EXAMPLE
Too complex (C1): "Leveraging a phased migration strategy enables organizations to
modernize legacy systems while simultaneously mitigating the operational risks inherent
in a wholesale rewrite."
A2 version: "You can move off an old system one step at a time. This is safer than
rebuilding everything at once. It also keeps your app running while you work."

Write the whole post this way. Short sentences. Simple words. Clear ideas.
`;

const B1_GUIDE = `
WRITE IN B1 (INTERMEDIATE) ENGLISH
Keep sentences mostly short (aim under 20 words). Prefer common words over rare ones.
Use the active voice. Avoid jargon unless you explain it. Never use em dashes or colons
in titles. Split long, multi-clause sentences into shorter ones.
`;

const B2_GUIDE = `
WRITE IN CLEAR B2 ENGLISH
Favor plain, direct language. Keep most sentences under 25 words. Avoid needless jargon
and flowery vocabulary. Use the active voice. Never use em dashes or colons in titles.
`;

/**
 * Returns the reading-level guidance block for the configured CONTENT_READING_LEVEL,
 * or an empty string when level enforcement is disabled.
 */
export function getReadingLevelGuidelines(): string {
  switch (env.CONTENT_READING_LEVEL) {
    case 'A2': return A2_GUIDE;
    case 'B1': return B1_GUIDE;
    case 'B2': return B2_GUIDE;
    case 'none':
    default: return '';
  }
}

/** Short reminder line for prompts that already carry the full guide elsewhere. */
export function getReadingLevelReminder(): string {
  if (env.CONTENT_READING_LEVEL === 'none') return '';
  return `Write in ${env.CONTENT_READING_LEVEL} English: short sentences, simple common words, active voice, no em dashes.`;
}
