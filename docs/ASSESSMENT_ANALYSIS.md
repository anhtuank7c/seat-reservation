# Assessment Analysis — What the Interviewer Is Actually Looking For

A reading of `Technical Assignment.txt`, separating what it *literally asks for* from what it is
*really evaluating*, and mapping both onto the concrete artifact in this repo.

> The brief says it plainly: *"The objective is not to build a perfect production system, but to
> demonstrate how you think as a senior engineer when designing and implementing a business-critical
> workflow."* So this submission optimises for **judgment made visible**, not feature count.

---

## 1. Explicit functional requirements

| # | Requirement (from the brief) | Where it lives |
|---|---|---|
| R1 | Display **3 available seats** | seeded in `src/app.ts` (`seatCount = 3`) |
| R2 | Seats reserved only by **authenticated users** | `ReservationService._requireSession` gates every action |
| R3 | **Login with session expiry at 90 days** | `AuthService` — `expiresAt = now + 90d`, enforced per request |
| R4 | **Select a seat** | `holdSeat` — atomic hold with a TTL |
| R5 | **Proceed to payment** | `pay` — creates a gateway intent for the held seat |
| R6 | **Reserve the seat upon payment completion** | `confirmPayment` — webhook commits the reservation |

These are the easy part. They are table stakes, not the differentiator.

## 2. The real evaluation rubric (the interviewer's lens)

The brief enumerates exactly what is being judged. Each maps to a concrete decision here:

| What they grade (their words) | How it shows up in this submission |
|---|---|
| **Engineering judgment** | Scope cut to the core workflow; a tiny dependency-free harness instead of a half-built app. |
| **System-design thinking** | Clear seat state machine; services depend on injected `Clock`/`Gateway`/`Store` seams. |
| **Software quality** | Small single-responsibility classes, typed `ReservationError`, 12 readable tests. |
| **Operational awareness** | Idempotent webhooks, lazy expiry + a sweeper hook, Payment/Reservation rows as an audit trail. |
| **Security considerations** | AuthN + 90-day expiry, ownership checks (no IDOR), HMAC-signed/verified webhooks. |
| **Thoughtful trade-offs** | Documented below and in the README, not hand-waved. |
| **Edge / failure cases** | Double-book race, paid-but-expired, declined, duplicate webhook, forged signature — each tested. |
| **System reliability** | "Money and inventory never disagree" is the invariant every path is built around. |
| **Ability to explain compromises** | This document + the trade-offs table. |

## 3. The real concerns of *this* business (seat reservation / ticketing)

This is the heart of the assessment — the domain hazards a senior engineer is expected to
anticipate *before* being told about them:

| Hazard | Why it bites | Demonstrated by |
|---|---|---|
| **Double-booking / oversell** | Concurrent buyers, one seat. The classic check-then-act race. | optimistic locking via atomic compare-and-swap in `holdSeat`; `UNIQUE(seat)` reservation backstop |
| **Checkout holds & TTL** | A seat must be reserved *during* payment, not given away mid-flow. | `HELD` state with `heldUntil` |
| **Abandoned checkout** | Users leave; inventory must not be locked forever. | lazy expiry (`isClaimableAt`) + `releaseExpiredHolds` sweeper |
| **Payment ↔ reservation consistency** | Charging (external) and reserving (our DB) can't share one transaction. | hold-before-charge ordering; idempotent `confirmPayment` |
| **Money taken, no seat** | Hold lapsed or lost after charge — the worst outcome. | automatic **refund** compensation path |
| **Webhook reliability** | Providers retry and can deliver duplicates/out-of-order. | idempotency on `Payment` status + key |
| **Webhook authenticity** | A webhook URL is public; anyone can POST a fake "paid". | HMAC sign + constant-time `verify` |
| **Fairness** | One actor shouldn't lock all inventory. | one-active-hold-per-user rule |
| **Session security** | 90-day sessions are long; theft/revocation matter. | server-side revocable sessions; `logout` |
| **Observability / audit** | Money is involved — every transition must be reconstructable. | `Payment` + `Reservation` rows are the ledger |

## 4. Concern → what's being probed → how this harness answers it

| Probe | Test (`node --test`) |
|---|---|
| Do you prevent double-booking under real concurrency? | *two buyers race → exactly one wins* |
| Do you understand *why* the naive version is wrong? | *naive hold reproduces the double-book bug* |
| Do abandoned holds free inventory? | *hold expires after TTL → claimable again* |
| Are payment webhooks safe to retry? | *duplicate webhook is idempotent* |
| What if money is taken but the seat is gone? | *paid but expired → refund, no reservation* |
| What on a declined charge? | *declined → no reservation; hold releases at TTL* |
| Is the 90-day session enforced exactly? | *auth required and 90-day expiry enforced* |
| Can one user act on another's hold? | *ownership / no IDOR* |
| Final guard against overselling? | *oversell backstop* |
| Inventory hoarding? | *one seat held at a time* |
| Forged webhooks? | *forged signature rejected* |

## 5. Trade-offs & deliberate omissions

Stated up front, because *explaining compromises* is itself on the rubric.

| Decision | Chosen here | Production path | Why this is fine for the assessment |
|---|---|---|---|
| Persistence | In-memory `Map`s | Postgres / SQLite | Concurrency semantics modelled with versioned CAS — the *logic* is identical. |
| Concurrency control | Optimistic locking (versioned compare-and-swap) | Pessimistic locking (`SELECT … FOR UPDATE`) or DB-level optimistic locking (`UPDATE … WHERE version=?`) | CAS is the same invariant; swap the store, keep the service. |
| Hold expiry | Lazy + optional sweeper | Background cron / queue | Lazy expiry is correct on its own; the sweeper is just tidiness. |
| Sessions | Server-side, revocable | DB sessions / signed cookies | Models true 90-day expiry **and** revocation; JWT would trade revocability for statelessness. |
| Payments | In-repo mock gateway | Stripe + real webhooks/retries | Exercises idempotency, signing, and refunds without an account or network. |
| Auth method | Passwordless "who are you" | Magic link / OAuth / credentials | The login mechanism is an integration detail, not the core workflow under test. |
| Transport | None (pure logic) | HTTP API + UI (SvelteKit etc.) | The business invariants live below the transport; this isolates and proves them. |
| Multi-seat orders, pricing, rate-limiting | Omitted | Add as needed | Out of scope for a 2-hour, judgment-focused exercise; noted, not pretended. |

## 6. One-paragraph summary for the reviewer

The genuinely hard parts of a seat-reservation business are **not** the UI or the CRUD — they are
*never double-booking a seat under concurrency* and *never letting money and inventory disagree*.
This submission isolates exactly those, models them with real concurrency (versioned compare-and-swap
plus a unique-constraint backstop) and a real payment lifecycle (signed, idempotent webhooks with a
refund compensation path), and proves each edge case with an executable test — while documenting
every shortcut taken to fit the time-box.
