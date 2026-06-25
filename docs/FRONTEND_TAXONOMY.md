# Frontend Integration Guide — Posts, Categories, Tags, Redirects

This document is the contract for the Next.js frontend(s) that render the blog. The content
backend writes everything to **MySQL/TiDB**; the frontend reads it (directly via server
components, or behind your own API). One Next.js app serves one domain → always scope
queries by that site's `website_id`.

URL structure (must match the backend's URL patterns):

| Page | Path |
|---|---|
| Post | `/blog/{slug}` |
| Category hub | `/blog/category/{slug}` |
| Tag hub | `/blog/tag/{slug}` |
| Sitemap | `/sitemap.xml` |

---

## 1. Data model

### `websites`
One row per site. Get the current site's `id` once (by `domain`) and reuse it.

| Column | Type | Notes |
|---|---|---|
| `id` | varchar(36) | PK — the `website_id` used everywhere below |
| `domain` | varchar(255) | e.g. `primestrides.com` |
| `brand_name`, `tagline` | varchar | for headers/footers |

### `posts`
| Column | Type | Notes |
|---|---|---|
| `id` | char(36) | PK |
| `website_id` | varchar(36) | scope all queries by this |
| `slug` | varchar(255) | **canonical URL path — immutable, the source of truth.** Do NOT use `content_json.slug`. |
| `title` | varchar(512) | H1 |
| `meta_title` | varchar(512) | `<title>` |
| `meta_description` | text | `<meta name="description">` |
| `primary_keyword` | varchar(255) | internal/SEO; not usually rendered |
| `content_json` | json | the article body — see §3 |
| `status` | enum | `published` = render · `merged` = redirect · `draft`/`rewrite`/`to_be_deleted` = treat as 404 |
| `redirect_to_slug` | varchar(255) | when `status='merged'`, 301 to `/blog/{redirect_to_slug}` |
| `created_at`, `updated_at` | timestamp | `updated_at` = sitemap `lastmod` |

> Only ever render posts with `status = 'published'`.

### `categories`  (controlled set — pillar/hub pages)
| Column | Type | Notes |
|---|---|---|
| `id` | char(36) | PK |
| `website_id` | varchar(36) | |
| `name` | varchar(100) | display name, e.g. "Legacy Modernization" |
| `slug` | varchar(150) | URL: `/blog/category/{slug}` |
| `description` | varchar(500) | short tagline (always present) |
| `seo_content` | mediumtext \| null | **long unique intro copy. May be NULL** (generated gradually). Render `description` as fallback. |
| `meta_title` | varchar(255) \| null | falls back to `name` |
| `meta_description` | varchar(500) \| null | falls back to `description` |
| `post_count` | int | published posts in this category |

> Render/sitemap a category page only if `post_count > 0`. Empty categories → `noindex` or 404.

### `tags`  (open set — gated)
Same as `categories` **except there is NO `description` column** — a tag's only intro copy is
`seo_content` (which may be null). Columns: `id`, `website_id`, `name`, `slug`, `seo_content`,
`meta_title`, `meta_description`, `post_count`, `is_indexable`, timestamps.

| Column | Type | Notes |
|---|---|---|
| `is_indexable` | tinyint(1) | **`1` = real page (indexable, in sitemap). `0` = noindex.** A tag becomes indexable only once it has enough posts. |

> Render a tag page only if `is_indexable = 1`. For `is_indexable = 0`, return 404 or `<meta robots="noindex">`.
> If `seo_content` is null, render just the tag `name` + the post list (no fallback description exists for tags).

**Descriptive content status (current):** every **category** has a short `description` (always
present); category/tag `seo_content` (the long unique intro) is LLM-generated and is being
backfilled — treat it as possibly-null and fall back as above.

### `post_categories`  (many-to-many)
| Column | Type | Notes |
|---|---|---|
| `post_id` | char(36) | |
| `category_id` | char(36) | |
| `is_primary` | tinyint(1) | `1` = the post's primary category (use for breadcrumb / canonical category) |

### `post_tags`  (many-to-many)
| Column | Type |
|---|---|
| `post_id` | char(36) |
| `tag_id` | char(36) |

---

## 2. JSON schemas (entity shapes the frontend consumes)

TypeScript interfaces (use directly), followed by JSON Schema for `content_json`.

```ts
// A post in a list (category page, tag page, blog index, related links)
interface PostListItem {
  slug: string;            // → /blog/{slug}
  title: string;
  metaDescription: string; // good for card excerpts
  updatedAt: string;       // ISO
}

// Full post for the detail page
interface PostDetail {
  slug: string;
  title: string;
  metaTitle: string;
  metaDescription: string;
  content: BlogPostContent;        // parsed content_json (§3)
  primaryCategory: TaxonomyRef | null;   // is_primary = 1
  categories: TaxonomyRef[];             // all categories
  tags: TaxonomyRef[];                   // indexable + non-indexable; render links only for indexable if you prefer
}

interface TaxonomyRef {
  name: string;
  slug: string;            // category → /blog/category/{slug}; tag → /blog/tag/{slug}
}

// Category or tag hub page
interface TaxonomyPage {
  name: string;
  slug: string;
  description: string | null;
  seoContent: string | null;   // long intro; may be null → render `description`
  metaTitle: string | null;    // fallback to `name`
  metaDescription: string | null; // fallback to `description`
  postCount: number;
  isIndexable: boolean;        // tags only; categories are indexable when postCount > 0
  posts: PostListItem[];       // the posts filed here
}

// Redirect resolution result for /blog/[slug]
type PageResolution =
  | { kind: 'post'; post: PostDetail }
  | { kind: 'redirect'; toSlug: string }   // 301 → /blog/{toSlug}
  | { kind: 'notFound' };
```

### JSON Schema — `content_json` (`BlogPostContent`)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "BlogPostContent",
  "type": "object",
  "required": ["hero", "sections", "faq", "conclusion", "internalLinks"],
  "properties": {
    "title": { "type": "string" },
    "slug":  { "type": "string", "description": "Ignore — use posts.slug column instead" },
    "meta": {
      "type": "object",
      "properties": {
        "title": { "type": "string" },
        "description": { "type": "string" },
        "keywords": { "type": "array", "items": { "type": "string" } }
      }
    },
    "hero": {
      "type": "object",
      "required": ["hook"],
      "properties": {
        "hook": { "type": "string", "description": "Opening line / lede" },
        "subtitle": { "type": "string" }
      }
    },
    "sections": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "heading", "level", "content"],
        "properties": {
          "id": { "type": "string", "description": "Stable anchor id for the heading" },
          "heading": { "type": "string" },
          "level": { "type": "integer", "enum": [2, 3], "description": "h2 or h3" },
          "content": { "type": "string", "description": "Plain prose. No markdown/HTML." },
          "keyTakeaway": { "type": ["string", "null"], "description": "Optional callout/highlight" },
          "cta": {
            "description": "Optional inline CTA. Usually a string; occasionally an object.",
            "anyOf": [
              { "type": "null" },
              { "type": "string" },
              { "type": "object" }
            ]
          }
        }
      }
    },
    "faq": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["question", "answer"],
        "properties": {
          "question": { "type": "string" },
          "answer": { "type": "string" }
        }
      }
    },
    "conclusion": {
      "type": "object",
      "properties": {
        "summary": { "type": "string" },
        "cta": {
          "type": "object",
          "properties": {
            "text": { "type": "string" },
            "buttonText": { "type": "string" },
            "action": { "type": "string", "description": "e.g. 'contact' — map to your CTA route" }
          }
        }
      }
    },
    "internalLinks": {
      "type": "array",
      "items": { "type": "string", "format": "uri" },
      "description": "Absolute URLs: the post's primary category hub + related posts. RENDER THESE as <a> links."
    },
    "estimatedReadingMinutes": { "type": "integer" }
  }
}
```

> **Rendering note:** `hero.hook`, `sections[].content`, `faq[].answer`, and `conclusion.summary`
> are **plain text** (the backend strips markdown/HTML). Render paragraphs by splitting on
> newlines; don't run a markdown parser.

---

## 3. Page contracts (query + render)

Assume `WID` = this site's `website_id`. All queries scope by it.

### A. Post page — `/blog/[slug]`

```sql
-- 1) Resolve the post (status drives the branch)
SELECT id, slug, title, meta_title, meta_description, content_json, status, redirect_to_slug, updated_at
FROM posts
WHERE website_id = :WID AND slug = :slug;
```

Branch:
1. **No row** → 404.
2. **`status = 'merged'`** → **301/permanent redirect** to `/blog/{redirect_to_slug}`. (Backend guarantees `redirect_to_slug` points directly to a published post — single hop. Defensive: if the target is missing/not published, fall back to `/blog`.)
3. **`status = 'published'`** → render.
4. **anything else** → 404.

Taxonomy for the post (for breadcrumb + tag/category links):
```sql
-- categories (primary first)
SELECT c.name, c.slug, pc.is_primary
FROM post_categories pc JOIN categories c ON c.id = pc.category_id
WHERE pc.post_id = :postId ORDER BY pc.is_primary DESC;

-- tags
SELECT t.name, t.slug, t.is_indexable
FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
WHERE pt.post_id = :postId;
```

Render:
- `<h1>` = `title`; `<title>`/meta from `meta_title`/`meta_description`.
- Self-referencing canonical: `https://{domain}/blog/{slug}`.
- Body from `content_json` (§2).
- **Breadcrumb** using the primary category: `Home › {primaryCategory.name} › {title}`.
- **Category/tag chips** linking to their hubs (link only `is_indexable=1` tags if you want to avoid linking noindex pages — optional).
- **`content_json.internalLinks`** rendered as a "Related" block of real `<a>` links (un-orphans the post for Googlebot).

### B. Category page — `/blog/category/[slug]`

```sql
SELECT id, name, slug, description, seo_content, meta_title, meta_description, post_count
FROM categories WHERE website_id = :WID AND slug = :slug;
```
- If no row **or `post_count = 0`** → 404 (or render but `noindex`).
- Posts in the category:
```sql
SELECT p.slug, p.title, p.meta_description, p.updated_at
FROM post_categories pc JOIN posts p ON p.id = pc.post_id
WHERE pc.category_id = :categoryId AND p.status = 'published'
ORDER BY p.updated_at DESC
LIMIT 24 OFFSET :offset;     -- paginate if many
```
Render: H1 = `name`; intro = `seo_content` **or** `description` if null; meta = `meta_title`/`meta_description` with fallback to `name`/`description`; then the post list. Self-canonical. Paginate (`rel=prev/next` or `?page=`).

### C. Tag page — `/blog/tag/[slug]`
Same as category, but **gate on `is_indexable`**:
```sql
SELECT id, name, slug, seo_content, meta_title, meta_description, post_count, is_indexable
FROM tags WHERE website_id = :WID AND slug = :slug;
```
- No row → 404.
- `is_indexable = 0` → 404 **or** render with `<meta name="robots" content="noindex">` and **exclude from sitemap**.
- `is_indexable = 1` → render like a category page (posts via `post_tags`).

### D. Blog index — `/blog`
```sql
SELECT slug, title, meta_description, updated_at
FROM posts WHERE website_id = :WID AND status = 'published'
ORDER BY updated_at DESC LIMIT 24 OFFSET :offset;
```
Optionally list the categories (with `post_count > 0`) as a directory.

### E. Sitemap — `/sitemap.xml`  (generate dynamically)
Include, for the current site:
```sql
-- published posts
SELECT slug, updated_at FROM posts
WHERE website_id = :WID AND status = 'published';

-- category hubs with posts
SELECT slug, updated_at FROM categories
WHERE website_id = :WID AND post_count > 0;

-- indexable tag hubs
SELECT slug, updated_at FROM tags
WHERE website_id = :WID AND is_indexable = 1;
```
Build `<loc>` from the URL patterns above, `<lastmod>` from `updated_at`. **Never include** `merged` posts, empty categories, or non-indexable tags (the `status`/`post_count`/`is_indexable` filters handle this automatically).

Then: reference it in `robots.txt` (`Sitemap: https://{domain}/sitemap.xml`) and **submit it once in Google Search Console**.

### F. `robots.txt`
```
User-agent: *
Allow: /
Sitemap: https://{domain}/sitemap.xml
```
Also place the IndexNow key file at `/public/{INDEXNOW_KEY}.txt` (contents = the key).

---

## 4. Rules cheat-sheet

| Rule | Why |
|---|---|
| Render only `status='published'` posts | drafts/rewrites must never be public; `merged` redirect |
| `merged` → **301/permanent** to `/blog/{redirect_to_slug}` | consolidates duplicates onto the survivor |
| URL = `posts.slug` (never `content_json.slug`) | slug is immutable; inner slug can drift |
| Category page only if `post_count > 0` | avoid thin/empty hub pages |
| Tag page only if `is_indexable = 1` | avoid thin tag-archive penalty |
| `seo_content` may be null → fall back to `description` | intro copy is generated gradually |
| Self-referencing canonical on every page; one consistent host | you fixed www/non-www — keep canonical on that host |
| Render `content_json.internalLinks` + category/tag links as real `<a>` | this is what gets orphaned posts crawled/indexed |
| Sitemap excludes merged/empty/non-indexable automatically | via the status/count filters |

---

## 5. Implementation order (highest SEO impact first)
1. **Sitemap** (`/sitemap.xml`) + `robots.txt` + submit in GSC — fixes the "never discovered" posts.
2. **Render internal links** (`internalLinks` + category/tag chips) as real `<a>` tags.
3. **Merged-post 301 redirect** on `/blog/[slug]`.
4. **Category / tag hub pages** (`/blog/category/[slug]`, `/blog/tag/[slug]`).
5. Self-canonical + `noindex` on empty categories / non-indexable tags.
```
