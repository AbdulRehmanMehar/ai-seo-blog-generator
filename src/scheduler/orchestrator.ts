import type { RowDataPacket } from 'mysql2/promise';
import { env } from '../config/env.js';
import { mysqlPool } from '../db/mysqlPool.js';
import { postgresPool } from '../db/postgresPool.js';
import { loadAuthorKnowledge } from '../knowledge/authorKnowledge.js';
import { GeminiClient } from '../llm/geminiClient.js';
import { GeminiRateLimiter } from '../llm/rateLimiter.js';
import { parseGeminiApiKeys } from '../llm/keyManager.js';
import { EmbeddingStore } from '../embeddings/embeddingStore.js';
import { KeywordService } from '../services/keywordService.js';
import { TopicPlanner } from '../services/topicPlanner.js';
import { DuplicateChecker } from '../services/duplicateChecker.js';
import { BlogGenerator } from '../services/blogGenerator.js';
import { Humanizer } from '../services/humanizer.js';
import { PostReviewer } from '../services/postReviewer.js';
import { GscSyncService } from '../services/gscSyncService.js';
import { GscOpportunityDetector } from '../services/gscOpportunityDetector.js';
import { Ga4EngagementRefreshDetector } from '../services/ga4EngagementRefreshDetector.js';
import { ContentRefreshService } from '../services/contentRefreshService.js';
import { SitemapService } from '../services/sitemapService.js';
import { IndexNowService } from '../services/indexNowService.js';
import { GoogleIndexingService } from '../services/googleIndexingService.js';
import { TaxonomyService } from '../services/taxonomyService.js';

function log(message: string) {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${ts}] ${message}`);
}

/**
 * Final pipeline step: regenerate sitemaps for every website and (if configured)
 * submit recently published/refreshed URLs to IndexNow. Best-effort — never throws,
 * so it can run at the end of both the normal and refresh-only paths.
 */
async function runIndexingStep(taxonomy: TaxonomyService) {
  log('');
  log('──────────────────────────────────────────────────────────────────────────');
  log('STEP: TAXONOMY + SITEMAP + GOOGLE INDEXING API + INDEXNOW');
  log('──────────────────────────────────────────────────────────────────────────');

  // 0) Refresh taxonomy: backfill any uncategorized published posts, recompute
  //    published-post counts + tag indexability, then (re)generate unique hub-page
  //    content for stale/new categories & indexable tags.
  try {
    const backfilled = await taxonomy.backfillUncategorizedPublished(10);
    if (backfilled > 0) log(`🏷️  Taxonomy backfill: categorized ${backfilled} previously-uncategorized published post(s)`);
    const counts = await taxonomy.recomputeCountsAndIndexability();
    // Rebuild internal links for never-linked / rewritten / stale posts (no LLM cost).
    const links = await taxonomy.refreshInternalLinks(25);
    if (links.processed > 0) log(`🔗 Internal links: checked ${links.processed} post(s), rebuilt ${links.updated}`);
    const pages = await taxonomy.generatePendingPageContent(env.TAXONOMY_PAGE_CONTENT_PER_RUN);
    log(`🏷️  Taxonomy: indexable tags=${counts.indexableTags} | hub content generated this run: categories=${pages.categories} tags=${pages.tags}`);
  } catch (err) {
    log(`⚠️  Taxonomy update failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
  }

  // 1) Sitemaps — the legitimate Google discovery lever. Helps only once the live
  //    site serves the file and references it from robots.txt / Search Console.
  try {
    const sitemap = new SitemapService(mysqlPool);
    const results = await sitemap.generateAll();
    if (results.length === 0) {
      log('🗺️  Sitemap: no published posts yet — nothing to write');
    } else {
      for (const r of results) {
        log(`🗺️  Sitemap written: ${r.filePath} (${r.urlCount} URL(s) for ${r.domain})`);
      }
      log('   ↳ Deploy these to https://{domain}/sitemap.xml and reference them in robots.txt for Google to use them.');
    }
  } catch (err) {
    log(`⚠️  Sitemap generation failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2) Google Indexing API — pings Google directly for recently published/updated
  //    posts (URL_UPDATED). Quota-safe: a ledger (google_indexing_pings) ensures a
  //    URL is only re-pinged when its content changed since the last ping, capped
  //    per run. Best-effort — a setup error (service account not yet an OWNER of
  //    the GSC property, API disabled) aborts the batch with one log line and
  //    never blocks the pipeline. Runs BEFORE IndexNow deliberately: the IndexNow
  //    block exits this function early when INDEXNOW_KEY is unset.
  try {
    const googleIndexing = env.GOOGLE_INDEXING_PING_ENABLED ? GoogleIndexingService.build() : null;
    if (!env.GOOGLE_INDEXING_PING_ENABLED) {
      log('🔔 Google Indexing API: skipped (GOOGLE_INDEXING_PING_ENABLED=false)');
    } else if (!googleIndexing) {
      log('🔔 Google Indexing API: skipped (no Google service account configured)');
    } else {
      const sitemap = new SitemapService(mysqlPool);
      const recent = await sitemap.getRecentlyPublishedUrls(env.INDEXING_LOOKBACK_DAYS);
      if (recent.length > 0) {
        const result = await googleIndexing.pingUpdatedUrls(
          mysqlPool,
          recent.map((u) => ({ url: u.url, lastmod: u.lastmod })),
          env.GOOGLE_INDEXING_PINGS_PER_RUN
        );
        if (result.abortReason) {
          log(`⚠️  Google Indexing API: aborted after ${result.pinged} ping(s) — ${result.abortReason}`);
        } else {
          log(`🔔 Google Indexing API: ${result.pinged} pinged, ${result.skipped} already announced, ${result.failed} failed`);
        }
      }
    }
  } catch (err) {
    log(`⚠️  Google Indexing API ping failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3) IndexNow — notifies Bing/Yandex/Seznam (NOT Google). Gated on INDEXNOW_KEY.
  try {
    const indexNow = new IndexNowService();
    if (!indexNow.isEnabled()) {
      log('📨 IndexNow: skipped (INDEXNOW_KEY not set)');
      return;
    }
    const keyFile = await indexNow.writeKeyFile();
    if (keyFile) log(`📨 IndexNow key file written: ${keyFile} (host it at https://{domain}/<key>.txt)`);

    const sitemap = new SitemapService(mysqlPool);
    const recent = await sitemap.getRecentlyPublishedUrls(env.INDEXING_LOOKBACK_DAYS);
    if (recent.length === 0) {
      log(`📨 IndexNow: no posts published/updated in the last ${env.INDEXING_LOOKBACK_DAYS} day(s) — nothing to submit`);
      return;
    }
    const submissions = await indexNow.submitUrls(recent);
    for (const s of submissions) {
      if (s.ok) {
        log(`📨 IndexNow: submitted ${s.submitted} URL(s) for ${s.domain} (HTTP ${s.status})`);
      } else {
        log(`⚠️  IndexNow: submission for ${s.domain} failed: ${s.error}`);
      }
    }
  } catch (err) {
    log(`⚠️  IndexNow submission failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
  }
}

function elapsed(startMs: number): string {
  const ms = Date.now() - startMs;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export async function runPipelineOnce() {
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('🚀 PIPELINE RUN STARTED');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Parse API keys from env (supports both single and multiple keys)
  const apiKeys = parseGeminiApiKeys(env.GEMINI_API_KEY, env.GEMINI_API_KEYS);
  if (apiKeys.length === 0) {
    throw new Error('Missing GEMINI_API_KEY or GEMINI_API_KEYS: required to run the pipeline.');
  }

  log('📚 Loading author knowledge...');
  const knowledge = await loadAuthorKnowledge();
  log(`   ✓ Author knowledge loaded (${knowledge.raw.length} chars)`);

  log('🔧 Initializing services...');
  log('   → Creating rate limiter...');

  // Initialize the comprehensive rate limiter
  const rateLimiter = new GeminiRateLimiter(mysqlPool, apiKeys);
  log('   ✓ Rate limiter created');

  log('   → Creating Gemini client...');

  const gemini = new GeminiClient({
    rateLimiter,
    generationModel: env.GEMINI_GENERATION_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    minSecondsBetweenRequests: env.LLM_MIN_SECONDS_BETWEEN_REQUESTS
  });

  log(`   ✓ Gemini client (${apiKeys.length} key(s), model: ${env.GEMINI_GENERATION_MODEL})`);
  log(`   ✓ Rate limits: RPM/TPM/RPD tracking enabled (auto-switches keys)`);

  // Show current usage per key
  const usageSummary = await gemini.getUsageSummary();
  log(`   ✓ Key usage today: ${usageSummary}`);

  const embeddings = new EmbeddingStore(postgresPool);
  log('   ✓ Embedding store (Postgres + pgvector)');

  const keywordService = new KeywordService({ pool: mysqlPool, gemini });
  const topicPlanner = new TopicPlanner({ pool: mysqlPool, gemini, knowledge, embeddings });
  const duplicateChecker = new DuplicateChecker({ pool: mysqlPool, gemini, embeddings, threshold: env.DUPLICATE_SIMILARITY_THRESHOLD });
  const blogGenerator = new BlogGenerator({ pool: mysqlPool, gemini, knowledge, embeddings, minWords: env.POST_MIN_WORDS });
  const humanizer = new Humanizer({ pool: mysqlPool, gemini, knowledge, minWords: env.POST_MIN_WORDS });
  const postReviewer = new PostReviewer({ pool: mysqlPool, gemini });
  const taxonomy = new TaxonomyService({ pool: mysqlPool, gemini });
  log('   ✓ All services initialized');

  // ──────────────────────────────────────────────────────────────────────────
  // PRE-STEP: DATA INTELLIGENCE & REFRESH OPS (aligns runOnce with scheduler)
  // ──────────────────────────────────────────────────────────────────────────
  log('');
  log('──────────────────────────────────────────────────────────────────────────');
  log('PRE-STEP: GSC/GA4 SYNC + OPPORTUNITIES + REFRESH QUEUE (best-effort)');
  log('──────────────────────────────────────────────────────────────────────────');

  // 1) Pull latest GSC performance into DB (best-effort)
  try {
    const syncer = new GscSyncService(mysqlPool);
    const results = await syncer.syncAll();
    if (results.length > 0) {
      const ok = results.filter((r) => !r.error).length;
      const err = results.filter((r) => r.error).length;
      log(`📡 GSC sync complete: websites=${results.length} ok=${ok} failed=${err}`);
    } else {
      log('📡 GSC sync skipped (not configured or no websites)');
    }
  } catch (err) {
    log(`⚠️  GSC sync failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2) Detect GSC opportunities and write queue items / near-miss keywords (best-effort)
  try {
    const detector = new GscOpportunityDetector(mysqlPool);
    const results = await detector.detectAll();
    if (results.length > 0) {
      const total = results.reduce((sum, r) => sum + r.lowCtr + r.nearMiss + r.declining, 0);
      log(`🔍 GSC opportunity detection complete: websites=${results.length} total_opps=${total}`);
    } else {
      log('🔍 GSC opportunity detection skipped (no websites configured)');
    }
  } catch (err) {
    log(`⚠️  GSC opportunity detection failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
  }

  // NOTE: GSC near-miss keywords are now imported GSC-FIRST inside Step 1
  // (keywordService.discoverAndStoreKeywords), which leads with proven-demand queries and
  // only expands via SERP providers when the pool is thin. No separate import needed here.

  // 3) Detect GA4 low-engagement pages and queue refreshes (best-effort)
  try {
    const ga4Detector = new Ga4EngagementRefreshDetector(mysqlPool);
    const results = await ga4Detector.detectAndQueueAll();
    const queuedTotal = results.reduce((sum, r) => sum + r.queued, 0);
    const skipped = results.filter((r) => r.skipped).length;
    log(`📉 GA4 engagement detection complete: websites=${results.length} queued=${queuedTotal} skipped=${skipped}`);
    for (const r of results) {
      if (r.skipped) log(`   ↳ GA4 skipped website=${r.websiteId}: ${r.skipped}`);
    }
  } catch (err) {
    log(`⚠️  GA4 engagement detection failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4) Drain the refresh queue before generating new posts.
  //    Fixing existing thin posts restores domain quality signals faster
  //    than adding new posts Google won't index anyway.
  const refresher = new ContentRefreshService(mysqlPool, gemini);
  let pendingRefreshes = 0;
  try {
    pendingRefreshes = await refresher.getPendingQueueCount();
    log(`🔄 Refresh queue: ${pendingRefreshes} item(s) pending`);
  } catch (err) {
    log(`⚠️  Could not read refresh queue count: ${err instanceof Error ? err.message : String(err)}`);
  }

  const REFRESH_BATCH_SIZE = 5;

  if (pendingRefreshes > 0) {
    log('');
    log('──────────────────────────────────────────────────────────────────────────');
    log(`STEP 1: REFRESH QUEUE (${pendingRefreshes} pending — new posts paused until queue clears)`);
    log('──────────────────────────────────────────────────────────────────────────');
    try {
      const refreshResult = await refresher.processRefreshQueue(REFRESH_BATCH_SIZE);
      log(`✅ Refresh run complete: processed=${refreshResult.processed} ok=${refreshResult.succeeded} failed=${refreshResult.failed}`);
      const remaining = Math.max(0, pendingRefreshes - refreshResult.processed);
      if (remaining > 0) {
        const runsLeft = Math.ceil(remaining / REFRESH_BATCH_SIZE);
        log(`   ⏳ ${remaining} posts still queued (~${runsLeft} more run(s) to clear the backlog)`);
      } else {
        log('   🎉 Refresh queue fully cleared — new post generation resumes next run');
      }
    } catch (err) {
      log(`⚠️  Refresh queue processing failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Refreshed posts changed — refresh taxonomy, regenerate sitemaps and re-notify IndexNow.
    await runIndexingStep(taxonomy);

    log('');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('✅ PIPELINE RUN FINISHED (refresh-priority mode)');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return;
  }

  // PAUSE MODE: keep the GSC/GA4 review + refresh queue running (above), but skip generating
  // NEW posts. Used to let the existing library settle (e.g. while measuring an indexing
  // change) while the system still reviews GSC and acts on opportunities/refreshes.
  if (env.PAUSE_NEW_POSTS) {
    log('');
    log('⏸️  NEW-POST GENERATION PAUSED (PAUSE_NEW_POSTS=true).');
    log('   GSC/GA4 sync, opportunity detection, and the refresh queue still ran above.');
    await runIndexingStep(taxonomy);
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('✅ PIPELINE RUN FINISHED (paused — review/refresh only, no new posts)');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return;
  }

  log('🔄 Refresh queue empty — proceeding to new post generation');

  log('');
  log('──────────────────────────────────────────────────────────────────────────');
  log('STEP 1: KEYWORD DISCOVERY (GSC-first; SERP expansion only when pool is thin)');
  log('──────────────────────────────────────────────────────────────────────────');
  log('🔍 Importing GSC near-miss demand, expanding via SERP only if needed...');
  const keywordResult = await keywordService.discoverAndStoreKeywords();
  log(`   ✓ Keywords: source=${keywordResult.source}, gsc_nearmiss=${keywordResult.gscImported}, new=${keywordResult.inserted}`);

  log('');
  log('──────────────────────────────────────────────────────────────────────────');
  log('STEP 2: TOPIC PLANNING & CONTENT GENERATION');
  log('──────────────────────────────────────────────────────────────────────────');

  const targetPosts = env.POSTS_PER_RUN;
  let created = 0;
  let duplicatesSkipped = 0;
  let attempts = 0;

  log(`🎯 Target: generate ${targetPosts} blog post(s)`);

  while (created < targetPosts && attempts < 3) {
    attempts += 1;
    const needed = Math.min(2, targetPosts - created);

    log('');
    log(`📋 Planning topics (attempt ${attempts}/3, need ${needed} more post(s))...`);
    const planned = await topicPlanner.planTopics({ candidateCount: 30, selectCount: needed });
    log(`   ✓ Topics planned: ${planned.length}`);

    if (planned.length === 0) {
      log('   ⚠️  No topics planned (no suitable keywords available)');
      break;
    }

    for (let i = 0; i < planned.length; i++) {
      const topicId = planned[i]!;
      if (created >= targetPosts) break;

      log('');
      log(`📝 Processing topic ${i + 1}/${planned.length} (id: ${topicId.slice(0, 8)}...)`);

      log('   🔎 Checking for duplicates...');
      const topicIsDup = await duplicateChecker.isDuplicateTopic(topicId);
      if (topicIsDup) {
        log('   ⏭️  Skipped: duplicate content detected');
        duplicatesSkipped += 1;
        continue;
      }
      log('   ✓ No duplicate found');

      log('   ✍️  Generating blog post draft...');
      const genStart = Date.now();
      let postId: string;
      try {
        postId = await blogGenerator.generateDraftPost(topicId);
      } catch (genErr) {
        const msg = genErr instanceof Error ? genErr.message : String(genErr);
        log(`   ✗ Generation failed (skipping topic): ${msg}`);
        continue;
      }
      const [[postTitleRow]] = await mysqlPool.query<RowDataPacket[]>('SELECT title FROM posts WHERE id = ?', [postId]);
      const postTitle = (postTitleRow as any)?.title ?? `id:${postId.slice(0, 8)}`;
      log(`   ✓ Draft created: "${postTitle}" (${elapsed(genStart)})`);

      log('   🧹 Humanizing content...');
      const humanStart = Date.now();
      try {
        await humanizer.humanizePost(postId);
        log(`   ✓ Humanization complete (${elapsed(humanStart)})`);
      } catch (humanErr) {
        // Matches the generateDraftPost error-handling pattern above — a rare
        // humanizer failure (e.g. its own double-parse-failure path) must not abort
        // the whole pipeline run. The post already exists with valid, ≥minWords
        // content from generateDraftPost; proceeding to review as-is is safe.
        const msg = humanErr instanceof Error ? humanErr.message : String(humanErr);
        log(`   ⚠️  Humanization failed (keeping pre-humanization draft): ${msg}`);
      }

      log('   📋 Running quality review...');
      const reviewStart = Date.now();
      const reviewResult = await postReviewer.reviewPost(postId);
      const reviewTime = elapsed(reviewStart);
      if (reviewResult.passed) {
        log(`   ✓ Review PASSED (score: ${reviewResult.score}/100) → published (${reviewTime})`);
      } else {
        const topIssues = reviewResult.issues.slice(0, 3).map(i => i.code).join(', ');
        const extras = reviewResult.issues.length > 3 ? ` +${reviewResult.issues.length - 3} more` : '';
        log(`   ⚠️  Review FAILED (score: ${reviewResult.score}/100) → queued for rewrite (${reviewTime})`);
        log(`      Failing checks: ${topIssues}${extras}`);
      }

      // Only categorize posts that passed (now published). Failed drafts are picked up by
      // the backfill in the indexing step once/if they reach 'published' after a rewrite.
      if (reviewResult.passed) {
        log('   🏷️  Assigning categories & tags...');
        try {
          const tax = await taxonomy.assignTaxonomy(postId);
          const tagStr = tax.tags.length ? ` | tags: ${tax.tags.join(', ')}` : '';
          log(`   ✓ Filed under: ${tax.categories.join(', ') || '(uncategorized)'}${tagStr}`);
        } catch (taxErr) {
          log(`   ⚠️  Taxonomy assignment failed (continuing): ${taxErr instanceof Error ? taxErr.message : String(taxErr)}`);
        }
      }

      created += 1;
      log(`   🎉 Post ${created}/${targetPosts} processed!`);
    }
  }

  // Final step: refresh taxonomy + sitemaps + submit newly published URLs to IndexNow.
  await runIndexingStep(taxonomy);

  log('');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('✅ PIPELINE RUN FINISHED');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`   Posts created:      ${created}/${targetPosts}`);
  log(`   Duplicates skipped: ${duplicatesSkipped}`);
  log(`   Planning attempts:  ${attempts}`);
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}
