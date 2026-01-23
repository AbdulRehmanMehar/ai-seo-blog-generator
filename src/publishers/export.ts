import { env } from '../config/env.js';
import { mysqlPool } from '../db/mysqlPool.js';
import { MarkdownExporter } from './markdownExporter.js';

const exporter = new MarkdownExporter({ pool: mysqlPool, exportDir: env.EXPORT_DIR });
const count = await exporter.exportDrafts();
// eslint-disable-next-line no-console
console.log(`Exported ${count} draft posts to ${env.EXPORT_DIR}`);

await mysqlPool.end();
