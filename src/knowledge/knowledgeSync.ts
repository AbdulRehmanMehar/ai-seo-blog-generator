import fs from 'node:fs/promises';
import path from 'node:path';
import { GitHubService, type GitHubRepo } from '../services/githubService.js';
import { env } from '../config/env.js';

const KNOWLEDGE_FILE = './data/author_knowledge.md';
const GITHUB_SECTION_MARKER = '<!-- GITHUB_REPOS_START -->';
const GITHUB_SECTION_END_MARKER = '<!-- GITHUB_REPOS_END -->';

function log(message: string) {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${ts}] ${message}`);
}

/**
 * Sync GitHub repositories to the knowledge base.
 * This fetches repos, their descriptions, READMEs, and updates the author_knowledge.md file.
 */
export async function syncGitHubKnowledge(): Promise<{ reposProcessed: number; updated: boolean }> {
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('🔄 GITHUB KNOWLEDGE SYNC STARTED');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!env.GITHUB_PAT) {
    log('⚠️  GITHUB_PAT not configured, skipping sync');
    return { reposProcessed: 0, updated: false };
  }

  const github = new GitHubService();

  const maxRepos = env.GITHUB_MAX_REPOS || 999;
  log(`📥 Fetching GitHub repositories (max: ${maxRepos})...`);
  const repos = await github.fetchReposWithReadmes({
    includePrivate: true,
    includeForks: false,
    maxRepos
  });
  log(`   ✓ Fetched ${repos.length} repositories`);

  if (repos.length === 0) {
    log('   ⚠️  No repositories found');
    return { reposProcessed: 0, updated: false };
  }

  log('📝 Generating knowledge section...');
  const githubSection = generateGitHubKnowledgeSection(repos);
  log(`   ✓ Generated ${githubSection.length} chars of knowledge`);

  log('💾 Updating knowledge file...');
  const updated = await updateKnowledgeFile(githubSection);
  if (updated) {
    log('   ✓ Knowledge file updated');
  } else {
    log('   ℹ️  No changes needed (content unchanged)');
  }

  log('');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('✅ GITHUB KNOWLEDGE SYNC FINISHED');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`   Repositories processed: ${repos.length}`);
  log(`   Knowledge file updated: ${updated ? 'yes' : 'no'}`);
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  return { reposProcessed: repos.length, updated };
}

function generateGitHubKnowledgeSection(repos: GitHubRepo[]): string {
  const lines: string[] = [
    GITHUB_SECTION_MARKER,
    '',
    '## GitHub Projects (Auto-synced)',
    '',
    `> Last synced: ${new Date().toISOString()}`,
    '',
    'The following projects showcase my technical expertise and recent work:',
    ''
  ];

  // Group by language
  const byLanguage = new Map<string, GitHubRepo[]>();
  for (const repo of repos) {
    const lang = repo.language ?? 'Other';
    if (!byLanguage.has(lang)) byLanguage.set(lang, []);
    byLanguage.get(lang)!.push(repo);
  }

  // Sort languages by count
  const sortedLangs = [...byLanguage.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [language, langRepos] of sortedLangs) {
    lines.push(`### ${language}`);
    lines.push('');

    for (const repo of langRepos.slice(0, 5)) {
      lines.push(`#### ${repo.name}`);
      if (repo.description) {
        lines.push(`*${repo.description}*`);
      }
      lines.push('');

      const meta: string[] = [];
      if (repo.stars > 0) meta.push(`⭐ ${repo.stars}`);
      if (repo.forks > 0) meta.push(`🍴 ${repo.forks}`);
      if (repo.topics.length > 0) meta.push(`Tags: ${repo.topics.slice(0, 5).join(', ')}`);
      if (meta.length > 0) {
        lines.push(meta.join(' | '));
        lines.push('');
      }

      if (repo.readme) {
        // Extract key sections from README (first few meaningful paragraphs)
        const summary = extractReadmeSummary(repo.readme);
        if (summary) {
          lines.push('**Overview:**');
          lines.push(summary);
          lines.push('');
        }
      }
    }
  }

  // Add tech stack summary
  lines.push('### Technical Stack Summary');
  lines.push('');
  const allTopics = repos.flatMap((r) => r.topics);
  const topicCounts = new Map<string, number>();
  for (const topic of allTopics) {
    topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
  }
  const topTopics = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([t]) => t);

  if (topTopics.length > 0) {
    lines.push(`**Key technologies:** ${topTopics.join(', ')}`);
    lines.push('');
  }

  const langCounts = new Map<string, number>();
  for (const repo of repos) {
    if (repo.language) {
      langCounts.set(repo.language, (langCounts.get(repo.language) ?? 0) + 1);
    }
  }
  const topLangs = [...langCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([l, c]) => `${l} (${c})`);

  if (topLangs.length > 0) {
    lines.push(`**Languages:** ${topLangs.join(', ')}`);
    lines.push('');
  }

  lines.push(GITHUB_SECTION_END_MARKER);

  return lines.join('\n');
}

function extractReadmeSummary(readme: string, maxLength = 500): string | null {
  // Remove badges, images, and HTML
  let cleaned = readme
    .replace(/!\[.*?\]\(.*?\)/g, '') // images
    .replace(/\[!\[.*?\]\(.*?\)\]\(.*?\)/g, '') // badge links
    .replace(/<[^>]+>/g, '') // HTML tags
    .replace(/^#+ .+$/gm, '') // headers
    .replace(/```[\s\S]*?```/g, '') // code blocks
    .replace(/^\s*[-*]\s+/gm, '• ') // normalize lists
    .trim();

  // Find first meaningful paragraph(s)
  const paragraphs = cleaned
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 30 && !p.startsWith('•'));

  if (paragraphs.length === 0) return null;

  let summary = paragraphs[0]!;
  if (summary.length < maxLength && paragraphs[1]) {
    summary += '\n\n' + paragraphs[1];
  }

  if (summary.length > maxLength) {
    summary = summary.slice(0, maxLength);
    const lastPeriod = summary.lastIndexOf('.');
    if (lastPeriod > maxLength * 0.6) {
      summary = summary.slice(0, lastPeriod + 1);
    } else {
      summary += '...';
    }
  }

  return summary;
}

async function updateKnowledgeFile(githubSection: string): Promise<boolean> {
  const filePath = path.resolve(process.cwd(), KNOWLEDGE_FILE);

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    // File doesn't exist, create it
    content = '# Author Knowledge Base\n\n';
  }

  // Check if GitHub section exists
  const startIdx = content.indexOf(GITHUB_SECTION_MARKER);
  const endIdx = content.indexOf(GITHUB_SECTION_END_MARKER);

  let newContent: string;
  if (startIdx >= 0 && endIdx > startIdx) {
    // Replace existing section
    newContent = content.slice(0, startIdx) + githubSection + content.slice(endIdx + GITHUB_SECTION_END_MARKER.length);
  } else {
    // Append new section
    newContent = content.trimEnd() + '\n\n' + githubSection + '\n';
  }

  // Check if content actually changed
  if (newContent === content) {
    return false;
  }

  await fs.writeFile(filePath, newContent, 'utf8');
  return true;
}
