# Phase 4 Report: Work Orders, Supervisor Dashboard and Engineer Assignment

**Status:** complete, accepted by the project owner on 13 November 2026
**Date:** 13 November 2026

## 1. What was delivered

| Area | Delivered |
|---|---|
| **Work-order creation** (WO-01 to WO-03) | Created from a complaint. The complaint must be classified first (BR-002). One or several work orders per complaint, following the configuration setting (D-03, BR-004). Atomic `WO-YYYY-000001` numbers. Fields: title, description, work scope, priority (defaults to the complaint's), supervisor (defaults to the creator), planned visit start and end, due date (defaults to the complaint's SLA due date), shutdown required with details, materials required with notes. When shutdown or materials are ticked, the details are mandatory. Engineers can optionally be assigned at creation. The location is copied from the complaint for data scoping. |
| **Assignment** (WO-04) | Only active field engineers or technicians can be assigned, with a lead engineer. **Full assignment history** records who was added and removed, the lead, who made the change, when, and the reason. The first assignment moves the work order from *Draft* to *Assigned* and the complaint to *Assigned*, which is an automatic step that re-checks intake and classification. Assigned engineers gain access to the work order and its complaint even outside their usual area; when they are removed, that access is withdrawn. |
| **Notifications** (WO-05) | Assigned engineers get an in-app notice and an email with the site, task, planned visit and due date, plus a shutdown warning when relevant. Removed engineers, the supervisor (on acceptance), and the team (on cancellation or planning changes) also get in-app notices. |
| **Acceptance** (WO-06) | Only an assigned engineer can accept, never a supervisor on their behalf. Each engineer's acceptance is recorded. **Changing the engineers on accepted or scheduled work requires a reason** and sends the work order back to *Assigned* for re-acceptance; this is the new automatic `reassign` step in workflow version 2. |
| **Planning and lifecycle** | Planning fields can be edited until work starts. **Changing a due date requires a reason**, is audited, and notifies the engineers. *Schedule* requires a planned date. *Hold* and *Resume* are optional steps that can be switched off; *Hold* needs a reason. *Cancel* needs a reason, notifies the team, and locks the record. A complaint cannot be cancelled while it has an active work order (the guard added in Phase 3 now applies). |
| **Assignment board** (SUP-02) | **List view:** a workload table per engineer (active work, overdue, planned this week, due in the next 7 days) and a queue of unassigned work with a quick *Assign* button. **Week view:** a grid of engineers against days, with chips coloured by priority, overdue jobs outlined, and multi-day jobs spanning their days, plus a "Not yet planned" list. **Month view.** On a phone, you pick an engineer and the days stack vertically. |
| **Workload and ageing** (SUP-03) | The engineer picker shows each engineer's workload and warns "Outside usual area" when the engineer doesn't normally cover the site. Overdue flags appear on lists, the board and dashboards. |
| **Dashboards** (SUP-01) | **Supervisor:** work-order KPIs (open, unassigned, awaiting acceptance, in progress, overdue) and this week's team workload. **Admin and management:** work-order KPIs and charts by engineer and by status. **Engineer:** a new *My work* dashboard showing jobs awaiting my acceptance (with an inline Accept button), today's visits, the next 7 days, and overdue jobs. |
| **Screens** | Work-order list, with quick tabs for staff and an "Awaiting my acceptance" view for engineers. Work-order detail. Create, assign and edit dialogs. A *Work orders* panel and *Create work order* button on the complaint. Navigation shows *My work orders* for engineers and *Assignment board* for supervisors. |
| **API** | 79 documented paths. New endpoints: `/work-orders/*`, `POST/GET /complaints/:id/work-orders` and `GET /engineer/work-orders` (the paths named in HO §9). Migration `003` creates the `workOrders` indexes from HO §8.2 and adds the `reassign` step to existing workflow definitions without overwriting admin edits. |

## 2. Verification evidence

| Check | Result |
|---|---|
| Type-check and lint, all workspaces | 0 errors |
| Shared package tests | **15 / 15** |
| API integration tests | **126 / 126** (20 new for work orders, including migration 003) |
| Web component tests | **51 / 51** (15 new) |
| Playwright E2E on the production build | **17 / 17** (4 new) |
| Production builds | Succeed |
| Production dependency audit | No new findings; only the known K-01 and K-03 |

**New automated coverage**

- **Creation:** classification is required; numbering and defaults; validation of the details and dates; the single-or-multiple setting; who may create.
- **Assignment:** non-engineers rejected; the lead must be an assignee; the work order and complaint both move to *Assigned*; history recorded; in-app and email notices; engineers gain access, and other regions are blocked.
- **Acceptance:** assignee-only; each engineer recorded; duplicate accepts rejected; supervisors can't accept on an engineer's behalf.
- **Reassignment and lifecycle:** reassigning needs a reason and requires re-acceptance; removed engineers are notified and lose access; *Schedule* needs a planned date; *Cancel* needs a reason, notifies the team and locks the record.
- **Planning edits:** a due-date change needs a reason, is audited and notifies the engineers; engineers cannot edit planning.
- **Board data:** the calendar range (including multi-day jobs), the unplanned list and the 92-day range limit; workload and site-coverage flags; the overdue filter and summary.
- **Complaint integration:** the complaint lists its work orders for staff only; it cannot be cancelled while a work order is active; the migration upgrades an older database exactly once and keeps admin edits.
- **Browser:**
  - A supervisor classifies a complaint, creates a work order with a planned visit and assigns `engineer1`; the complaint shows *Assigned*.
  - `engineer1` accepts from the dashboard.
  - An engineer from another region gets *not found*.
  - The job appears on the supervisor's week board and opens the work order.

**Fixed during verification**

- **Work-order details lacked the asset code and equipment type.** Both are now shown, because engineers need them on site.
- **Clearer error when no classification exists:** creating a work order for an unclassified complaint now says "classify it first" instead of giving a generic status error.
- **Test stability:** the browser test now waits for the accept request to finish, and the per-test timeout is 60 seconds.

## 3. Requirement status

| Status | IDs |
|---|---|
| **Done in Phase 4** | WO-01 to WO-06; SUP-01 (the work-order and complaint widgets); SUP-02; SUP-03; DB-03 (work-order numbers); the work-order parts of DASH-01 and DASH-02; NOT-03 for *work order created/assigned* and *engineer assigned* |
| **Partly done, continues in Phase 5** | ENG-01: the engineer dashboard has work-order lists now; visits, time events and pending reports arrive in Phase 5 |

## 4. Walkthrough (demo script)

1. Sign in as `supervisor@example.com`. Open a demo complaint, such as Hillcrest Water Works ("SF6 low-pressure alarm").
2. Classify it as *High*. Notice that **Create work order** appears.
3. Create a work order: set a planned visit for tomorrow at 09:00, tick *Shutdown required* (the details become mandatory), and pick **Eli Engineer**. Note his workload counts. Notice the "Outside usual area" warning on Erin Engineer, who covers the South region.
4. The work order opens in *Assigned*. The complaint is now *Assigned* too, and its *Work orders* panel lists the job. An email for Eli is written to `apps/api/var/mail`.
5. Sign in as `engineer1@example.com`. *My work* shows the job under **Awaiting my acceptance**. Click **Accept**.
6. As the supervisor, open **Assignment board → Week**. The job sits on Eli's row tomorrow. Try **Month**, and **List** for the workload table and the unassigned queue.
7. Reassign the job to Erin. You must give a reason, the job returns to *Assigned*, Eli gets a "removed" notice, and the assignment history shows the change.
8. Change the due date and see that a reason is required. Then cancel the work order and see that a reason is required and the team is notified.
9. Try to cancel the complaint while another work order is still active. It is blocked.

## 5. Open items

- **Engineers' work orders on a phone.** The board's phone view works by picking an engineer. A fuller mobile workflow for engineers arrives in Phase 5, with visits and time tracking.
- **D-32** (Turnstile keys), **K-01** (Zod upgrade before go-live), and connecting Atlas (`apps/api/.env`; run `npm run migrate` to apply migrations 002 and 003).

## 6. Next phase (on acceptance)

**Phase 5: engineer dashboard, site visits, six-step time tracking and inspections.** This covers:

- visits against a work order, with GPS captured only with the engineer's permission
- the six time events in strict order, timed by the server in UTC and shown in local time; visits that cross midnight work, and only one active sequence at a time (D-14)
- the time-correction request and approval workflow
- versioned inspection checklist templates per equipment type (D-06: real checklists are still needed)
- inspection results (Pass / Fail / Not Checked / Not Applicable) with evidence, draft and preview, submission rules, and records that can't be changed once submitted
- temporary assets recorded in the field (D-25)
