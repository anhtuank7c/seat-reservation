/**
 * Domain entities.
 *
 * Plain OOP value/state objects. They carry just enough behaviour to express the
 * invariants of the domain (e.g. "is this seat claimable right now?") and nothing about
 * storage, HTTP, or payments. `clone()` everywhere keeps the in-memory store honest:
 * callers get snapshots, never live references to stored state.
 */

export const SeatStatus = {
  AVAILABLE: 'AVAILABLE',
  HELD: 'HELD',
  RESERVED: 'RESERVED',
} as const;
export type SeatStatus = (typeof SeatStatus)[keyof typeof SeatStatus];

export const PaymentStatus = {
  PENDING: 'PENDING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export interface SeatProps {
  id: string;
  label: string;
  status?: SeatStatus;
  heldBy?: string | null;
  heldUntil?: number | null;
  version?: number;
}

export class Seat {
  id: string;
  label: string;
  status: SeatStatus;
  heldBy: string | null; // userId of the current holder, if HELD
  heldUntil: number | null; // epoch ms when the hold lapses
  version: number; // optimistic-concurrency token

  constructor({ id, label, status = SeatStatus.AVAILABLE, heldBy = null, heldUntil = null, version = 0 }: SeatProps) {
    this.id = id;
    this.label = label;
    this.status = status;
    this.heldBy = heldBy;
    this.heldUntil = heldUntil;
    this.version = version;
  }

  /**
   * A seat can be claimed if it is free, OR if it is held but the hold has lapsed.
   * RESERVED is terminal — never claimable. This is the single source of truth for
   * "is this seat up for grabs", used by both the lazy-expiry and the claim paths.
   */
  isClaimableAt(now: number): boolean {
    if (this.status === SeatStatus.AVAILABLE) return true;
    if (this.status === SeatStatus.HELD && this.heldUntil !== null && this.heldUntil <= now) return true;
    return false;
  }

  clone(): Seat {
    return new Seat({ ...this });
  }
}

export class User {
  id: string;
  email: string;

  constructor({ id, email }: { id: string; email: string }) {
    this.id = id;
    this.email = email;
  }
}

export interface SessionProps {
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

export class Session {
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;

  constructor({ token, userId, createdAt, expiresAt }: SessionProps) {
    this.token = token;
    this.userId = userId;
    this.createdAt = createdAt;
    this.expiresAt = expiresAt;
  }

  isValidAt(now: number): boolean {
    return now < this.expiresAt;
  }

  clone(): Session {
    return new Session({ ...this });
  }
}

export interface PaymentProps {
  id: string;
  seatId: string;
  userId: string;
  amount: number;
  idempotencyKey: string;
  status?: PaymentStatus;
  providerRef?: string | null;
  createdAt: number;
}

export class Payment {
  id: string;
  seatId: string;
  userId: string;
  amount: number;
  idempotencyKey: string;
  status: PaymentStatus;
  providerRef: string | null; // the gateway's intent id
  createdAt: number;

  constructor({ id, seatId, userId, amount, idempotencyKey, status = PaymentStatus.PENDING, providerRef = null, createdAt }: PaymentProps) {
    this.id = id;
    this.seatId = seatId;
    this.userId = userId;
    this.amount = amount;
    this.idempotencyKey = idempotencyKey;
    this.status = status;
    this.providerRef = providerRef;
    this.createdAt = createdAt;
  }

  clone(): Payment {
    return new Payment({ ...this });
  }
}

export interface ReservationProps {
  id: string;
  seatId: string;
  userId: string;
  paymentId: string;
  createdAt: number;
}

export class Reservation {
  id: string;
  seatId: string;
  userId: string;
  paymentId: string;
  createdAt: number;

  constructor({ id, seatId, userId, paymentId, createdAt }: ReservationProps) {
    this.id = id;
    this.seatId = seatId;
    this.userId = userId;
    this.paymentId = paymentId;
    this.createdAt = createdAt;
  }

  clone(): Reservation {
    return new Reservation({ ...this });
  }
}
