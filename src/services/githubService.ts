import { env } from '../config/env.js';
import { withRetry } from '../utils/retry.js';

export interface GitHubRepo {
  name: string;
  fullName: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  topics: string[];
  url: string;
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
  readme: string | null;
}

interface GitHubApiRepo {
  name: string;
  full_name: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  topics?: string[];
  html_url: string;
  private: boolean;
  created_at: string;
  updated_at: string;
  fork: boolean;
}

export class GitHubService {
  private readonly token: string;
  private readonly baseUrl = 'https://api.github.com';

  constructor(token?: string) {
    const pat = token ?? env.GITHUB_PAT;
    if (!pat) {
      throw new Error('GitHubService: GITHUB_PAT is required');
    }
    this.token = pat;
  }

  private async request<T>(endpoint: string): Promise<T> {
    return await withRetry(
      async () => {
        const res = await fetch(`${this.baseUrl}${endpoint}`, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          }
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`GitHub API ${res.status}: ${text}`);
        }

        return (await res.json()) as T;
      },
      { retries: 3, baseDelayMs: 1000, maxDelayMs: 10000 }
    );
  }

  private async requestRaw(endpoint: string): Promise<string | null> {
    try {
      const res = await fetch(`${this.baseUrl}${endpoint}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github.raw+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      });

      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }

  /**
   * Fetch all repositories for the authenticated user.
   * Includes both public and private repos.
   */
  async fetchUserRepos(opts?: { includePrivate?: boolean; includeForks?: boolean }): Promise<GitHubApiRepo[]> {
    const includePrivate = opts?.includePrivate ?? true;
    const includeForks = opts?.includeForks ?? false;

    const allRepos: GitHubApiRepo[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const repos = await this.request<GitHubApiRepo[]>(
        `/user/repos?per_page=${perPage}&page=${page}&sort=updated&direction=desc&affiliation=owner`
      );

      if (repos.length === 0) break;

      for (const repo of repos) {
        if (!includePrivate && repo.private) continue;
        if (!includeForks && repo.fork) continue;
        allRepos.push(repo);
      }

      if (repos.length < perPage) break;
      page++;
    }

    return allRepos;
  }

  /**
   * Fetch README content for a repository.
   */
  async fetchReadme(owner: string, repo: string): Promise<string | null> {
    return await this.requestRaw(`/repos/${owner}/${repo}/readme`);
  }

  /**
   * Fetch all repos with their READMEs.
   */
  async fetchReposWithReadmes(opts?: {
    includePrivate?: boolean;
    includeForks?: boolean;
    maxRepos?: number;
  }): Promise<GitHubRepo[]> {
    const maxRepos = opts?.maxRepos ?? 50;
    const apiRepos = await this.fetchUserRepos(opts);
    const limited = apiRepos.slice(0, maxRepos);

    const results: GitHubRepo[] = [];

    for (const repo of limited) {
      const [owner] = repo.full_name.split('/');
      const readme = await this.fetchReadme(owner!, repo.name);

      results.push({
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description,
        language: repo.language,
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        topics: repo.topics ?? [],
        url: repo.html_url,
        isPrivate: repo.private,
        createdAt: repo.created_at,
        updatedAt: repo.updated_at,
        readme: readme ? truncateReadme(readme) : null
      });
    }

    return results;
  }
}

/**
 * Truncate README to avoid excessive content.
 * Keep first ~2000 chars which usually contains the important overview.
 */
function truncateReadme(content: string, maxChars = 2000): string {
  if (content.length <= maxChars) return content;
  const truncated = content.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf('\n');
  return (lastNewline > maxChars * 0.7 ? truncated.slice(0, lastNewline) : truncated) + '\n\n[... truncated ...]';
}
