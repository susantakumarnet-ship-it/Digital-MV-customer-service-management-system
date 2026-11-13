# Phase 5 Report: Site Visits, Six-Step Time Tracking and Inspections

**Status:** complete, accepted by the project owner on 13 November 2026
**Date:** 13 November 2026

## 1. What was delivered

| Area | Delivered |
|---|---|
| **Site visits** (ENG-02) | A visit is created against a work order once the work has been accepted, with a purpose, planned time, participating engineers (who must be assigned to the work order), other attendees and notes. Visits are numbered `VIS-YYYY-000001`. Only the visit's engineers, or supervisors allowed to update work orders, can change field records (BR-005). A planned visit can be cancelled with a reason. |
| **Six-step time tracking** (TIME-01..06, BR-010) | The six events are Start Travel from Base, Arrive at Site, Start Work at Site, End Work at Site, Start Return Travel and Arrive at Base.<br>• **Order and duplicates:** strict order; out-of-order and duplicate events are refused, and a database constraint keeps duplicates impossible even when two taps arrive at once. A retried tap is safe.<br>• **Time and location:** the server clock is authoritative and stored in UTC; the phone's clock and GPS are kept for diagnosis only. GPS is captured only when the engineer switches it on and the browser allows it.<br>• **Who and when:** an engineer must have accepted the work order before recording time. One active sequence per engineer, unless the configuration allows more.<br>• **Effects:** the first Start Travel moves the work order and complaint to *In Progress*.<br>• **Durations:** travel, waiting on site, on-site work, return travel and total, calculated from absolute timestamps, so visits that cross midnight work, and shown in the configured timezone. |
| **Several engineers on a visit** (D-34, confirmed) | Each engineer records their own six steps. The visit shows the furthest step anyone has reached, and becomes *Completed* only when everyone who started is back at base. A co-assigned engineer can accept the work even after it has started. |
| **Time corrections** (TIME-07/08, BR-011, D-35) | The engineer requests a correction to their own event, giving a reason. The proposed time must fall between the neighbouring events and cannot be in the future. Only one correction per event can be pending. An independent person approves or rejects it (a rejection needs a comment), and neither the engineer concerned nor the requester can decide. **The original server time is never changed**: the approved time is stored alongside it and used for durations. Everything is audited and notified. Time records can never be deleted. |
| **Checklist templates** (INSP-01) | One template per equipment type, with versions: draft, then publish (which retires the previous active version), new version, and retire. Each item has a section, description, guidance, and settings for whether it is required, whether evidence is needed (none, photo, document or either), whether *Not Applicable* needs a reason, and whether a *Fail* needs evidence. Admins manage templates with a full editor. |
| **Inspection reports** (INSP-02..07, BR-006..009) | A report starts from the active template for the asset's equipment type and keeps a copy of it, so later template changes never alter an existing report. Each item is marked Pass, Fail, Not Checked or Not Applicable, with remarks, a reason where needed, and photo or document evidence (taken with the phone camera or uploaded). Drafts save automatically. A preview lists every problem still blocking submission.<br>**Submission rules:**<br>• *Not Checked* always needs a reason.<br>• *Not Applicable* needs a reason where the template says so.<br>• Every required item must be answered.<br>• Mandatory evidence must be attached, and a *Fail* needs evidence where configured.<br>• The engineer must have recorded *Arrive at Site*, *Start Work* and *End Work* (D-33, confirmed).<br>**After submission:** the report can no longer be changed, whether through the screens, the API or a direct database update, and it can't be deleted. The work order moves to *Submitted*, the complaint moves to *Submitted for Review* once all of its work orders are submitted, and reviewers are notified. |
| **Temporary assets** (MD-08, D-25) | An engineer can record an unknown asset on site. It gets a `TMP-YYYY-00001` code and can be inspected straight away. A supervisor then approves it (optionally giving a permanent code) or rejects it with a comment. |
| **Screens** | **Visits list and visit page:**<br>• a large "next step" button and a six-step progress view<br>• live duration tiles and every engineer's progress, each with the full breakdown<br>• a time-events table showing the corrected time, the phone's clock difference and a GPS map link<br>• correction requests and approvals<br>**Elsewhere:**<br>• *Plan a visit* on the work order<br>• a correction approval queue with a pending count in the menu<br>• the inspection report page: checklist by section, large touch targets, camera upload, autosave, a sticky progress bar and a preview before submitting<br>• the checklist-template admin, temporary-asset review, and the report list<br>• updated engineer, supervisor and reviewer dashboards |
| **API** | 101 documented paths. Migration `004` creates the visits, time events, time corrections, inspection templates and inspection reports collections with the indexes from HO §8.2. |
| **Demo data** | Sample checklists for each demo equipment type, marked **SAMPLE** until the real checklists are provided (D-06). |

## 2. Verification evidence

| Check | Result |
|---|---|
| Type-check and lint, all workspaces | 0 errors |
| Shared package tests | **15 / 15** |
| API integration tests | **150 / 150** (24 new in Phase 5) |
| Web component tests | **68 / 68** (17 new) |
| Playwright E2E on the production build, desktop and phone | **22 / 22** (5 new); the field journey passed 3 consecutive runs |
| Production builds | Succeed |
| Dependency audit | No new findings; only the known K-01 (Zod) and K-03 (exceljs/uuid) |
| Live instance | Running at http://localhost:5610 (API on 4610) against the local `MVServiceMgmt` database; health check reports the replica set |

**Browser journey (new):** a supervisor sets up the job through the API. Then, all through the screens:

1. Erin accepts the work and plans a visit.
2. She records travel and work time.
3. She starts the inspection and answers the checklist, including N/A with a reason, a photo, and a test document.
4. Autosave confirms the answers are saved.
5. She previews and submits, and the report locks (its controls are disabled).
6. She records return travel, and the visit completes.
7. A supervisor sees all six steps with their durations, and the work order shows *Submitted*.

A phone check confirms the field screens fit without sideways scrolling.

**Defects found and fixed in Phase 5 verification**

- **A second engineer couldn't accept work already in progress**, so they could never record time and the visit showed *Completed* too early. Fixed.
- **A just-uploaded photo could disappear** when an older autosave response arrived after the upload. The page now re-fetches the latest server state once activity settles.
- **Supervisors only saw part of each engineer's durations.** Each engineer's card now shows travel, on-site work, return travel and total (TIME-06).
- **Visits without a planned time were missing from dashboard date lists.** They now appear by their creation date.
- **Test stability:** three browser-test timing issues were fixed (thumbnail rendering, debounced search, waiting under load). MongoDB had stopped after a system shutdown and was restarted with your approval.

## 3. Requirement status

| Status | IDs |
|---|---|
| **Done in Phase 5** | ENG-01 to ENG-04; TIME-01 to TIME-08; INSP-01 to INSP-07 (INSP-07's revision creation runs inside the Phase 6 *return* flow); MD-04; MD-08; UI-07 (autosave and record-state badges); DB-03 (visit numbers); the field-work part of NOT-03 (corrections, report submitted) |
| **Decisions** | D-33 and D-34 confirmed. D-35 remains open but is working as built. |

## 4. Walkthrough

1. Sign in as `supervisor@example.com`. Classify a demo complaint, create a work order and assign **Erin Engineer** (or **Eli** for North and Central sites).
2. Sign in as the engineer. Open the work order and click **Accept work**, then **Plan a visit** and **Create visit**.
3. On the visit, tap **Start Travel from Base**. Optionally switch on *Share location*, and the browser asks permission. Continue through **Arrive at Site**, **Start Work at Site** and **End Work at Site** (which asks you to confirm).
4. Click **Start inspection**. Answer the checklist: try *Not checked* without a reason and see the problem shown on that item, then add a photo with the camera button on a phone. Click **Preview & submit** to see any remaining problems, then **Submit**. The report becomes read-only.
5. Back on the visit, request a correction to one of your times with a reason. Sign in as the supervisor or `reviewer@example.com`, open **Time corrections** and approve it. The corrected time appears with the original struck through, and the durations update.
6. As the engineer, tap **Start Return Travel** and then **Arrive at Base**. The visit shows *Completed*.
7. As an administrator, open **Administration → Checklist templates** and create a new version of a SAMPLE checklist. Publishing it retires the old version, and existing reports keep their original version.

## 5. Open items

- **D-06:** please supply the real inspection checklists per equipment type, which replace the SAMPLE templates.
- **D-35:** confirm who may approve time corrections; supervisors and reviewers are allowed as built.
- **Atlas (D-28):** the live instance currently uses the local database. To switch, put the Atlas connection string in `apps/api/.env` (`MONGODB_URI`), then run `npm run migrate` and `npm run seed` (or `seed:demo`).
- **K-01** (Zod upgrade before go-live), **D-32** (Turnstile keys).

## 6. Next phase (on acceptance)

**Phase 6: review, approval and report versioning.** This covers:

- the reviewer queue, with the full context: checklist, evidence, six-step time log, corrections and NCRs
- approve, or return with mandatory comments and per-item feedback (D-29)
- a returned report creating a new draft revision; the earlier revision is kept and can be compared side by side
- no self-approval (BR-012)
- optional multi-level approval (D-17)
- time-log flags: missing steps, unusual durations, pending corrections
- the complaint and work order moving to *Approved*
