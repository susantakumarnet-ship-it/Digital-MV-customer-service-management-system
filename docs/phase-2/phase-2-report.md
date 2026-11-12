# Phase 2 Report: Foundation (UI/UX, Authentication, RBAC, Master Data)

**Status:** complete, accepted by the project owner on 12 November 2026
**Date:** 12 November 2026

## 1. What was delivered

| Area | Delivered |
|---|---|
| **Repository and tooling** | npm-workspaces monorepo: `apps/api`, `apps/web`, `packages/shared`. TypeScript strict mode, ESLint, Prettier. |
| **Authentication** | Sign-in by email or username. Lockout after 5 failures for 15 minutes (configurable). Short-lived access token, plus a rotating HttpOnly/SameSite=Strict refresh cookie with reuse (theft) detection. CSRF double-submit protection. Idle and absolute session timeouts. Logout, sign-out-everywhere, and listing and revoking sessions. Forgot/reset password and account activation, using single-use hashed tokens. Forced password change. TOTP MFA with recovery codes, which can be made mandatory for Administrator, Supervisor and Reviewer. Argon2id password hashing. |
| **RBAC** | Catalogue of 79 permission keys. 8 system roles, including the non-assignable Public Reporter. Custom roles with a permission matrix. Default deny on every endpoint. Multiple roles per user. Data scope by organisation, region and site, or global. Anti-escalation rules: you cannot grant roles, permissions or scope you don't hold. Last-administrator protection. The Administrator role always keeps a minimum set of permissions. Customer users are locked to their own organisation. |
| **Master data** | Organisations, regions, cities, sites, equipment types, assets, request types, priorities with SLA hours, warehouses, and the material catalogue. One generic API and admin UI drive all of them. Codes are unique regardless of case. Parent references are validated. Region and organisation are derived automatically from the parent hierarchy and cascade when it changes. Records are deactivated, never deleted, and a parent with active children cannot be deactivated. Bulk import from CSV/XLSX runs as a dry-run validation report, then an all-or-nothing commit. |
| **Configuration** | Seven validated settings groups: general/timezone, numbering, workflow rules, attachments, security, notifications and the public form. All changes are audited. |
| **Workflow engine** | A central state-transition service with definitions for all six entities from Appendix A: complaint, work order, visit, inspection report, material request and NCR. Each transition checks the permission, the current state, any mandatory reason and named guards, which fail closed. Every transition is audited. Admins can rename states and switch optional transitions on or off; mandatory rules cannot be edited. |
| **Audit** | An append-only audit log that the application cannot update or delete. Secrets are redacted. Each entry records actor, role, IP, user agent, request ID, before/after values and reason. There is a searchable audit screen. |
| **Reference numbers** | Atomic, configurable counters in the format `MV-YYYY-000001`. A test confirms 50 concurrent requests receive 50 unique, gap-free numbers. |
| **Notifications** | In-app notifications with a header bell and a notifications page. Email goes through a pluggable provider: `.eml` files in development, SMTP in production. |
| **Web app** | Navy, royal-blue and teal theme. Collapsible sidebar and mobile drawer, breadcrumbs, a role-specific dashboard (the admin dashboard shows only live database figures), admin screens for everything above, and a Profile & Security page. Every screen has loading, empty, error and success states. High-impact actions have confirmation dialogs. |
| **API documentation** | OpenAPI 3, generated from the same route definitions that enforce validation and permissions: 52 paths. Swagger UI at `/api/v1/docs`; the static file is [docs/api/openapi.json](../api/openapi.json). |
| **Data operations** | Versioned migrations (`npm run migrate`). Idempotent seeds: system roles, workflows, settings, first administrator, and optional demo data that is refused in production. |
| **DevOps** | CI: lint, typecheck, tests on a MongoDB replica set, Playwright E2E, `npm audit`, secret scan and build. An image release workflow (staging on `main`, production on tags behind an approval gate). Dockerfiles, nginx config, and a production-like `docker-compose.yml`. |

## 2. Verification evidence

| Check | Result |
|---|---|
| `npm run typecheck` (all workspaces) | 0 errors |
| `npm run lint` | 0 errors (21 warnings: deliberate `any` at database and test boundaries) |
| Shared package tests | **15 / 15** passed |
| API integration tests (real MongoDB replica set, throwaway database per file) | **65 / 65** passed |
| Web component tests | **25 / 25** passed |
| Playwright E2E against the production build (Chromium desktop + Pixel 7) | **7 / 7** passed |
| Production builds (`apps/api/dist`, `apps/web/dist`) | Succeed |
| Manual smoke test of the running API | Health and readiness OK (replica set detected). Login, permission denial and the forced password change behave as specified. |

**What the automated tests cover**

- **Authentication:** lockout; no account enumeration; refresh rotation and theft detection; immediate effect of logout and deactivation; idle timeout; single-use reset tokens; MFA enrolment, challenge and single-use recovery codes; mandatory-MFA policy.
- **RBAC:** default deny for an empty role; engineer and management restrictions; union of roles; inactive roles granting nothing; both kinds of anti-escalation; the administrator permission floor; last-admin and self-deactivation protection; customer-role rules; scoped admin visibility; IDOR attempts returning 404.
- **Master data:** derived fields; spoofed derived fields ignored; case-insensitive duplicates; invalid and inactive references; parent filters; deactivation rules and reason; cascades; import dry run, commit and errors; the organisations alias.
- **Core services:** counter concurrency and rollback; audit immutability and redaction; workflow engine (valid, wrong-state, forbidden, missing reason, unknown action, system-only, fail-closed guard, registered guard); workflow configuration limits; settings validation, audit and public subset.
- **API conventions:** error shape and request ID; NoSQL operator stripping; no password hashes or secrets in responses; page-size cap; security headers; OpenAPI generation; seed idempotency.
- **Browser (E2E):** invalid credentials; forced first-login password change leading to an admin dashboard with real counts and the in-app security notice; create region, duplicate code shown on the field, deactivation of a region with children blocked, no delete; engineer has no admin menu and is refused admin URLs; session survives reload and ends at sign-out; WCAG 2 A/AA axe scan of the login page; no horizontal scrolling on a phone.

**Defects found and fixed during verification**

- **Admins couldn't create customer users.** The Administrator role lacked `acceptance.decide`, so the anti-escalation rule blocked it. Administrator now holds every permission. Acting *as* a customer will additionally be bound to customer identity or an acceptance token in Phase 8.
- **`?includeInactive=false` was read as true.** Query booleans now parse strictly.
- **Import errors were less specific than they should be.** A row's specific error (for example "No region with code ZZZ") was being overwritten by a generic "Required".
- **The profile page couldn't show the user's phone number.** It is now returned by `/auth/me`.
- **OpenAPI generation failed.** Zod needed the OpenAPI extension.
- **Some grey text failed WCAG AA contrast (4.35:1).** The secondary text colour was darkened app-wide to about 5.4:1.
- **The API crashed silently when its port was taken.** It now exits with a clear message.

## 3. Requirement status

| Status | Requirement IDs |
|---|---|
| **Done in Phase 2** | AUTH-01 to AUTH-06; RBAC-01 to RBAC-05, RBAC-07, RBAC-08; MD-01 to MD-03, MD-06, MD-07; CFG-01, CFG-02 (configuration), CFG-04 (configuration), CFG-05 (engine), CFG-06, CFG-07; UI-01, UI-03 (shell), UI-04, UI-05 (tables); WF-01, WF-02; AUD-01, AUD-03 (API and UI); SEC-01 to SEC-04, SEC-06, SEC-07, SEC-08; API-01 to API-03, API-05; DB-03 (counters), DB-04, DB-05, DB-06; NOT-01 (infrastructure), NOT-02 (provider); OPS-02 (pipeline); OPS-04 (logging, health checks) |
| **Infrastructure ready, used in later phases** | RBAC-06 (separation-of-duty guards, P6–P8); API-04 (idempotency keys, P3); UI-02, UI-06, UI-08 (applied to every new screen); AUD-02 (each module adds its events) |
| **Planned** | All Phase 3–10 IDs, as listed in the traceability matrix |

## 4. Environment and configuration notes

- **Database (D-28).** The application is set up for your Atlas database `MVServiceMgmt`, but the connection string must still be entered in `apps/api/.env` (`MONGODB_URI`). Atlas must also allow this machine's IP under Network Access. After that, run `npm run migrate` and then `npm run seed` (or `npm run seed:demo` for demo users). Automated tests never use Atlas: they create and drop their own local databases.
- **Local ports.** Ports 4000, 4100 and 5173 are already used on this machine by other projects (`C:\Tutorial management`, `C:\BAPIN GARMENTS` and an app on 4000). This project therefore uses **API 4610**, **web 5610**, and **5611** for the E2E preview server. All three can be changed through `PORT` and the Vite config.
- **First administrator.** Username `admin`. The initial password is `SEED_ADMIN_PASSWORD` in `apps/api/.env` (randomly generated for you), and it must be changed at first sign-in.
- **Demo users** (only after `npm run seed:demo`): `supervisor@example.com`, `engineer1@example.com`, `engineer2@example.com`, `reviewer@example.com`, `storekeeper@example.com`, `management@example.com` and `customer@example.com`. They share the password in `SEED_DEMO_PASSWORD`.

## 5. Phase 2 walkthrough (demo script)

1. Start the app with `npm run dev` and open http://localhost:5610.
2. Sign in with a wrong password. You see a generic error, and the attempt appears in the Audit Log as `auth.login.failure`.
3. Sign in as `admin`. You are forced to change the password. The dashboard then shows live user counts, the sign-in trend and the Operational modules panel. The bell shows the "Your password was changed" notice.
4. **Master Data → Regions:** create a region. Try the same code again in lower case and see the error on the Code field. Try to deactivate *North Region* and see it blocked because it has active cities.
5. **Master Data → Cities → Import:** download the template, upload a file containing one bad region code, review the per-row errors, fix the file, and commit.
6. **Users → New user:** create an engineer with the North region in scope and no password, so an activation email is written to `apps/api/var/mail`. Open the link from the `.eml` file to set the password.
7. **Roles & Permissions:** create a custom role. Note that permissions you don't hold are locked.
8. **Configuration → Security:** turn on *MFA required for privileged roles*. Sign in as `supervisor@example.com` and you are taken to MFA setup (QR code, then recovery codes).
9. **Workflows → Work order:** rename *On Hold* and disable the optional *Put on hold* transition, giving a reason. Mandatory transitions cannot be disabled.
10. Sign in as `engineer1@example.com`. There is no administration menu, `/admin/users` shows *no access*, and the dashboard shows the engineer's scope and what will arrive in Phase 5.
11. **Audit Log:** filter by entity type and open an entry to see before/after values and request metadata.
12. Open the API documentation at http://localhost:4610/api/v1/docs.

## 6. Open items for the project owner

- **New decisions:** D-28 is confirmed. D-29 (are approval comments mandatory?) and D-30 (should supervisors see the user list?) are open. See the [decisions register](../phase-1/03-decisions-register.md).
- **Known issues K-01 to K-05.** K-01 is a high-severity Zod 3 advisory, mitigated by size caps and scheduled to be fixed before go-live. K-02 (React Router) is resolved: upgraded to v7.
- **Still open from Phase 1:** D-01 (sign-off of the status transition matrix) is required by the end of Phase 3. D-13 (complaint reference format) and D-20 (attachment types and limits) are needed for Phase 3.

## 7. Next phase (on acceptance)

**Phase 3: public complaint registration and complaint management.** This covers:

- the public step-based form with cascading Region › City › Site › Asset › Equipment selection
- anti-spam controls and an idempotent submission
- atomic `MV-YYYY-000001` references and the acknowledgement email
- private file storage with signed URLs
- the complaint queue and detail screens
- classification, duplicate linking, information requests, rejection and cancellation through the workflow engine
- Phase 3 tests and documentation
