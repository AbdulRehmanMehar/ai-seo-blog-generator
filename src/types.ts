export type KeywordStatus = 'new' | 'used' | 'rejected';
export type PostStatus = 'draft' | 'published';

export interface KeywordRow {
  id: string;
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  intent: string | null;
  status: KeywordStatus;
  created_at: string;
}

export interface TopicRow {
  id: string;
  keyword_id: string;
  topic: string;
  outline: unknown;
  created_at: string;
}

export interface PostRow {
  id: string;
  topic_id: string;
  title: string;
  slug: string;
  primary_keyword: string;
  meta_title: string;
  meta_description: string;
  content_markdown: string;
  status: PostStatus;
  published_at: string | null;
  created_at: string;
}
