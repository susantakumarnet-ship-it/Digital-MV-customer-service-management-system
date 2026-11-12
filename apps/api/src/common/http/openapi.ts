import { OpenAPIRegistry, OpenApiGeneratorV3, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Patches the (single, hoisted) zod prototype so schemas from @mv/shared can be documented.
extendZodWithOpenApi(z);

/** Single registry populated by ApiRouter.route() so documentation never drifts from routes (API-05). */
export const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

let cached: object | undefined;

export function openApiDocument() {
  if (cached) return cached;
  const generator = new OpenApiGeneratorV3(registry.definitions);
  cached = generator.generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'Digital MV Customer Service Management System API',
      version: '1.0.0',
      description: [
        'REST API for the Digital MV CSMS. All endpoints are under `/api/v1`.',
        '',
        '**Authentication:** `POST /auth/login` returns a short-lived bearer access token and sets an HttpOnly',
        'refresh cookie. Send `Authorization: Bearer <token>`. Refresh with `POST /auth/refresh`',
        '(requires the `X-CSRF-Token` header matching the `mv_csrf` cookie).',
        '',
        '**Errors:** `{ "error": { "code", "message", "fields?", "requestId" } }` with status',
        '400 validation · 401 unauthenticated · 403 forbidden · 404 not found · 409 state conflict ·',
        '422 business rule · 429 rate limited · 500 unexpected.',
        '',
        '**Lists:** `?page=&limit=` (max 100) → `{ data: [], meta: { page, limit, total, pages } }`.',
        '',
        '**Permissions:** every protected endpoint lists its required permission keys. Default deny.',
      ].join('\n'),
    },
    servers: [{ url: '/' }],
  });
  return cached;
}
