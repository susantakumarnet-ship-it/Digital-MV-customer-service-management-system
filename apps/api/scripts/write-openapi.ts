/**
 * Writes the OpenAPI document to docs/api/openapi.json (API-05). Run: npm run openapi
 * Requires no database: route registration only.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
process.env.JWT_ACCESS_SECRET ??= randomBytes(48).toString('base64url');
process.env.MFA_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
process.env.LOG_LEVEL = 'silent';

const { createApp } = await import('../src/app');
const { openApiDocument } = await import('../src/common/http/openapi');
createApp();
const doc = openApiDocument() as { paths: Record<string, unknown> };
const out = path.resolve(import.meta.dirname, '../../../docs/api/openapi.json');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc, null, 2));
console.log(`Wrote ${Object.keys(doc.paths).length} paths to ${out}`);
