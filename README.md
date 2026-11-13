# Digital MV Customer Service Management System

Web-based complaint and field-service management: complaint intake → review → work orders → engineer visits with six-step time tracking → inspections → review/approval → materials → NCR → customer acceptance → closure.

**Stack:** React 18 + TypeScript + Tailwind (apps/web) · Node.js + Express 5 + TypeScript (apps/api) · MongoDB (replica set) via Mongoose · shared Zod schemas and permission catalogue (packages/shared).

**Delivery status:** Phase 8 (NCRs, customer acceptance and complaint closure) complete — see [docs/phase-8/phase-8-report.md](docs/phase-8/phase-8-report.md). Earlier phases: [Phase 7](docs/phase-7/phase-7-report.md), [Phase 6](docs/phase-6/phase-6-report.md), [Phase 5](docs/phase-5/phase-5-report.md), [Phase 4](docs/phase-4/phase-4-report.md), [Phase 3](docs/phase-3/phase-3-report.md), [Phase 2](docs/phase-2/phase-2-report.md). Requirements, architecture and open decisions are in [docs/phase-1](docs/phase-1/).

## Prerequisites

- Node.js 20.11+ (developed on Node 24) and npm 10+
- MongoDB **replica set** (transactions are required): MongoDB Atlas, or a local `mongod` started with `replication.replSetName`

## First-time setup

```bash
npm install
cp apps/api/.env.example apps/api/.env      # then edit it (see below)
npm run migrate                             # create collections and indexes
npm run seed                                # settings, system roles, workflows, first administrator
npm run seed:demo                           # optional, non-production: demo master data + one user per role
npm run dev                                 # API on :4610, web on :5610
```

Open http://localhost:5610 and sign in as `admin` with `SEED_ADMIN_PASSWORD`. You must change the password at first sign-in. API documentation: http://localhost:4610/api/v1/docs.

### apps/api/.env essentials

| Variable | Notes |
|---|---|
| `MONGODB_URI` | Atlas → *Connect* → *Drivers* connection string (`mongodb+srv://…`). Add your machine's IP under Atlas → *Network Access*. |
| `MONGODB_DB` | `MVServiceMgmt` |
| `JWT_ACCESS_SECRET` / `MFA_ENCRYPTION_KEY` | Generate per environment (commands in `.env.example`). Never reuse across environments. |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Used only by `npm run seed` when no administrator exists. |
| `MAIL_TRANSPORT` | `file` writes emails to `apps/api/var/mail/*.eml` in development; `smtp` for real delivery. |

`.env` files are git-ignored. Do not commit secrets.

## Scripts (repository root)

| Command | Purpose |
|---|---|
| `npm run dev` | API (tsx watch) + web (Vite, proxies `/api` to :4610) |
| `npm test` | All tests. API tests need a local replica set at `mongodb://127.0.0.1:27017/?replicaSet=rs0` (override with `MONGODB_URI_TEST`); each test file uses and drops its own throwaway database. |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript across all workspaces |
| `npm run build` | Production bundles (`apps/api/dist`, `apps/web/dist`) |
| `npm run migrate` | Apply pending migrations (`npm run migrate:status -w @mv/api` to inspect) |
| `npm run seed` / `npm run seed:demo` | Idempotent seeding (demo refused when `NODE_ENV=production`) |
| `npm run e2e` | Playwright end-to-end tests against the production build (fresh local `mv_e2e` database; never Atlas) |
| `npm run openapi` | Regenerate [docs/api/openapi.json](docs/api/openapi.json) |

## Repository layout

```
apps/api        Express API: src/core (audit, workflow engine, counters, settings, mail, notifications, scope),
                src/modules/* (auth, users, roles, masters, settings, audit, notifications, dashboard), test/
apps/web        React SPA
packages/shared Permission catalogue, system roles, enums, Zod schemas shared by API and web
docs/           Phase documents, API spec, guides
.github/        CI (lint, typecheck, tests on a MongoDB replica set, audit, secret scan, build) and image release
```

## Security model (summary)

- Short-lived JWT access token in memory + rotating HttpOnly/SameSite=Strict refresh cookie with reuse detection; CSRF double-submit on cookie endpoints.
- Argon2id password hashing; lockout after repeated failures; optional/mandatory TOTP MFA for privileged roles.
- Default-deny RBAC on every endpoint, record-level data scoping (organization / region / site / assignment), anti-privilege-escalation rules.
- Immutable, redacted audit log of security and business events.
- All status changes go through a central workflow engine with permission, state, reason and guard checks.
