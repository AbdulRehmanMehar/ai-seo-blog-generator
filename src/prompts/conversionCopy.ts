/**
 * High-Converting Blog Copywriting Guidelines
 * Based on proven conversion principles and frameworks.
 */

/**
 * Remove Friction, Promise the Experience.
 * Replaces the old "Sell Money, Not Services" dollarization framework.
 * Per the Brand Operating System: we never promise revenue or dollar savings —
 * those outcomes depend on factors beyond our work. We name the friction the
 * reader's customers and team feel daily, and we promise what we control.
 */
export const REMOVE_FRICTION_FIRST = `
Remove Friction, Promise the Experience (Core Framework)

PRINCIPLE: Your reader doesn't want a website, an API, or an AI integration.
They want their staff to stop fighting the tools, their customers to stop feeling
the friction, and their own evenings back. Every piece of content must frame your
work as removing specific, recognizable friction — not as a revenue machine.

WRONG: "I build Next.js applications."
WRONG: "This system will save you $180k a year." (a promise we cannot make)
RIGHT: "The front desk retypes every booking into three systems. That's the kind
of friction we remove, so the team's time goes to guests instead of data entry."

THE FRICTION FORMULA:
  [Recognizable daily friction] → [What smooth looks like] → [What we build to get there]

Examples (derive from author knowledge and ICP context):
- "Your staff copy-paste between the CRM and the scheduler" → "one intake flow that updates both" → "a small integration layer we build in weeks"
- "Customers give up halfway through your booking form on mobile" → "a two-minute booking that works on any phone" → "a rebuilt booking flow"
- "Your Monday report takes half a day to assemble" → "a dashboard that's already up to date on Monday morning" → "reporting automation on top of your existing tools"

NO DOLLAR PROMISES (non-negotiable):
- NEVER write "this will save you $X" or "worth $X a year" or promise ROI, payback, or revenue.
  Revenue and cost depend on many factors beyond what we build, and pretending otherwise breaks trust.
- Consequences of friction are stated OPERATIONALLY: hours of rework, abandoned bookings,
  slow replies, staff burnout, onboarding that takes weeks. The reader can verify these
  in their own business today — that is what makes them persuasive.
- Real measured outcomes from the author's real projects are EVIDENCE, stated in past
  tense about that project ("one project cut manual processing by 70%"). Evidence is
  never converted into a prediction for the reader.

COST OF INACTION — FRICTION EDITION:
Every post should still answer "why not just do nothing?" — honestly.
  "If nothing changes, [the friction] keeps taxing [who feels it] every [day/week/season], and [growth/busy season] makes it worse, never better."
Examples:
- "Every busy season, the manual workload doubles and your best admin gets closer to quitting."
- "Every customer who abandons the booking form goes somewhere smoother, and you never hear about it."
- "Every new hire takes weeks to learn the workarounds, because the process lives in people's heads."

PROBLEM SEEKER, NOT JUST PROBLEM SOLVER:
Don't write about "how to build a better API."
Write about the friction the reader recognizes, where the answer happens to be what you build.

Wrong topic angle: "How to Build a Booking System"
Right topic angle: "Why Customers Abandon Your Booking Halfway" (answer is a better flow)

Wrong topic angle: "Workflow Automation Services"
Right topic angle: "Your Team Isn't Slow. Your Tools Are." (answer is integration + automation)
`;

/** @deprecated Old dollarization framework — kept as an alias so stale imports fail loudly in review, not silently. */
export const SELL_MONEY_NOT_SERVICES = REMOVE_FRICTION_FIRST;

export const HEADLINE_FORMULAS = `
Headline Formula (REQUIRED: Pain + Outcome + Curiosity)

Every headline MUST include:
1. SPECIFIC PAIN POINT the reader feels right now
2. CLEAR OUTCOME or benefit they'll get  
3. CURIOSITY gap or specific number

FORMULA: [Pain] + [Outcome] + [Curiosity]

GOOD examples:
- "Why Customers Abandon Your Booking Halfway (And What Smooth Looks Like)"
  (Pain: lost bookings, Outcome: fix the flow, Curiosity: why?)
- "Your Team Isn't Slow. Your Tools Are."
  (Pain: slow operations, Outcome: understand the real cause, Curiosity: contrarian claim)
- "7 Signs Your Systems Don't Talk to Each Other"
  (Pain: disconnected tools, Outcome: diagnose it, Curiosity: 7 signs)
- "The Monday Report Your Ops Manager Shouldn't Be Building by Hand"
  (Pain: manual reporting, Outcome: automate it, Curiosity: what instead?)

BAD examples:
- "Technical Debt in Software" (no pain, no outcome, no curiosity)
- "Building Teams: A Complete Guide" (colon, generic, no emotional hook)
- "7 Mistakes That Cost Startups $100K+" (dollar-scare framing — we don't promise or threaten dollars)
- "Software Development Best Practices" (boring, no stakes)

Power words to use: Cost, Mistakes, Fix, Losing, Failing, Wrong, Actually
NEVER use clickbait words: Hidden, Secret, Shocking, Ultimate, Insider — Google refuses to index
formulaic clickbait titles, and the brand is never flashy. Specificity does the selling.

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

CRITICAL AUTHENTICITY RULE:
NEVER fabricate client stories, company names, or specific results you didn't achieve.
Only reference your own direct experience from the author knowledge.
Do NOT make up clients, customers, or companies you "helped".

1. First-Person Experience. Share YOUR direct experience, not invented client stories.
   NDA RULE: never name a client or employer — describe the work anonymously.
   Good: "After building 5 production APIs, I've found that..."
   Good: "On a large e-commerce migration I led, we reduced load time from 4.2s to 0.8s"
   BAD: "In my SmashCloud migration project..." (NDA violation — client name)
   BAD: "I helped a client reduce their load time..." (unless specifically mentioned in author knowledge)
   BAD: "My clients see 50% improvement..." (fabrication)

2. Authority from Real Projects. Reference actual projects from author knowledge, anonymously.
   Good: "After migrating a legacy .NET MVC platform to Next.js..."
   Good: "While building a desktop screen-recording product..."
   BAD: "While building the DashCam.io desktop app..." (NDA violation — client name)
   BAD: "I worked with 3 Series A startups..." (unless true and documented)

3. Specificity. Vague fails. Specific converts. But be truthful.
   Bad: "Improve performance significantly"
   Good: "Reduce API latency from 800ms to 120ms" (only if you actually did this)
   Good: "Use pagination to handle 10k+ records efficiently"

4. Transformation over Features.
   Bad: "AI-powered code analysis"
   Good: "Ship confident code without 2-hour PR review cycles"

5. Risk Reversal. Address objections proactively.
   Good: "You might be thinking this adds complexity. Here's why it actually simplifies things..."

NEVER use colons for labels. Write flowing sentences instead.
Do NOT invent success metrics, client names, or case studies.
`;

export const CTA_GUIDELINES = `
CTA Strategy

Formula is Verb plus Value plus Optional Urgency.
Bad examples are "Contact us" or "Learn more" or "Schedule a call"
Good examples are "Send Me Your Booking Flow and I'll Show You Where Customers Drop Off"

Placement:
1. Soft CTA after intro for high-intent readers. Offer a related resource or quick win.
2. Contextual mid-article CTAs. Naturally mention services where relevant.
3. Primary CTA before conclusion. Place it after delivering value.

CTAs that work (calm, specific, low-friction diagnostic offers):
- "Send me a screen recording of the double entry your team does. I'll show you what can be automated."
- "Describe your booking flow in one email. I'll point out where customers give up."
- "Get the workflow audit checklist."
- "Send me your current setup. I'll map the friction and what I'd fix first."

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

3. Shareable Insights:
   - Include quotable, verifiable observations (from real experience only)
   - Make the friction and the fix concrete enough to forward to a colleague
   - Owner-friendly summary points, no invented ROI figures

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

${REMOVE_FRICTION_FIRST}

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

${REMOVE_FRICTION_FIRST}

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
   - "significantly improved" becomes "improved by 67%" (only if true)
   - "many developers" becomes "developers I've mentored"
   - "various options" becomes "three options which are X, Y, Z"
   - NEVER make up client numbers or companies you haven't worked with

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

AUTHORITY SIGNALS TO WEAVE IN (MUST BE AUTHENTIC)
- Specific years or project counts like \"After 5 years building full-stack systems...\"\n- Anonymous descriptions of YOUR actual work like \"On a large e-commerce migration I led...\" or \"While building a desktop replay product...\" — NEVER client or employer names (NDA)\n- Concrete results from YOUR real projects, not fabricated client stories\n- Lessons from YOUR actual failures, not made-up scenarios\n- NEVER claim to have \"clients\" unless the author knowledge explicitly lists them\n- NEVER make up company names or specific metrics for unnamed clients

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
