# AI-Powered SEO Blog Generator

A fully automated, self-improving content generation pipeline that creates high-quality, SEO-optimized blog posts. The system learns from its own review failures to continuously improve output quality, producing human-like content that passes AI detection tests.

## 🎯 What This Project Does

This is an **autonomous content pipeline** that:

1. **Discovers keywords** via SERP providers (Serpstack, Zenserp) and enriches them with Gemini
2. **Plans topics** with detailed outlines based on author knowledge and keyword data
3. **Detects duplicates** using vector embeddings (pgvector) to prevent similar content
4. **Generates blog posts** in structured JSON format with SEO metadata, FAQs, and CTAs
5. **Humanizes content** through a multi-pass system to remove AI patterns
6. **Reviews quality** with automated checks + LLM review (scores 0-100)
7. **Learns from failures** by extracting rules from review issues to improve future generations
8. **Supports multiple websites** with different voice/tone configurations

Posts that pass review (score ≥ 75) are automatically published. Failed posts are queued for rewrite with specific instructions.

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              ORCHESTRATOR                                    │
│                         (src/scheduler/orchestrator.ts)                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 1: KEYWORD DISCOVERY                                                   │
│  ┌─────────────────┐    ┌──────────────────┐    ┌─────────────────────┐     │
│  │  SERP Providers │───▶│ Gemini Enrichment│───▶│ Keyword Filtering   │     │
│  │ (Serpstack,     │    │ (volume, CPC,    │    │ (volume > 100,      │     │
│  │  Zenserp, etc.) │    │  difficulty,     │    │  difficulty < 40,   │     │
│  └─────────────────┘    │  intent)         │    │  CPC > $2)          │     │
│                         └──────────────────┘    └─────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 2: TOPIC PLANNING                                                      │
│  ┌─────────────────┐    ┌──────────────────┐    ┌─────────────────────┐     │
│  │ Candidate       │───▶│ Gemini Selection │───▶│ Outline Generation  │     │
│  │ Keywords (30)   │    │ (top 2 by value) │    │ (H2/H3 structure)   │     │
│  └─────────────────┘    └──────────────────┘    └─────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 3: DUPLICATE DETECTION                                                 │
│  ┌─────────────────┐    ┌──────────────────┐    ┌─────────────────────┐     │
│  │ Generate        │───▶│ Compare Against  │───▶│ Reject if           │     │
│  │ Embedding       │    │ Existing Content │    │ similarity ≥ 0.85   │     │
│  │ (768-dim)       │    │ (pgvector)       │    │                     │     │
│  └─────────────────┘    └──────────────────┘    └─────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 4: BLOG GENERATION                                                     │
│  ┌─────────────────┐    ┌──────────────────┐    ┌─────────────────────┐     │
│  │ Load Author     │───▶│ Load Website     │───▶│ Generate Draft      │     │
│  │ Knowledge       │    │ Voice Config     │    │ (Gemini 2.5 Flash)  │     │
│  │ + Learnings     │    │ (I/we/they)      │    │                     │     │
│  └─────────────────┘    └──────────────────┘    └─────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 5: HUMANIZATION (Multi-Pass)                                           │
│  ┌─────────────────┐    ┌──────────────────┐    ┌─────────────────────┐     │
│  │ PostHumanizer   │───▶│ LLM Humanizer    │───▶│ Final Cleanup       │     │
│  │ (deterministic  │    │ (rewrite for     │    │ (PostHumanizer      │     │
│  │  replacements)  │    │  natural flow)   │    │  again)             │     │
│  └─────────────────┘    └──────────────────┘    └─────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 6: QUALITY REVIEW                                                      │
│  ┌─────────────────┐    ┌──────────────────┐    ┌─────────────────────┐     │
│  │ Automated       │───▶│ LLM Review       │───▶│ Score Calculation   │     │
│  │ Checks          │    │ (AI detection,   │    │ (base 75, penalties │     │
│  │ (vocab, format) │    │  quality issues) │    │  & bonuses)         │     │
│  └─────────────────┘    └──────────────────┘    └─────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    ▼                                   ▼
            ┌───────────────┐                   ┌───────────────┐
            │  PASS (≥75)   │                   │  FAIL (<75)   │
            │  → Published  │                   │  → Rewrite    │
            └───────────────┘                   │  → Learn      │
                                                └───────────────┘
                                                        │
                                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 7: LEARNING (Continuous Improvement)                                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ Extract patterns from failures → Store as rules → Inject into prompts  ││
│  │ Categories: vocabulary, structure, formatting, tone, SEO, CTA, content ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 📊 Data Flow

### Database Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          MYSQL (TiDB Cloud)                                  │
│                     Content, Metadata & Statistics                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐                 │
│  │   keywords   │────▶│    topics    │────▶│    posts     │                 │
│  │              │     │              │     │              │                 │
│  │ - keyword    │     │ - topic      │     │ - title      │                 │
│  │ - volume     │     │ - outline    │     │ - content    │                 │
│  │ - CPC        │     │ - website_id │     │ - status     │                 │
│  │ - difficulty │     │              │     │ - website_id │                 │
│  │ - intent     │     │              │     │              │                 │
│  │ - status     │     │              │     │              │                 │
│  └──────────────┘     └──────────────┘     └──────────────┘                 │
│         │                                          │                         │
│         │                                          ▼                         │
│         │                                  ┌──────────────┐                  │
│         │                                  │ post_reviews │                  │
│         │                                  │              │                  │
│         │                                  │ - score      │                  │
│         │                                  │ - passed     │                  │
│         │                                  │ - issues     │                  │
│         │                                  └──────────────┘                  │
│         │                                          │                         │
│         ▼                                          ▼                         │
│  ┌──────────────┐                         ┌───────────────────┐             │
│  │   websites   │                         │ prompt_learnings  │             │
│  │              │                         │                   │             │
│  │ - domain     │                         │ - category        │             │
│  │ - voice      │                         │ - rule_type       │             │
│  │ - brand_name │                         │ - rule_value      │             │
│  │ - CTA config │                         │ - failure_count   │             │
│  └──────────────┘                         └───────────────────┘             │
│                                                                              │
│  ┌──────────────────┐  ┌────────────────────┐  ┌─────────────────────┐      │
│  │ llm_usage_daily  │  │ llm_usage_monthly  │  │ serp_usage_monthly  │      │
│  │ (rate limiting)  │  │ (per-key tracking) │  │ (per-key tracking)  │      │
│  └──────────────────┘  └────────────────────┘  └─────────────────────┘      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                    POSTGRESQL (with pgvector)                                │
│                        Embeddings & Similarity                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                           embeddings                                  │   │
│  │                                                                       │   │
│  │  - entity_type (topic | post)                                        │   │
│  │  - entity_id                                                          │   │
│  │  - embedding (vector 768)  ◄── Cosine similarity for duplicate check │   │
│  │                                                                       │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Post Status Flow

```
             ┌─────────┐
             │   NEW   │  (keyword discovered)
             └────┬────┘
                  ▼
             ┌─────────┐
             │  USED   │  (topic planned)
             └────┬────┘
                  ▼
             ┌─────────┐
             │  DRAFT  │  (post generated)
             └────┬────┘
                  │
       ┌──────────┴──────────┐
       ▼                     ▼
┌─────────────┐       ┌─────────────┐
│  PUBLISHED  │       │   REWRITE   │
│ (score ≥75) │       │ (score <75) │
└─────────────┘       └──────┬──────┘
                             │
                             ▼ (rewritten)
                      ┌─────────────┐
                      │   DRAFT     │
                      └──────┬──────┘
                             │
                    (review cycle repeats)
```

---

## 🔧 Key Components

### Services (`src/services/`)

| Service | Purpose |
|---------|---------|
| `keywordService.ts` | Discovers keywords from SERP providers, enriches with Gemini |
| `topicPlanner.ts` | Selects best keywords and generates topic outlines |
| `duplicateChecker.ts` | Prevents duplicate content via embedding similarity |
| `blogGenerator.ts` | Creates structured blog posts with SEO metadata |
| `humanizer.ts` | LLM-based rewriting for natural voice |
| `postHumanizer.ts` | Deterministic cleanup (vocabulary, contractions) |
| `postReviewer.ts` | Quality scoring with automated + LLM checks |
| `promptLearner.ts` | Extracts rules from failures to improve prompts |
| `websiteService.ts` | Multi-website configuration and voice instructions |

### Humanization Strategy

The system uses a **dual-pass humanization** approach:

1. **PostHumanizer (Deterministic)** - Runs before and after LLM humanization
   - Replaces 60+ forbidden AI words (leverage → use, utilize → employ)
   - Injects contractions (it is → it's, do not → don't)
   - Removes colons from titles
   - Fixes forbidden paragraph openings

2. **Humanizer (LLM-Based)** - Rewrites for natural flow
   - Adds personal anecdotes and specific examples
   - Varies sentence structure
   - Injects industry-specific terminology

### Review System

**Automated Checks** (instant, no LLM calls):
- Colon in title (-10 points)
- AI vocabulary usage (-3 per word)
- Forbidden openings (-5 each)
- Missing contractions (-2 points)

**LLM Review** (deeper analysis):
- AI detection patterns
- Content quality issues
- SEO optimization gaps
- Structural problems

**Scoring**:
- Base score: 75
- Pass threshold: 75
- Penalties reduce score
- Bonuses can increase (capped at 100)

### Learning System

The `PromptLearner` analyzes review failures and extracts actionable rules:

```typescript
// Categories of learnings
type LearningCategory = 
  | 'vocabulary'      // Forbidden words/phrases
  | 'structure'       // Section limits, FAQ length
  | 'formatting'      // Bold patterns, list formatting
  | 'tone'            // Voice, contractions, hedging
  | 'seo'             // Title patterns, keyword usage
  | 'cta'             // Call-to-action placement
  | 'content';        // Topic coverage, depth
```

Rules are stored in `prompt_learnings` and injected into future generation prompts.

---

## 🌐 Multi-Website Support

The system supports generating content for multiple websites with different voices:

| Website | Voice | Style |
|---------|-------|-------|
| primestrides.com | `first_person_plural` ("we", "our team") | Professional, agency voice |
| theabdulrehman.com | `first_person_singular` ("I", "my") | Personal, individual voice |

Each website has configured:
- Brand name and tagline
- Default CTA text and URL
- Style configuration (tone, formality, target audience)

---

## 📦 Requirements

- **Node.js 18+** (with built-in fetch)
- **MySQL 8+** or TiDB Cloud (content storage)
- **PostgreSQL 15+** with `pgvector` extension (embeddings)
- **Google Gemini API** key(s)

---

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

**Required variables:**
```env
MYSQL_URL=mysql://user:pass@host:3306/database
POSTGRES_URL=postgres://user:pass@host:5432/database
GEMINI_API_KEYS=key1,key2,key3   # Multiple keys for higher throughput
```

### 3. Run Migrations

```bash
npm run migrate
```

### 4. Run the Pipeline

```bash
# Run once (recommended for testing)
npm run runOnce

# Run on schedule (production)
npm run dev
```

---

## 🐳 Docker Deployment

### Build Image

```bash
docker build -t primestrides/seo-blog-generator:latest .
```

### Local Development

```bash
cp .env.example .env
# Configure .env

docker-compose up -d
docker-compose logs -f
```

### Deploy to Portainer

1. **Push to registry:**
   ```bash
   docker build -t your-registry/seo-blog-generator:latest .
   docker push your-registry/seo-blog-generator:latest
   ```

2. **In Portainer:**
   - Stacks → Add Stack → Name: `seo-blog-generator`
   - Paste content from `docker-compose.portainer.yml`
   - Configure environment variables
   - Deploy

**Key Environment Variables:**

| Variable | Description | Default |
|----------|-------------|---------|
| `MYSQL_URL` | MySQL/TiDB connection string | Required |
| `POSTGRES_URL` | PostgreSQL connection string | Required |
| `GEMINI_API_KEYS` | Comma-separated API keys | Required |
| `CRON_SCHEDULE_1` | Primary cron schedule | `15 9 * * *` |
| `DUPLICATE_SIMILARITY_THRESHOLD` | Embedding similarity threshold | `0.85` |
| `POST_MIN_WORDS` | Minimum words per post | `1200` |

---

## 📁 Project Structure

```
├── src/
│   ├── config/           # Environment configuration
│   ├── db/               # Database connections & migrations
│   ├── embeddings/       # pgvector embedding store
│   ├── knowledge/        # Author knowledge loader
│   ├── llm/              # Gemini client & rate limiter
│   ├── prompts/          # All LLM prompt templates
│   ├── publishers/       # Export/publish handlers
│   ├── scheduler/        # Cron scheduler & orchestrator
│   ├── services/         # Core business logic
│   └── utils/            # Helpers (retry, json, slug)
├── migrations/
│   ├── mysql/            # MySQL schema migrations
│   └── postgres/         # PostgreSQL schema migrations
├── data/                 # Author knowledge files
├── docs/                 # Additional documentation
├── scripts/              # Utility scripts
├── Dockerfile            # Multi-stage production build
├── docker-compose.yml    # Local development
└── docker-compose.portainer.yml  # Portainer deployment template
```

---

## 🔑 API Key Management

### Gemini Keys

The system supports multiple API keys for higher throughput:

```env
GEMINI_API_KEYS=key1,key2,key3
```

Features:
- **Automatic rotation** based on rate limits
- **Per-key tracking** of RPM, TPM, RPD usage
- **Smart selection** chooses least-used key
- **Graceful fallback** when keys are exhausted

### SERP Provider Keys

For keyword discovery:

```env
SERPSTACK_APIS=key1,key2
ZENSERP_APIS=key1,key2
SCRAPPER_X_API=single_key  # Fallback
```

Monthly usage tracking per key ensures even distribution.

---

## 📈 Monitoring

### Health Check

```bash
npm run healthcheck
# Or
curl http://localhost:3000/health
```

### View Logs

```bash
# Docker
docker-compose logs -f

# Local
npm run dev  # Outputs to console
```

### Check API Usage

The system logs:
- Daily LLM request counts
- Per-key usage summaries
- SERP provider usage

---

## 🧪 Output Format

Posts are stored as structured JSON:

```typescript
interface BlogPostStructure {
  title: string;
  slug: string;
  meta: {
    title: string;
    description: string;
    keywords: string[];
  };
  hero: {
    hook: string;
    subtitle: string;
  };
  sections: Array<{
    id: string;
    heading: string;
    level: 2 | 3;
    content: string;
    keyTakeaway: string | null;
    cta: string | null;
  }>;
  faq: Array<{
    question: string;
    answer: string;
  }>;
  conclusion: {
    summary: string;
    cta: {
      text: string;
      buttonText: string;
      action: string;
    };
  };
  internalLinks: string[];
  estimatedReadingMinutes: number;
}
```

### Export to Markdown

```bash
npm run export
# Outputs to ./out/posts/
```

---

## 📝 Notes

- **Keyword Discovery**: Uses SERP providers when configured, falls back to Google Suggest
- **Enrichment**: Gemini estimates volume/CPC/difficulty when SERP doesn't provide them
- **Duplicate Threshold**: Default 0.85 cosine similarity blocks very similar content
- **Model**: Uses `gemini-2.5-flash` for better instruction following
- **Review Cycle**: Failed posts can be rewritten up to 3 times before manual intervention

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Run tests: `npm test`
4. Submit a pull request

---

## 📄 License

MIT License - See LICENSE file for details.
