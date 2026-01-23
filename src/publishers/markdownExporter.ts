import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool as MysqlPool, RowDataPacket } from 'mysql2/promise';

export class MarkdownExporter {
  constructor(private readonly deps: { pool: MysqlPool; exportDir: string }) {}

  async exportDrafts(): Promise<number> {
    const [rows] = await this.deps.pool.query<RowDataPacket[]>(
      `SELECT slug, content_markdown, title FROM posts WHERE status = 'draft' ORDER BY created_at DESC LIMIT 20`
    );

    await fs.mkdir(this.deps.exportDir, { recursive: true });

    let written = 0;
    for (const row of rows as any[]) {
      const file = path.join(this.deps.exportDir, `${String(row.slug)}.md`);
      await fs.writeFile(file, String(row.content_markdown), 'utf8');
      written += 1;
    }

    return written;
  }
}
