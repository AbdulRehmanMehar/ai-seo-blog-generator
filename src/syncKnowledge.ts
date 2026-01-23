import { syncGitHubKnowledge } from './knowledge/knowledgeSync.js';

// Run GitHub knowledge sync once
syncGitHubKnowledge()
  .then((result) => {
    process.exit(result.updated ? 0 : 0);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('GitHub sync failed:', err);
    process.exit(1);
  });
