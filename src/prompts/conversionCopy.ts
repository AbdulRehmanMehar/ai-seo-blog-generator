/**
 * High-Converting Blog Copywriting Guidelines
 * Based on proven conversion principles and frameworks.
 */

export const HEADLINE_FORMULAS = `
## Headline Formulas (Use ONE)

1. **Numbers Formula:** "7 Database Mistakes That Cost Startups $100K+"
2. **How-To Formula:** "How to [Achieve Outcome] Without [Pain Point]"
3. **Curiosity Gap:** "Why Your [Topic] Is [Problem] (It's Not What You Think)"
4. **Direct Benefit:** "Cut Your [Metric] by [Percentage]"
5. **Contrarian Take:** "Why I Stopped Using [Popular Thing] (And What I Use Instead)"

**Power Words:** Hidden, Proven, Secret, Ultimate, Insider, Guaranteed, Surprising
`;

export const OPENING_HOOK_STRATEGIES = `
## Opening Hook (Choose ONE strategy)

1. **Pain Agitation Hook** - Start with a pain point the reader feels RIGHT NOW:
   "You're staring at [specific problem]. [Consequence]. [Stakes]."

2. **Story Hook** - Open with a specific, relatable moment:
   "It was [time] when [incident]. [What happened]. [Cost/consequence]."

3. **Outcome Hook** - Lead with the end result:
   "Last month, we [achieved X outcome]. No [common objection]. Just [simple solution]."

4. **Contrarian Hook** - Challenge a common belief:
   "Everyone says you need [popular solution]. After [experience], I'm convinced that's wrong."

5. **Question Hook** - Ask something that makes them say "yes, that's me":
   "Ever spent [time] on [task], only to realize [bad outcome]?"

**CRITICAL:** First 2 sentences must hook. No throat-clearing. No definitions. Jump into the pain or outcome.
`;

export const COPYWRITING_FRAMEWORKS = `
## Content Structure Framework

Use **PAS** (Problem → Agitation → Solution) structure throughout:

1. **Problem:** State the pain clearly in reader's language
2. **Agitation:** Make them feel the cost of NOT solving it
3. **Solution:** Present your approach as the logical answer

For each major section:
- Start with WHY this matters (not what it is)
- Use specific numbers and examples (not "improve performance" → "reduce load time from 4.2s to 0.8s")
- End sections with a transition that builds momentum
`;

export const PERSUASION_TRIGGERS = `
## Persuasion Triggers (Integrate Naturally)

1. **Social Proof:** Mention specific companies, user counts, results
   - "This approach helped [Company] reduce [metric] by [percentage]"
   
2. **Authority Signals:** Reference experience naturally
   - "After building [X] systems over [Y] years..."
   - "Having worked with [type of clients]..."

3. **Specificity:** Vague fails. Specific converts.
   - BAD: "Improve performance significantly"
   - GOOD: "Reduce API latency from 800ms to 120ms"

4. **Transformation over Features:**
   - BAD: "AI-powered code analysis"
   - GOOD: "Ship confident code without 2-hour PR review cycles"

5. **Risk Reversal:** Address objections proactively
   - "You might be thinking [objection]. Here's why that's not the case..."
`;

export const CTA_GUIDELINES = `
## CTA Strategy

**Formula:** Verb + Value + (Optional Urgency)
- BAD: "Contact us" / "Learn more"
- GOOD: "Get Your Free Architecture Review" / "See How We Cut Costs 60%"

**Placement:**
1. **Soft CTA after intro** (for high-intent readers): Related resource or quick win
2. **Contextual mid-article CTAs:** Naturally mention services where relevant
3. **Primary CTA before conclusion:** After delivering value

**B2B CTAs that work:**
- "Book a Free [Specific] Review"
- "Get the [Resource] Checklist"
- "See This in Action (Case Study)"
- "Schedule a Technical Discovery Call"

**Tone:** CTA should feel like the natural next step, not a sales pitch.
`;

export const CONTENT_STRUCTURE = `
## Scannable Structure Requirements

1. **Headers every 200-300 words** - Readers skim first
2. **Bold key phrases** - Main takeaways pop out
3. **Bullet lists for steps/features** - Easy to process
4. **Specific examples after concepts** - Theory + Practice
5. **Transition sentences** - Guide readers between sections

**"So What?" Test:** Every paragraph must answer: "Why should the reader care?"

**Transformation Language:**
- Don't describe features, describe outcomes
- Don't say "you can", say "you will"
- Don't be vague, be specific with numbers/examples
`;

export const B2B_SPECIFIC = `
## B2B Writing Guidelines

1. **Multi-Stakeholder Value:**
   - Technical depth for engineers
   - Business outcomes for executives
   - Implementation ease for managers

2. **Risk Reduction:**
   - Include "what to expect" clarity
   - Mention similar companies/use cases
   - Address common concerns proactively

3. **Shareable Stats:**
   - Include quotable numbers
   - Make ROI clear
   - Executive-friendly summary points
`;

/**
 * Get full conversion guidelines for blog generation
 */
export function getConversionGuidelines(): string {
  return `
# HIGH-CONVERTING CONTENT GUIDELINES

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
# HEADLINE & TOPIC GUIDELINES

${HEADLINE_FORMULAS}

## Topic Selection Criteria
- High commercial intent (buyer keywords)
- Clear pain point or outcome
- Specific enough to be actionable
- Allows for contrarian or unique angle

## Outline Requirements
- Opening section MUST be a hook (not a definition)
- Each section should build toward transformation
- Include a "Common Mistakes" or "What Most People Get Wrong" section
- End with actionable next steps, not just summary
`.trim();
}

/**
 * Get humanization guidelines for the polish pass
 */
export function getHumanizationGuidelines(): string {
  return `
# HUMANIZATION & CONVERSION POLISH

## FORBIDDEN AI VOCABULARY (ABSOLUTE BLOCKLIST - never use these)
❌ "delve" / "delve into" → use: look at, explore, dig into
❌ "leverage" → use: use, apply, take advantage of
❌ "utilize" → use: use
❌ "facilitate" → use: help, enable, make possible
❌ "robust" → describe specifically what makes it strong
❌ "seamless" → describe the actual experience
❌ "cutting-edge" → be specific about what's new
❌ "comprehensive" → use: complete, full, thorough
❌ "streamline" → use: speed up, simplify
❌ "synergy" / "paradigm shift" / "game-changer"
❌ "arguably" → just state your argument directly, or don't make it
❌ "paramount" → use: critical, essential, crucial
❌ "pivotal" → use: key, important, turning point
❌ "foster" → use: build, encourage, grow
❌ "bolster" → use: strengthen, boost, support
❌ "boasts" → use: has, offers, includes
❌ "myriad" → use: many, lots of, countless
❌ "plethora" → use: many, lots of, plenty
❌ "landscape" (as metaphor) → be specific about the market/industry
❌ "navigate" (as metaphor) → use: handle, deal with, work through
❌ "realm" → use: area, field, space
❌ "underscore" → use: highlight, show, emphasize
❌ "spearhead" → use: lead, start, drive
❌ "endeavor" → use: try, work, effort
❌ "multifaceted" → use: complex, varied, or list the specific facets

## FORBIDDEN OPENINGS (rewrite immediately if found)
❌ "In today's [fast-paced/digital/ever-evolving] world..."
❌ "In this article, we will explore..."
❌ "It's no secret that..."
❌ "As businesses continue to..."
❌ "Let's dive into..."
❌ "When it comes to..."

## FORBIDDEN TRANSITIONS
❌ "Furthermore..." / "Moreover..." / "Additionally..."
❌ "It's worth noting that..." / "It's important to remember..."
❌ "Having said that..." / "That being said..."

## FORBIDDEN CLOSINGS
❌ "In conclusion..." / "To sum up..." / "As we've seen..."
❌ "Moving forward..." / "At the end of the day..."

## HEDGE WORDS TO ELIMINATE (these scream "AI wrote this")
❌ "can potentially" → just say "can" or commit to "will"
❌ "might be able to" → "can" or "will"
❌ "could possibly" → pick one: "could" or "possibly", not both
❌ "it's worth noting" → just note it directly
❌ "it bears mentioning" → just mention it
❌ "essentially" → remove it entirely or be specific
❌ "basically" → remove it or explain properly
❌ "arguably" → make your argument or don't
❌ "relatively" → give the actual comparison
❌ "fairly" / "quite" / "rather" → commit to a stronger word
❌ "somewhat" → be specific about the degree
❌ "in many ways" → list the actual ways or cut it

## VOICE TRANSFORMATION RULES
1. **Replace hedge words with commitment:**
   - "might potentially help" → "helps"
   - "could be considered" → "is"
   - "it's possible that" → state it directly

2. **Replace passive with active:**
   - "was implemented by the team" → "the team implemented"
   - "can be achieved through" → "achieve this through"

3. **Replace vague with specific:**
   - "significantly improved" → "improved by 67%"
   - "many companies" → "3 Series A startups I've worked with"
   - "various options" → "three options: X, Y, Z"

4. **Add contractions (mandatory):**
   - "do not" → "don't"
   - "cannot" → "can't"
   - "will not" → "won't"
   - Exception: emphasis ("I do NOT recommend...")

## SENTENCE RHYTHM REQUIREMENTS
- Vary length: some 5-word punches, some 20-word flows
- Use fragments occasionally. Like this.
- Start some sentences with "And" or "But"
- Include at least one 1-sentence paragraph per section for impact

## PERSONALITY INJECTION
Add these naturally throughout:
- Personal judgment: "In my experience...", "What I've found is..."
- Mild frustration: "This drives me crazy...", "I've seen this mistake too many times..."
- Enthusiasm: "This is where it gets good...", "Here's the elegant part..."
- Honest uncertainty: "I might be wrong, but...", "The data isn't clear on..."

## AUTHORITY SIGNALS TO WEAVE IN
- Specific years/project counts: "After 8 years building..."
- Named companies or types: "At a Series B fintech..."
- Concrete results: "...which cut our deploy time from 4 hours to 12 minutes"
- Lessons from failure: "I learned this the hard way when..."

## TRANSITION PHRASES THAT FEEL HUMAN
✅ "Here's where it gets interesting..."
✅ "But here's what most people miss..."
✅ "This is where it clicks..."
✅ "Now, you might be thinking..."
✅ "The counterintuitive part..."
✅ "What surprised me was..."

## THE READ-ALOUD TEST
If any sentence:
- Makes you stumble when reading aloud → rewrite it
- Sounds like a robot wrote it → add personality
- You wouldn't say to a colleague → simplify it

## HEADLINE-CONTENT ALIGNMENT (CRITICAL)
**If your headline promises a number, DELIVER that exact number:**
- "7 Mistakes" → you MUST have 7 clearly numbered/labeled mistakes
- "5 Ways" → you MUST have 5 distinct, numbered ways
- "10 Tips" → you MUST have 10 clearly identified tips

**Format for numbered headlines:**
- Each item gets its own H2 or H3
- Number them explicitly: "1. First Mistake", "2. Second Mistake"
- Don't bury items in prose—make them scannable

**For "How to" headlines:**
- Include clear, numbered steps
- Each step should be actionable (start with a verb)

**For "Guide" headlines:**
- Cover the topic comprehensively
- Include a logical progression from basics to advanced
`.trim();
}
