import { mysqlPool } from '../src/db/mysqlPool.js';
import { PromptLearner } from '../src/services/promptLearner.js';
import { blogGenerationPrompt } from '../src/prompts/blogGeneration.js';
import { loadAuthorKnowledge } from '../src/knowledge/authorKnowledge.js';

async function main() {
  console.log('🔍 Testing Learned Rules Injection into BlogGenerator\n');
  console.log('='.repeat(70));

  const learner = new PromptLearner(mysqlPool);
  const learnedRules = await learner.generatePromptRules();
  
  console.log('\n📚 Learned rules that will be injected:');
  console.log(learnedRules);
  
  console.log('\n' + '='.repeat(70));
  console.log('📝 Sample prompt generation with learned rules:\n');

  // Load knowledge
  const knowledge = await loadAuthorKnowledge();
  
  // Generate a sample prompt
  const prompt = blogGenerationPrompt({
    knowledge,
    keyword: 'hire remote developers',
    topic: 'How to successfully hire and manage remote developers',
    outline: { sections: ['Intro', 'Benefits', 'Challenges', 'Best Practices', 'Conclusion'] },
    learnedRules
  });

  // Show first 2000 chars of the system prompt to see learned rules injection
  console.log('System prompt (first 2500 chars):');
  console.log('-'.repeat(70));
  console.log(prompt.system.slice(0, 2500));
  console.log('...[truncated]');

  await mysqlPool.end();
}

main().catch(console.error);
