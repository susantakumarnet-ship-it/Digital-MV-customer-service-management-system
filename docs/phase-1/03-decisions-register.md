# Decisions Register

The handover document marks some items "Confirm", and the project brief (§27.13) says they must not be decided silently. This register lists each of them, along with gaps and contradictions found during analysis.

Each decision has a **provisional default**: what gets built unless the project owner says otherwise. Wherever practical, that default is *configurable*, so changing the answer later means changing configuration, not rework.

The **Needed by** column is the latest phase that can proceed on the provisional default. After that, the answer becomes blocking.

| Status | Meaning |
|---|---|
| Open | No answer yet. The provisional default applies. |
| Confirmed | The project owner has answered. The answer is recorded in the table. |
| Superseded | Replaced by a later decision. |

---

| ID | Decision | Provisional default (configurable where noted) | Needed by | Status |
|---|---|---|---|---|
| D-01 | Final lifecycle, status labels and transition matrix for every entity (HO §17, App. A). | Seed the statuses in HO App. A, plus the BRF §22 lifecycle with *Duplicate* added as a complaint status. Labels and optional transitions are **configurable**. **A signed transition matrix is needed.** | End of P3 | Open |
| D-02 | Customer portal: do customers log in, track complaints and accept through a portal, or only through a secure link? | **Both.** A Customer User role with a portal and dashboard (scoped to their own organisation), plus expiring, single-use acceptance links for customers without an account. | P2 (auth model) | Confirmed 2026-11-12 |
| D-03 | Complaint-to-work-order cardinality (BR-004). | **Many per complaint by default.** An admin setting can limit it to one. Closure requires every work order to be complete or cancelled. | P4 | Confirmed 2026-11-12 |
| D-04 | What "MV" means, asset classes, mandatory identifiers, and whether *Asset* and *Equipment* are separate levels in the hierarchy. | MV means medium-voltage. Hierarchy is Region › City › Site › Asset, where each asset has an Equipment Type. The public form's "Equipment" dropdown is the equipment type, filtered by the selected asset. | P2 | Open |
| D-05 | Master data (regions, cities, sites, assets, customers): source lists, owners and import format. | CSV/XLSX import templates are provided in P2. Demo data is used until real data arrives. **Real data is needed before UAT.** | P10 (UAT) | Open |
| D-06 | Inspection checklists per equipment type, pass/fail criteria, and the report layout. | One sample template per seeded equipment type. Templates are fully **configurable** by admins. **Real checklists are needed before P5 sign-off.** | P5 | Open |
| D-07 | Inventory scope: full stock accounting or request tracking only? Also units, number of warehouses, approval limits, opening balances, reorder levels, valuation. | Full ledger, multiple warehouses, receipt/opening-balance transactions, reorder threshold shown as a warning. **No valuation** (out of scope unless approved). | P7 | Open |
| D-08 | NCR categories, severities, owners, required approvals and final status labels. | **Configurable** category and severity lists, and the BRF §15 lifecycle. A Reviewer/Quality Approver verifies. | P8 | Open |
| D-09 | Notification providers: email service, and SMS/WhatsApp provider and budget. | SMTP adapter, with dev file transport. SMS and WhatsApp are **disabled adapters** behind configuration flags, and a Twilio adapter is written only if approved. | P9 | Open |
| D-10 | Hosting provider, data residency, expected users and volumes, RPO/RTO, retention period. | Cloud-agnostic Docker images, S3-compatible storage, managed MongoDB replica set. Proposed RPO 24 h (daily backup plus PITR where available) and RTO 8 h. | P10 | Open |
| D-11 | Interface languages. | English only. UI text is kept in one place so translation can be added later. | P10 | Open |
| D-12 | Is a legally binding e-signature needed for approvals or customer acceptance? | No. The approval record is the user's identity, the server timestamp, the action and the IP/user agent (HO §2.2). | P8 | Open |
| D-13 | **Contradiction:** HO §4.1 says the complaint reference is "non-sequential", but the example and the BRF give the sequential format `MV-YYYY-000001`. Prefixes for other documents are also needed. | Follow the brief: sequential per year, `MV-YYYY-000001`, generated atomically. Note that sequential numbers reveal complaint volume. Other prefixes: `WO-`, `VIS-`, `MR-`, `NCR-` + `YYYY-000001`. Format is **configurable**. | P3 | Open |
| D-14 | Time-tracking exceptions: breaks, several engineers on one visit, shared visits, overnight work, offline sites. | One sequence of six events per engineer per visit, so several engineers on a visit each record their own sequence. No break events. Online only (offline is out of scope, HO §2.3). One active sequence per engineer, **configurable**. | P5 | Open |
| D-15 | SLA rules per priority, and whether the SLA pauses while *Awaiting Customer Information*. | SLA targets (acknowledge, assign, resolve) are **configurable** per priority. Placeholders: Critical 4h/8h/24h, High 8h/24h/72h, Medium 24h/48h/7d, Low 48h/72h/14d. Pausing is **off** by default and can be switched on. | P4 | Open |
| D-16 | CAPTCHA for the public form. | Honeypot field, minimum fill time and per-IP rate limit. A **pluggable** CAPTCHA (Cloudflare Turnstile or reCAPTCHA) is switched on when keys are provided. | P10 | Open |
| D-17 | Number of approval levels for inspection reports. | One level, with a **configurable** number of levels (each level needs a different reviewer). | P6 | Open |
| D-18 | What happens when the customer rejects the service. | The complaint returns to *Reopened*, and the supervisor must create a follow-up work order or record a resolution note before requesting acceptance again. | P8 | Open |
| D-19 | KPI definitions: acknowledgement time, first-time fix, repeat complaint, engineer utilisation. | Ack = first transition out of *New*. First-time fix = closed with one visit and no reopen. Repeat = same asset within 30 days (**configurable**). Utilisation = on-site work hours ÷ configured available hours. | P9 | Open |
| D-20 | Allowed attachment types and size limits. | JPG, PNG, HEIC, PDF, DOCX, XLSX. 10 MB per file, 10 files and 50 MB per record (**configurable**). | P3 | Open |
| D-21 | MFA method and which roles must use it. | TOTP authenticator app, with recovery codes. A setting can make it mandatory for Administrator, Supervisor and Reviewer. Off by default in development. | P2 | Open |
| D-22 | Migrating legacy complaints or records. | No migration of historical data. Master data is imported only. | P10 | Open |
| D-23 | Malware scanning of uploads. | ClamAV hook, enabled when a ClamAV host is configured. Files stay in *pending scan* until they are scanned clean, if scanning is enabled. | P10 | Open |
| D-24 | Who can waive customer acceptance, and what evidence the waiver needs. | Needs the `complaint.acceptance.waive` permission (held by the Supervisor role), a mandatory reason, and an optional attachment. | P8 | Open |
| D-25 | Who reviews temporary assets recorded in the field. | A supervisor approves them, which promotes the record into the asset master, or rejects them. | P5 | Open |
| D-26 | Local timezone for display. | **Configurable** system timezone. Placeholder `UTC` until confirmed. Users can override it in their profile. | P2 | Open |
| D-27 | **Environment:** the local MongoDB 9.0.2 service runs *standalone*, and transactions need a replica set. | **Convert the local service to a single-node replica set `rs0`.** Staging and production also run as replica sets. | P2 | Confirmed 2026-11-12 |

| D-28 | Which database the application uses. | **MongoDB Atlas, database `MVServiceMgmt`** (project-owner instruction, 2026-11-12). The connection string goes only in `apps/api/.env`, never in git. Automated tests run against the local `rs0` replica set using throwaway databases, so they never touch Atlas data. Atlas must allow this machine's IP in its Network Access list. | P2 | Confirmed 2026-11-12 |

| D-29 | Whether comments are mandatory when a reviewer *approves* a report. HO §4.5 says "approve or return… with mandatory comments", which can be read either way. | Comments are mandatory when returning a report and optional when approving. | P6 | Open |
| D-30 | Whether a Service Supervisor needs to see the user directory, to pick engineers for assignment. | Yes. The Supervisor role has `user.read`, but no user-management permissions. | P4 | Open |

## Known issues and security register

These are tracked items found during delivery. Each must be closed, or explicitly accepted by the project owner, before production go-live (Phase 10).

| ID | Item | Severity | Mitigation now | Planned action |
|---|---|---|---|---|
| K-01 | `zod` 3.x advisory: oversized constrained collections can exhaust memory during validation. Production dependency; also reaches us through `@asteasolutions/zod-to-openapi`. | High (npm audit) | Every array schema has a `.max()` cap, and JSON bodies are limited to 1 MB by Express. | Migrate to Zod 4, zod-to-openapi v8+ and @hookform/resolvers v5. Phase 10 at the latest. |
| K-02 | `react-router-dom` 6 advisory: open redirect via a backslash in `<Link>` or `navigate`. | Moderate | — | **Resolved 2026-11-12:** upgraded to react-router-dom v7.18. |
| K-03 | `exceljs` → `uuid` < 11.1.1 advisory: missing bounds check when a caller supplies a buffer. | Moderate | Not reachable: exceljs does not pass caller buffers. | Monitor; upgrade exceljs when a fixed release exists. |
| K-04 | The rate limiter keeps its counters in each server process's memory. | Low | Correct for a single API instance. | Move to a shared store when scaling beyond one instance (D-10). |
| K-05 | Docker images and `docker-compose.yml` have not been built locally, because Docker isn't installed on the development machine. | Low | CI builds the images on every push. | Verify in Phase 10, during staging deployment. |

## Change log

| Date | Change |
|---|---|
| 2026-11-12 | Register created in Phase 1. |
| 2026-11-12 | D-02, D-03 and D-27 confirmed. The project owner accepted Phase 1. |
| 2026-11-12 | Phase 2: added D-28 (Atlas database), D-29, D-30 and the known-issues register (K-01 to K-05). Nodemailer upgraded to v10 to clear its high-severity advisories. |
