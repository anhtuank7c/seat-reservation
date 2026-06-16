# Sequence Diagrams — Public Seat Reservation Platform

Interaction diagrams for the core workflow. Rendered with [Mermaid](https://mermaid.js.org) (shows
inline on GitHub and most Markdown viewers). Participants map 1:1 to the code:

| Diagram participant | Code |
|---|---|
| **User** | the public buyer (browser/client) |
| **AuthService** | `src/auth-service.ts` |
| **ReservationService** | `src/reservation-service.ts` (the core) |
| **Store (DB)** | `src/store.ts` — in-memory, but models DB semantics (CAS, unique constraints) |
| **PaymentGateway** | `src/payment-gateway.ts` (mock, Stripe-shaped) |

---

## 0. End-to-end happy path (overview)

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant A as AuthService
    participant R as ReservationService
    participant DB as Store
    participant PG as PaymentGateway

    U->>A: login(email)
    A-->>U: session token (valid 90 days)

    U->>R: holdSeat(token, seatId)
    R->>DB: atomic claim (compare-and-set)
    DB-->>R: won → seat HELD (TTL 5 min)
    R-->>U: seat held, proceed to pay

    U->>R: pay(token, seatId)
    R->>PG: createIntent + capture
    PG-->>R: signed webhook: payment.succeeded
    R->>DB: createReservation [UNIQUE] + mark RESERVED
    R-->>U: seat RESERVED ✅
```

---

## 1. Login & 90-day session

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant A as AuthService
    participant DB as Store

    U->>A: login(email)
    A->>DB: findUserByEmail(email)
    DB-->>A: user or none
    alt first-time user
        A->>DB: putUser(user)
    end
    A->>A: expiresAt = now + 90 days
    A->>DB: putSession(token, expiresAt)
    A-->>U: { user, session token }

    Note over U,A: Every later request carries the token.<br/>authenticate() returns null once now ≥ expiresAt,<br/>and logout() revokes the session immediately.
```

> **Business rules:** BR-2 (auth required), BR-10 (90-day expiry), BR-11 (revocable, server-side).

---

## 2. Select a seat — atomic hold (happy path)

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant R as ReservationService
    participant DB as Store

    U->>R: holdSeat(token, seatId)
    R->>R: authenticate(token)
    R->>DB: findActiveHoldForUser(userId)
    DB-->>R: none (BR-6: one hold per user)
    R->>DB: getSeat(seatId)
    DB-->>R: seat { status: AVAILABLE, version: v }
    R->>DB: compareAndSwapSeat(seat→HELD, expected = v)
    DB-->>R: true (version v → v+1)
    R-->>U: HELD until now + TTL
```

> **Business rules:** BR-3 (temporary hold + TTL), BR-6 (one hold per user). Re-selecting a seat you
> already hold is idempotent (returns the existing hold).

---

## 3. The hard part — two buyers race for the same seat

```mermaid
sequenceDiagram
    autonumber
    actor A as Buyer A
    actor B as Buyer B
    participant R as ReservationService
    participant DB as Store

    par both read the same version
        A->>R: holdSeat(seatId)
        R->>DB: getSeat → version 0
    and
        B->>R: holdSeat(seatId)
        R->>DB: getSeat → version 0
    end

    A->>DB: compareAndSwap(expected = 0)
    DB-->>A: true  (stored version → 1)
    B->>DB: compareAndSwap(expected = 0)
    DB-->>B: false (stored version is now 1)

    R-->>A: HELD ✅
    R-->>B: SEAT_TAKEN ❌
```

> **Business rule:** BR-1 (no double-booking). The compare-and-set is the in-memory equivalent of
> `UPDATE seats SET ... WHERE id = ? AND version = ?` (or `SELECT ... FOR UPDATE`).
> **Verified by:** test *"two buyers race for one seat → exactly one wins"*, with the
> intentionally-broken `holdSeatNaive` proving the bug the CAS prevents.

---

## 4. Payment & reservation (happy path)

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant R as ReservationService
    participant DB as Store
    participant PG as PaymentGateway

    U->>R: pay(token, seatId)
    R->>DB: getSeat(seatId)
    DB-->>R: HELD by this user, not expired
    R->>PG: createIntent(amount, idempotencyKey)
    PG-->>R: intent (idempotent by key)
    R->>DB: putPayment(PENDING) [audit trail]
    R->>PG: capture(intent)
    PG-->>R: signed event: payment.succeeded

    Note over R,PG: In production the provider POSTs this<br/>webhook asynchronously — here it is returned inline.

    R->>R: confirmPayment(event)
    R->>PG: verify(signature) ✓
    R->>DB: getSeat → hold still valid?
    R->>DB: createReservation(seatId) [UNIQUE]
    R->>DB: markSeatReserved(seatId)
    R->>DB: putPayment(SUCCEEDED)
    R-->>U: RESERVED ✅
```

> **Business rules:** BR-5 (reserve only on payment), BR-7 (hold-before-charge), BR-9 (verify webhook).
> The seat is HELD **before** charging, so at most one buyer can ever pay for a given seat.

---

## 5. Paid, but the hold expired first → automatic refund (compensation)

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant R as ReservationService
    participant DB as Store
    participant PG as PaymentGateway

    U->>R: pay(token, seatId) [hold still valid]
    R->>PG: createIntent + capture
    PG-->>R: payment.succeeded (customer charged)

    Note over R: ⏳ TTL lapses before the webhook is processed<br/>(slow webhook / retry / customer dawdled)

    R->>R: confirmPayment(event)
    R->>DB: getSeat → hold expired or taken
    R->>PG: refund(intent)
    R->>DB: putPayment(REFUNDED)
    R-->>U: no reservation, money returned ✅
```

> **Business rule:** BR-7 (never keep money without a seat). This is the single most important
> reliability path — *money and inventory must never disagree*.
> **Verified by:** test *"paid but hold already expired → refund, no reservation, seat free"*.

---

## 6. Declined payment

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant R as ReservationService
    participant DB as Store
    participant PG as PaymentGateway

    U->>R: pay(token, seatId, scenario = decline)
    R->>PG: createIntent + capture
    PG-->>R: signed event: payment.failed
    R->>R: confirmPayment(event)
    R->>DB: putPayment(FAILED)
    Note over DB: Seat stays HELD — released lazily<br/>when the TTL lapses (no reservation created).
    R-->>U: payment failed ❌
```

> **Business rule:** BR-4 (unpaid hold auto-releases at TTL).

---

## 7. Duplicate / retried webhook → idempotent

```mermaid
sequenceDiagram
    autonumber
    participant PG as PaymentGateway
    participant R as ReservationService
    participant DB as Store

    PG->>R: webhook (payment.succeeded)
    R->>DB: findPaymentByKey → PENDING
    R->>DB: createReservation + mark RESERVED + SUCCEEDED
    R-->>PG: 200 OK

    Note over PG: No/late ack → provider retries the same event

    PG->>R: webhook (same event, redelivered)
    R->>DB: findPaymentByKey → already SUCCEEDED
    R-->>PG: 200 OK (replayed: returns the existing reservation,<br/>no second charge, no second reservation)
```

> **Business rule:** BR-8 (process payment confirmation exactly once). A `UNIQUE(seat_id)`
> reservation is the backstop even under concurrent redelivery.
> **Verified by:** test *"duplicate webhook is idempotent: one reservation, charged once"*.

---

## 8. Seat lifecycle — state model

```mermaid
stateDiagram-v2
    [*] --> AVAILABLE
    AVAILABLE --> HELD: holdSeat / atomic CAS
    HELD --> RESERVED: confirmPayment / valid hold + paid
    HELD --> AVAILABLE: TTL lapses / cancelHold / declined
    RESERVED --> [*]: terminal - UNIQUE seat backstop

    note right of HELD
        Carries heldBy + heldUntil.
        An expired hold is treated as
        free on the next claim.
    end note
```

> **Business rules:** BR-1, BR-3, BR-4, BR-5. See also `Seat.isClaimableAt(now)` in `src/domain.ts`.
