import { mysqlPool } from '../src/db/mysqlPool.js';
import { PromptLearner } from '../src/services/promptLearner.js';

async function main() {
  console.log('📚 Prompt Learning System Status\n');
  console.log('='.repeat(70));

  const learner = new PromptLearner(mysqlPool);

  // Get stats
  const stats = await learner.getStats();
  console.log(`\n📊 Statistics:`);
  console.log(`   Total rules learned: ${stats.totalLearnings}`);
  console.log(`   Total violations tracked: ${stats.totalFailures}`);
  console.log(`\n   By category:`);
  for (const [cat, count] of Object.entries(stats.byCategory)) {
    console.log(`     - ${cat}: ${count} violations`);
  }

  // Get all learnings
  const learnings = await learner.getActiveLearnings();
  
  if (learnings.length > 0) {
    console.log(`\n\n📜 Learned Rules (${learnings.length} total):`);
    console.log('-'.repeat(70));
    
    for (const l of learnings) {
      console.log(`\n[${l.category}/${l.ruleType}] "${l.ruleValue}"`);
      console.log(`   Failed: ${l.failureCount}x | Last: ${l.lastFailureAt.toISOString()}`);
      console.log(`   Reason: ${l.reason.slice(0, 100)}...`);
    }
  }

  // Show what would be injected into prompts
  console.log(`\n\n${'='.repeat(70)}`);
  console.log('📝 Generated Prompt Rules (injected into content generation):');
  console.log('='.repeat(70));
  
  const promptRules = await learner.generatePromptRules();
  if (promptRules) {
    console.log(promptRules);
  } else {
    console.log('(no rules generated yet)');
  }

  await mysqlPool.end();
}

main().catch(console.error);
