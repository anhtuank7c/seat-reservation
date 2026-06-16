import { SeatStatus, PaymentStatus, Payment, Reservation, Seat, Session } from './domain.ts';
import type { Clock } from './clock.ts';
import type { IdGen } from './types.ts';
import type { InMemoryStore } from './store.ts';
import type { AuthService } from './auth-service.ts';
import type { MockPaymentGateway, PaymentIntent, WebhookEvent, CaptureScenario } from './payment-gateway.ts';

const DEFAULT_HOLD_TTL_MS = 5 * 60 * 1000; // 5 minutes to pay before the seat is released
const DEFAULT_AMOUNT = 5000; // cents

/** Typed domain error so callers/tests can branch on `.code`, not on message strings. */
export class ReservationError extends Error {
  code: string;

  constructor(code: string, message?: string) {
    super(message || code);
    this.name = 'ReservationError';
    this.code = code;
  }
}

export interface ConfirmResult {
  payment: Payment;
  reservation: Reservation | null;
  replayed?: boolean;
  refunded?: boolean;
}

export interface PayResult {
  payment: Payment;
  intent: PaymentIntent;
  event: WebhookEvent;
}

export interface ReservationDeps {
  store: InMemoryStore;
  clock: Clock;
  gateway: MockPaymentGateway;
  auth: AuthService;
  idGen: IdGen;
  holdTtlMs?: number;
  amount?: number;
}

/**
 * The core business workflow: hold a seat, pay for it, reserve it on payment completion.
 *
 * Three properties drive every decision in here:
 *
 *  1. No double-booking. A seat is claimed with an atomic compare-and-set; only one of N
 *     racing buyers can win. The UNIQUE reservation row is a second, independent backstop.
 *  2. Money and inventory stay consistent. The seat is HELD *before* the customer is
 *     charged, the webhook handler is idempotent, and a payment that lands with no valid
 *     hold is refunded rather than silently kept.
 *  3. Abandoned checkouts self-heal. Holds carry a TTL; an expired hold is treated as free
 *     on the next claim (lazy expiry) — no background job required for correctness.
 */
export class ReservationService {
  private store: InMemoryStore;
  private clock: Clock;
  private gateway: MockPaymentGateway;
  private auth: AuthService;
  private idGen: IdGen;
  private holdTtlMs: number;
  private amount: number;

  constructor({ store, clock, gateway, auth, idGen, holdTtlMs = DEFAULT_HOLD_TTL_MS, amount = DEFAULT_AMOUNT }: ReservationDeps) {
    this.store = store;
    this.clock = clock;
    this.gateway = gateway;
    this.auth = auth;
    this.idGen = idGen;
    this.holdTtlMs = holdTtlMs;
    this.amount = amount;
  }

  private async _requireSession(token: string | null | undefined): Promise<Session> {
    const session = await this.auth.authenticate(token);
    if (!session) throw new ReservationError('UNAUTHENTICATED', 'Login required or session expired');
    return session;
  }

  // -------------------------------------------------------------------------
  // 1. HOLD — atomically claim a seat for this user for `holdTtlMs`.
  // -------------------------------------------------------------------------

  async holdSeat(token: string, seatId: string): Promise<Seat> {
    const session = await this._requireSession(token);
    const now = this.clock.now();

    // Fairness: one active hold per user, so a single person can't lock all inventory.
    // Re-selecting the seat you already hold is idempotent.
    const existingHold = await this.store.findActiveHoldForUser(session.userId, now);
    if (existingHold) {
      if (existingHold.id === seatId) return existingHold;
      throw new ReservationError('ALREADY_HOLDING', `You already hold seat ${existingHold.label}`);
    }

    const seat = await this.store.getSeat(seatId);
    if (!seat) throw new ReservationError('NO_SUCH_SEAT', 'No such seat');
    if (!seat.isClaimableAt(now)) {
      throw new ReservationError('SEAT_TAKEN', 'Seat is reserved or currently held');
    }

    const expectedVersion = seat.version;
    seat.status = SeatStatus.HELD;
    seat.heldBy = session.userId;
    seat.heldUntil = now + this.holdTtlMs;

    const won = await this.store.compareAndSwapSeat(seat, expectedVersion);
    if (!won) throw new ReservationError('SEAT_TAKEN', 'Lost the race for this seat');
    return seat;
  }

  /**
   * ⚠️ INTENTIONALLY BROKEN — kept to demonstrate, in a test, the check-then-act race
   * that the compare-and-set version above prevents. It reads the seat, decides it is
   * free, then blind-writes. Two concurrent callers both read "free" before either writes,
   * so BOTH end up holding the same seat. Do not use in real flows.
   */
  async holdSeatNaive(token: string, seatId: string): Promise<Seat> {
    const session = await this._requireSession(token);
    const now = this.clock.now();

    const seat = await this.store.getSeat(seatId); // read
    if (!seat || !seat.isClaimableAt(now)) throw new ReservationError('SEAT_TAKEN', 'Seat taken');

    seat.status = SeatStatus.HELD; // ...time passes...
    seat.heldBy = session.userId;
    seat.heldUntil = now + this.holdTtlMs;
    await this.store.putSeat(seat); // blind write — clobbers a concurrent winner
    return seat;
  }

  async cancelHold(token: string, seatId: string): Promise<Seat> {
    const session = await this._requireSession(token);
    const seat = await this.store.getSeat(seatId);
    if (!seat) throw new ReservationError('NO_SUCH_SEAT', 'No such seat');
    if (seat.status !== SeatStatus.HELD) return seat; // nothing to release
    if (seat.heldBy !== session.userId) {
      throw new ReservationError('FORBIDDEN', 'Not your hold'); // ownership — no IDOR
    }

    const expectedVersion = seat.version;
    seat.status = SeatStatus.AVAILABLE;
    seat.heldBy = null;
    seat.heldUntil = null;
    await this.store.compareAndSwapSeat(seat, expectedVersion);
    return seat;
  }

  // -------------------------------------------------------------------------
  // 2. PAY — start a payment for a seat this user currently holds.
  //    Returns the signed webhook `event`; settlement happens in confirmPayment.
  // -------------------------------------------------------------------------

  async pay(token: string, seatId: string, scenario: CaptureScenario = 'success'): Promise<PayResult> {
    const session = await this._requireSession(token);
    const now = this.clock.now();

    const seat = await this.store.getSeat(seatId);
    if (!seat) throw new ReservationError('NO_SUCH_SEAT', 'No such seat');
    if (seat.status !== SeatStatus.HELD || seat.heldBy !== session.userId) {
      throw new ReservationError('NOT_HELD_BY_YOU', 'You must hold the seat before paying'); // ownership
    }
    if (seat.heldUntil === null || seat.heldUntil <= now) {
      throw new ReservationError('HOLD_EXPIRED', 'Your hold has expired');
    }

    // Stable per hold, so a retried checkout reuses the same charge instead of double-billing.
    const idempotencyKey = `${session.userId}:${seatId}:${seat.heldUntil}`;
    const intent = this.gateway.createIntent({
      amount: this.amount,
      idempotencyKey,
      metadata: { seatId, userId: session.userId },
    });

    // Record a PENDING payment up-front: the Payment/Reservation rows ARE the audit log.
    let payment = await this.store.findPaymentByKey(idempotencyKey);
    if (!payment) {
      payment = new Payment({
        id: this.idGen('pay'),
        seatId,
        userId: session.userId,
        amount: this.amount,
        idempotencyKey,
        providerRef: intent.id,
        status: PaymentStatus.PENDING,
        createdAt: now,
      });
      await this.store.putPayment(payment);
    }

    const event = this.gateway.capture(intent.id, scenario);
    return { payment, intent, event };
  }

  // -------------------------------------------------------------------------
  // 3. CONFIRM — the webhook handler. Where money meets inventory. Idempotent.
  // -------------------------------------------------------------------------

  async confirmPayment(event: WebhookEvent): Promise<ConfirmResult> {
    // (a) Authenticity — never trust an unsigned/forged webhook.
    if (!this.gateway.verify(event.body, event.signature)) {
      throw new ReservationError('BAD_SIGNATURE', 'Invalid webhook signature');
    }

    const { type, data } = event.payload;
    const payment = await this.store.findPaymentByKey(data.idempotencyKey);
    if (!payment) throw new ReservationError('UNKNOWN_PAYMENT', 'No payment for this event');

    // (b) Idempotency — replays/retries return the prior outcome, never re-apply.
    if (payment.status === PaymentStatus.SUCCEEDED) {
      const reservation = await this.store.findReservationBySeat(payment.seatId);
      return { payment, reservation, replayed: true };
    }
    if (payment.status === PaymentStatus.FAILED || payment.status === PaymentStatus.REFUNDED) {
      return { payment, reservation: null, replayed: true };
    }

    if (type === 'payment.failed') {
      payment.status = PaymentStatus.FAILED;
      await this.store.putPayment(payment);
      return { payment, reservation: null }; // leave the hold to lapse on its own
    }

    // (c) Success — only commit if the hold is still valid for this user.
    const now = this.clock.now();
    const seat = await this.store.getSeat(payment.seatId);
    const holdValid =
      seat !== null &&
      seat.status === SeatStatus.HELD &&
      seat.heldBy === payment.userId &&
      seat.heldUntil !== null &&
      seat.heldUntil > now;

    if (!holdValid || seat === null) {
      // Paid, but the seat is gone (hold lapsed / taken). Compensate: refund, don't keep money.
      return this._refund(payment);
    }

    try {
      const reservation = new Reservation({
        id: this.idGen('res'),
        seatId: seat.id,
        userId: payment.userId,
        paymentId: payment.id,
        createdAt: now,
      });
      await this.store.createReservation(reservation); // UNIQUE(seat) — the oversell backstop
      await this.store.markSeatReserved(seat.id);

      payment.status = PaymentStatus.SUCCEEDED;
      await this.store.putPayment(payment);
      return { payment, reservation };
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'SEAT_ALREADY_RESERVED') throw err;

      // Someone already has a reservation for this seat.
      const existing = await this.store.findReservationBySeat(payment.seatId);
      if (existing && existing.userId === payment.userId) {
        // It's ours (a concurrent duplicate webhook) — settle idempotently, no refund.
        payment.status = PaymentStatus.SUCCEEDED;
        await this.store.putPayment(payment);
        return { payment, reservation: existing, replayed: true };
      }
      // Lost the seat to someone else after charging — refund.
      return this._refund(payment);
    }
  }

  private async _refund(payment: Payment): Promise<ConfirmResult> {
    if (payment.providerRef) this.gateway.refund(payment.providerRef);
    payment.status = PaymentStatus.REFUNDED;
    await this.store.putPayment(payment);
    return { payment, reservation: null, refunded: true };
  }

  // -------------------------------------------------------------------------
  // Sweeper — lazy expiry already guarantees correctness; this just tidies state
  // (and is where a production cron / queue would hook in).
  // -------------------------------------------------------------------------

  async releaseExpiredHolds(): Promise<number> {
    const now = this.clock.now();
    let released = 0;
    for (const seat of await this.store.allSeats()) {
      if (seat.status === SeatStatus.HELD && seat.heldUntil !== null && seat.heldUntil <= now) {
        const expectedVersion = seat.version;
        seat.status = SeatStatus.AVAILABLE;
        seat.heldBy = null;
        seat.heldUntil = null;
        if (await this.store.compareAndSwapSeat(seat, expectedVersion)) released += 1;
      }
    }
    return released;
  }
}
