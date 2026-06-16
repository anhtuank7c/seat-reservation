/**
 * Clock abstraction.
 *
 * Time is an *input* to this domain (hold TTL, 90-day session expiry), so we inject it
 * instead of calling `Date.now()` directly. That makes every time-dependent rule
 * deterministically testable: the tests advance a `FakeClock` instead of sleeping.
 */

export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class FakeClock implements Clock {
  private _now: number;

  constructor(startMs = 0) {
    this._now = startMs;
  }

  now(): number {
    return this._now;
  }

  /** Move time forward (e.g. to expire a hold or a session). */
  advance(ms: number): number {
    this._now += ms;
    return this._now;
  }
}
