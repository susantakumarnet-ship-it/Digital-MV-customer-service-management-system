# Phase 6 Report: Review, Approval and Report Versioning

**Status:** complete, accepted by the project owner on 13 November 2026
**Date:** 13 November 2026

## 1. What was delivered

| Area | Delivered |
|---|---|
| **Review queue** (REV-01) | Shows reports that are submitted or under review, within the reviewer's data scope. Tabs: Pending, Under review, Returned, Approved and All, plus "Reviewed by me" and search. Each row shows the work order, complaint, visit, site, checklist version, revision (marked *resubmitted* from revision 2 on), who submitted it and when, how long it has waited (amber after 24 hours, red after 48), the Fail and Not Checked counts, and approval progress ("1 of 2"). Reports the reviewer worked on are marked "Your report, cannot review". |
| **Review workspace** (REV-01) | Everything for one report on one screen:<br>• the read-only checklist, grouped by section, with remarks, reasons and evidence, plus filters for Fail, Not checked and items with feedback<br>• findings<br>• every engineer's six-step time log, showing the original time crossed out next to any approved correction, and their durations<br>• **time-log warnings**<br>• corrections (pending ones link to the visit, where they're decided)<br>• the work order and complaint context<br>• the list of revisions, and the review history<br>The actions bar stays fixed at the bottom of the screen on a phone. |
| **Time-log warnings** (REV-05) | Missing steps (red when Arrive, Start Work or End Work is missing), long travel, long or very short on-site work (all three thresholds are configurable in Workflow settings), a phone clock more than 10 minutes off the server time, approved corrections, and corrections still pending. These are warnings for the reviewer and never block approval on their own. |
| **No self-review** (BR-012) | Anyone who submitted the report, or who was an engineer on that visit, cannot start the review, approve or return it, even if they also hold the Reviewer role. The screen explains why. This can be overridden only through the *allow self-approval* setting. |
| **Approve** (REV-02/03, D-29) | Comments are optional. Approval locks the report permanently. The work order moves to *Approved* once none of its reports is still open, and the complaint moves to *Approved* once every active work order is approved. The engineers and the supervisor are notified. |
| **Multi-level approval** (D-17) | Configurable as 1 to 3 levels (default 1). Each level must be approved by a different reviewer. Approvals before the last level are recorded while the report stays *Under Review*, and the remaining reviewers are notified. |
| **Return for correction** (REV-02, INSP-07, BR-009) | Comments are mandatory, and feedback can be added for individual checklist items. Returning creates **the next draft revision**, with the previous answers and evidence carried over, for the engineers to correct. The returned revision stays unchanged and is marked *Superseded*. The work order goes back to *In Progress* and the complaint to *Returned for Correction*, and the engineers are notified. When the engineer opens the new draft, they see the reviewer's comments as a banner and the item feedback on each item. Resubmitting moves the work order and complaint back to review. |
| **Revision history and comparison** (REV-04) | A list of all revisions of a report. The comparison view shows, item by item, what changed between two revisions (result, remarks, reason and evidence) alongside the reviewer's feedback; unchanged items are collapsed. |
| **Review record** (REV-03) | Every review action (start, approve with its level, return) is stored in the new `reviewActions` collection with the reviewer, their roles, the time, comments and item feedback. These records cannot be changed. Each action is also in the audit log. |
| **Dashboards** | **Reviewer dashboard:** exact counts for pending, under review, waiting more than 24 hours (and more than 48), and approved this week, from `/reviews/summary`. It also lists the oldest pending reports and pending time corrections. Supervisors see how many reports are awaiting review. Engineers get a "Returned for correction" list. |
| **API** | 107 documented paths. New: `/reviews`, `/reviews/summary`, `/reviews/:id`, `POST /inspection-reports/:id/review-actions` (the HO §9 path), `/inspection-reports/:id/revisions` and `/inspection-reports/:id/compare`. Migration `005` adds the `reviewActions` collection. |

## 2. Verification evidence

| Check | Result |
|---|---|
| Type-check and lint, all workspaces | 0 errors |
| Shared package tests | **15 / 15** |
| API integration tests | **157 / 157** (7 new in Phase 6) |
| Web component tests | **78 / 78** (10 new) |
| Playwright E2E on the production build, desktop and phone | **27 / 27** (5 new) |
| Production builds | Succeed |
| Live instance | Updated: migration 005 applied to the local `MVServiceMgmt` database; new routes are live at http://localhost:5610 |

**Browser journey (new):**
- The reviewer sees both submitted reports in the queue and approves one; its work order shows *Approved*.
- The reviewer returns the other with item feedback.
- The engineer opens revision 2, sees the reviewer's comments and the item feedback, and resubmits.
- The reviewer sees revision 2 back in the queue and opens the comparison view.
- The engineer who did the work cannot approve it.

**Fixed during Phase 6 verification**

- **Administrators were listed as engineers.** They appeared on the assignment board and in the engineer pickers because the Administrator role holds every permission. Only roles meant for field work count as engineers now.
- **Exact reviewer figures.** The reviewer dashboard's "waiting more than 24 hours" and "approved this week" were estimates; a new server-side summary makes them exact.
- **Configurable login limit.** The per-address sign-in limit (20 attempts per 15 minutes) correctly blocked the test suite once it signed in more than a real user would. The limit is now set by `LOGIN_RATE_LIMIT_PER_15_MIN` (production default 20, unchanged) and raised only for the test harness. The browser screenshots confirm the limit and its message work as intended.
- **Live app and tests can run together.** The test harness now uses its own API port (4710), so the live app on 4610 can keep running during test runs.

## 3. Requirement status

| Status | IDs |
|---|---|
| **Done in Phase 6** | REV-01 to REV-07; RBAC-06 (report part); INSP-07 (new revision on return); the *report submitted, approved, returned* triggers of NOT-03 |
| **Carried forward** | NCR information in the review workspace: placeholder until Phase 8 |

## 4. Walkthrough

1. As an engineer, submit an inspection report (see the Phase 5 walkthrough).
2. Sign in as `reviewer@example.com`. The dashboard shows the pending count, and **Reviews** opens the queue.
3. Open the report. Check the time-log warnings, the corrections and the evidence. Click **Add feedback** on an item, then **Return for correction** and enter what must be fixed.
4. As the engineer, open the dashboard's **Returned for correction** list. The new revision shows the reviewer's comments as a banner and the item feedback on the item. Fix it and resubmit.
5. As the reviewer, use **Compare** to see what changed, then **Approve**. The work order and complaint move to *Approved*.
6. Optional: set **Configuration → Workflow → approval levels** to 2. A second, different reviewer must now give the final approval.
7. As the engineer, open `/reviews/<id>` for your own report. No review actions are offered, and the screen explains why.

## 5. Open items

- **D-06:** real checklists still to be supplied; the SAMPLE templates are in use.
- **Atlas (D-28):** the connection string is still needed in `apps/api/.env`; the live instance uses the local database.
- **K-01** (Zod upgrade before go-live) and **D-32** (Turnstile keys).

## 6. Next phase (on acceptance)

**Phase 7: material requests and inventory.**

- **Requests:** engineers raise material requests linked to the work order and visit.
- **Supervisor decision:** approve, reject or ask for clarification. Approval does not imply the stock is available.
- **Storekeeper:** reserve and issue stock (full or partial), record backorders, batch and serial numbers, who received it and proof of handover, and handle returns and damaged or unused items.
- **Records:** a stock ledger whose entries can't be changed, and a running stock balance per warehouse.
- **Rules:**
  - nobody can issue more than was approved without a revised approval (BR-013)
  - a storekeeper can't approve their own request
  - the inventory scope must be confirmed (D-07)
