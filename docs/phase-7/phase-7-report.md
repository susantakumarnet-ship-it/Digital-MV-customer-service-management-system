# Phase 7 Report: Material Requests and Inventory

**Status:** complete, accepted by the project owner on 13 November 2026
**Date:** 13 November 2026
**Decision applied:** D-07 confirmed: a full stock ledger, several warehouses, and supervisor approval with no limits (never on their own request).

## 1. What was delivered

| Area | Delivered |
|---|---|
| **Material request** (MAT-01) | An engineer assigned to the work order raises the request, optionally linked to a visit. Each line is a catalogue item with its code, name and unit, the quantity, an optional specification and an optional reason. The request also carries an urgency (Low, Normal, High, Critical), an overall reason and a needed-by date. It can be submitted straight away or saved as a draft. Requests are numbered `MR-YYYY-000001`, and approvers in scope are notified. |
| **Supervisor decision** (MAT-02) | **Approve** (quantities may be reduced, never increased), **reject** with a reason, or **ask for clarification**; the engineer replies, edits and resubmits. Approval does not mean the stock is available. Nobody can decide their own request, including someone who is both engineer and supervisor (MAT-07). Storekeepers are notified when a request is ready to issue. |
| **Revised approval** (BR-013) | After approval, a supervisor can change a line's approved quantity with a reason. It cannot go below what has already been issued and reserved. **Issuing more than the approved quantity is refused** (409 EXCEEDS_APPROVED) until the approval is revised. |
| **Store operations** (MAT-03/04) | **Reserve** stock in a chosen warehouse, and release a reservation with a reason. **Issue** all or part of a line, using this request's reservation first, recording the batch number, serial numbers (one per unit), the recipient and a note, with an optional handover photo or document. **Backorder** with an expected date, notifying the requester. **Return**: good items go back into stock, while damaged or unused items are recorded but not restocked. **Close** is blocked while stock is still reserved. |
| **Stock ledger** (MAT-05) | Ledger entries can never be changed or deleted. Entry types: Opening balance, Receipt, Reserve, Release, Issue, Return, Damaged, Adjustment in and Adjustment out. The **balance per item and warehouse** is updated in the same database transaction as its entry, and conditional updates make overdrawing or double-booking stock impossible, even with simultaneous requests (tested). **Receipts and opening balances** can be recorded, and **adjustments** need a reason. The **integrity check** recalculates every balance from the ledger and reports any difference. |
| **Inventory screens** | Balances (on hand, reserved, available, reorder level and a low-stock flag) with filters, Receive stock, Adjust, an item detail view, the ledger with filters and links to each request, and the integrity check. |
| **Closing a complaint** (BR-016) | **A complaint cannot be resolved while it has open material requests**: submitted, awaiting clarification, approved or partly issued. |
| **Screens and dashboards** | A materials panel on work orders and visits; the request list and detail page, with decision and store panels; the store queue, sorted by urgency and then by age; the inventory and ledger pages. **Storekeeper dashboard:** items ready to issue, partly issued and critical requests, plus low stock. Supervisor, engineer and admin dashboards show material figures. |
| **API** | 125 documented paths: `/material-requests/*` and `/inventory/*`, the paths the brief names. Migration `006` adds the material requests, stock transactions and stock balances collections. |

## 2. Verification evidence

| Check | Result |
|---|---|
| Type-check and lint, all workspaces | 0 errors |
| Shared package tests | **15 / 15** |
| API integration tests | **174 / 174** (17 new) |
| Web component tests | **92 / 92** (14 new) |
| Playwright E2E on the production build, desktop and phone | **31 / 31** (4 new) |
| Production builds | Succeed |
| Dependency audit | No new findings (only the known K-01 and K-03) |
| Live instance | Migration 006 and demo opening stock applied to the local `MVServiceMgmt` database |

**New automated coverage**

- **Stock:** receipts and opening balances in separate warehouses; adjustments need a reason and can't go negative; low-stock flag; the ledger can't be changed or deleted.
- **Requests:** only assigned engineers can raise one, and only for active items; no deciding your own request; the clarification round trip; approval quantity limits.
- **Store:** reservations within the approved and available amounts; refusals for over-approval, serial-number mismatches and missing recipients; partial issue using the reservation, with evidence that only authorised people can download; backorders; revised approval; insufficient stock refused, then issued from another warehouse.
- **Returns and closing:** good and damaged returns, and no over-returns; close blocked while stock is reserved; the integrity check passes after every scenario.
- **Concurrency:** two simultaneous issues against the same stock: exactly one succeeds, and the balance never goes negative.
- **Rules and access:** a complaint can't be resolved with open requests; other regions can't see the requests; the store queue sorts by severity; the catalogue options include units.
- **Browser:** the engineer requests 4 fuses from the work order; the supervisor approves; the storekeeper issues from the Central Store with a handover photo, and the request shows *Issued*; the ledger shows the issue and the integrity check reports "All balances match the ledger".

**Gaps closed during verification:**
- urgency now sorts by severity rather than alphabetically, on the server
- request summaries show how many lines still need issuing
- the server now tells the screen whether a return is allowed
- the catalogue options include each item's unit

## 3. Requirement status

| Status | IDs |
|---|---|
| **Done in Phase 7** | MAT-01 to MAT-08 (MAT-08: opening balances and reorder warnings; valuation is out of scope under D-07); RBAC-06 (material part); NOT-03 for *material request submitted, approved, rejected and issued*; the material part of the complaint closure rule (BR-016); DASH-01 *pending material requests* |

## 4. Walkthrough

1. As `supervisor@example.com`, create and assign a work order to Eli (see the Phase 4 walkthrough). As `engineer1@example.com`, accept it.
2. On the work order, click **Request material**. Add *HRC Fuse 63A × 4* with urgency **High** and submit.
3. As the supervisor, open **Material requests → Pending approval**. Try **Ask for clarification**, reply as the engineer and resubmit, then **Approve** 3 of the 4.
4. As `storekeeper@example.com`, open the **Store queue**. **Reserve** 2 in the Central Store. **Issue** 3: try 4 first and see the "revised approval needed" message, then issue with a batch number, a recipient and a handover photo.
5. As the supervisor, use **Revise approved quantity** to raise it to 4, giving a reason. Issue the last one, from the North Store this time, and the request shows *Issued*. Release any leftover reservation, then **Close** the request.
6. **Return** one item: good items go back into stock, damaged ones are recorded only.
7. Open **Inventory**: the balances have moved, low-stock items are flagged, the **Ledger** lists every movement, and **Run check** confirms the balances match the ledger.

## 5. Open items

- **D-06:** real inspection checklists. **D-28:** Atlas connection string. **K-01:** Zod upgrade. **D-32:** Turnstile keys.

## 6. Next phase (on acceptance)

**Phase 8: NCR management, customer acceptance and complaint closure.**

- **NCRs:** linked to the complaint, work order, asset or a checklist item, and tracked Open → Assigned → Action in Progress → Submitted for Verification → Returned or Verified → Closed. Closing needs verification evidence and an authorised reviewer (BR-014). Categories and severities are configurable (D-08).
- **Customer acceptance:** a secure, expiring, single-use link or the customer portal. Opening the link never counts as acceptance. The customer can accept, or reject with comments, and give feedback.
- **Closure:** the closure checklist (reports approved, time reviewed, materials complete, NCRs done, customer acceptance or a recorded waiver, BR-016), and reopening with a reason.
