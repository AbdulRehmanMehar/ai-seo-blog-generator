/**
 * CORPUS REDACTION SWEEP (Phase A) — deterministically remove unshippable
 * content from EVERY published post: NDA client names, fear/payback idioms,
 * dollar-outcome promises, and fabricated numeric claims. No LLM involved.
 *
 * PURPOSE: 93% of the live corpus violates at least one non-negotiable. This
 * kills the legal exposure (NDA names) and the worst trust-destroyers in one
 * pass, for every page a buyer or Google might read today.
 *
 *   npx tsx scripts/corpus-redact.ts --sample 3     # preview: exports what WOULD be deleted, no DB writes
 *   npx tsx scripts/corpus-redact.ts --apply        # full sweep + IndexNow ping
 *
 * Titles/meta titles are NEVER auto-changed: posts whose TITLE contains an NDA
 * name or violation are listed in the report for deliberate per-post handling.
 */
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import fs from 'node:fs';
import path from 'node:path';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { mysqlPool } from '../src/db/mysqlPool.js';
import { redactViolatingSentences } from '../src/services/brandRedaction.js';
import { BRAND_SCREEN } from '../src/services/brandRedaction.js';
import { CLIENT_NAME_BLOCKLIST } from '../src/knowledge/brandKnowledge.js';
import { buildPostUrl, type PublishedPostUrl } from '../src/services/sitemapService.js';
import { IndexNowService } from '../src/services/indexNowService.js';
import type { BlogPostStructure } from '../src/prompts/blogGeneration.js';

/** Structural validation: a redacted post must be shape-identical to a valid BlogPostStructure. */
function isStructurallyValid(post: BlogPostStructure): boolean {
  try {
    const roundTrip = JSON.parse(JSON.stringify(post)) as BlogPostStructure;
    if (typeof roundTrip.title !== 'string' || !roundTrip.title) return false;
    if (!Array.isArray(roundTrip.sections) || roundTrip.sections.length === 0) return false;
    for (const s of roundTrip.sections) {
      if (typeof s.heading !== 'string' || typeof s.content !== 'string' || !s.content) return false;
    }
    if (roundTrip.faq && !Array.isArray(roundTrip.faq)) return false;
    for (const f of roundTrip.faq ?? []) {
      if (typeof f.question !== 'string' || typeof f.answer !== 'string') return false;
    }
    if (roundTrip.conclusion && typeof roundTrip.conclusion.summary !== 'string') return false;
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const sampleFlag = process.argv.indexOf('--sample');
  const sampleN = sampleFlag >= 0 ? Number(process.argv[sampleFlag + 1] ?? 3) : apply ? 0 : 3;

  if (apply) {
    // Full reversibility: snapshot every published post's exact current JSON first.
    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS posts_content_backup (
        post_id CHAR(36) NOT NULL,
        backed_up_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        content_json JSON NOT NULL,
        reason VARCHAR(100) NOT NULL,
        PRIMARY KEY (post_id, backed_up_at)
      )`);
    const [bk] = await mysqlPool.query<ResultSetHeader>(`
      INSERT INTO posts_content_backup (post_id, content_json, reason)
      SELECT id, content_json, 'corpus-redact-2026-07-26' FROM posts WHERE status = 'published'`);
    console.log(`backup: ${bk.affectedRows} posts snapshotted to posts_content_backup`);
  }

  const [rows] = await mysqlPool.query<RowDataPacket[]>(
    `SELECT p.id, p.slug, p.title, p.content_json, p.website_id, w.domain
       FROM posts p JOIN websites w ON w.id = p.website_id
      WHERE p.status = 'published'`
  );

  const outDir = path.resolve('review', 'redaction');
  fs.mkdirSync(outDir, { recursive: true });

  const titleProblems: string[] = [];
  const changed: PublishedPostUrl[] = [];
  let totalDropped = 0, totalTrimmed = 0, totalCapped = 0, postsChanged = 0, processed = 0;

  for (const r of rows as any[]) {
    const current = (typeof r.content_json === 'string' ? JSON.parse(r.content_json) : r.content_json) as BlogPostStructure;
    const { post: redacted, stats } = redactViolatingSentences(current);
    const isChanged = stats.droppedSentences.length > 0 || stats.trimmedFaqs > 0 || stats.cappedCtas > 0;

    // Titles are pinned — report violations there for deliberate handling.
    const titleText = `${r.title} ${current.meta?.title ?? ''}`;
    const titleBad = CLIENT_NAME_BLOCKLIST.some((n) => new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(titleText))
      || BRAND_SCREEN.some(({ pattern }) => pattern.test(titleText));
    if (titleBad) titleProblems.push(`https://${r.domain}/blog/${r.slug} — "${r.title}"`);

    if (!isChanged) continue;
    postsChanged++;
    totalDropped += stats.droppedSentences.length;
    totalTrimmed += stats.trimmedFaqs;
    totalCapped += stats.cappedCtas;

    if (!apply && processed < sampleN) {
      processed++;
      const md: string[] = [];
      md.push(`# Redaction preview: ${r.title}\n`);
      md.push(`> https://${r.domain}/blog/${r.slug}\n`);
      md.push(`Sentences that WOULD be deleted (${stats.droppedSentences.length}):\n`);
      for (const s of stats.droppedSentences) md.push(`- ${s}`);
      if (stats.trimmedFaqs) md.push(`\nFAQ answers trimmed to 25-word budget: ${stats.trimmedFaqs}`);
      if (stats.cappedCtas) md.push(`CTAs nulled beyond the cap of 3: ${stats.cappedCtas}`);
      fs.writeFileSync(path.join(outDir, `${r.slug}.md`), md.join('\n'));
      console.log(`sample exported: review/redaction/${r.slug}.md (${stats.droppedSentences.length} deletions)`);
    }

    if (apply) {
      if (!isStructurallyValid(redacted)) {
        console.log(`⚠️ SKIPPED (failed structural validation): ${r.slug}`);
        continue;
      }
      await mysqlPool.query<ResultSetHeader>(
        `UPDATE posts SET content_json = ?, meta_description = ?, updated_at = NOW() WHERE id = ?`,
        [JSON.stringify(redacted), redacted.meta?.description ?? '', String(r.id)]
      );
      changed.push({ websiteId: String(r.website_id), domain: String(r.domain), slug: String(r.slug), url: buildPostUrl(String(r.domain), String(r.slug)) });
    }
  }

  if (apply && changed.length > 0) {
    const indexNow = new IndexNowService();
    if (indexNow.isEnabled()) {
      const results = await indexNow.submitUrls(changed);
      for (const s of results) console.log(`IndexNow ${s.ok ? 'OK' : 'FAILED'} — ${s.domain}: ${s.submitted} URLs`);
    }
  }

  fs.writeFileSync(path.join(outDir, '_title-violations.md'),
    `# Titles needing deliberate handling (never auto-changed)\n\n${titleProblems.map((t) => `- ${t}`).join('\n')}\n`);

  console.log(`\n══ ${apply ? 'APPLIED' : 'DRY RUN'} ══`);
  console.log(`Posts scanned: ${(rows as any[]).length} | posts ${apply ? 'changed' : 'that would change'}: ${postsChanged}`);
  console.log(`Sentences ${apply ? 'deleted' : 'to delete'}: ${totalDropped} | FAQ trims: ${totalTrimmed} | CTA caps: ${totalCapped}`);
  console.log(`Titles with violations (manual handling): ${titleProblems.length} → review/redaction/_title-violations.md`);
  await mysqlPool.end();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  try { await mysqlPool.end(); } catch { /* ignore */ }
  process.exit(1);
});
