import type { Seat, Reservation, Payment, Session, User } from './domain.ts';

/**
 * In-memory store — a stand-in for the database.
 *
 * Two production concerns are modelled deliberately, because they are where seat
 * reservation actually gets hard:
 *
 *  1. Optimistic concurrency. `compareAndSwapSeat` only writes if the stored row's
 *     `version` is unchanged — the in-memory equivalent of `UPDATE ... WHERE version = ?`
 *     (or a Postgres `SELECT ... FOR UPDATE`). The version check and the write run with
 *     NO `await` between them, so they form an atomic critical section even when the
 *     surrounding service yields.
 *
 *  2. Unique constraints. `createReservation` rejects a second reservation for the same
 *     seat (`SEAT_ALREADY_RESERVED`), exactly like a `UNIQUE(seat_id)` index. This is the
 *     last-line backstop against overselling even if the application logic has a bug.
 *
 * `latencyMs` injects an `await` before each operation so that concurrent callers
 * genuinely interleave at the event loop — that is what makes the double-booking race in
 * the tests real rather than theoretical.
 */

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class InMemoryStore {
  latencyMs: number;
  private _seats = new Map<string, Seat>();
  private _reservations = new Map<string, Reservation>();
  private _reservationBySeat = new Map<string, string>(); // seatId -> reservationId (UNIQUE)
  private _payments = new Map<string, Payment>();
  private _paymentByKey = new Map<string, string>(); // idempotencyKey -> paymentId (UNIQUE)
  private _sessions = new Map<string, Session>();
  private _users = new Map<string, User>();
  private _userByEmail = new Map<string, string>(); // email -> userId

  constructor({ latencyMs = 0 }: { latencyMs?: number } = {}) {
    this.latencyMs = latencyMs;
  }

  private async _io(): Promise<void> {
    if (this.latencyMs > 0) await delay(this.latencyMs);
  }

  // ---- seats ---------------------------------------------------------------

  async putSeat(seat: Seat): Promise<Seat> {
    await this._io();
    this._seats.set(seat.id, seat.clone());
    return seat;
  }

  async getSeat(id: string): Promise<Seat | null> {
    await this._io();
    const seat = this._seats.get(id);
    return seat ? seat.clone() : null;
  }

  async allSeats(): Promise<Seat[]> {
    await this._io();
    return [...this._seats.values()].map((s) => s.clone());
  }

  /**
   * Atomic compare-and-set on a seat. Returns true iff the write happened.
   * The simulated IO is awaited BEFORE the critical section; the read-compare-write
   * itself is synchronous, so two racing callers are serialised and only the first
   * (matching `expectedVersion`) wins.
   */
  async compareAndSwapSeat(next: Seat, expectedVersion: number): Promise<boolean> {
    await this._io();
    const current = this._seats.get(next.id);
    if (!current || current.version !== expectedVersion) return false;
    const stored = next.clone();
    stored.version = expectedVersion + 1;
    this._seats.set(stored.id, stored);
    return true;
  }

  /**
   * Once a reservation exists, the seat sale is authoritative; flipping the seat's
   * denormalised status needs no version check (the UNIQUE reservation already made the
   * winner exclusive). Avoids a spurious refund if the seat row moved underneath us.
   */
  async markSeatReserved(seatId: string): Promise<void> {
    await this._io();
    const seat = this._seats.get(seatId);
    if (!seat) return;
    seat.status = 'RESERVED';
    seat.heldUntil = null;
    seat.version += 1;
  }

  async findActiveHoldsForUser(userId: string, now: number): Promise<Seat[]> {
    await this._io();
    const holds: Seat[] = [];
    for (const seat of this._seats.values()) {
      if (seat.status === 'HELD' && seat.heldBy === userId && seat.heldUntil !== null && seat.heldUntil > now) {
        holds.push(seat.clone());
      }
    }
    return holds;
  }

  // ---- reservations (seatId UNIQUE => no oversell) -------------------------

  async createReservation(reservation: Reservation): Promise<Reservation> {
    await this._io();
    if (this._reservationBySeat.has(reservation.seatId)) {
      throw new Error('SEAT_ALREADY_RESERVED'); // UNIQUE(seat_id) violation
    }
    this._reservations.set(reservation.id, reservation.clone());
    this._reservationBySeat.set(reservation.seatId, reservation.id);
    return reservation;
  }

  async findReservationBySeat(seatId: string): Promise<Reservation | null> {
    await this._io();
    const id = this._reservationBySeat.get(seatId);
    return id ? this._reservations.get(id)!.clone() : null;
  }

  async allReservations(): Promise<Reservation[]> {
    await this._io();
    return [...this._reservations.values()].map((r) => r.clone());
  }

  // ---- payments (idempotencyKey UNIQUE) ------------------------------------

  async putPayment(payment: Payment): Promise<Payment> {
    await this._io();
    this._payments.set(payment.id, payment.clone());
    this._paymentByKey.set(payment.idempotencyKey, payment.id);
    return payment;
  }

  async findPaymentByKey(key: string): Promise<Payment | null> {
    await this._io();
    const id = this._paymentByKey.get(key);
    return id ? this._payments.get(id)!.clone() : null;
  }

  // ---- users ---------------------------------------------------------------

  async putUser(user: User): Promise<User> {
    await this._io();
    this._users.set(user.id, user);
    this._userByEmail.set(user.email, user.id);
    return user;
  }

  async findUserByEmail(email: string): Promise<User | null> {
    await this._io();
    const id = this._userByEmail.get(email);
    return id ? this._users.get(id)! : null;
  }

  // ---- sessions ------------------------------------------------------------

  async putSession(session: Session): Promise<Session> {
    await this._io();
    this._sessions.set(session.token, session.clone());
    return session;
  }

  async getSession(token: string): Promise<Session | null> {
    await this._io();
    const session = this._sessions.get(token);
    return session ? session.clone() : null;
  }

  async deleteSession(token: string): Promise<void> {
    await this._io();
    this._sessions.delete(token);
  }
}
