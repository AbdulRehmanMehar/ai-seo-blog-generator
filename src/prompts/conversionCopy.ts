/**
 * High-Converting Blog Copywriting Guidelines
 * Based on proven conversion principles and frameworks.
 */

export const HEADLINE_FORMULAS = `
Headline Formulas (Use ONE)

1. Numbers Formula like "7 Database Mistakes That Cost Startups $100K+"
2. How-To Formula like "How to Achieve Outcome Without Pain Point"
3. Curiosity Gap like "Why Your Topic Is Problem and It Is Not What You Think"
4. Direct Benefit like "Cut Your Metric by Percentage"
5. Contrarian Take like "Why I Stopped Using Popular Thing and What I Use Instead"

Power Words to use are Hidden, Proven, Secret, Ultimate, Insider, Guaranteed, Surprising

IMPORTANT: Never use colons in titles. Write flowing titles without colons or em dashes.
`;

export const OPENING_HOOK_STRATEGIES = `
Opening Hook (Choose ONE strategy)

1. Pain Agitation Hook. Start with a pain point the reader feels RIGHT NOW.
   Write something like "You're staring at specific problem. Then show consequence. Then show stakes."

2. Story Hook. Open with a specific, relatable moment.
   Write something like "It was time when incident happened. Then describe what happened. Then show cost or consequence."

3. Outcome Hook. Lead with the end result.
   Write something like "Last month, we achieved X outcome. No common objection. Just simple solution."

4. Contrarian Hook. Challenge a common belief.
   Write something like "Everyone says you need popular solution. After experience, I'm convinced that's wrong."

5. Question Hook. Ask something that makes them say "yes, that's me."
   Write something like "Ever spent time on task, only to realize bad outcome?"

CRITICAL: First 2 sentences must hook. No throat-clearing. No definitions. Jump into the pain or outcome.

NEVER use colons in your hook. Write naturally flowing sentences.
`;

export const COPYWRITING_FRAMEWORKS = `
Content Structure Framework

Use PAS structure throughout, which means Problem then Agitation then Solution.

1. Problem. State the pain clearly in reader's language
2. Agitation. Make them feel the cost of NOT solving it
3. Solution. Present your approach as the logical answer

For each major section:
- Start with WHY this matters, not what it is
- Use specific numbers and examples. Instead of "improve performance" write "reduce load time from 4.2s to 0.8s"
- End sections with a transition that builds momentum

NEVER use colons or em dashes in your content. Write naturally flowing prose.
`;

export const PERSUASION_TRIGGERS = `
Persuasion Triggers (Integrate Naturally)

1. Social Proof. Mention specific companies, user counts, results.
   Example is "This approach helped Company reduce metric by percentage"
   
2. Authority Signals. Reference experience naturally.
   Example is "After building X systems over Y years..."
   Example is "Having worked with type of clients..."

3. Specificity. Vague fails. Specific converts.
   Bad example is "Improve performance significantly"
   Good example is "Reduce API latency from 800ms to 120ms"

4. Transformation over Features.
   Bad example is "AI-powered code analysis"
   Good example is "Ship confident code without 2-hour PR review cycles"

5. Risk Reversal. Address objections proactively.
   Example is "You might be thinking objection. Here's why that's not the case..."

NEVER use colons for labels. Write flowing sentences instead.
`;

export const CTA_GUIDELINES = `
CTA Strategy

Formula is Verb plus Value plus Optional Urgency.
Bad examples are "Contact us" or "Learn more"
Good examples are "Get Your Free Architecture Review" or "See How We Cut Costs 60%"

Placement:
1. Soft CTA after intro for high-intent readers. Offer a related resource or quick win.
2. Contextual mid-article CTAs. Naturally mention services where relevant.
3. Primary CTA before conclusion. Place it after delivering value.

B2B CTAs that work:
- "Book a Free Specific Review"
- "Get the Resource Checklist"
- "See This in Action in the Case Study"
- "Schedule a Technical Discovery Call"

Tone. CTA should feel like the natural next step, not a sales pitch.

NEVER use colons in CTAs. Write them as natural action-oriented phrases.
`;

export const CONTENT_STRUCTURE = `
Scannable Structure Requirements

1. Headers every 200-300 words. Readers skim first.
2. Emphasize key phrases by placing them at sentence starts. No bold markers.
3. Use flowing prose for steps and features. Easy to process.
4. Include specific examples after concepts. Theory plus Practice.
5. Add transition sentences. Guide readers between sections.

"So What?" Test. Every paragraph must answer why should the reader care.

Transformation Language:
- Don't describe features, describe outcomes
- Don't say "you can", say "you will"
- Don't be vague, be specific with numbers and examples

FORMATTING RULES:
- No colons in headers or body text
- No em dashes anywhere
- No markdown formatting symbols
- Write plain, natural-sounding prose
`;

export const B2B_SPECIFIC = `
B2B Writing Guidelines

1. Multi-Stakeholder Value:
   - Technical depth for engineers
   - Business outcomes for executives
   - Implementation ease for managers

2. Risk Reduction:
   - Include "what to expect" clarity
   - Mention similar companies and use cases
   - Address common concerns proactively

3. Shareable Stats:
   - Include quotable numbers
   - Make ROI clear
   - Executive-friendly summary points

IMPORTANT: All content must be plain text. No colons for labels. No em dashes. No markdown.
`;

/**
 * Get full conversion guidelines for blog generation
 */
export function getConversionGuidelines(): string {
  return `
HIGH-CONVERTING CONTENT GUIDELINES

CRITICAL FORMATTING RULES:
- Never use colons in titles, headings, or body text
- Never use em dashes anywhere
- Never use markdown formatting like asterisks or hashtags
- Write plain, natural-sounding prose throughout

${HEADLINE_FORMULAS}

${OPENING_HOOK_STRATEGIES}

${COPYWRITING_FRAMEWORKS}

${PERSUASION_TRIGGERS}

${CTA_GUIDELINES}

${CONTENT_STRUCTURE}

${B2B_SPECIFIC}
`.trim();
}

/**
 * Get headline-specific guidelines for topic planning
 */
export function getHeadlineGuidelines(): string {
  return `
HEADLINE AND TOPIC GUIDELINES

${HEADLINE_FORMULAS}

Topic Selection Criteria:
- High commercial intent with buyer keywords
- Clear pain point or outcome
- Specific enough to be actionable
- Allows for contrarian or unique angle

Outline Requirements:
- Opening section MUST be a hook, not a definition
- Each section should build toward transformation
- Include a "Common Mistakes" or "What Most People Get Wrong" section
- End with actionable next steps, not just summary

CRITICAL: Never use colons or em dashes in headlines or body text. Write naturally flowing titles.
`.trim();
}

/**
 * Get humanization guidelines for the polish pass
 */
export function getHumanizationGuidelines(): string {
  return `
HUMANIZATION AND CONVERSION POLISH

CRITICAL FORMATTING RULES FOR ALL OUTPUT:
- Never use colons anywhere in titles, headings, or body text
- Never use em dashes anywhere
- Never use markdown formatting like asterisks, hashtags, or underscores
- Write plain, natural-sounding prose that flows when read aloud

FORBIDDEN AI VOCABULARY (ABSOLUTE BLOCKLIST)
Never use these words. Replace them as follows:
- \"delve\" or \"delve into\" becomes \"look at\", \"explore\", \"dig into\"
- \"leverage\" becomes \"use\", \"apply\", \"take advantage of\"
- \"utilize\" becomes \"use\"
- \"facilitate\" becomes \"help\", \"enable\", \"make possible\"
- \"robust\" should describe specifically what makes it strong
- \"seamless\" should describe the actual experience
- \"cutting-edge\" should be specific about what is new
- \"comprehensive\" becomes \"complete\", \"full\", \"thorough\"
- \"streamline\" becomes \"speed up\", \"simplify\"
- \"synergy\" or \"paradigm shift\" or \"game-changer\" should never appear
- \"arguably\" should just state your argument directly, or don't make it
- \"paramount\" becomes \"critical\", \"essential\", \"crucial\"
- \"pivotal\" becomes \"key\", \"important\", \"turning point\"
- \"foster\" becomes \"build\", \"encourage\", \"grow\"
- \"bolster\" becomes \"strengthen\", \"boost\", \"support\"
- \"boasts\" becomes \"has\", \"offers\", \"includes\"
- \"myriad\" becomes \"many\", \"lots of\", \"countless\"
- \"plethora\" becomes \"many\", \"lots of\", \"plenty\"
- \"landscape\" as metaphor should be specific about the market or industry
- \"navigate\" as metaphor becomes \"handle\", \"deal with\", \"work through\"
- \"realm\" becomes \"area\", \"field\", \"space\"
- \"underscore\" becomes \"highlight\", \"show\", \"emphasize\"
- \"spearhead\" becomes \"lead\", \"start\", \"drive\"
- \"endeavor\" becomes \"try\", \"work\", \"effort\"
- \"multifaceted\" becomes \"complex\", \"varied\", or list the specific facets

FORBIDDEN OPENINGS (rewrite immediately if found)
- \"In today's fast-paced or digital or ever-evolving world...\"
- \"In this article, we will explore...\"
- \"It's no secret that...\"
- \"As businesses continue to...\"
- \"Let's dive into...\"
- \"When it comes to...\"

FORBIDDEN TRANSITIONS
- \"Furthermore...\" or \"Moreover...\" or \"Additionally...\"
- \"It's worth noting that...\" or \"It's important to remember...\"
- \"Having said that...\" or \"That being said...\"

FORBIDDEN CLOSINGS
- \"In conclusion...\" or \"To sum up...\" or \"As we've seen...\"
- \"Moving forward...\" or \"At the end of the day...\"

HEDGE WORDS TO ELIMINATE (these signal AI wrote this)
- \"can potentially\" should just say \"can\" or commit to \"will\"
- \"might be able to\" becomes \"can\" or \"will\"
- \"could possibly\" should pick one word, not both
- \"it's worth noting\" should just note it directly
- \"it bears mentioning\" should just mention it
- \"essentially\" should be removed entirely or be specific
- \"basically\" should be removed or explained properly
- \"arguably\" should make your argument or don't
- \"relatively\" should give the actual comparison
- \"fairly\" or \"quite\" or \"rather\" should commit to a stronger word
- \"somewhat\" should be specific about the degree
- \"in many ways\" should list the actual ways or cut it

VOICE TRANSFORMATION RULES

1. Replace hedge words with commitment.
   - \"might potentially help\" becomes \"helps\"
   - \"could be considered\" becomes \"is\"
   - \"it's possible that\" should state it directly

2. Replace passive with active.
   - \"was implemented by the team\" becomes \"the team implemented\"
   - \"can be achieved through\" becomes \"achieve this through\"

3. Replace vague with specific.
   - \"significantly improved\" becomes \"improved by 67%\"
   - \"many companies\" becomes \"3 Series A startups I've worked with\"
   - \"various options\" becomes \"three options which are X, Y, Z\"

4. Add contractions (mandatory).
   - \"do not\" becomes \"don't\"
   - \"cannot\" becomes \"can't\"
   - \"will not\" becomes \"won't\"
   - Exception is for emphasis like \"I do NOT recommend...\"

SENTENCE RHYTHM REQUIREMENTS
- Vary length with some 5-word punches and some 20-word flows
- Use fragments occasionally. Like this.
- Start some sentences with \"And\" or \"But\"
- Include at least one 1-sentence paragraph per section for impact

PERSONALITY INJECTION
Add these naturally throughout:
- Personal judgment like \"In my experience\" or \"What I've found is\"
- Mild frustration like \"This drives me crazy\" or \"I've seen this mistake too many times\"
- Enthusiasm like \"This is where it gets good\" or \"Here's the elegant part\"
- Honest uncertainty like \"I might be wrong, but\" or \"The data isn't clear on\"

AUTHORITY SIGNALS TO WEAVE IN
- Specific years or project counts like \"After 8 years building...\"
- Named companies or types like \"At a Series B fintech...\"
- Concrete results like \"which cut our deploy time from 4 hours to 12 minutes\"
- Lessons from failure like \"I learned this the hard way when...\"

TRANSITION PHRASES THAT FEEL HUMAN
- \"Here's where it gets interesting...\"
- \"But here's what most people miss...\"
- \"This is where it clicks...\"
- \"Now, you might be thinking...\"
- \"The counterintuitive part...\"
- \"What surprised me was...\"

THE READ-ALOUD TEST
If any sentence:
- Makes you stumble when reading aloud then rewrite it
- Sounds like a robot wrote it then add personality
- You wouldn't say to a colleague then simplify it

HEADLINE-CONTENT ALIGNMENT (CRITICAL)
If your headline promises a number, DELIVER that exact number.
- \"7 Mistakes\" means you MUST have 7 clearly numbered or labeled mistakes
- \"5 Ways\" means you MUST have 5 distinct, numbered ways
- \"10 Tips\" means you MUST have 10 clearly identified tips

Format for numbered headlines:
- Each item gets its own section heading
- Number them explicitly like \"1. First Mistake\" and \"2. Second Mistake\"
- Don't bury items in prose. Make them scannable.

For \"How to\" headlines:
- Include clear, numbered steps
- Each step should be actionable and start with a verb

For \"Guide\" headlines:
- Cover the topic completely
- Include a logical progression from basics to advanced
`.trim();
}
