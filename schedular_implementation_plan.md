# Scheduled Downloads: Implementation Plan

Status: **Phase 1 implemented**, 2026-11-16; **timing changed 2026-11-17**; **Phase 2 (tender documents) implemented 2026-11-17** (section 14) (exports once 09:00-10:00 every 10 min, PDFs hourly 09:00-18:00, last run at 18:00; D7 and Appendix A updated, Appendix B "Timing change"). DocLink branch `user/alok/scheduler`, Recon Engine branch `user/alok/doclink_schedule`, not committed. Appendix B lists where the build differs from the text below. It replaces the single-user draft of 2026-11-15.

Repos and branches:
- DocLink: `ireps_portal_mock`, new branch `user/alok/scheduler` off `main`.
- Recon Engine: `01_recon_engine_repo/recon-engine`, branch `user/alok/doclink_schedule`.

---

## 1. What we are building

Today DocLink downloads only when a user clicks. The scheduler lets an admin say, per IREPS account and per
document type, **when** downloads should run. The standard schedule (changed 2026-11-17): "Account 833 (Hosur):
Bill Status, CRN and R-NOTE **once between 09:00 and 10:00, checked every 10 minutes until done**; MA, POs and
ICs **every hour from 09:00 to 18:00 (the last run at 18:00)**, each run looking for new documents".

Bill Status, CRN and R-NOTE are downloaded **once per day**: the first check that succeeds, by whichever user,
does it, and no user's DocLink triggers that type again until the next day's window. MA, POs and ICs run **once
per hour**: each hourly run fetches what is new since the documents already saved (the reservations skip the
rest), and no DocLink runs that hour again.

(Sections 4-6 below describe the once-a-day slot with the original 09:00-12:00 / 15-min example; an hourly
schedule works the same way with one slot per hour. Appendix A is the current contract.)

Many people use DocLink, maybe 20 on the same IREPS account. Each scheduled download must happen **once**,
not once per user:

- **Any** DocLink whose user is signed in to the Recon Engine and logged in to IREPS on that account may run a
  due schedule.
- **Exactly one** does. The others see "Done by Priya at 10:06" and download nothing.
- A document that anyone already saved for that account to that destination is **never downloaded again**.
  It is skipped, with no prompt.

### Phases

| Phase | Documents | This plan |
|---|---|---|
| **1: non-tender** | Bill Status, CRN, R-NOTE (exports → S3); MA, POs by PO date, ICs by IC date, ICs from notifications (PDFs → ECM) | Full design (sections 3-13) |
| **2: tender** | NIT, corrigenda, LOA / letters, Financial / Commercial Tabulation, correspondence | Outline only (section 14). They run in the side panel, not the worker |

Single PO / single IC downloads (typed PO number) are not scheduled. Scheduled POs and ICs use the existing
batch runs (`services/batch-download.js`).

---

## 2. Rules this design follows (from CLAUDE.md)

| Rule | What it means here |
|---|---|
| Never keep the IREPS session alive (IREPS logs out after about 5 min idle) | No timed IREPS checks. IREPS is contacted only by the **one** DocLink that won the claim, and only when its browser shows recent IREPS activity |
| Read-only toward IREPS | Scheduled runs use the existing download flows unchanged: same requests, same `withIrepsFormLock` |
| No new `config.json` keys | Schedules live in the Recon Engine. Timings are constants in code. **One exception, asked for by the user on 2026-11-16:** the on/off flag `schedular_phase1` (D10, section 8.9). It needs the tech lead's sign-off, and CLAUDE.md must record it as the documented exception |
| New `manifest.json` permission needs approval | `alarms` is requested (D1). Phase 1 also works without it, only less punctually |
| Fail closed | Backend unreachable, or IREPS account not verified → no scheduled run. Never guess, never fall back silently |
| Long jobs run in `holdWorker()` and save state for `restoreSavedJob` | Scheduled runs reuse the existing jobs, so they inherit both |
| Recon / ECM / log requests use `fetchWithDeadline` | The new scheduler API client does too |
| Every user-facing failure is an error code | New `SCHEDULE_*` codes in `utils/messages.js` |

---

## 3. Decisions

| # | Decision | Default in this plan | Status |
|---|---|---|---|
| D1 | `alarms` permission in `manifest.json` | Add it, so a run starts on time. No `notifications` permission: the toolbar badge needs none | **Needs approval** |
| D2 | Who may run scheduled downloads | Roles `admin`, `tendering`, `tendering_approver` (new permission `doclink.schedule.run`) | Confirm |
| D3 | Who may create and edit schedules | `admin` only (new permission `doclink.schedule.manage`) | Confirm |
| D4 | Trusting the IREPS account id DocLink reports | Phase 1: trusted for users who hold `doclink.schedule.run`. Later: a user ↔ IREPS account mapping on the backend | Confirm |
| D5 | Manual runs | Unchanged in Phase 1 (per-user check, "download again?" prompt). Scheduled runs still respect manual downloads, because the reservation reads the download log. Phase 1b: manual ECM / S3 runs reserve documents too (section 5.3) | Confirm |
| D6 | Destinations of scheduled downloads | **S3 / ECM only, never local.** Exports (Bill Status, CRN, R-NOTE) → S3 through the Recon Engine; PDFs (MA, PO, IC) → ECM. The panel's Local \| ECM / S3 switch doesn't apply to scheduled runs. **No local fallback:** a document the ECM or S3 refuses is reported `failed` (the slot becomes `partial`) and retried at the next check. IREPS still has it, so nothing is lost | Fixed (user, 2026-11-16) |
| D7 | Daily window and check interval | Bill Status, CRN, R-NOTE: **once between 09:00 and 10:00 IST**, checked **every 10 min** (09:00, 09:10 … 09:50) until done; not done by 10:00 → `missed`. MA, POs, ICs: **every hour from 09:00 to 18:00 IST** (one slot per hour, 09:00 … 18:00; the 18:00 run may run until 19:00), each run fetching what is new, retried every 15 min within its hour. Per document type, editable per account (`repeat_every_minutes`) | Set by user, 2026-11-16; changed 2026-11-17 |
| D9 | A user logs in to IREPS between two checks (e.g. 09:07) | The run starts at once (IREPS page-load trigger), not at 09:15. The 15-min checks catch users who are already active | Default, confirm |
| D8 | Where schedules are edited | DocLink panel (Schedule view), for users with `manage`. Could move to the Recon web UI later | Default |
| D10 | On/off switch and type list in DocLink | `config.json` block `"schedular_phase1": { "enabled": true, "documents": ["BillStatus", "CRN", "RNote", "MA", "PO", "IC"] }`. Only listed types are triggered automatically: remove `IC` and IC is never scheduled. `enabled` not `true`, or no known type listed → **no scheduling at all** (fail closed). Section 8.9 | Asked for by the user. **Needs tech-lead sign-off** (exception to the no-new-keys rule) |

---

## 4. Concepts

| Term | Meaning |
|---|---|
| **Schedule** | Admin rule: IREPS account + document type + weekdays + daily window (09:00-12:00) + check interval (15 min) + destination + look-back days |
| **Slot** | One per schedule **per day**: `833 · billStatus · 2026-11-17`, open 09:00-12:00. Once `done`, it is closed for every user for the rest of the day. Tomorrow is a new slot |
| **Check** | A moment in the window when DocLinks look for open slots: every 15 min (09:00, 09:15 … 11:45), plus any IREPS page load inside the window (D9) |
| **Claim** | The right to run one slot. Only one DocLink holds it, for a limited time (the **lease**), identified by its `claim_id` |
| **Document status** | One row per account + destination + document key. Once `done`, that document is never downloaded again by anyone |
| **Lease** | `lease_until`, kept moving by heartbeats. A lease that has run out counts as failed and can be claimed again |

Document keys are the existing `downloadKey` values (`po:`, `ic:`, `ma:`, `export:<type>:<fingerprint>`).
An export's key is the fingerprint of its rows: the same rows are never saved twice, and changed rows give a
new key, so they are saved.

---

## 5. Running once without races

### 5.1 Why "read the flag, then set it" fails

```
Priya:  GET status → (none)           ...  SET in_progress ✓ → downloads
Rahul:  GET status → (none)   ...  SET in_progress ✓         → downloads too  ✗
```

Both read "no status" before either wrote. With 20 DocLinks waking at 09:00 (and again at every 15-min check) this will happen.

**Fix: the client never reads and then writes.** It asks the database to "set in-progress **only if** free" in
**one statement**. The database applies statements on the same row one after another:
- Postgres checks the `WHERE` again after taking the row lock;
- SQLite allows one writer at a time.

So exactly one caller changes the row, and everyone else gets "0 rows changed". All times are the database
server's `now()`, so wrong clocks on users' laptops don't matter.

### 5.2 Level A: claiming a slot (who runs the job)

```sql
UPDATE doclink_schedule_slots
   SET status = 'in_progress', claim_id = :claim_id, holder_user_id = :me,
       lease_until = now() + interval '10 minutes', started_at = now(),
       attempts = attempts + CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END   -- a takeover counts the dead run
                                                                   -- (finish(failed) adds its own attempt when it counts)
 WHERE id = :slot_id
   AND now() BETWEEN window_start_at AND window_end_at            -- only inside today's 09:00-12:00
   AND (    status = 'pending'                                    -- no status yet
        OR (status IN ('failed', 'partial') AND next_try_at <= now())   -- retry at the next check
        OR (status = 'in_progress' AND lease_until < now()) )     -- holder died
                                                                  -- 'done' never matches: once a day
   AND NOT EXISTS (SELECT 1 FROM doclink_schedule_slots o         -- one run per IREPS account
                    WHERE o.ireps_account_id = :account AND o.id <> :slot_id
                      AND o.status = 'in_progress' AND o.lease_until >= now());
-- 1 row  → this DocLink runs the slot
-- 0 rows → someone else has it, it's done, or another slot of this account is running: download nothing
```

**One run per account at a time.** "ICs by date" and "ICs from notifications" can find the same IC, so they
must not run side by side. This rule also keeps load on IREPS low.

On Postgres, the `NOT EXISTS` across rows needs one of two guards:
- the claim transaction takes `SELECT … FOR UPDATE` on the account's row in a small `doclink_schedule_accounts` table first; or
- a partial unique index: `UNIQUE (ireps_account_id) WHERE status = 'in_progress'`.

Use the advisory row (`FOR UPDATE`). The partial index can't see expired leases, so it would block a takeover.
SQLite serialises writers, so it needs no guard.

**Slot states:**

```
 09:00 window opens
     │      claim (atomic)                  finish(done)
  pending ───────────────► in_progress ─────────────────────► done        closed for everyone until tomorrow
     ▲                       │   │   │
     │                       │   │   └─ finish(partial) ─► partial ─(next check)─► claimable: only the documents
     │                       │   │                                                not yet done are fetched
     │                       │   └─ finish(failed) ─► failed ─(next check)─► claimable again
     │                       │                         └─ permanent error ─► failed_final
     │                       └─ lease_until passes (Chrome closed, crash) ─► claimable again
     └─ 12:00, not done ──► missed (keeps the last error, if any)
```

This is the rule "the next user goes only when the status is Failed or there is none", with two additions:
- **an expired lease counts as failed.** Without it, one crashed laptop would block everyone;
- **`partial`**: the run finished, but some documents failed (e.g. the ECM refused one). The next check
  re-runs the slot, and the document reservation lets it fetch only what is missing. So "downloaded once"
  holds per document, and nothing is left behind.

**Retry rules (constants in the backend):**

| Failure | `next_try_at` | Notes |
|---|---|---|
| The winner's IREPS check fails (not logged in, wrong account) | now: anyone else may claim at once | No attempt counted |
| IREPS error during the run (5xx, timeout, unrecognised page), Recon / ECM unavailable | the next 15-min check | Retried at every check until 12:00, then `missed` with the last error |
| Some documents failed (`partial`) | the next 15-min check | Only the unfinished documents are fetched |
| Lease ran out | immediately | Counted as an attempt (shown in Today) |
| Permanent error (no permission, invalid schedule, `RECON_NOT_CONFIGURED`) | none | `failed_final` |

### 5.3 Level B: reserving documents (who saves each file)

Level A stops two scheduled runs. Level B makes each **document** be saved once. It covers the gaps
level A leaves:
- a manual run and a scheduled run fetching the same IC;
- the overlap between IC batches;
- a rerun after a crash, which fetches only what's missing.

Just before downloading, the run reserves a small batch of keys (about 10; downloads run 3 at a time):

```
POST /api/doclink/documents/reserve
  { claim_id, ireps_account_id: "833", destination: "ecm", keys: ["ic:…", "ic:…", …] }
→ { granted: ["ic:A", "ic:C"],
    taken:   { "ic:B": { status: "done", by: "Rahul Sharma", at: "2026-11-16T15:02:11+05:30" } } }
```

On the server, in **one transaction**:

```sql
-- 1. A document already in the download log for this account + destination counts as done
--    (manual downloads included, D5). Done once per key, then kept in doclink_document_status.
INSERT INTO doclink_document_status (ireps_account_id, destination, doc_key, status, holder_user_id, updated_at)
SELECT :account, :destination, d.doc_key, 'done', d.user_id, now()
  FROM doclink_downloads d
 WHERE d.ireps_account_id = :account AND d.destination = :destination AND d.doc_key IN (:keys)
ON CONFLICT (ireps_account_id, destination, doc_key) DO NOTHING;

-- 2. New keys: mine
INSERT INTO doclink_document_status (ireps_account_id, destination, doc_key, status, claim_id, holder_user_id, lease_until, updated_at)
VALUES (… each key …, 'in_progress', :claim_id, :me, now() + interval '10 minutes', now())
ON CONFLICT (ireps_account_id, destination, doc_key) DO NOTHING;

-- 3. Failed or dead keys: mine
UPDATE doclink_document_status
   SET status = 'in_progress', claim_id = :claim_id, holder_user_id = :me, lease_until = now() + interval '10 minutes', updated_at = now()
 WHERE ireps_account_id = :account AND destination = :destination AND doc_key IN (:keys)
   AND (status = 'failed' OR (status = 'in_progress' AND lease_until < now()));

-- 4. What I got
SELECT doc_key FROM doclink_document_status WHERE claim_id = :claim_id AND doc_key IN (:keys);
```

`ON CONFLICT … DO NOTHING` works on Postgres and on SQLite 3.24+. After saving, the run reports each document:

```
POST /api/doclink/documents/complete
  { claim_id, done: [ <download-log record> … ], failed: [ { doc_key, code } … ] }
```

- `done` rows become `done`, and their download-log records are written **in the same transaction**. So the
  next reservation, by anyone, sees them at once. There is no gap between the run and the log flush.
- `failed` rows become `failed` and can be reserved again.
- **No local fallback in scheduled runs (D6).** Manual runs save a document locally when the ECM refuses it.
  A scheduled run doesn't: it reports the document `failed` with the `ECM_*` / `RECON_*` code, and the next
  check tries it again.

### 5.4 Four safeguards

1. **Lease and heartbeat.** A claim is valid for 10 minutes. While running, the winner calls `heartbeat` every
   2 minutes from the existing `holdWorker` loop. That one call extends the slot **and** every document it
   holds in progress (same `claim_id`). A healthy long run keeps its claim. A closed laptop loses it 10 minutes
   after its last heartbeat.
2. **Claim token (fencing).** `heartbeat`, `reserve`, `complete` and `finish` must carry the `claim_id` that
   won. After a takeover, the old holder gets `409 CLAIM_LOST` and stops at once. Before each upload, the run
   checks that its last heartbeat succeeded within the lease. If not, it stops.
3. **Safe to repeat.** The client generates `claim_id` (UUID) **before** calling `claim`. If the response is
   lost and the client sends `claim` again with the same id, the server answers "you hold it". Repeating
   `complete` or `finish` with the same id changes nothing. Retrying a network call never creates a second winner.
4. **Losers send nothing to IREPS.** The order is: local checks → backend claim → **one** IREPS check by the
   winner. With 20 users, IREPS sees one session check, not 20.

### 5.5 What is guaranteed, and the one limit

| Case | Result |
|---|---|
| 20 DocLinks claim the same slot at once | Exactly one runs (database guarantee) |
| All seven document types open at 09:00 for one account | One DocLink runs them one after the other; nobody else starts any of them meanwhile |
| Manual and scheduled run want the same document | The scheduled run skips anything the log already has. Both at the very same moment: closed by Phase 1b (D5) |
| The winner's Chrome closes mid-run | Taken over at most 10 min after the last heartbeat. Documents already `done` are not fetched again |
| A network call is repeated | No second winner (same `claim_id`) |
| A frozen laptop wakes up after losing its claim | `CLAIM_LOST`, stops before its next upload |
| Backend down | No scheduled runs. Manual runs work as before |

**Limit.** No lock can make an upload to *another* system (ECM, S3) exactly-once in every case. A laptop that
froze for more than 10 minutes in the middle of an upload, and then finished it, could leave one extra copy.
Three things make that practically impossible or harmless:
- it takes 5 missed heartbeats;
- each upload checks the claim first;
- the existing ECM lookup (`findInEcm`) and the Recon S3 ingest (which skips rows it already has) catch the copy.

---

## 6. Example: 20 users on account 833, window 09:00-12:00, every 15 min

Seven slots open at 09:00 for account 833, one per document type. While one DocLink holds the account, it
runs them one after another; nobody else can start any of them (one run per account).

| Time | What happens |
|---|---|
| 09:00:00-09:00:30 | 20 alarms fire, each with a random 0-30 s delay. Each DocLink checks locally: is Recon signed in, is no local job running, and did this browser load an IREPS page in the last 4 minutes on account 833? Nobody is on IREPS yet. All 20 just read `GET /due` and set their next alarm for 09:15. **No IREPS request is sent.** |
| 09:07 | Priya logs in to IREPS. Her page load triggers her DocLink (D9). It claims Bill Status and **wins**: nobody else is trying. Her DocLink checks IREPS once (logged in, account 833) and runs Bill Status, then CRN, R-NOTE, MA, POs, ICs by date, ICs from notifications. Each slot ends with `finish(done)`. A heartbeat goes every 2 minutes. |
| 09:10 | Rahul logs in to IREPS. His DocLink asks `GET /due`: everything is either `done` or held by Priya. It shows "Running - Priya" and claims nothing. |
| 09:15 | The 15-min check. 20 DocLinks call `GET /due`. Suppose ICs by date is still running: 6 of them are active on IREPS and try to claim → all get `409 ACCOUNT_BUSY (Priya)`. The rest is `done` → no claim. |
| 09:21 | Priya's run ends. One IC failed because the ECM refused it, so ICs by date is `partial`. Everything else is `done`. |
| 09:30 | The 15-min check. Rahul and 4 others are active and try to claim ICs by date. **One wins.** Its reservation grants only the one missing IC, which is saved → `done`. |
| 09:45 → 11:45 | Each check: `GET /due` returns nothing for 833. No claim, no IREPS request. Alarms go to **tomorrow 09:00**. |

If 6 active users all claim at 09:00:12, the database lets exactly one win. The other 5 get
`409 {status: in_progress, holder: "Priya", lease_until: …}` and touch nothing on IREPS.

If the winner's IREPS check fails, it calls `finish(failed, IREPS_LOGIN)`. That counts no attempt, and the slot
can be claimed again at once. That DocLink won't claim again until its browser loads a new IREPS page.

---

## 7. Recon Engine changes (`recon-engine`)

### 7.1 Permissions (`backend/app/permissions.py`)

- `DOCLINK_SCHEDULE_RUN = "doclink.schedule.run"`: `due`, `claim`, `heartbeat`, `finish`, `reserve`, `complete`.
- `DOCLINK_SCHEDULE_MANAGE = "doclink.schedule.manage"`: create, edit and delete schedules.
- Add both to `ALL_PERMISSIONS` (admin). Add `run` to the roles chosen in D2.
- Reading schedules and today's slots: every signed-in user (`READ`).

### 7.2 Tables (`backend/db/models.py`, one Alembic migration)

| Table | Columns | Constraints |
|---|---|---|
| `doclink_schedules` | id, ireps_account_id, doc_type, window_start (`"09:00"`), window_end (`"12:00"`), check_every_minutes (15), days (JSON, default all 7; 0 = Sunday, IST), destination (`ecm`/`s3`), lookback_days, enabled, created_by, updated_by, created_at, updated_at | One schedule per (ireps_account_id, doc_type). window_end > window_start. check_every_minutes ∈ {15, 30, 60}. Destination fixed by type: exports `s3`, PDFs `ecm` |
| `doclink_schedule_accounts` | ireps_account_id (PK) | Row-lock target for "one run per account" (5.2) |
| `doclink_schedule_slots` | id, schedule_id, ireps_account_id, doc_type, slot_date, window_start_at, window_end_at, status (`pending`/`in_progress`/`partial`/`failed`/`done`/`failed_final`/`missed`), claim_id, holder_user_id, done_by_user_id, lease_until, attempts, next_try_at, started_at, ended_at, code, result (JSON), updated_at | **unique (schedule_id, slot_date)**: one slot per type per day; index (ireps_account_id, status) |
| `doclink_document_status` | id, ireps_account_id, destination, doc_key, status (`in_progress`/`done`/`failed`), claim_id, holder_user_id, lease_until, code, updated_at | **unique (ireps_account_id, destination, doc_key)**; index (claim_id) |

Also add an index on `doclink_downloads (ireps_account_id, destination, doc_key)` for step 1 of the reservation.

### 7.3 Endpoints (new `backend/app/schedules.py`, router included behind `require_user`)

| Method and path | Permission | Request → response |
|---|---|---|
| `GET /api/doclink/schedules?account=` | READ | → `{ schedules: [...] }` |
| `POST /api/doclink/schedules` | manage | schedule → `201 { schedule }`. Validates times, days, type, destination |
| `PUT /api/doclink/schedules/{id}` | manage | schedule → `{ schedule }`. Today's slots that haven't started yet are rebuilt |
| `DELETE /api/doclink/schedules/{id}` | manage | → `204`. Pending slots are removed; finished ones are kept for history |
| `GET /api/doclink/schedule/due?account=&types=` | run | `types` (optional, comma list such as `billStatus,crn`): answer only for those types, the ones in the caller's `schedular_phase1.documents`; `next_check_at` then ignores the other types too. Creates today's slot for each schedule once its window has opened (`INSERT … ON CONFLICT DO NOTHING`), and marks slots past `window_end_at` `missed`. → `{ due: [slot], running: slot\|null, next_check_at }`. `due` lists only slots that can be claimed **now**: `done` slots never appear again that day. `next_check_at` is the next check tick (09:15, 09:30, …) while any slot of the account is not done, otherwise the next day's window start |
| `POST /api/doclink/schedule/claim` | run | `{ slot_id, claim_id, ireps_account_id }` → `200 { slot, lease_until, params }` or `409 { code: SLOT_TAKEN \| SLOT_DONE \| ACCOUNT_BUSY \| NOT_DUE, holder, lease_until }`. `params` are the **server-computed** IREPS inputs (date range in `DD/MM/YYYY`, Bill Status mode) |
| `POST /api/doclink/schedule/heartbeat` | run | `{ claim_id }` → `{ lease_until }` (the slot and its in-progress documents), or `409 CLAIM_LOST` |
| `POST /api/doclink/schedule/finish` | run | `{ claim_id, outcome: done\|failed, code, counts_as_attempt, result }` → `{ slot }`. Idempotent per `claim_id` |
| `POST /api/doclink/documents/reserve` | run | section 5.3 → `{ granted, taken }`. `409 CLAIM_LOST` when the claim is gone. At most 100 keys |
| `POST /api/doclink/documents/complete` | run | section 5.3 → `{ done: n, failed: n }`. Writes the `doclink_downloads` rows in the same transaction |
| `GET /api/doclink/schedule/today?account=` | READ | → today's slots with status, holder name, times, result (for the panel) |

Notes:
- Each `claim`, `finish` and takeover is written to the audit log with `record_event` (`doclink.schedule_claimed`, …).
- All dates and times use `IST = ZoneInfo("Asia/Kolkata")`, as in `downloads.py`. Slots are built from the server clock.
- `result` is a small summary only (counts, file names, codes): no IREPS HTML, no tokens.
- Timings are constants in `schedules.py`: `LEASE = 10 min`, `HEARTBEAT = 2 min`, `RESERVE_MAX = 100`.
  The window and check interval come from each schedule (default 09:00-12:00, 15 min). A failed or `partial`
  slot's `next_try_at` is the next check tick.

### 7.4 Backend tests (`backend/tests/test_doclink_schedule.py`)

These prove the design. Run them against SQLite **and** a Postgres instance (`DATABASE_URL`). Use real threads, one session each.

- 20 threads claim one slot → exactly 1 `200`, 19 `409`.
- **Once a day:** after `finish(done)`, `due` returns no slot for that type for any user until the next day,
  and `claim` gives `409 SLOT_DONE`, including at every later check (09:15 … 11:45).
- The window: `claim` before 09:00 or after 12:00 → `409 NOT_DUE`. An unfinished slot after 12:00 → `missed`.
- `next_check_at` follows the 15-min ticks while a slot is open. Once everything is done → tomorrow 09:00.
- `partial` → claimable at the next tick. The reservation grants only the documents not yet `done`.
- `due?types=billStatus,crn` returns no slot of any other type, and its `next_check_at` ignores them.
- Two slots of one account claimed together → only one `in_progress`.
- 20 threads reserve overlapping key sets → every key granted exactly once.
- An expired lease can be claimed again (inside the window), and `attempts` goes up.
- After a takeover, the old `claim_id` gets `CLAIM_LOST` on heartbeat, reserve, complete and finish.
- `claim` repeated with the same `claim_id` → `200` "you hold it". `finish` repeated → no change.
- A key already in `doclink_downloads` for the account → `taken` (done), whoever logged it.
- `complete` writes the log rows. A later `reserve` by another user sees them.
- Slot creation in IST: one per type per day, weekdays, window start and end, `missed`. No slots are created
  for past days.
- Permissions: without `run`, every run endpoint gives `403`. Without `manage`, schedule writes give `403`.
- `params`: the look-back range is computed in IST correctly across midnight UTC.

---

## 8. DocLink changes (`ireps_portal_mock`)

### 8.1 Step 0: awaitable jobs (refactor, no behaviour change)

The `start*` handlers in `background/service-worker.js` run their work inside `holdWorker(...)` and return
`{ started: true }`. The scheduler needs the outcome. For each schedulable job, split out an awaitable runner
and keep the `start*` wrapper unchanged:

| Today | New awaitable runner |
|---|---|
| `startDownloadJob` | `runBillStatusJob(options, hooks)` |
| `startDocumentDownloadJob` | `runDocumentJob(criteria, options, hooks)` (CRN, R-NOTE) |
| `startMaSearch` + `startMaDownload` | `runMaJob(options, hooks)`: search, then download every row found |
| `startBatch` → `runBatch` | `runBatchJob(kind, params, hooks)` (`po-date`, `ic-date`, `ic-notif`) |

`hooks` replaces the panel-only pieces. For manual runs it holds today's behaviour:
- `ask: askPanel(panelTabId)`;
- the per-user `preflight` and `onSaved`.

For scheduled runs it holds the shared versions (8.3). The pieces that change:
- `saveExportFile` (`services/export-save-service.js`) takes `target.ask`;
- `documentRunHooks` takes the hook overrides.

Done when `npm test` passes with the same counts and manual runs on the mock behave exactly as before.

### 8.2 New modules (`services/scheduler/`)

| File | Content |
|---|---|
| `schedule-api.js` | The calls in 7.3, through `fetchWithDeadline` and the same Recon base URL, credentials and error mapping as `download-log.js` `request()`. Maps `409` codes to `SCHEDULE_*` |
| `local-signals.js` | Reads and writes the local signals (8.4): last IREPS activity, last verified IREPS account, last failed IREPS check. Only timestamps, tab ids and the account id; never URLs with tokens, never page content |
| `scheduler.js` | `createScheduler({ api, signals, runners, irepsCheck, isBusy, alarms, badge, broadcast, now, random })` → `{ wake(trigger), getState() }`. Holds the logic of 8.4 and 8.5. No `chrome.*` inside, so it is testable |
| `shared-run-hooks.js` | The scheduled versions of `preflight` / `onSaved` / export save: reserve before download, complete after, claim check before each upload (8.3) |

Wiring lives in a new `background/scheduler-job.js`, created from the worker the way `bill-upload-job.js` is.
Imported by the worker only, so `scripts/build.mjs` needs no new entry point.

### 8.3 How a scheduled run saves documents

- **PDF runs** (MA, PO by date, IC by date, IC notifications): `preflight(items)` calls `reserve` in batches
  of 10. Items not granted are marked skipped, with "Already saved by <name> on <date>" (existing `skip`
  shape, new reason `SKIP_REASON.ALREADY_SAVED_BY_ACCOUNT`). `onSaved` collects the download-log record, and
  `complete` is sent per batch. A failed item is reported `failed`.
- **Exports** (Bill Status, CRN, R-NOTE): the export key is reserved the same way before `saveExportFileTo`.
  The record carries `ireps_account_id`; manual export records don't carry it today, so add it there too.
- **Destination is fixed: S3 / ECM, never local (D6).**
  - The scheduled hooks call the runners with destination `recon` (the stored value of "ECM / S3"),
    whatever the panel's switch says.
  - The ECM saver is built so that "save locally instead" isn't possible. The scheduled `saveFile` hands
    `saveToEcmOrLocally` a local saver that only throws `SCHEDULE_DESTINATION_REFUSED`, carrying the ECM code.
  - For exports, a failed Recon upload in `saveExportFileTo` stays a failure: nothing is downloaded.
  - Either way the document is reported `failed`, and the slot ends `partial` or `failed`.
  - A test checks that a scheduled run never calls `downloadBytes` (`chrome.downloads`).
- **Before each upload:** if the last successful heartbeat is older than the lease minus one heartbeat, stop
  the run with `SCHEDULE_CLAIM_LOST`.
- **Duplicate questions:** `ask` is not used. A scheduled run never asks "download again?".
- **`complete` fails** (network): it is retried 3 times within the run. If it still fails, the records go to
  the normal download-log queue (`logDownload`). The documents' leases run out, and a later reservation sees
  them through the log once the queue is flushed.

### 8.4 When DocLink checks, and the order of checks

**Triggers** (each ends in `scheduler.wake(trigger)`, debounced 15 s):
1. `chrome.alarms` `doclink.scheduler` at the backend's `next_check_at`, plus a random 0-30 s delay (D1).
   Inside the window that is the next 15-min tick. Once every slot of the account is done, it is the next
   day's 09:00, so DocLink stays quiet for the rest of the day.
2. `chrome.tabs.onUpdated`, when a tab on the configured IREPS origin finishes loading a page that isn't the
   login page. This also records the IREPS-activity signal. Inside the window this starts a check at once
   (D9). Outside the window it only records the signal.
3. The panel sends `SCHEDULE_NUDGE` after a Recon sign-in and after a passing IREPS session check.
4. `runtime.onStartup`, `runtime.onInstalled`, and the end of any local job.

**Order inside `wake`.** It stops at the first step that doesn't pass:

```
0. schedular_phase1.enabled and at least one listed type?   (no → stop; nothing below runs, see 8.9)
1. Recon signed in?                     (reconWhoAmI; no → badge "Sign in to Recon", stop)
2. Last verified IREPS account known?   (local signal; none → stop)
3. GET /schedule/due?account=…&types=… (only the types in schedular_phase1.documents;
                                         nothing due → set alarm at next_check_at, stop)
4. Local job running?                   (isBusy: any job, batch or bill upload → stop, retry at end of that job)
5. IREPS activity in the last 4 min, and no failed IREPS check since?   (no → wait for a trigger, stop)
6. Slot type in schedular_phase1.documents?  (no → skip that slot; never claimed by this DocLink)
   POST /schedule/claim                 (409 → show holder, alarm in 2-3 min, stop)
7. IREPS session check + account check  (the winner only; fail → finish(failed, counts_as_attempt=false), stop)
8. Run the job with shared hooks and params from the claim; heartbeat every 2 min
9. POST /schedule/finish                (done / failed with code)
10. Next due slot of the same account?  → back to 3 (one at a time)
```

Steps 1-6 never contact IREPS. Step 7 happens only in the one DocLink that won. So DocLink never polls IREPS,
and the IREPS session is never kept alive by the scheduler.

**IREPS session lost during the run** (`IREPS_SESSION_EXPIRED`): finish with `failed`, `counts_as_attempt=false`.
Anyone may claim again at once. Documents already `done` stay done.

### 8.5 Heartbeat

`scheduler.js` starts a 2-minute timer when the claim succeeds. The run already holds the worker through
`holdWorker`, so the worker stays alive.
- A heartbeat answered `CLAIM_LOST` aborts the run between documents. The run keeps what is already done.
- A heartbeat that fails on the network is retried at the next tick. Uploads stop once the lease could have
  run out (8.3).

### 8.6 Panel (`popup/popup-schedule.js`, Schedule view)

- **Today:** one row per slot of the current account. It shows the type, the time and the status:
  - "Waiting for an IREPS user", "Running - Priya", "Done by Priya at 10:06 - 1 saved, 2 already saved",
    "Missed", "Failed: <text>".
- **Schedules:** for users with `manage`. Per document type: on/off, daily window (default 09:00-12:00),
  check interval (15 / 30 / 60 min, default 15), weekdays (default every day), look-back days. The destination
  is fixed by type (D6). "Apply to all types" sets the same window for every type.
- **Banner** when this DocLink can't take part. The reasons: not signed in to Recon, IREPS account not
  verified, or no `doclink.schedule.run` permission.
- **Badge** (`chrome.action.setBadgeText`, no permission needed): `!` when a slot of this account is due and
  this user could run it by opening IREPS.

`showView()` in `popup.js` gets the new view, `popup.html` the markup, `popup.css` the styles.

### 8.7 Messages and error codes (`utils/messages.js`)

- **Messages:** `SCHEDULE_GET_STATE`, `SCHEDULE_NUDGE`, `SCHEDULE_SAVE`, `SCHEDULE_DELETE` (the worker
  forwards these to the backend), and `SCHEDULE_STATE` (broadcast).
- **Storage keys:** `doclink.scheduler.signals` (session storage) and `doclink.scheduler.account` (local storage).
- **Error codes, each with `describeError` text:**
  - `SCHEDULE_SLOT_TAKEN`, `SCHEDULE_SLOT_DONE`, `SCHEDULE_ACCOUNT_BUSY`, `SCHEDULE_CLAIM_LOST`
  - `SCHEDULE_NO_PERMISSION`, `SCHEDULE_ACCOUNT_UNVERIFIED`, `SCHEDULE_BACKEND_UNAVAILABLE`
  - `SCHEDULE_MISSED`, `SCHEDULE_INVALID`, `SCHEDULE_DESTINATION_REFUSED`

### 8.8 Manifest

Add `"alarms"` to `permissions` (D1, needs approval) and bump `version` to 1.6.1. No new `host_permissions`:
the scheduler API is on the Recon origin, which is already listed.

### 8.9 The `schedular_phase1` setting (D10)

`schedular_phase1` does two jobs. It switches scheduling on or off for this DocLink build, and it lists
**which document types** the scheduler may trigger. A type that isn't in the list is never triggered
automatically by this DocLink. It can still be downloaded by hand.

**In `config.json`:**

```json
"//schedular_phase1": "Scheduled downloads, Phase 1 (S3 / ECM only). enabled: true = this DocLink takes part in the shared schedules kept in the Recon Engine; false = no scheduling at all. documents: the document types the scheduler may trigger - BillStatus, CRN, RNote, MA, PO, IC. Remove a name and that type is never triggered automatically (manual downloads are unchanged). config.local.json may override the whole block.",
"schedular_phase1": {
  "enabled": true,
  "documents": ["BillStatus", "CRN", "RNote", "MA", "PO", "IC"]
}
```

**The names and what each one schedules:**

| Name in `documents` | Scheduled run(s) | Saved to |
|---|---|---|
| `BillStatus` | Bill Status export | S3 |
| `CRN` | CRN export | S3 |
| `RNote` | R-NOTE export | S3 |
| `MA` | MA copies (search, then every row) | ECM |
| `PO` | POs by PO date | ECM |
| `IC` | ICs by IC date **and** ICs from notifications | ECM |

Example: with `"documents": ["BillStatus", "CRN", "RNote", "MA", "PO"]`, IC is never triggered automatically by
this DocLink. Bill Status, CRN, R-NOTE, MA and PO still run in the 09:00-12:00 window.

**How it is read.**
- Through `readConfigFiles()` (`utils/config.js`), like every other setting. No new `fetch("config.json")`.
- A small `loadSchedulerConfig()` returns `{ enabled, documents: Set<scheduleType>, unknown: string[] }`.
  It maps the names above to the backend's schedule types (`billStatus`, `crn`, `rnote`, `ma`, `poDate`,
  `icDate` + `icNotifications`).
- Names are matched after trimming, ignoring case (`"rnote"` = `"RNote"`).
- `config.local.json` can override it. Top-level keys replace, so it replaces the **whole**
  `schedular_phase1` block: `enabled` and `documents` together.

**Fail closed.** Scheduling is on only when **both** of these hold:
- `enabled` is the JSON value `true`;
- `documents` is an array that names at least one known type.

Everything else means **off**:
- `enabled: false`;
- a missing block or a missing `enabled`;
- `"true"` as a string, `1`, `null`;
- `documents` missing, empty, or not an array;
- a config file that can't be read.

An unknown name (a typo such as `"BilStatus"`) is ignored. It is logged as a warning, and the Schedule view
shows "Unknown document type in config: BilStatus", so a typo can't silently turn a type off unnoticed.

**How the list is applied.** It is checked at three places, so a type left out can never run:
1. `GET /schedule/due?account=…&types=billStatus,crn,…`: the backend returns only slots of those types.
2. Before `claim`, the scheduler checks the slot's type against the list again, in case the backend ignored
   the filter.
3. In the runner table: `scheduler-job.js` passes the scheduler only the runners of listed types. An unlisted
   type has no runner in this DocLink at all.

**What happens to an unlisted type's slots.** The slots stay in the backend, and any other DocLink whose
config lists that type can run them. If **no** DocLink lists it (every user has the same build), the slots
are never claimed and become `missed` at 12:00. The Today list shows those types as "Not scheduled in this
DocLink". To stop a type cleanly for everyone, also disable its schedule in the Recon Engine, so no `missed`
rows pile up.

**What `enabled: false` turns off:**
- no `chrome.alarms` alarm is created, and any left over from an earlier `true` is cleared
  (`chrome.alarms.clear("doclink.scheduler")` at worker start);
- the `tabs.onUpdated` and `SCHEDULE_NUDGE` triggers return at step 0 (8.4);
- no request goes to the `/api/doclink/schedule*` or `/documents/reserve|complete` endpoints;
- no badge;
- the Schedule view is hidden in `showView()` / the panel's navigation.

Manual downloads, the download log and everything else are unchanged.

**What `enabled: true` turns on:** everything in this section 8, for the listed types only. The schedules
themselves still live in the Recon Engine. With `true` and no schedule created (or every schedule disabled),
DocLink still downloads nothing by itself.

**Two levels of switch:**

| Switch | Who changes it | Effect | Takes effect |
|---|---|---|---|
| `schedular_phase1` in `config.json` (`enabled`, `documents`) | Whoever builds DocLink | Whether this DocLink build schedules, and which types | After a new build is installed, or after editing an unpacked copy and reloading it |
| `enabled` on a schedule in the Recon Engine | Admin (`manage`) | That account's schedule for that type runs for every DocLink, or for none | At the next check: no rebuild needed |

A type runs automatically only when **both** allow it: it is in this DocLink's `documents` list **and** its
schedule is enabled in the Recon Engine. To stop scheduled downloads for everyone at once, disable the schedules
in the Recon Engine. A build shipped with `enabled: false` never schedules, whatever the backend says.

**Build.** The production build ships the block that `config.json` holds. Release builds for Phase 1 set it on
purpose: `enabled: true` only when the backend (build-order step 1) is deployed. `scripts/build.mjs` prints
`enabled` and the resolved `documents` list, and stops the build when `documents` holds an unknown name. The
build is where a typo should be caught.

**Tests.**
- `test/node/config-tests.mjs`:
  - `enabled: true` with known names → on, with the right types (`IC` → both IC runs);
  - `enabled` false / missing / `"true"` / `1` → off;
  - `documents` missing, empty or not an array → off;
  - names are case-insensitive;
  - an unknown name is ignored and reported;
  - `config.local.json` replaces the whole block.
- `test/scheduler-tests.js`:
  - off → `wake()` makes no API call, sets no alarm and clears the old one;
  - `documents` without `IC` → `due` is asked without the IC types, an IC slot that the backend returns anyway
    is not claimed, and no IC runner exists.

---

## 9. Failure handling

| Situation | What happens |
|---|---|
| Nobody is on IREPS between 09:00 and 12:00 | Slot stays `pending`. The first user to load an IREPS page inside the window runs it. Not done by 12:00 → `missed` |
| Already done today, then a 15-min check comes round | `due` is empty for that type → no claim, no IREPS request, for every user |
| The winner isn't really logged in to IREPS | Step 7 fails → `failed`, no attempt counted → the next active user claims |
| The winner is on another IREPS account | Step 7 account check fails → same as above |
| Unverified IREPS account (not 833 / 60828) | Step 2 or 7 → no run. Never guessed |
| The winner closes Chrome mid-run | Lease runs out → another user takes over → reservations skip what's done |
| The winner's IREPS session expires mid-run | `failed`, no attempt counted → claimable at once |
| IREPS keeps answering with errors | Retried at every 15-min check until 12:00, then `missed` with the last error, shown in Today |
| The ECM or S3 refuses a document | **Not saved locally** (D6). Reported `failed` with its `ECM_*` / `RECON_*` code → the slot is `partial` → the next check fetches only that document |
| `schedular_phase1.enabled` is `false` (or the block is missing) in this DocLink | This DocLink never schedules: no alarm, no claim, no Schedule view. Other DocLinks with `enabled: true` still run the shared schedules |
| `IC` is not in `schedular_phase1.documents` | This DocLink never triggers IC by date or IC notifications. If no DocLink lists IC, IC slots become `missed` at 12:00; disable the IC schedule in the Recon Engine to stop them cleanly. Manual IC downloads are unchanged |
| A typo in `documents` (e.g. `"BilStatus"`) | The production build stops with an error. An unpacked copy ignores the name, logs a warning and shows it in the Schedule view |
| The backend is unreachable | No scheduled runs (fail closed). Badge and banner say so. Manual runs work |
| A manual run is going on locally | This DocLink doesn't claim. Other users still can |
| The schedule is edited during the day | Slots not yet started are rebuilt. Running or finished ones are left alone |

---

## 10. Testing

### 10.1 Backend

Section 7.4, plus the existing `test_doclink_downloads.py` stays green.

### 10.2 DocLink automated (`npm test`)

**`test/scheduler-tests.js`** (browser suite: `export runSchedulerTests`, `currentSuite = "scheduler"` in
`test/run-tests.js`). It uses a fake API, fake signals and a fake clock:
- the order of checks: no Recon, no account, nothing due, busy, no IREPS activity → **no claim and no IREPS
  call** in each case;
- claim lost (`409`) → no IREPS call, alarm 2-3 min;
- a winner's failed IREPS check → `finish(failed, counts_as_attempt=false)`, and no new claim until a new IREPS page load;
- a heartbeat answered `CLAIM_LOST` → the run stops between documents;
- `IREPS_SESSION_EXPIRED` mid-run → finish `failed` without counting an attempt;
- two due slots → run one after the other;
- random delay and debounce: 5 triggers within 15 s → one wake;
- `schedular_phase1` off → `wake()` makes no API call, sets no alarm, clears a leftover alarm (8.9);
- `documents` without `IC` → no IC slot is asked for, claimed or run (8.9).

**`test/node/shared-run-hooks-tests.mjs`** (node, it needs timers):
- reservations in batches of 10;
- not-granted items skipped with the right reason;
- `complete` retried 3 times, then the queue fallback;
- an upload stops when the heartbeat is stale;
- an ECM refusal or a failed S3 upload → reported `failed`, and **`downloadBytes` is never called** (no local save, D6);
- the destination is `recon` even when the panel's switch is set to Local.

**`test/node/config-tests.mjs`** (existing file): the `schedular_phase1` parsing cases listed in 8.9.

**Step 0 regression:** every existing suite passes with unchanged counts.

### 10.3 End-to-end (mock portal + local backend, two Chrome profiles)

1. Run a local `recon-engine` with two users who hold `doclink.schedule.run`, plus the mock IREPS
   (`node test/mock/mock-ireps-server.mjs`).
2. Load DocLink in **two Chrome profiles** (user A, user B), both signed in to Recon and both on mock account 833.
3. As admin, create "Bill Status + ICs from notifications, window now → now + 45 min, every 15 min".
4. At the slot time, both browsers have a recently loaded mock IREPS page. Check:
   - exactly one runs;
   - the other shows "Running - A", then "Done by A";
   - the backend's `doclink_downloads` has one row per document;
   - at the next two 15-min checks, neither browser claims or sends anything to IREPS.
5. Close A's Chrome during the IC batch (`/mock/scenario/slow`). After about 10 minutes B takes over and saves
   only the ICs A didn't finish.
6. A downloads an IC manually. The next scheduled IC run (as B) skips it as "Already saved by A".
7. Scenario `login` in A's browser: A wins the claim, fails the IREPS check and releases. B runs.
8. Stop the backend: no scheduled run, banner shown, a manual run still works.
9. Set A's panel switch to **Local**. A wins a slot: every file still goes to S3 / ECM, and nothing appears in
   A's Downloads folder.
10. Make the mock ECM refuse one IC: it isn't saved anywhere, the slot shows `partial`, and the next 15-min
    check saves only that IC.
11. Set `"enabled": false` in B's `schedular_phase1` and reload: B shows no Schedule view and sends no
    scheduler request, while A keeps running the schedules.
12. Remove `"IC"` from `documents` in **both** copies and reload: in the next window Bill Status, CRN, R-NOTE,
    MA and PO run, no IC is downloaded automatically, and the IC slots show "Not scheduled in this DocLink"
    (then `missed` at the window end). A manual IC download still works.

### 10.4 Before a client build

CLAUDE.md Definition of done, point 3. Run the built extension (`npm run build -- --allow-mock`) through
steps 3-6, and compare the IREPS requests with the last build that worked on live IREPS. Expect only the
intended differences, which should be none for IREPS.

---

## 11. Build order

| Step | Repo | Content | Done when |
|---|---|---|---|
| 1 | recon-engine | Permissions, tables, migration, `schedules.py`, reserve / complete, tests 7.4 | Tests pass on SQLite and Postgres. Deployable while unused |
| 2 | DocLink | Step 0 refactor (8.1) | `npm test` with the same counts. Manual mock runs unchanged |
| 3 | DocLink | `schedular_phase1` block (8.9), `services/scheduler/*`, `scheduler-job.js`, shared hooks (S3 / ECM only), messages, codes, `alarms` | 10.2 green. 10.3 steps 1-12 pass with schedules created through the API |
| 4 | DocLink | Schedule view, badge, banner | 10.3 done from the panel alone |
| 5 | both | README (new section "Scheduled downloads"), TESTING.md part, CLAUDE.md paragraph (DocLink and recon-engine), 10.4 | `npm run verify` passes. Docs match the code |
| 6 | DocLink | Phase 1b (optional): manual ECM / S3 runs reserve documents too (D5) | Manual and scheduled runs at the same moment never save the same document twice |

---

## 12. Files touched

**recon-engine**
- [ ] `backend/app/permissions.py`
- [ ] `backend/db/models.py`, `backend/alembic/versions/<new>_doclink_schedules.py`
- [ ] `backend/app/schedules.py` (new), `backend/app/main.py` (include router)
- [ ] `backend/tests/test_doclink_schedule.py` (new)
- [ ] CLAUDE.md / README of recon-engine (new endpoints)

**DocLink**
- [ ] `background/service-worker.js` (step 0, wiring), `background/scheduler-job.js` (new)
- [ ] `services/scheduler/schedule-api.js`, `local-signals.js`, `scheduler.js`, `shared-run-hooks.js` (new)
- [ ] `services/export-save-service.js` (`ask`, account on export records), `services/download-log.js` (new skip reason)
- [ ] `utils/messages.js`
- [ ] `popup/popup.html`, `popup/popup.css`, `popup/popup.js`, `popup/popup-schedule.js` (new), `popup/popup-recon-auth.js` (nudge)
- [ ] `manifest.json` (`alarms`, version)
- [ ] `config.json` (`schedular_phase1` block plus its `//` comment), `utils/config.js` or a small `loadSchedulerConfig()` (8.9), `scripts/build.mjs` (print the block, stop on an unknown document name)
- [ ] `test/scheduler-tests.js` (new), `test/run-tests.js`, `test/node/shared-run-hooks-tests.mjs` (new), `test/node/config-tests.mjs`
- [ ] `README.md`, `TESTING.md`, `CLAUDE.md`

---

## 13. Risks

| Risk | Handling |
|---|---|
| Duplicate upload after a laptop freezes for more than 10 min mid-upload | 5 missed heartbeats needed; a claim check before each upload; ECM lookup and S3 ingest catch it (5.5) |
| Slots missed because nobody uses IREPS in the window | Visible as `missed` in Today. Admins can widen the times. DocLink can't log in to IREPS for anyone |
| The IREPS account id reported by DocLink is wrong | Only verified accounts (833 / 60828) take part; `run` permission required; D4 mapping later |
| Backend load at each 15-min check from many DocLinks | Random delay, one cheap `due` read each, one atomic claim. Trivial for 20-100 clients |
| Users surprised that DocLink downloads without a click | Schedule view and badge show every slot and who ran it. Schedules are admin-made |
| Postgres "one run per account" across rows | Row lock on `doclink_schedule_accounts` inside the claim transaction; the concurrency test runs on Postgres |

---

## 14. Phase 2: tender documents (implemented 2026-11-17)

Asked for on 2026-11-17: tender documents every hour from 10:30 to 18:30, looking for new documents, "same
functionality as the other scheduler", flags and fields in config. Decisions taken with the user that day:

| # | Decision | Built |
|---|---|---|
| P1 | Negotiation letters (IREPS opens them very slowly) | Their own type `tenderNegotiation`, less often: 12:30, 15:30, 18:30 (repeat 180 min, retry every 30) |
| P2 | Window | Hourly runs at 10:30, 11:30 … 18:30 IST (the last at 18:30), retried every 15 min within the hour |
| P3 | LOA letters need IREPS's "LOA viewed" POST | Scheduled too: the run sends it unattended, as a manual LOA download does. **The tech lead's 15 Nov approval should be extended** |
| P4 | Where a tender run happens | A background DocLink tab, with Chrome's print-to-PDF as in a manual run (the "started debugging" bar shows briefly) |
| P5 | Config | `schedular_phase2: { enabled, documents }` beside `schedular_phase1`: NIT, CounterOffer, LOA, Tabulation, Correspondence, Negotiation. Needs the tech lead's sign-off like D10 |

**Types** (Recon Engine `TENDER_TYPES`, destination `ecm`, run after the phase 1 types, Negotiation last):
`tenderNit` (automatic mode: My Messages → NIT, attachments, My Offer, corrigenda; look-back 2), `tenderCounterOffer`,
`tenderLoa` (letters by Letter Date; 2), `tenderTabulations` (Financial + Commercial by closing date; 15),
`tenderCorrespondence` (pending letters; no date range), `tenderNegotiation` (2).

**How a tender slot runs.** The scheduler (unchanged) claims it like any slot, checks IREPS once, and calls the
tender runner (`services/scheduler/tender-runner.js`). That opens `tender/schedule-runner.html?claim=<id>` with
`chrome.tabs.create({ active: false })` and waits under `holdWorker`. The page asks READY (the worker answers only
the tab it opened: type, date range, verified account), runs the existing tender job with the shared-run hooks
installed, asks PING every 20 s (the claim is live while the worker's heartbeat is fresh), and reports DONE with its
outcome; the worker closes the tab. A closed tab gives the slot back without an attempt; 50 minutes is the limit.

**Inside the tender code** (`tender/tender-shared-run.js`, installed only in the runner tab):
- reserve before fetch: `checkAlreadyDownloaded` reserves each category's documents (`downloadKey.tender`), the
  correspondence loop each letter (`downloadKey.pending(key, "letter")`); taken ones are skipped without a question;
- ECM only: `tenderEcmSink` returns the hooks' sink (no local fallback), `createSaver` refuses any local save, and
  the `.html` copy of a rendered letter is not kept;
- report: each saved file's download-log record goes to `complete`; reserved keys not saved are released at the end;
- a separate ledger (`<account>#scheduled`) so the user's own manual (Local) history never makes a run skip;
- no Recon sign-in page (the scheduler checked the sign-in); another IREPS account logged in stops the run.

**Grouped ECM kinds** (NIT, LOA, Result) are reserved per PDF key, so a later run can still add a new LOA to an
existing tender document. They need direct ECM (`ecmBackendAws: false`, as config.json ships); through the gateway
they would be refused and, in a scheduled run, fail instead of falling back to Local.

**Not settled / to check:** the runner tab has run against the mocks only (unit and FakeIreps tests), not yet in a
real Chrome against the mock portal; a manual tender run in a panel and a scheduled one in a runner tab can hit IREPS
at the same time (the tender code does not share the worker's busy check).

---

## Appendix A: API contract (Phase 1)

The Recon Engine and DocLink are built against this appendix. If the two disagree, this appendix wins and the
code is fixed.

**Conventions**
- All paths are under the Recon Engine origin. Auth: the existing `require_user` (cookie or `rcn_` bearer).
- Timestamps: ISO 8601 in UTC with offset (`2026-11-17T03:30:00+00:00`). Days: `slot_date` = IST date
  `YYYY-MM-DD`. Times of day: IST `HH:MM`.
- Errors: `{"detail": {"error": "<CODE>", "detail": "<text>", ...extra}}`, the same shape as
  `app/downloads.py`. 409 answers add `holder` (`{user_id, name}`), `lease_until` and `doc_type` when they apply.
- Schedule types, in run order: `billStatus`, `crn`, `rnote`, `ma`, `poDate`, `icDate`, `icNotifications`, then the
  Phase 2 tender types `tenderNit`, `tenderCounterOffer`, `tenderLoa`, `tenderTabulations`, `tenderCorrespondence`,
  `tenderNegotiation`. Destination is fixed by type: `s3` for the first three, `ecm` for the rest.
- Weekdays: 0 = Sunday … 6 = Saturday, in IST.
- Constants: lease 600 s; DocLink heartbeat every 120 s.

**Permissions** (`app/permissions.py`)
- `doclink.schedule.run`: due, claim, heartbeat, finish, reserve, complete. Granted to `admin`, `tendering`,
  `tendering_approver`.
- `doclink.schedule.manage`: create, update and delete schedules. Granted to `admin`.
- `read`: list schedules, today.
- `GET /api/auth/me` already returns `permissions`, so DocLink checks these names there.

**Schedule object**

```json
{ "id": 1, "ireps_account_id": "833", "doc_type": "billStatus", "window_start": "09:00", "window_end": "10:00",
  "check_every_minutes": 10, "repeat_every_minutes": null, "days": [0,1,2,3,4,5,6], "destination": "s3",
  "lookback_days": 90, "enabled": true, "updated_at": "…", "updated_by": { "user_id": 3, "name": "Admin" } }
```

- **`repeat_every_minutes`:** `null` = once a day (one slot for the whole window). A number = one slot per
  period of that length, counted from `window_start`. Periods **start** up to and including `window_end`
  (09:00-18:00 hourly runs at 09:00 … 18:00; the 18:00 period lasts until 19:00). `check_every_minutes`
  is how often a slot not yet done is retried.
- **Defaults on create** (2026-11-17): billStatus, crn, rnote: window 09:00-10:00, every 10 min, once a day;
  ma, poDate, icDate, icNotifications: window 09:00-18:00, every 15 min, repeat every 60 min. All: all 7 days;
  enabled. `lookback_days` defaults by type:
  billStatus 90, crn 90, rnote 90, ma 2, poDate 2, icDate 2, icNotifications 1 (unused). DocLink searches 90 days
  for billStatus, crn and rnote whatever the stored look-back (19 Nov 2026; crn and rnote were 30 before).
- **Validation (400 `SCHEDULE_INVALID`):**
  - `ireps_account_id` matches `^\d{1,16}$`;
  - `doc_type` is a known type;
  - times are `HH:MM` and `window_start < window_end`;
  - `check_every_minutes` ∈ {10, 15, 30, 60};
  - `repeat_every_minutes` is `null` or ∈ {30, 60, 120, 180}, and not shorter than `check_every_minutes`;
  - `days` is a non-empty subset of 0..6;
  - `lookback_days` is 1..180.
- **Uniqueness:** one schedule per (account, doc_type), otherwise 409 `SCHEDULE_EXISTS`.

**Slot object** (`claim_id` is never included)

```json
{ "id": 12, "schedule_id": 1, "ireps_account_id": "833", "doc_type": "billStatus", "destination": "s3",
  "slot_date": "2026-11-17", "period": "day|HH:MM", "window_start_at": "…", "window_end_at": "…", "check_every_minutes": 10,
  "status": "pending|in_progress|partial|failed|done|failed_final|missed", "attempts": 0,
  "next_try_at": null, "lease_until": null, "holder": null, "done_by": null,
  "started_at": null, "ended_at": null, "code": null, "result": null }
```

- `period` is `"day"` for a once-a-day slot, else the IST start of its period (`"10:00"`); `window_start_at` /
  `window_end_at` are the period's.
- `holder` is set only while the slot is `in_progress`.
- `done_by` is set when the slot is `done`.

**Slot creation** (on `due` and `today`). For each enabled schedule of the account, of the asked types:
- if today (IST) is one of its days and the window has opened, the current slot is created if it doesn't exist
  (unique (schedule_id, slot_date, period)): the day's slot, or the slot of the period now falls in. Past periods
  of a repeating schedule are not made up; no slot is made after its window has ended.

Then each slot is closed when it can no longer run:
- `pending` / `failed` / `partial` past `window_end_at` → `missed`;
- `in_progress` past `window_end_at` whose lease has run out → `missed`.

**Claimable** means all of these:
- now is within the window;
- the status is `pending`; or `failed` / `partial` with `next_try_at <= now`; or `in_progress` with `lease_until < now`;
- no **other** slot of the same account is `in_progress` with a live lease.

| Method and path | Permission | Request | Answer |
|---|---|---|---|
| `GET /api/doclink/schedules?account=` | read | | `{ "schedules": [schedule] }` |
| `POST /api/doclink/schedules` | manage | schedule fields (defaults above) | `201 { "schedule" }`; 400 / 409 |
| `PUT /api/doclink/schedules/{id}` | manage | any of: window_start, window_end, check_every_minutes, repeat_every_minutes (`null` allowed), days, lookback_days, enabled | `{ "schedule" }`; today's day slot of a once-a-day schedule takes the new window when it has not run: `pending`; `failed` / `partial` (its `next_try_at` cleared: it retries in the new window); `missed`, reopened as `pending` (code, result, claim and times cleared) when the new window has not ended, the schedule is on and today is one of its days. `done`, `in_progress` and `failed_final` are not touched. Any other `pending` slot of today is deleted and the next look makes the right one (19 Nov 2026: before, only a `pending` slot moved) |
| `DELETE /api/doclink/schedules/{id}` | manage | | `204`; `pending` slots removed, others kept |
| `GET /api/doclink/schedule/due?account=&types=a,b` | run | `types` optional (default all); unknown names ignored | `{ "now", "due": [slot], "running": slot\|null, "next_check_at": iso\|null, "slots": [today's slots of those types] }` |
| `POST /api/doclink/schedule/claim` | run | `{ "slot_id", "claim_id", "ireps_account_id" }` (`claim_id`: 8-64 chars `[A-Za-z0-9-]`, made by the client) | `200 { "slot", "claim_id", "lease_until", "params": { "lookbackDays", "dateFrom": "DD/MM/YYYY", "dateTo": "DD/MM/YYYY" } }`; 404 `SLOT_NOT_FOUND`; 409 `WRONG_ACCOUNT` / `NOT_DUE` / `SLOT_DONE` / `SLOT_TAKEN` / `ACCOUNT_BUSY` |
| `POST /api/doclink/schedule/heartbeat` | run | `{ "claim_id" }` | `{ "lease_until" }`; 409 `CLAIM_LOST` |
| `POST /api/doclink/schedule/finish` | run | `{ "claim_id", "outcome": "done"\|"partial"\|"failed", "code": str\|null, "counts_as_attempt": true, "permanent": false, "result": object\|null }`. `result` (at most 16,000 characters of JSON; DocLink keeps it under 12,000): the counts (`found`, `saved`, `skipped`, `failed`, `notReported`, `records`), `file`, `range` (what the run searched), `detail` (why it stopped), `failures` (the first 20 documents not saved: `{ doc, code, detail }`), `failuresMore` and `warnings` (at most 5). Document numbers, codes and DocLink's texts only | `{ "slot" }`; 409 `CLAIM_LOST` |
| `POST /api/doclink/documents/reserve` | run | `{ "claim_id", "ireps_account_id", "destination": "ecm"\|"s3", "keys": [1..100] }` | `{ "granted": [key], "taken": { key: { "status": "done"\|"in_progress", "by": {user_id,name}\|null, "at": iso\|null } } }`; 409 `CLAIM_LOST` |
| `POST /api/doclink/documents/complete` | run | `{ "claim_id", "done": [log record as in POST /api/doclink/downloads], "failed": [{ "doc_key", "destination", "code" }] }` (≤ 500 each) | `{ "done": n, "failed": n }`; 409 `CLAIM_LOST` |
| `GET /api/doclink/schedule/today?account=&types=` | read | | `{ "date", "slots": [slot], "schedules": [schedule] }` |

**Rules behind the endpoints**

- **`due.next_check_at`:**
  - While the current slot of the asked types is open and not finished, it is the next check tick
    (`window_start_at + k × check_every_minutes`) after now and before `window_end_at`.
  - For a repeating schedule whose current slot is finished (or has no tick left), the start of its next
    period today.
  - Before today's window opens, it is today's window start.
  - Otherwise it is the next enabled window start on an allowed day, looking up to 7 days ahead.
  - `null` when there is no schedule.
- **`due.running`:** any slot of the account that is `in_progress` with a live lease, whatever its type.
- **`claim`:**
  - **Atomic** (5.2). The same `claim_id` that already holds the slot gets `200` again.
  - **Takeover** of an expired `in_progress`: `attempts + 1`, and the old claim's `in_progress` documents
    become `failed`.
  - **`params`:** `dateTo` = today (IST); `dateFrom` = today − (lookback_days − 1).
- **`heartbeat`:** valid while the slot is `in_progress` with this `claim_id`. Sets the slot's and this claim's
  `in_progress` documents' `lease_until = now + 600 s`.
- **`finish`:** needs the slot's current `claim_id`. Sending it again after it succeeded returns the slot unchanged.
  - `done` → `done`, `done_by` = caller.
  - `partial` → `attempts + 1`, `next_try_at` = next tick.
  - `failed` + `permanent` → `failed_final`.
  - `failed` → `attempts + 1` if `counts_as_attempt`, and `next_try_at` = next tick (or now when it doesn't count).
  - Every outcome: lease cleared; this claim's `in_progress` documents → `failed`.
- **`reserve`:**
  - The claim must be live (slot `in_progress`, this `claim_id`, account matches).
  - A key that is `done`, or that is in `doclink_downloads` for (account, destination) by any user, is `taken`
    (`done`). Keys already held by this claim are `granted` again.
  - Atomic per 5.3.
- **`complete`:**
  - The claim must be the slot's current one and `in_progress`.
  - Each `done` record: `doclink_downloads` row (caller, the slot's account) + document status `done`.
  - Each `failed` key held by this claim → `failed`.
  - One transaction.

---

## Appendix B: As built (2026-11-16)

Where the implementation differs from, or settles, the text above.

**DocLink**
- **Branch.** DocLink was branched from `user/alok/prod_integration`, not `main`: `main` lacks the November refactor this
  plan builds on.
- **Reserve up front.** A document run reserves all of its documents before the first download, in chunks of 100
  (the downloader's `preflight` sees the whole list at once), not 10 at a time. The heartbeat keeps every reservation
  of the claim alive, so the protection is the same.
- **The winner's IREPS check is one request:** the IREPS home page, which says both "logged in" and which account.
  The first time an account is unknown, it is read the same way, but only while the user is active on IREPS.
- **IREPS page loads don't call the backend after a quiet look.** After a look that found nothing to do and nothing
  running, page loads stay quiet until the backend's next check, for at most 30 minutes, so browsing IREPS does not
  call the Recon Engine on every page. The alarm and the panel's nudges always look.
- **Panel IREPS check.** The panel's own IREPS session check counts as IREPS activity when it passes.
- **ICs from notifications** writes no local manifest JSON when scheduled.
- **Exports from manual runs** still don't carry `ireps_account_id`: reading it would add an IREPS request to every
  manual export. A scheduled run therefore sees manual PDF downloads (which carry it) but not manual exports. An
  identical export from a scheduled run is caught by its own reservation.
- **New error code.** `SCHEDULE_NOT_FOUND`, for an edit or delete of a schedule that is gone.

**Timing change (2026-11-17)**
- **What changed.** Asked for by the user: Bill Status, CRN and R-NOTE once between 09:00 and 10:00, checked every
  10 minutes until done; the other Phase 1 types every hour between 09:00 and 18:00, looking for new documents.
- **Recon Engine.** New schedule field `repeat_every_minutes` and slot field `period`; the slot key became
  (schedule_id, slot_date, period). Migration `b6e2d9f4c718` was edited in place (it was never released); a database
  that already ran it must be downgraded one step and upgraded again. `TIMING_DEFAULT` holds the new defaults;
  `check_every_minutes` also accepts 10. Schedules created before the change keep their timing (none were deployed).
- **DocLink.** The scheduler core needed no change: it already runs whatever slots `due` returns, one at a time.
  The Schedule view gained a "Runs" choice (once a day, every 30 min / hour / 2 h / 3 h) and the 10-min retry, new
  schedules start from `SCHEDULE_DEFAULT_TIMING` (`schedule-types.js`, the backend's defaults), and an hourly type
  shows its latest run, the next run and the earlier runs of the day folded into one line.
- **Hourly runs and IREPS.** An hourly run still needs a user active on IREPS in that hour (the scheduler never keeps
  IREPS alive). An hour nobody covers is `missed`; the next run searches the same look-back range, so nothing is
  lost, only later.
- **Retry inside the hour.** Every 15 minutes (the user did not set it), plus any IREPS page load.
- **The last run starts at 18:00** (user, 2026-11-17): for a repeating schedule `window_end` is the start of the last
  period, which lasts its full length (18:00-19:00). Once-a-day windows still end at `window_end`.

**Recon Engine** (as reported by its implementation; contract check below)
- **Window and due.** The window includes its start and excludes its end. `due` and `today` require `account`.
- **`NOT_DUE`** also covers `failed_final` / `missed`, a disabled or deleted schedule, and a `next_try_at` still ahead.
- **Claims.** A repeated claim with the same `claim_id` also renews the lease. A `claim_id` reused for another slot
  gets `400 CLAIM_ID_REUSED` (DocLink makes a new UUID per claim).
- **Expired lease.** An expired lease still works for heartbeat / reserve / complete / finish until someone else
  has claimed the slot.
- **Postgres.** The Postgres variants of the concurrency tests were skipped (no `TEST_POSTGRES_URL`): **run them
  against a Postgres before deploying.**

**Contract check.** DocLink's `schedule-api.js` was run against a local Recon Engine (temporary SQLite database,
an admin and two tendering users). 22 of 22 checks passed:
- 20 concurrent claims from two users gave exactly one winner;
- another slot of the account was `ACCOUNT_BUSY` while one ran;
- a reservation without the claim was refused;
- after `done` the slot was not due for anyone and a new claim got `SLOT_DONE`;
- a key saved by one user was taken for the other;
- a lost IREPS session gave the slot back without an attempt;
- `today` showed who ran it.

**Logs and 90 days (2026-11-19)**, asked for after a day of live runs ("5 failed" with no way to see which):
- **Each failed document is named, with its reason.** The shared hooks keep the real reason of a save (the ECM's
  code and text, not the downloader's "Chrome could not save the file"); the tender code reports each failure
  (`documentFailed`); a document a stopped run never reached says so. `finish.result` carries `range`, `detail`,
  the first 20 `failures` and `failuresMore` (Appendix A), so every user of the account sees them in Today.
- **This browser's run log** (`services/scheduler/run-log.js`): each run with what it saved, skipped and could not
  save, and the scheduler's decisions (why a due slot did not run here). The Schedule view lists it, and copies or
  saves it as text.
- **Bill Status, CRN and R-NOTE search the last 90 days** whatever the look-back (Bill Status: IREPS "Last 90
  Days"; CRN / R-NOTE: 90 days up to the claim's `dateTo`). The Recon Engine's default look-back for crn / rnote is
  90 too.
- **A time changed after a missed window runs today.** The Recon Engine's `PUT` reopens today's missed day slot
  (Appendix A). The Schedule view also kept redrawing a box being edited when the worker's state changed, so a Save
  could send the old time: a box with unsaved changes is now kept as it is.
- The Recon Engine part is a patch on `user/alok/doclink_schedule` (`Wabtec/docs/patches/2026-11-19-recon-schedule-time-change-and-90-days.patch`),
  not committed: 38 backend tests pass (3 Postgres variants skipped).

**Not yet done:**
- the end-to-end run in two Chrome profiles (TESTING.md, "Scheduled downloads");
- the built extension against the mock portal (CLAUDE.md Definition of done, point 3);
- the tech lead's sign-off on `schedular_phase1` (D10);
- the Postgres concurrency run.

