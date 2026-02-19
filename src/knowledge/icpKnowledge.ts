import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * ICP (Ideal Client Profile) data structure.
 * Based on the Chris Do framework: biographics + psychographics + crap they deal with + hunger + trifecta.
 */
export interface IcpPersona {
  persona_name: string;
  biographics: {
    age: number;
    title: string;
    status: string;
    location: string;
    education: string;
    personal_income: string;
  };
  psychographics: {
    values: string;
    belief_system: string;
    fears: string;
    spending_logic: string;
  };
  the_crap_he_deals_with: string;
  the_hunger: string;
  trifecta_alignment: {
    joy: string;
    money: string;
    mission: string;
  };
  /**
   * The quantified cost of doing nothing.
   * From the "Sell Money, Not Services" framework:
   * "Why not do nothing?" — make the client feel the real dollar cost of inaction.
   */
  cost_of_inaction: string;
}

const ICP_PATH = './data/icps.json';

let _cachedIcps: IcpPersona[] | null = null;

export async function loadIcps(): Promise<IcpPersona[]> {
  if (_cachedIcps) return _cachedIcps;

  const filePath = path.resolve(process.cwd(), ICP_PATH);
  const raw = await fs.readFile(filePath, 'utf8');
  _cachedIcps = JSON.parse(raw) as IcpPersona[];
  return _cachedIcps;
}

/**
 * Get a single ICP by name (case-insensitive partial match).
 */
export async function getIcpByName(name: string): Promise<IcpPersona | undefined> {
  const icps = await loadIcps();
  return icps.find(icp =>
    icp.persona_name.toLowerCase().includes(name.toLowerCase())
  );
}

/**
 * Pick an ICP using a round-robin index based on a counter (e.g., topic sequence number).
 * Pass a counter from 0..N so content cycles through all ICPs over time.
 */
export async function getIcpByIndex(index: number): Promise<IcpPersona> {
  const icps = await loadIcps();
  return icps[index % icps.length]!;
}

/**
 * Pick a random ICP.
 */
export async function getRandomIcp(): Promise<IcpPersona> {
  const icps = await loadIcps();
  return icps[Math.floor(Math.random() * icps.length)]!;
}

/**
 * Format an ICP persona into a rich prompt block that teaches the LLM:
 * 1. WHO the reader is (biographics + psychographics)
 * 2. WHAT their stuck moment looks like (from ContentWriting framework)
 * 3. WHAT makes them say "That's me" (the "that's me" test)
 * 4. HOW to phrase the hook (empathy-based opening)
 * 5. WHAT drives their buying decision (hunger + spending logic)
 *
 * This is derived from two frameworks:
 * - ICP.md (Chris Do): Demographics → Psychographics → Crap They Deal With → Hunger → Trifecta
 * - ContentWriting.md: Stuck Moment → "That's Me" hook → Pain Agitation → Real Problem → Wish
 */
export function formatIcpForPrompt(icp: IcpPersona): string {
  return `
TARGET READER PROFILE: ${icp.persona_name}
============================================================

WHO THIS PERSON IS:
- Title: ${icp.biographics.title}
- Age: ${icp.biographics.age} | Income: ${icp.biographics.personal_income}
- Status: ${icp.biographics.status}
- Location: ${icp.biographics.location}
- Education: ${icp.biographics.education}

WHAT THEY BELIEVE AND VALUE:
- Core values: ${icp.psychographics.values}
- Belief system: ${icp.psychographics.belief_system}
- Deepest fear: ${icp.psychographics.fears}
- Why they spend big: ${icp.psychographics.spending_logic}

THE CRAP THEY DEAL WITH (their frustrations with the market):
${icp.the_crap_he_deals_with}

WHAT THEY ARE STARVING FOR (their transformation / hunger):
${icp.the_hunger}

THEIR TRIFECTA (what makes them the perfect client):
- Joy alignment: ${icp.trifecta_alignment.joy}
- Budget reality: ${icp.trifecta_alignment.money}
- Mission alignment: ${icp.trifecta_alignment.mission}

============================================================
HOW TO WRITE FOR THIS PERSON
============================================================

THE "THAT'S ME" TEST:
Every sentence you write must pass this test. Ask yourself: would ${icp.persona_name} read this
and think "that's me, that's exactly my situation"? If not, rewrite it.

THE STUCK MOMENT FRAMEWORK (from ContentWriting playbook):
Use these to build the hook and opening sections. Derive exact language from their profile above.

1. What they say out loud at 11pm:
   Think about their frustration with: "${icp.the_crap_he_deals_with}"
   Write a line they would literally say out loud to a colleague about this.

2. What they think privately (but won't admit):
   Their fear is: "${icp.psychographics.fears}"
   Write the quiet internal thought this fear produces.

3. What they believe the problem is (they're wrong):
   Based on their belief system: "${icp.psychographics.belief_system}"
   Write the surface-level diagnosis they have for their problem.

4. What the REAL problem is (your insight as the expert):
   The truth behind their hunger: "${icp.the_hunger}"
   Write the real diagnosis only an expert would give.

5. The emotion underneath:
   A ${icp.biographics.age}-year-old ${icp.biographics.title} dealing with this feels: frustration,
   fear of public failure, and urgency. Name the strongest emotion in your writing.

6. If they don't solve this, what happens:
   Their fear manifests as: "${icp.psychographics.fears}"
   Write the consequence they privately dread.

7. What they WISH someone told them:
   The transformation they want: "${icp.the_hunger}"
   Write the insight/truth that would make them feel relief and say "finally, someone gets it."

EMPATHY-BASED HOOK FORMULA:
Start with: "You know that moment when [describe their stuck scenario from their world]..."
OR: "It's [time they'd be working late] and [describe the exact stuck moment]..."
OR: "If you're a ${icp.biographics.title.split(' ').slice(0, 3).join(' ')} dealing with [their specific crap]..."

The hook MUST make ${icp.persona_name} say "that's me" in the first 2 sentences.

CTA LANGUAGE FOR THIS PERSON:
Do NOT write generic CTAs like "Contact us" or "Learn more."
Write CTAs that dollarize the value and reduce the risk.
Good CTA examples for this persona:
- Reference the cost of inaction: frame what they lose each month without fixing this
- Reference their transformation: getting them from their stuck state to "${icp.the_hunger}"
- Acknowledge their spending logic: "${icp.psychographics.spending_logic}"
- Address their fear as risk reduction: their fear is "${icp.psychographics.fears}"

  COST OF INACTION (the "Why not do nothing?" answer for this person):
${icp.cost_of_inaction}

DOLLARIZATION FORMULA:
Your work must be framed in this client's currency, not yours.
Run every benefit through: [Your Work] → [Specific Outcome] → [Dollar Value]
Their spending logic already confirms they think this way: "${icp.psychographics.spending_logic}"
In at least ONE section, frame a point as: "Every [time unit] you don't solve this costs [dollar amount]."
============================================================
`;
}
