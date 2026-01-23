/**
 * PostHumanizer - A separate pass to clean AI patterns from generated content
 * 
 * This runs AFTER the main generation to:
 * 1. Replace forbidden AI vocabulary with natural alternatives
 * 2. Add contractions where missing
 * 3. Fix title format issues (remove colons)
 * 4. Clean up forbidden patterns
 * 
 * By doing this as a separate pass, we reduce cognitive load on the generation model.
 */

import type { BlogPostStructure } from '../prompts/blogGeneration.js';
import { AI_VOCABULARY_BLOCKLIST, FORBIDDEN_OPENINGS, FORBIDDEN_TRANSITIONS } from '../prompts/reviewer.js';

// Natural replacements for AI vocabulary
const VOCABULARY_REPLACEMENTS: Record<string, string[]> = {
  'leverage': ['use', 'apply', 'tap into', 'make use of'],
  'leveraging': ['using', 'applying', 'tapping into'],
  'leveraged': ['used', 'applied', 'tapped into'],
  'utilize': ['use', 'employ'],
  'utilizing': ['using', 'employing'],
  'utilized': ['used', 'employed'],
  'robust': ['solid', 'strong', 'reliable', 'sturdy'],
  'seamless': ['smooth', 'easy', 'effortless'],
  'seamlessly': ['smoothly', 'easily', 'effortlessly'],
  'cutting-edge': ['latest', 'modern', 'new', 'advanced'],
  'innovative': ['new', 'fresh', 'creative'],
  'comprehensive': ['complete', 'full', 'thorough'],
  'streamline': ['simplify', 'speed up', 'make easier'],
  'streamlining': ['simplifying', 'speeding up'],
  'optimize': ['improve', 'boost', 'enhance'],
  'optimizing': ['improving', 'boosting'],
  'optimized': ['improved', 'boosted', 'tuned'],
  'arguably': ['perhaps', 'some say', 'many think'],
  'paramount': ['critical', 'key', 'vital', 'essential'],
  'pivotal': ['key', 'crucial', 'important'],
  'foster': ['build', 'grow', 'encourage'],
  'fostering': ['building', 'growing', 'encouraging'],
  'bolster': ['strengthen', 'support', 'boost'],
  'bolstering': ['strengthening', 'supporting'],
  'boasts': ['has', 'offers', 'features'],
  'myriad': ['many', 'lots of', 'countless'],
  'plethora': ['many', 'lots of', 'plenty of'],
  'delve': ['dig into', 'explore', 'look at'],
  'delving': ['digging into', 'exploring', 'looking at'],
  'facilitate': ['help', 'enable', 'make possible'],
  'facilitating': ['helping', 'enabling'],
  'synergy': ['teamwork', 'collaboration', 'combined effort'],
  'paradigm shift': ['big change', 'major shift', 'transformation'],
  'game-changer': ['breakthrough', 'big deal', 'major improvement'],
  'revolutionary': ['groundbreaking', 'major', 'significant'],
  'tangible': ['real', 'concrete', 'actual', 'measurable'],
  'landscape': ['space', 'world', 'field', 'market'],
  'navigate': ['work through', 'handle', 'deal with'],
  'realm': ['area', 'field', 'space'],
  'underscore': ['highlight', 'show', 'emphasize'],
  'underscores': ['highlights', 'shows', 'emphasizes'],
  'spearhead': ['lead', 'drive', 'head up'],
  'spearheading': ['leading', 'driving', 'heading up'],
  'endeavor': ['effort', 'project', 'attempt'],
  'endeavors': ['efforts', 'projects', 'attempts'],
  'multifaceted': ['complex', 'varied', 'diverse'],
};

// Contractions to apply
const CONTRACTION_MAP: Record<string, string> = {
  'it is': "it's",
  'It is': "It's",
  'you are': "you're",
  'You are': "You're",
  'we are': "we're",
  'We are': "We're",
  'they are': "they're",
  'They are': "They're",
  'do not': "don't",
  'Do not': "Don't",
  'does not': "doesn't",
  'Does not': "Doesn't",
  'did not': "didn't",
  'Did not': "Didn't",
  'will not': "won't",
  'Will not': "Won't",
  'would not': "wouldn't",
  'Would not': "Wouldn't",
  'could not': "couldn't",
  'Could not': "Couldn't",
  'should not': "shouldn't",
  'Should not': "Shouldn't",
  'can not': "can't",
  'cannot': "can't",
  'Can not': "Can't",
  'Cannot': "Can't",
  'is not': "isn't",
  'Is not': "Isn't",
  'are not': "aren't",
  'Are not': "Aren't",
  'was not': "wasn't",
  'Was not': "Wasn't",
  'were not': "weren't",
  'Were not': "Weren't",
  'has not': "hasn't",
  'Has not': "Hasn't",
  'have not': "haven't",
  'Have not': "Haven't",
  'had not': "hadn't",
  'Had not': "Hadn't",
  'I have': "I've",
  'you have': "you've",
  'You have': "You've",
  'we have': "we've",
  'We have': "We've",
  'they have': "they've",
  'They have': "They've",
  'I will': "I'll",
  'you will': "you'll",
  'You will': "You'll",
  'we will': "we'll",
  'We will': "We'll",
  'they will': "they'll",
  'They will': "They'll",
  'I would': "I'd",
  'you would': "you'd",
  'You would': "You'd",
  'we would': "we'd",
  'We would': "We'd",
  'that is': "that's",
  'That is': "That's",
  'what is': "what's",
  'What is': "What's",
  'there is': "there's",
  'There is': "There's",
  'here is': "here's",
  'Here is': "Here's",
  'let us': "let's",
  'Let us': "Let's",
};

export class PostHumanizer {
  private replacementCount = 0;
  private contractionCount = 0;
  private titleFixed = false;

  /**
   * Humanize a blog post by cleaning AI patterns
   */
  humanize(post: BlogPostStructure): { post: BlogPostStructure; changes: string[] } {
    this.replacementCount = 0;
    this.contractionCount = 0;
    this.titleFixed = false;
    const changes: string[] = [];

    // Deep clone to avoid mutating original
    const humanized = JSON.parse(JSON.stringify(post)) as BlogPostStructure;

    // 1. Fix title (remove colons)
    humanized.title = this.fixTitle(humanized.title);
    if (this.titleFixed) changes.push('Removed colon from title');

    // 2. Fix meta title
    if (humanized.meta?.title) {
      const originalMeta = humanized.meta.title;
      humanized.meta.title = this.fixTitle(humanized.meta.title);
      if (humanized.meta.title !== originalMeta) changes.push('Removed colon from meta title');
    }

    // 3. Process hero hook
    if (humanized.hero?.hook) {
      humanized.hero.hook = this.processText(humanized.hero.hook);
    }

    // 4. Process all sections
    for (const section of humanized.sections || []) {
      if (section.heading) {
        section.heading = this.fixTitle(section.heading); // Remove colons from headings too
      }
      if (section.content) {
        section.content = this.processText(section.content);
      }
      if (section.keyTakeaway) {
        section.keyTakeaway = this.processText(section.keyTakeaway);
      }
    }

    // 5. Process FAQs
    for (const faq of humanized.faq || []) {
      if (faq.question) {
        faq.question = this.processText(faq.question);
      }
      if (faq.answer) {
        faq.answer = this.processText(faq.answer);
      }
    }

    // 6. Process conclusion
    if (humanized.conclusion?.summary) {
      humanized.conclusion.summary = this.processText(humanized.conclusion.summary);
    }

    if (this.replacementCount > 0) {
      changes.push(`Replaced ${this.replacementCount} AI vocabulary instances`);
    }
    if (this.contractionCount > 0) {
      changes.push(`Added ${this.contractionCount} contractions`);
    }

    return { post: humanized, changes };
  }

  /**
   * Fix title by removing colons and reformatting
   */
  private fixTitle(title: string): string {
    if (!title.includes(':')) return title;
    
    this.titleFixed = true;
    
    // Common patterns: "Topic: Subtitle" → "Topic - Subtitle" or just "Subtitle"
    const parts = title.split(':').map(p => p.trim());
    const firstPart = parts[0] ?? '';
    const secondPart = parts[1] ?? '';
    
    if (parts.length === 2 && firstPart && secondPart) {
      // If second part is more descriptive, use it
      if (secondPart.length > firstPart.length) {
        return secondPart;
      }
      // Otherwise combine with dash or use first part
      if (firstPart.length + secondPart.length < 60) {
        return `${firstPart} — ${secondPart}`;
      }
      return firstPart;
    }
    
    // Multiple colons - just remove them
    return title.replace(/:/g, ' —');
  }

  /**
   * Process text to replace AI vocabulary and add contractions
   */
  private processText(text: string): string {
    let result = text;

    // Replace AI vocabulary (case-insensitive)
    for (const [word, replacements] of Object.entries(VOCABULARY_REPLACEMENTS)) {
      const regex = new RegExp(`\\b${word}\\b`, 'gi');
      if (regex.test(result)) {
        const replacement = replacements[Math.floor(Math.random() * replacements.length)] ?? replacements[0] ?? word;
        const matches = result.match(regex);
        this.replacementCount += matches?.length ?? 0;
        result = result.replace(regex, (match: string): string => {
          // Preserve capitalization
          if (match[0] === match[0]?.toUpperCase()) {
            return replacement.charAt(0).toUpperCase() + replacement.slice(1);
          }
          return replacement;
        });
      }
    }

    // Add contractions
    for (const [full, contraction] of Object.entries(CONTRACTION_MAP)) {
      const regex = new RegExp(`\\b${full}\\b`, 'g');
      if (regex.test(result)) {
        const matches = result.match(regex);
        this.contractionCount += matches?.length ?? 0;
        result = result.replace(regex, contraction);
      }
    }

    // Fix "**Bold:** text" pattern → "**Bold.** text"
    result = result.replace(/\*\*([^*]+):\*\*/g, '**$1.**');

    // Remove forbidden transitions at start of sentences
    for (const transition of FORBIDDEN_TRANSITIONS) {
      const regex = new RegExp(`(^|\\. )${transition}[,.]?\\s*`, 'gi');
      result = result.replace(regex, '$1');
    }

    return result;
  }

  /**
   * Check if hook has forbidden opening pattern and suggest fix
   */
  checkOpeningHook(hook: string): { isForbidden: boolean; suggestion?: string } {
    for (const pattern of FORBIDDEN_OPENINGS) {
      if (pattern.test(hook)) {
        return {
          isForbidden: true,
          suggestion: 'Start with a bold claim, specific number, or direct statement instead'
        };
      }
    }
    return { isForbidden: false };
  }
}

export const postHumanizer = new PostHumanizer();
