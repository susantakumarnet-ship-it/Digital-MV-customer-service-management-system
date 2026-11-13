# Phase 8 Report: NCRs, Customer Acceptance and Complaint Closure

**Status:** complete, accepted by the project owner on 13 November 2026
**Date:** 13 November 2026
**Decisions applied:**
- **D-08:** the standard MV categories and severities, both configurable. The supervisor assigns the owner, and a reviewer other than the owner verifies.
- **D-12:** the customer decides either through a secure link (recording the name they type) or in the customer portal (tied to their own organisation).
- **D-18 / D-24:** when the customer rejects, the complaint reopens. A supervisor can waive acceptance, but must give a reason.

## 1. What was delivered

| Area | Delivered |
|---|---|
| **Raising an NCR** (NCR-01) | Anyone with `ncr.create` (engineers, supervisors, reviewers) raises an NCR against a complaint. It can also be linked to a work order, an asset at the site, or a failed item in an inspection report. Each NCR has a category, severity, title, description, optional due date (default 14 days, configurable) and evidence files. NCRs are numbered `NCR-YYYY-000001`. A supervisor can assign the owner at the same time; otherwise the supervisors in scope are notified. |
| **Lifecycle** (NCR-02) | Open → Assigned → Action in Progress → Submitted for Verification → Returned or Verified → Closed. **Assign** and **reassign** need `ncr.assign` and an owner who can work NCRs. Only the **owner** records the containment action, root cause, corrective action and disposition; the first change moves the NCR to Action in Progress. Submitting needs all four. **Return** needs a reason, and the owner is notified. |
| **Verification** (NCR-03, BR-014, D-08) | **Verify** needs at least one *verification* attachment, added by a verifier. **The owner can never verify their own NCR**, even when they also hold the reviewer role; the screen explains why. Close follows verification. |
| **History** (NCR-04) | Every change to the owner's fields is kept as a revision showing old and new values. Comments, status history and the audit log are kept as well. NCRs cannot be deleted. |
| **Configuration** | New settings group **NCR**: categories, severities and default due days. `GET /ncrs/options` gives the configured lists to anyone who works NCRs, and the possible owners within the complaint's scope to assigners. |
| **Resolving a complaint** (BR-016) | **A complaint cannot be resolved while any of its NCRs is open.** This adds to the open-material-request check from Phase 7. |
| **Requesting acceptance** (CUS-01) | **Request acceptance** emails a random, single-use link that expires after the configured number of days (default 14). Only a hash of the token is stored. Portal users of the customer organisation are notified. **Resend link** issues a new link and cancels the old one. The screen shows the recipient, the expiry, and whether the link has been opened or has expired. |
| **Customer decision** (CUS-02/03/04, D-12) | The **public page `/acceptance/:token`** shows the reference, the work carried out, the visits and time on site, and summaries of the approved inspection reports with findings and recommendations. **Opening the link never counts as acceptance**; only submitting a decision does. The customer **accepts**, or **requests further action** (comments required), and can add a 1–5 rating and feedback. The token flow records the signer's name, IP address and browser. Separate screens cover invalid, expired, replaced and already-used links. **In the portal**, only users of the complaint's customer organisation can decide; administrators cannot act as the customer. Decision records can never be changed. |
| **Rejection** (CUS-07, D-18) | The complaint moves to **Reopened**, the customer's comments are recorded in the status history, and supervisors are notified. The supervisor then either starts a new review and creates new work orders, or uses the new **Record resolution** action (a reason is required) if no new field work is needed, and requests acceptance again. |
| **Waiver** (D-24) | **Waive acceptance** needs `complaint.waiveAcceptance` and a reason. It is recorded in the acceptance history as *Waived*. |
| **Closure** (CUS-05, BR-016, AC-10) | A **closure checklist** on the complaint lists every condition: all work orders technically approved; visits completed and time corrections decided; material requests complete; NCRs verified or closed; customer acceptance recorded or waived. The **Close** action is refused until all are met. Closing also closes the approved work orders and emails the customer. |
| **Reopen** (CUS-06) | Reopening needs a reason. It clears the current acceptance cycle and cancels any outstanding link. |
| **Screens** | Pages: the **NCR list** (summary figures, filters, overdue items highlighted) and the **NCR detail page** (actions, evidence, verification, comments, revisions, timeline). A **Raise NCR** dialog appears on the complaint, work order, inspection report (failed items) and review workspace; the review workspace's NCR list is now live. A **Resolution & acceptance** panel on the complaint page carries the checklist, acceptance status, link details, history and actions. Customers get a decision panel in the portal, with a "Waiting for your acceptance" list on their dashboard. Supervisor and reviewer dashboards show NCR figures. |
| **API** | `/ncrs/*`; `/complaints/:id/acceptance`, `/request-acceptance`, `/acceptance/resend` and `/closure-checklist`; and the public `/customer-acceptance/:token`. These are the paths the brief names. **Migration `007`** adds the `ncrs`, `acceptanceTokens` and `customerAcceptances` collections and moves the complaint workflow to v2, adding the *Record resolution* step. Settings changed by an administrator are kept. |

## 2. Verification evidence

| Check | Result |
|---|---|
| Type-check and lint, whole workspace | 0 errors |
| Shared package tests | **15 / 15** |
| API integration tests | **181 / 181** (7 new scenario tests) |
| Web component tests | **106 / 106** (14 new) |
| Playwright E2E on the production build | **37 / 37** (6 new) |
| Production builds | Succeed |
| Live instance | Migration 007 applied to the local `MVServiceMgmt` database |

**New automated coverage**

- **NCR lifecycle:**
  - Category is validated against the configured list.
  - The NCR can be linked to a failed checklist item, with evidence.
  - Supervisors are notified when it is raised.
  - Engineers can't assign owners, and only the owner records actions.
  - Submitting is refused until all four action fields are filled.
  - Return needs a reason, and every revision is kept.
  - Verification needs verification evidence, which only a verifier can add.
  - The NCR is locked after closing and can't be deleted.
  - The review context lists the NCR.
- **Segregation of duties:** a reviewer who owns an NCR can't add verification evidence or verify it; a second reviewer can.
- **Options and access:**
  - Workers get the configured lists, and only assigners get possible owners.
  - Customers have no NCR access.
  - List filters and summary figures work.
- **Resolve guard:** resolving is refused while an NCR is open, and the refusal names the NCR.
- **Secure link:**
  - Only the hash is stored.
  - Viewing doesn't change the status, though the "opened" time is recorded.
  - The signer's name is required, and invalid links are refused.
  - Accepting works once; a second attempt returns `LINK_USED`.
  - The decision record can't be changed.
- **Closure:**
  - Closing is blocked until acceptance, then succeeds.
  - Closing closes the work order and emails the customer.
  - Reopening clears the acceptance cycle.
- **Rejection path:**
  - Resending replaces the old link (`LINK_SUPERSEDED`).
  - Rejecting needs comments and reopens the complaint with them, notifying supervisors.
  - *Record resolution* needs a reason.
  - Expired links are refused (`LINK_EXPIRED`).
- **Portal:**
  - Users of another organisation can't see the acceptance.
  - Administrators get `NOT_CUSTOMER`.
  - The Acme customer accepts, and the emailed link stops working.
- **Waiver:**
  - A reason is required, and engineers can't waive.
  - Closing is still blocked by an unfinished visit, and succeeds once the visit is complete.
- **Browser journey:**
  1. The engineer raises an NCR from the work order.
  2. The owner's actions are recorded.
  3. A reviewer verifies the NCR on screen.
  4. The supervisor requests acceptance, and the checklist shows *Awaiting the customer*.
  5. The Acme customer accepts in the portal with a 5-star rating.
  6. The supervisor closes the complaint.
  7. An invalid link shows a clear message.

**Gaps closed during verification**
- **Configured NCR lists:** supervisors and engineers couldn't read them, because settings need `settings.read`.
- **Possible NCR owners:** there was no list of people who can own an NCR.
  - Both are now served by `GET /ncrs/options`, which returns owners within the complaint's scope.
- **Hidden lint gap:** an old lint error in the E2E start script, missed by earlier per-workspace runs, is now fixed.

## 3. Requirement status

| Status | IDs |
|---|---|
| **Done in Phase 8** | NCR-01 to NCR-04; CUS-01 to CUS-07; BR-014, BR-015, BR-016 (complete: materials, NCRs, time logs, approval, acceptance); AC-09; AC-10; NOT-03 for *NCR raised, assigned, returned and verified* and *acceptance requested, accepted and rejected* |

## 4. Walkthrough

1. As the supervisor and `engineer1@example.com`, take a complaint through to an approved inspection report, as in the Phase 6 walkthrough. Mark one checklist item **Fail**.
2. As the engineer or the reviewer, open the report or the review workspace. Next to the failed item, click **Raise NCR for this item** and fill in the category, severity, title and description.
3. As the supervisor, open **NCRs** and the new NCR, then click **Assign** and choose Eli.
4. As Eli, fill in the **owner's actions** (containment, root cause, corrective action, disposition) and click **Submit for verification**.
5. As `reviewer@example.com`, try **Verify**: it asks for verification evidence. Upload a photo under **Verification** and verify, then **Close**.
6. As the supervisor, open the complaint and click **Resolve**, which is now allowed. Under **Resolution & acceptance**, click **Request acceptance**. The email is written to the mail folder (`MAIL_DIR`) and contains the link.
7. Open the link in a private window. The summary shows, and the status is unchanged. Choose **Request further action** with a comment. The complaint is now **Reopened**.
8. As the supervisor, use **Record resolution** with a reason, then **Request acceptance** again. Sign in as `customer@example.com` and accept in the portal.
9. As the supervisor, every checklist condition is now ticked. Click **Close complaint**: the work orders close and the customer gets a closing email.
10. Optional: on another resolved complaint, click **Waive acceptance** and give a reason.

## 5. Open items and notes

- **D-06:** real inspection checklists. **D-28:** Atlas connection string. **K-01:** Zod upgrade. **D-32:** Turnstile keys.
- `AcceptanceSummaryDto.documents` is empty for now. The customer sees report summaries but can't download documents. PDF reports and downloads come with the Phase 9 exports.
- The complaints list has no status filter in the URL, so the customer dashboard's "View all" opens the open-complaints tab. This will be addressed in Phase 9 with the reports and filters work.

## 6. Next phase (on acceptance)

**Phase 9: management dashboards, reports, exports and notifications.**
- **Reports** (REP-01–08): complaint register, work order status, visit and time log, inspection, material requests and issues, NCR register, SLA and ageing, audit history. Each has filters and is exported to CSV, Excel or PDF, with personal data masked unless `report.viewPersonalData` is held.
- **Management dashboards:** trends, workload, overdue items and SLA.
- **Notifications:** the remaining notification events, email templates, and per-user preferences.
