# Requirements Traceability Matrix

**Project:** Digital MV Customer Service Management System
**Sources:**
- `HO` = *Site Complaint Management – Developer Handover V2.docx* (v1.0, 10 Nov 2026). This is the primary specification.
- `BRF` = the project brief that the project owner supplied with the handover.

**Phase key:** P2 Foundation · P3 Complaints · P4 Work orders · P5 Field execution · P6 Review · P7 Materials · P8 NCR & acceptance · P9 Reporting & notifications · P10 Hardening & go-live

**Status:** every row was *Planned* at the end of Phase 1. Each phase report records which IDs it delivered and how they were verified. A row only counts as *Done* when its verification passes. See [Phase 2 report §3](../phase-2/phase-2-report.md#3-requirement-status).

Some rows depend on an open decision. For those, the Decision column links to [03-decisions-register.md](03-decisions-register.md).

---

## 1. Authentication and sessions

| ID | Requirement | Source | Phase | Verification | Decision |
|---|---|---|---|---|---|
| AUTH-01 | Secure login by email or username and password. Show lockout and rate-limit messages. | HO §6 AUTH-01; BRF §4 | P2 | API + component tests | |
| AUTH-02 | Forgot and reset password with a single-use, expiring, hashed token. Rate-limited. Responses must not reveal whether an account exists. | HO §9; BRF §4 | P2 | API tests | |
| AUTH-03 | Activate and deactivate accounts. Deactivating an account revokes its sessions immediately. | BRF §4, §6A | P2 | API tests | |
| AUTH-04 | Session management: a short-lived access token plus a rotating refresh token in a cookie that is HttpOnly, Secure and SameSite. Users can log out and can list or revoke their sessions. | HO §10.1, §11 | P2 | API + security tests | |
| AUTH-05 | MFA (TOTP) for privileged accounts when enabled. | BRF §4; HO §10.1 | P2 | API tests | D-21 |
| AUTH-06 | Track user activity and login history, including failed logins. | BRF §4, §6A, §21 | P2 | API tests | |

## 2. RBAC and data scoping

| ID | Requirement | Source | Phase | Verification | Decision |
|---|---|---|---|---|---|
| RBAC-01 | Seed eight system roles: Administrator, Service Supervisor, Field Engineer/Technician, Reviewer/Quality Approver, Storekeeper, Management Viewer, Customer User, Public Reporter (unauthenticated). | HO §3; BRF §4 | P2 | Seed test | D-02 |
| RBAC-02 | Permissions are keys of the form module × action. Actions are create, read, update, submit, approve, return, close, export and administer. | HO §3.1; BRF §6B | P2 | Unit tests | |
| RBAC-03 | Default deny: a user without an explicit grant gets 403 from every protected API. | HO §3.1 | P2 | RBAC security tests | |
| RBAC-04 | A user can hold multiple roles when authorised. Effective permissions are the union of those roles. | HO §3; BRF §6A | P2 | Unit tests | |
| RBAC-05 | Every read and write is scoped by organisation, region, site or assigned work order. This includes list, detail, report and export endpoints, and blocks IDOR. | HO §3.1, §11; BRF §4, §17 | P2 framework; applied in every phase | Cross-scope security tests | |
| RBAC-06 | Separation of duties: nobody approves their own report (BR-012), material request or NCR verification. | HO §3, §3.1 | P6/P7/P8 | Security tests | |
| RBAC-07 | Admin UI to create roles and configure their permissions. | BRF §6B | P2 | Component + E2E | |
| RBAC-08 | Permission and role changes are audited. | HO §11; BRF §21 | P2 | API tests | |

## 3. Master data and configuration

| ID | Requirement | Source | Phase | Verification | Decision |
|---|---|---|---|---|---|
| MD-01 | CRUD for Organisations, Regions, Cities, Sites, Assets and Equipment Types, following the hierarchy Region › City › Site › Asset. | HO §4.9, §8; BRF §6C | P2 | API + E2E | D-04 |
| MD-02 | Request types, priorities and status labels are configurable. | HO §4.9; BRF §6C | P2 | API tests | D-01 |
| MD-03 | Material catalogue and warehouses. | HO §4.9; BRF §6C | P2 (data), P7 (usage) | API tests | D-07 |
| MD-04 | Inspection checklist templates per equipment type, with versions and effective dates. | HO §4.3, §8; BRF §12 | P5 | API + unit tests | D-06 |
| MD-05 | Notification templates. | HO §4.9; BRF §18 | P9 | API tests | |
| MD-06 | Records that transactions reference are deactivated, never hard-deleted (BR-018). | HO BR-018; BRF §6 | P2 | API tests | |
| MD-07 | Bulk-import templates (CSV/XLSX) for master data, with a validation report. | HO §4.9 | P2 | API tests | D-05 |
| MD-08 | An engineer can record a controlled temporary asset, which is then reviewed. | HO §4.3 | P5 | API tests | D-25 |
| CFG-01 | Configurable complaint and work-order numbering: prefix, padding, yearly reset. | BRF §6D | P2 | Unit tests | D-13 |
| CFG-02 | SLA rules per priority: acknowledge, assign, resolve. | BRF §6D; HO §4.2 | P2 config, P4/P9 usage | Unit tests | D-15 |
| CFG-03 | Notification preferences per user and per trigger. | BRF §6D | P9 | API tests | |
| CFG-04 | Limits on attachment type, per-file size and per-record size. | HO §7.1; BRF §6D | P2 | API tests | D-20 |
| CFG-05 | Workflow rules: state machines, the multi-work-order toggle, the concurrent-sequence toggle and approval levels. | BRF §6D, §22 | P2 engine | Unit tests | D-01, D-03 |
| CFG-06 | Application settings: timezone, organisation name, branding. | BRF §6D, §11 | P2 | API tests | D-26 |
| CFG-07 | Only authorised admins can change configuration, and every change is audited. | HO §4.9, §11 | P2 | API tests | |

## 4. UI/UX (applies to every phase)

| ID | Requirement | Source | Phase | Verification |
|---|---|---|---|---|
| UI-01 | Theme of deep navy, royal blue and teal on light grey. Collapsible sidebar, header with notifications and profile, breadcrumbs, consistent status badges. | BRF §3 | P2 | Visual review |
| UI-02 | Responsive at desktop, tablet and phone sizes. Field screens must be usable one-handed on a phone. | HO §6.1; BRF §3 | All | Playwright viewports |
| UI-03 | Dashboard layouts specific to each role. | BRF §3 | P2 shell; filled P4–P9 | E2E |
| UI-04 | Loading, empty, success and error states. Confirmation dialogs for high-impact actions. Inline validation. | HO §6.1, App. B; BRF §3 | All | Component tests |
| UI-05 | Tables support search, advanced filters, sorting, pagination, export and saved views. | HO CMP-01; BRF §3 | P3 | Component tests |
| UI-06 | Target WCAG 2.1 AA for accessibility, including keyboard navigation. | HO §6.1, §10.2 | All | axe checks in E2E |
| UI-07 | Drafts autosave. Draft, Submitted, Returned, Approved and Closed records are clearly distinguished. | HO §6.1 | P5 | Component tests |
| UI-08 | Show timestamps with their timezone, and keep server-recorded times visually distinct from planned dates. | HO §6.1 | All | Component tests |

## 5. Public complaint registration

| ID | Requirement | Source | Phase | Verification | Decision |
|---|---|---|---|---|---|
| PUB-01 | Public, step-based form that needs no login, with every field listed in BRF §5. | HO PUB-01, §4.1; BRF §5 | P3 | E2E | |
| PUB-02 | Cascading dropdowns Region › City › Site › Asset › Equipment, with the relationship re-validated on the server. | HO §4.1; BRF §5 | P3 | API + component tests | |
| PUB-03 | Validate mandatory fields, email and mobile number on the client and the server. | HO §4.1; BRF §5 | P3 | API tests | |
| PUB-04 | Attachments: allow-listed types, MIME and file-signature checks, size limits, malware-scan hook. | HO §7.1; BRF §5, §21 | P3 | Upload security tests | D-20, D-23 |
| PUB-05 | Anti-spam: rate limit, honeypot, minimum fill time, pluggable CAPTCHA. An idempotency key stops accidental double submission. | HO §9.1, §11; BRF §5 | P3 | API tests | D-16 |
| PUB-06 | Warn about possible duplicates at submission and in the review queue. | HO §2.1, §4.1 | P3 | API tests | |
| PUB-07 | Reference `MV-YYYY-000001`, generated atomically on the server from a counter (BR-001). | HO BR-001; BRF §5 | P3 | Concurrency test | D-13 |
| PUB-08 | Confirmation screen showing the reference, received date and contact guidance. | HO PUB-02 | P3 | E2E | |
| PUB-09 | Acknowledgement email with the reference. It never includes internal notes. | HO §4.1; BRF §5 | P3 | Integration test | D-09 |
| PUB-10 | Privacy consent is mandatory and stored with the consent-text version and a timestamp. | BRF §5; HO §4.1 | P3 | API tests | |
| PUB-11 | Record the complaint source: public form, portal or internal entry. | HO §4.1 | P3 | API tests | |

## 6. Complaint management and workflow

| ID | Requirement | Source | Phase | Verification | Decision |
|---|---|---|---|---|---|
| CMP-01 | Complaint queue with filters for status, priority, region, site, received date, due date, owner and an overdue flag. | HO §4.2; BRF §8 | P3 | API + E2E | |
| CMP-02 | Detail page shows customer, organisation, site, equipment, description, priority, dates, owners, attachments, internal notes (internal users only) and activity history. | HO CMP-02; BRF §8 | P3 | E2E | |
| CMP-03 | Review and classify a complaint. It cannot be assigned until intake and classification are complete (BR-002). | HO BR-002 | P3 | Unit + API tests | |
| CMP-04 | Identify and link duplicates. The original is never deleted (BR-003). | HO BR-003; BRF §8 | P3 | API tests | |
| CMP-05 | Request more information, which moves the complaint to *Awaiting Customer Information*. Whether the SLA pauses depends on policy. | HO §5.1; BRF §8 | P3 | API tests | D-15 |
| CMP-06 | Reject or cancel with a mandatory reason and evidence. These statuses are terminal but the record is kept. | HO §5.1; BRF §8 | P3 | API tests | |
| CMP-07 | A customer user sees their own organisation's complaints and can supply information that was requested. | HO §3 | P8 | Security tests | D-02 |
| WF-01 | One state-transition service for complaints, work orders, visits, reports, material requests and NCRs. There is no free-form status update. | BRF §22; HO App. A | P2 engine, used P3+ | Unit tests | D-01 |
| WF-02 | Every transition checks permission, current state, required fields and guard conditions, and is audited (BR-017). | BRF §22; HO BR-017 | P2 | Unit tests | |
| WF-03 | Complaint statuses: New, Under Review, Awaiting Customer Information, Assigned, In Progress, Submitted for Review, Returned for Correction, Approved, Resolved, Customer Acceptance Pending, Customer Accepted, Closed, Duplicate, Rejected, Cancelled, Reopened. | HO App. A; BRF §22 | P3 | Unit tests | D-01 |

## 7. Work orders and supervisor

| ID | Requirement | Source | Phase | Verification | Decision |
|---|---|---|---|---|---|
| WO-01 | Create a work order from a complaint with the fields in BRF §9. | HO WO-01; BRF §9 | P4 | API + E2E | |
| WO-02 | Allow one or many work orders per complaint, depending on configuration (BR-004). | HO BR-004 | P4 | API tests | D-03 |
| WO-03 | Generate the work-order number atomically. | BRF §19 | P4 | Concurrency test | D-13 |
| WO-04 | Assign engineers, and keep assignment history and status history. | HO §4.2; BRF §9 | P4 | API tests | |
| WO-05 | Notify engineers as soon as they are assigned. | HO §4.2; BRF §9 | P4 | Integration test | |
| WO-06 | An engineer accepts assigned work. | BRF §10 | P5 | API tests | |
| SUP-01 | Supervisor dashboard: review queue, workload, overdue items, pending material requests, pending inspections, NCRs. | BRF §7 | P4 (widgets filled through P8) | E2E | |
| SUP-02 | Assignment board with list and calendar views. | HO WO-02; BRF §7 | P4 | E2E | |
| SUP-03 | Workload and ageing indicators, and an overdue flag based on SLA rules. | HO §4.2 | P4 | Unit tests | D-15 |
| SUP-04 | Resolve complaints, and reopen them with a mandatory reason. | BRF §7, §16 | P8 | API tests | |

## 8. Engineer, visits and time tracking

| ID | Requirement | Source | Phase | Verification | Decision |
|---|---|---|---|---|---|
| ENG-01 | Engineer dashboard: assigned work, today's visits, upcoming, overdue, in progress, pending reports, returned reports, pending material requests. | HO ENG-01; BRF §10 | P5 | E2E (mobile viewport) | |
| ENG-02 | Create one or more visits per work order, recording site, date, attendees and purpose. | HO §4.3 | P5 | API tests | |
| ENG-03 | Capture GPS only after an explicit user action and browser permission. Store accuracy and capture time. | HO §4.3; BRF §10 | P5 | Component tests | |
| ENG-04 | Only the assigned engineers or an authorised supervisor can update field records (BR-005). | HO BR-005 | P5 | Security tests | |
| TIME-01 | Exactly six ordered events: Start Travel, Arrive Site, Start Work, End Work, Start Return, Arrive Base. | HO §4.4; BRF §11 | P5 | Unit tests | |
| TIME-02 | The server timestamp, stored in UTC, is authoritative. Client time is kept only as diagnostic metadata. | HO §4.4, BR-010 | P5 | Unit tests | |
| TIME-03 | Reject duplicate and out-of-order events. Use idempotency keys and a unique index. | HO §4.4, §8.2 | P5 | Unit + concurrency tests | |
| TIME-04 | One active sequence per engineer per work order, unless concurrency is configured. | HO §4.4 | P5 | API tests | D-14 |
| TIME-05 | Calculate travel, on-site, return and total durations. Sequences can cross midnight. Display in the configured timezone. | HO §4.4, AC-05 | P5 | Unit tests | D-26 |
| TIME-06 | Time-tracking screen shows the current event, next allowed event, server time, history and durations. | BRF §11; HO VIS-01 | P5 | Component + E2E | |
| TIME-07 | Correction requests: the original stays unchanged; the request records the proposed time, a mandatory reason, and the reviewer's approval or rejection, all audited. | HO §4.4, BR-011, AC-06 | P5 | API tests | |
| TIME-08 | Time events are never hard-deleted. | HO §4.4 | P5 | API tests | |

## 9. Inspections, review and approval

| ID | Requirement | Source | Phase | Verification | Decision |
|---|---|---|---|---|---|
| INSP-01 | Each template item has a description, a mandatory-evidence rule, whether N/A needs a reason, and whether the item is required. | HO §4.3; BRF §12 | P5 | Unit tests | D-06 |
| INSP-02 | Load the correct template version for the equipment type, and snapshot it into the report. | HO §4.3 | P5 | Unit tests | |
| INSP-03 | Results are limited to Pass, Fail, Not Checked and Not Applicable (BR-006). | HO BR-006 | P5 | Unit tests | |
| INSP-04 | Each item can have remarks, photos and documents, linked to the uploader, time, visit and item. | HO §4.3 | P5 | API tests | |
| INSP-05 | Save as draft, preview the report, and submit for review. | HO INSP-01, RPT-01 | P5 | E2E | |
| INSP-06 | Submission rules: Not Checked needs a reason; N/A needs a reason if configured; mandatory evidence is present; required items are complete; time events are complete (BR-007, BR-008). | HO BR-007, BR-008 | P5 | Unit tests | |
| INSP-07 | A submitted revision is immutable. Any correction creates a new revision (BR-009). | HO BR-009 | P5/P6 | Unit tests | |
| REV-01 | Reviewer queue and review screen showing the complaint, work order, visit, checklist, attachments, six events, corrections and NCRs. | HO §4.5; BRF §13 | P6 | E2E | |
| REV-02 | Approve, or return with mandatory comments and item-level feedback. | HO §4.5 | P6 | API tests | |
| REV-03 | An approved version is immutable and records the reviewer, their role and the server time. | HO §4.5 | P6 | API tests | |
| REV-04 | Version history, and side-by-side comparison of revisions. | HO REV-01; BRF §13 | P6 | Component tests | |
| REV-05 | Flag time logs with missing events, abnormal durations or pending corrections. | HO §4.5 | P6 | Unit tests | |
| REV-06 | No self-approval (BR-012). | HO BR-012 | P6 | Security tests | |
| REV-07 | Configurable multi-level approval. | HO §4.5; BRF §13 | P6 | API tests | D-17 |

## 10. Materials and inventory

| ID | Requirement | Source | Phase | Verification | Decision |
|---|---|---|---|---|---|
| MAT-01 | Material request lines: item, code, specification, quantity, unit, urgency and reason, linked to a work order and visit. | HO §4.6; BRF §14 | P7 | API tests | |
| MAT-02 | Supervisor approves, rejects or asks for clarification. Approval does not imply the stock is available. | HO §4.6 | P7 | API tests | |
| MAT-03 | Storekeeper can reserve, issue in full or in part, record a backorder, batch/serial number and recipient, and attach handover evidence. | HO §4.6; BRF §14 | P7 | API tests | |
| MAT-04 | Returns, damaged or unused material, and adjustments, each with a reason. | HO §4.6 | P7 | API tests | |
| MAT-05 | An append-only stock ledger, with balances derived inside transactions. | HO §4.6; BRF §14 | P7 | Stock transaction tests | |
| MAT-06 | Issued quantity cannot exceed the approved quantity without a revised approval (BR-013). | HO BR-013 | P7 | Unit tests | |
| MAT-07 | A storekeeper cannot approve their own request. | HO §3 | P7 | Security tests | |
| MAT-08 | Optional: opening balances, reorder thresholds, valuation. | HO §4.6 | P7 | — | D-07 |

## 11. NCR, customer acceptance and closure

| ID | Requirement | Source | Phase | Verification | Decision |
|---|---|---|---|---|---|
| NCR-01 | Create an NCR linked to a complaint, work order, asset or inspection item, with every field in BRF §15. | HO §4.7; BRF §15 | P8 | API tests | D-08 |
| NCR-02 | Lifecycle: Open → Assigned → Action in Progress → Submitted for Verification → Returned or Verified → Closed. | HO §4.7; BRF §15 | P8 | Unit tests | D-08 |
| NCR-03 | Closure requires verification evidence and an authorised reviewer (BR-014). | HO BR-014 | P8 | NCR verification tests | |
| NCR-04 | Keep comments, revisions and audit history. | HO §4.7 | P8 | API tests | |
| CUS-01 | Secure, expiring, single-purpose token link (stored hashed) and/or the customer portal (BR-015). | HO §4.8, BR-015 | P8 | Security tests | D-02 |
| CUS-02 | Show the reference, work-order summary, completion details, approved report and documents. | BRF §16 | P8 | E2E | |
| CUS-03 | The customer accepts, or rejects and requests further action, with comments and feedback. Record identity, decision and timestamp. | HO §4.8; BRF §16 | P8 | API tests | D-12 |
| CUS-04 | Opening the link or the email never counts as acceptance. Acceptance needs an explicit POST. | HO §4.8, AC-09 | P8 | Security tests | |
| CUS-05 | Closure is blocked until every condition is met: reports approved, time reviewed, material obligations done, NCRs disposed, and acceptance received or waived (BR-016). | HO BR-016; BRF §16 | P8 | Unit tests (AC-10) | D-24 |
| CUS-06 | A closed complaint can be reopened with a mandatory reason and an audit entry. | HO §4.8; BRF §16 | P8 | API tests | |
| CUS-07 | When the customer rejects, a follow-up action or new work order is created. | HO §5.1 | P8 | API tests | D-18 |

## 12. Dashboards, reports and notifications

| ID | Requirement | Source | Phase | Verification | Decision |
|---|---|---|---|---|---|
| DASH-01 | Admin dashboard: 12 KPI cards (BRF §6), all calculated from live data. | BRF §6 | P9 (cards appear as their modules land) | API tests vs. seeded data | |
| DASH-02 | Admin charts: complaints by month, region, priority and status; work orders by engineer; resolution trend; inspection pass/fail; NCR status. | BRF §6 | P9 | Component tests | |
| DASH-03 | Read-only management dashboard with 13 KPIs. | BRF §17; HO §12.1 | P9 | API tests | D-19 |
| REP-01–08 | Reports: Complaint Register, Work Order Status, Visit & Time Log, Inspection, Material Request & Issue, NCR Register, SLA & Ageing, Audit History. | HO §12.2; BRF §17 | P9 | API tests | |
| REP-09 | Filters for date range, region, city, site, customer, engineer, supervisor, priority and status. | BRF §17 | P9 | API tests | |
| REP-10 | Export to XLSX, CSV and PDF. Large exports run asynchronously. | HO §10.2; BRF §17 | P9 | Integration tests | |
| REP-11 | Reports and exports apply permission filtering, and mask personal data for management viewers. | HO §11, AC-11 | P9 | Security tests | |
| REP-12 | Every export is audited. | BRF §21 | P9 | API tests | |
| NOT-01 | In-app notifications, with a header bell and unread count. | BRF §18 | P3 infrastructure, P9 complete | Component tests | |
| NOT-02 | Email through a pluggable provider. A console/file transport is used in development. | HO §10.1 | P3 | Integration tests | D-09 |
| NOT-03 | All 18 notification triggers in BRF §18. | BRF §18; HO §12.3 | Added per phase, P9 complete | Integration tests | |
| NOT-04 | Reusable notification templates with variables. | BRF §18 | P9 | Unit tests | |
| NOT-05 | Scheduled jobs for "due date approaching" and "overdue", with a lock so they run on one instance only. | HO §12.3 | P9 | Unit tests | |
| NOT-06 | SMS and WhatsApp as optional adapters, enabled by configuration. | HO §10.1; BRF §18 | P9 | Unit tests | D-09 |
| NOT-07 | Delivery status, failure reason and retry with backoff. | HO §8 | P9 | Unit tests | |

## 13. Audit, security, API and data

| ID | Requirement | Source | Phase | Verification |
|---|---|---|---|---|
| AUD-01 | Append-only audit log recording user, role, action, entity, before and after values, reason, IP, user agent and server time. | HO §8, §11; BRF §21 | P2 |  API tests |
| AUD-02 | Audit every event listed in BRF §21, including failed logins, permission changes, approvals, corrections, stock movements, exports and configuration changes. | BRF §21 | All | Per-module tests |
| AUD-03 | Audit search screen. Payloads are redacted, and exporting the audit log needs a separate permission. | HO AUD-01, §9.1 | P2 (API), P9 (UI) | Security tests |
| SEC-01 | HTTPS, HSTS and secure headers (helmet), with a strict CSP. | HO §11 | P2, P10 | Header tests |
| SEC-02 | Passwords hashed with Argon2id. | HO §11; BRF §21 | P2 | Unit tests |
| SEC-03 | Rate limiting, globally and per sensitive endpoint. | HO §11 | P2 | API tests |
| SEC-04 | Schema validation and sanitisation (Zod), NoSQL-operator stripping, output encoding and CSRF protection. | HO §11 | P2 | Security tests |
| SEC-05 | Private object storage. Signed download URLs are issued only after a permission check. | HO §7.1; BRF §21 | P3 | Upload security tests |
| SEC-06 | Secrets come from environment variables or a secret store, never the repository. `.env.example` documents them. | HO §11 | P2 | CI secret scan |
| SEC-07 | Dependency and vulnerability scanning in CI. | HO §11 | P2 | CI |
| SEC-08 | API responses never include password hashes, internal notes for unauthorised users, tokens or raw storage paths. | HO §9.1; BRF §20 | All | Serializer tests |
| API-01 | Versioned REST routes under `/api/v1` (BRF §20 list, plus `/public`). | HO §9; BRF §20 | All | Contract tests |
| API-02 | Consistent error format with field-level errors and a request ID. Standard status codes (400/401/403/404/409/429). | HO §9.1 | P2 | API tests |
| API-03 | Pagination with a maximum page size. Filters and sorts come from an allow-list. | HO §9.1 | P2 | API tests |
| API-04 | Idempotency keys for critical writes. | HO §9.1; BRF §20 | P2 infrastructure | API tests |
| API-05 | OpenAPI 3 documentation, generated from the Zod schemas and updated every phase. | BRF §20, §25 | P2 onward | CI check |
| DB-01 | All 24 collections in BRF §19, plus the supporting collections listed in the architecture doc. | BRF §19; HO §8 | Per phase | Schema tests |
| DB-02 | The indexes in HO §8.2, plus any new ones identified in each phase. | HO §8.2 | Per phase | Index test |
| DB-03 | Atomic counters for reference numbers. | HO BR-001 | P3/P4 | Concurrency tests |
| DB-04 | Use transactions for multi-document writes. This requires a replica set. | HO §8, §10.1 | P2 | Integration tests |
| DB-05 | Versioned database migration scripts. | BRF §24 | P2 | CI |
| DB-06 | Seed scripts: roles, admin, sample masters, and demo data for development and UAT only. | BRF §25 | P2 | CI |

## 14. Non-functional, QA and operations

| ID | Requirement | Source | Phase | Verification | Decision |
|---|---|---|---|---|---|
| NFR-01 | 99.5% monthly availability. | HO §10.2 | P10 | Monitoring | D-10 |
| NFR-02 | List and detail API calls return in under 2 s at p95 under the agreed load. | HO §10.2 | P10 | k6 performance test | D-10 |
| NFR-03 | Latest two versions of Chrome, Edge, Firefox and Safari. | HO §10.2 | P10 | Playwright projects | |
| NFR-04 | Retention and archival period. | HO §10.2 | P10 | — | D-10 |
| QA-01 | Unit, API-integration, component and E2E tests, as listed in BRF §23. | BRF §23; HO §13 | Every phase | CI |
| QA-02 | Test scenarios for every role, and E2E journeys from complaint to closure. | BRF §23; HO §13.1 | P10 complete | Playwright |
| QA-03 | Security tests: RBAC bypass, cross-customer access, injection, uploads, sessions. | HO §13.1 | Every phase, P10 full | CI |
| QA-04 | Performance tests. | BRF §23 | P10 | k6 |
| OPS-01 | Three environments: development, staging/UAT and production. | HO §16.1; BRF §24 | P2 config, P10 deploy | — | D-10 |
| OPS-02 | CI/CD with review, tests and a manual approval gate before production. | HO §16.1 | P2 pipeline, P10 deploy | — | |
| OPS-03 | Automated daily backups, plus a restore test before go-live. | HO §10.2, §16.1 | P10 | Restore drill | D-10 |
| OPS-04 | Structured logging, health checks, error tracking and alerting. | HO §10.1 | P2 basic, P10 full | — | |
| OPS-05 | Migration scripts, a release checklist and a rollback procedure. | HO §16.1; BRF §24 | P10 | Rollback rehearsal | |
| DOC-01 | API docs, admin guide, user/training guides per role, and a deployment/backup runbook. | HO §16.2; BRF §25 | API docs every phase; guides P10 | Review | |

## 15. Mapping of acceptance criteria (HO §13.2)

| AC | Covered by |
|---|---|
| AC-01 Public submission | PUB-01…PUB-11 |
| AC-02 Access control | RBAC-01…RBAC-08, SEC-08 |
| AC-03 Work-order assignment | WO-01…WO-05, SUP-02 |
| AC-04 Inspection | INSP-01…INSP-07 |
| AC-05 Time tracking | TIME-01…TIME-06 |
| AC-06 Time correction | TIME-07, TIME-08 |
| AC-07 Report review | REV-01…REV-07 |
| AC-08 Material / NCR | MAT-*, NCR-* |
| AC-09 Customer acceptance | CUS-01…CUS-04 |
| AC-10 Closure | CUS-05, CUS-06 |
| AC-11 Reports | REP-01…REP-12 |
| AC-12 Audit | AUD-01…AUD-03 |
