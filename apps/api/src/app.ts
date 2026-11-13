import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env';
import { openApiDocument } from './common/http/openapi';
import { logger } from './common/logger';
import { errorHandler, notFoundHandler } from './common/middleware/error-handler';
import { limiter, requestId, sanitizeBody } from './common/middleware/security';
import { databaseStatus } from './db/connection';
import { auditRouter } from './modules/audit/audit.routes';
import { authRouter } from './modules/auth/auth.routes';
import { dashboardRouter } from './modules/dashboard/dashboard.routes';
import { mastersRouter } from './modules/masters/masters.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import { rolesRouter } from './modules/roles/roles.routes';
import { settingsRouter, workflowsRouter } from './modules/settings/settings.routes';
import { usersRouter } from './modules/users/users.routes';
import { complaintWorkOrdersRouter, engineerRouter, workOrdersRouter } from './modules/work-orders/work-orders.routes';
import { registerWorkOrderGuards } from './modules/work-orders/work-order.guards';
import { complaintsRouter } from './modules/complaints/complaints.routes';
import { publicRouter } from './modules/complaints/public.routes';
import { registerComplaintGuards } from './modules/complaints/complaint.guards';
import { canAccessComplaint } from './modules/complaints/complaint.service';
import { filesRouter, registerAttachmentOwner } from './modules/files/files.routes';

export function createApp(): Express {
  const e = env();
  const app = express();

  // Business-rule guards and attachment-owner access checks (fail closed if missing).
  registerComplaintGuards();
  registerWorkOrderGuards();
  registerAttachmentOwner('complaint', (auth, ownerId, a) =>
    canAccessComplaint(auth, ownerId).then((ok) => ok && (a.context !== 'internal' || auth.permissions.has('complaint.readInternal'))),
  );

  app.disable('x-powered-by');
  app.set('trust proxy', e.TRUST_PROXY);
  app.set('query parser', 'simple');

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId ?? '',
      autoLogging: { ignore: (req) => req.url?.startsWith('/api/v1/health') ?? false },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // Swagger UI needs inline styles; the API serves no other HTML.
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          scriptSrc: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      hsts: e.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
    }),
  );
  const origins = e.WEB_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || origins.includes(origin)),
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Request-Id', 'Idempotency-Key'],
      exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(sanitizeBody);
  app.use('/api/', limiter({ windowMs: 60_000, limit: 600 }));
  // API responses are never cached by browsers or proxies.
  app.use('/api/', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // ---- Health -----------------------------------------------------------------------------------
  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok', service: 'mv-api', time: new Date().toISOString() });
  });
  app.get('/api/v1/health/ready', async (_req, res) => {
    try {
      const db = await databaseStatus();
      res.status(db.ok ? 200 : 503).json({ status: db.ok ? 'ready' : 'unavailable', database: db });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  // ---- Modules ----------------------------------------------------------------------------------
  const routers = [
    authRouter,
    usersRouter,
    rolesRouter,
    mastersRouter,
    settingsRouter,
    workflowsRouter,
    auditRouter,
    notificationsRouter,
    dashboardRouter,
    complaintsRouter,
    publicRouter,
    filesRouter,
    workOrdersRouter,
    complaintWorkOrdersRouter,
    engineerRouter,
  ];
  for (const r of routers) app.use(`/api/v1${r.base}`, r.router);
  // BRF §20 lists /api/v1/organizations as its own route: alias of /masters/organizations.
  app.use('/api/v1/organizations', (req, res, next) => {
    req.url = `/organizations${req.url === '/' ? '' : req.url}`;
    mastersRouter.router(req, res, next);
  });

  // ---- API documentation (API-05) ---------------------------------------------------------------
  if (e.NODE_ENV !== 'production' || e.API_DOCS_ENABLED) {
    app.get('/api/v1/openapi.json', (_req, res) => {
      res.json(openApiDocument());
    });
    app.use('/api/v1/docs', swaggerUi.serve, swaggerUi.setup(undefined, { swaggerOptions: { url: '/api/v1/openapi.json' } }));
  }

  app.use('/api/', notFoundHandler);
  app.use(errorHandler);
  return app;
}
