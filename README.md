# Seat Reservation — Core Business Logic (TypeScript, in-memory)

A small, **zero-runtime-dependency** TypeScript model of the hard parts of a seat-reservation
platform: holding a seat, paying for it, and reserving it on payment completion — built to make the
*engineering judgment* visible rather than to ship a full app.

> See [`ASSESSMENT_ANALYSIS.md`](./docs/ASSESSMENT_ANALYSIS.md) for how this maps to what the assignment
> is actually evaluating.

## Documentation

| Document | What it covers |
|---|---|
| [`docs/C4-Model.md`](./docs/C4-Model.md) | C4 architecture: System Context → Container → Component → Code, plus Dynamic & Deployment views, with each component mapped to its source file. |
| [`docs/BA-Requirements.md`](./docs/BA-Requirements.md) | Business analysis: problem statement, actors, business rules (BR-1…11), use cases, NFRs, edge cases, risks, and a requirement→test traceability matrix. |
| [`docs/Sequence-Diagrams.md`](./docs/Sequence-Diagrams.md) | Mermaid sequence + state diagrams for every flow (login, hold, the concurrency race, pay/confirm, refund, declined, duplicate webhook). |
| [`ASSESSMENT_ANALYSIS.md`](./docs/ASSESSMENT_ANALYSIS.md) | How the build maps to what the assessment is evaluating, plus trade-offs. |

## Why this shape

The real risks in this business are **double-booking under concurrency** and **money/inventory
drifting out of sync** — not the UI or CRUD. So this repo strips away the database, framework, and
transport and keeps only the logic where those risks live, then proves it with executable tests.

## Run it

Requires **Node ≥ 22.18** (or ≥ 23.6). The `.ts` files run directly on Node's native type
stripping — **no build step and no runtime dependencies**.

```bash
node --test          # the full business-case suite (12 tests)
node demo.ts         # a narrated walk-through of the headline scenarios

# optional — full static type-check (installs dev-only typescript + @types/node):
npm install
npm run typecheck    # tsc --noEmit, strict mode
```

> On older Node (22.6–22.17) add `--experimental-strip-types`, or run via `npx tsx --test` /
> `npx tsx demo.ts`. The TypeScript is fully strict-mode clean (`npm run typecheck` → 0 errors).

## The seat state machine

```
                 holdSeat (atomic CAS)            confirmPayment (valid hold)
   AVAILABLE ─────────────────────────▶ HELD ──────────────────────────────▶ RESERVED
       ▲                                 │
       └──── TTL lapses / cancel / ──────┘
             payment declined
```

- **HELD** carries `heldUntil`; an expired hold is treated as free on the next claim (lazy expiry).
- **RESERVED** is terminal and backed by a `UNIQUE(seat)` reservation row — the oversell backstop.

## Architecture

Small classes with single responsibilities; time and payments are **injected** so every rule is
deterministically testable.

| File | Responsibility |
|---|---|
| `src/domain.ts` | Entities + invariants (`Seat.isClaimableAt`, status unions) |
| `src/store.ts` | In-memory store with **versioned compare-and-swap (CAS)** + **unique constraints** |
| `src/clock.ts` | `Clock` interface · `SystemClock` / `FakeClock` — time as an injectable input |
| `src/payment-gateway.ts` | Mock provider: idempotent intents + **HMAC-signed webhooks** |
| `src/auth-service.ts` | Login + **90-day**, revocable, server-side sessions |
| `src/reservation-service.ts` | **The core**: hold / pay / confirm / cancel / sweep |
| `src/app.ts` | Wires it together and seeds 3 seats |
| `src/types.ts` | Shared structural types |
| `test/reservation.test.ts` | One test per business concern (`node:test`) |
| `demo.ts` | Narrated scenarios |
| `tsconfig.json` | Strict config for `npm run typecheck` |

## How the core guarantees hold

- **No double-booking** — `holdSeat` reads the seat, then commits with `compareAndSwapSeat(seat,
  expectedVersion)`. The version check and write are one synchronous critical section, so only one of
  N racing buyers wins. `holdSeatNaive` is kept *intentionally broken* to show the race the CAS
  prevents (test #3).
- **Money ↔ inventory consistency** — the seat is **HELD before charging**; `confirmPayment` is
  idempotent (replays return the prior outcome), commits via a `UNIQUE(seat)` reservation, and
  **refunds** if the charge succeeds but the hold is gone.
- **Webhook trust** — every event is HMAC-signed and verified in constant time before it is acted on.
- **Self-healing inventory** — abandoned holds lapse via TTL; `releaseExpiredHolds` is the hook where
  a production cron/queue would live.

## What this deliberately omits

In-memory instead of a DB, optimistic locking (versioned compare-and-swap) instead of pessimistic
locking (`SELECT … FOR UPDATE`), a mock gateway instead of
Stripe, passwordless login, and no HTTP/UI layer. Each is a conscious, time-boxed trade-off with its
production path spelled out in [`ASSESSMENT_ANALYSIS.md`](./docs/ASSESSMENT_ANALYSIS.md#5-trade-offs--deliberate-omissions).
