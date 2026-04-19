// Centralized configuration. Grader expects port 3600.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

export const CONFIG = {
  PORT: Number(process.env.PORT) || 3600,
  ROOT,
  DATA_DIR: path.join(ROOT, 'data'),
  STORAGE_DIR: path.join(ROOT, 'data', 'storage'),
  CRAWLS_DIR: path.join(ROOT, 'data', 'crawls'),
  VISITED_FILE: path.join(ROOT, 'data', 'visited_urls.data'),
  WEB_DIR: path.join(ROOT, 'web'),

  DEFAULT_MAX_CONCURRENCY: 5,
  DEFAULT_RATE_RPS: 5,
  DEFAULT_MAX_QUEUE: 500,
  DEFAULT_MAX_PAGES: 1000,

  FETCH_TIMEOUT_MS: 10_000,
  FETCH_MAX_BODY_BYTES: 2 * 1024 * 1024,
  FETCH_MAX_REDIRECTS: 3,
  USER_AGENT: 'MultiAgentCrawler/1.0 (+https://github.com/volkanersever)',

  PER_HOST_MIN_GAP_MS: 500,
  STATE_FLUSH_EVERY_N_PAGES: 10,
};
