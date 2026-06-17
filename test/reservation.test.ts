import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeClock } from '../src/clock.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import { SeatStatus, PaymentStatus } from '../src/domain.ts';

const SEAT = 'seat_A1';
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const START = 1_000_000;

/** assert.rejects matcher on a domain error's `.code`. */
const code = (c: string) => (err: unknown): boolean => (err as { code?: string }).code === c;

interface TestApp extends App {
  clock: FakeClock;
}

async function appWith(opts: { latencyMs?: number; holdTtlMs?: number; seatCount?: number; maxSeatsPerUser?: number } = {}): Promise<TestApp> {
  const clock = new FakeClock(START);
  const app = await createApp({ clock, ...opts });
  return { clock, ...app };
}

const loginAs = (app: App, email: string) => app.auth.login(email).then((r) => r.session);

// 1 ---------------------------------------------------------------------------
test('happy path: login -> hold -> pay -> RESERVED', async () => {
  const app = await appWith();
  const session = await loginAs(app, 'alice@example.com');

  await app.reservations.holdSeat(session.token, SEAT);
  const { event } = await app.reservations.pay(session.token, SEAT, 'success');
  const result = await app.reservations.confirmPayment(event);

  assert.equal(result.payment.status, PaymentStatus.SUCCEEDED);
  assert.ok(result.reservation);
  assert.equal((await app.store.getSeat(SEAT))!.status, SeatStatus.RESERVED);
});

// 2 ---------------------------------------------------------------------------
test('concurrency: two buyers race for one seat -> exactly one wins', async () => {
  const app = await appWith({ latencyMs: 5 });
  const a = await loginAs(app, 'a@x.com');
  const b = await loginAs(app, 'b@x.com');

  const results = await Promise.allSettled([
    app.reservations.holdSeat(a.token, SEAT),
    app.reservations.holdSeat(b.token, SEAT),
  ]);

  const winners = results.filter((r) => r.status === 'fulfilled');
  assert.equal(winners.length, 1, 'exactly one buyer may hold the seat');
});

// 3 ---------------------------------------------------------------------------
test('the naive (no compare-and-set) hold reproduces the double-book bug', async () => {
  const app = await appWith({ latencyMs: 5 });
  const a = await loginAs(app, 'a@x.com');
  const b = await loginAs(app, 'b@x.com');

  const results = await Promise.allSettled([
    app.reservations.holdSeatNaive(a.token, SEAT),
    app.reservations.holdSeatNaive(b.token, SEAT),
  ]);

  const winners = results.filter((r) => r.status === 'fulfilled');
  assert.equal(winners.length, 2, 'the naive version wrongly lets BOTH hold the same seat');
});

// 4 ---------------------------------------------------------------------------
test('a hold expires after its TTL and the seat becomes claimable again', async () => {
  const app = await appWith({ holdTtlMs: 60_000 });
  const a = await loginAs(app, 'a@x.com');
  const b = await loginAs(app, 'b@x.com');

  await app.reservations.holdSeat(a.token, SEAT);
  await assert.rejects(() => app.reservations.holdSeat(b.token, SEAT), code('SEAT_TAKEN'));

  app.clock.advance(60_001); // hold lapses
  const seat = await app.reservations.holdSeat(b.token, SEAT);
  assert.equal(seat.heldBy, (await app.store.findUserByEmail('b@x.com'))!.id);
});

// 5 ---------------------------------------------------------------------------
test('duplicate webhook is idempotent: one reservation, charged once', async () => {
  const app = await appWith();
  const a = await loginAs(app, 'a@x.com');

  await app.reservations.holdSeat(a.token, SEAT);
  const { event } = await app.reservations.pay(a.token, SEAT, 'success');

  const first = await app.reservations.confirmPayment(event);
  const replay = await app.reservations.confirmPayment(event); // provider retried

  assert.equal(replay.replayed, true);
  assert.equal(replay.reservation!.id, first.reservation!.id);
  const forSeat = (await app.store.allReservations()).filter((r) => r.seatId === SEAT);
  assert.equal(forSeat.length, 1);
});

// 6 ---------------------------------------------------------------------------
test('paid but hold already expired -> refund, no reservation, seat free', async () => {
  const app = await appWith({ holdTtlMs: 60_000 });
  const a = await loginAs(app, 'a@x.com');

  await app.reservations.holdSeat(a.token, SEAT);
  const { event } = await app.reservations.pay(a.token, SEAT, 'success'); // charged while valid
  app.clock.advance(60_001); // ...then the hold lapses before the webhook lands

  const result = await app.reservations.confirmPayment(event);
  assert.equal(result.refunded, true);
  assert.equal(result.payment.status, PaymentStatus.REFUNDED);
  assert.equal(result.reservation, null);
  assert.ok((await app.store.getSeat(SEAT))!.isClaimableAt(app.clock.now()));
});

// 7 ---------------------------------------------------------------------------
test('declined payment -> no reservation; the hold releases at its TTL', async () => {
  const app = await appWith({ holdTtlMs: 60_000 });
  const a = await loginAs(app, 'a@x.com');

  await app.reservations.holdSeat(a.token, SEAT);
  const { event } = await app.reservations.pay(a.token, SEAT, 'decline');
  const result = await app.reservations.confirmPayment(event);

  assert.equal(result.payment.status, PaymentStatus.FAILED);
  assert.equal(result.reservation, null);
  assert.equal((await app.store.getSeat(SEAT))!.status, SeatStatus.HELD); // still held until TTL

  app.clock.advance(60_001);
  assert.ok((await app.store.getSeat(SEAT))!.isClaimableAt(app.clock.now()));
});

// 8 ---------------------------------------------------------------------------
test('auth is required and the 90-day session expiry is enforced', async () => {
  const app = await appWith();
  await assert.rejects(() => app.reservations.holdSeat('bogus-token', SEAT), code('UNAUTHENTICATED'));

  const session = await loginAs(app, 'a@x.com');
  assert.ok(await app.auth.authenticate(session.token));

  app.clock.advance(NINETY_DAYS_MS - 1); // just inside the window
  assert.ok(await app.auth.authenticate(session.token));

  app.clock.advance(2); // just past 90 days
  assert.equal(await app.auth.authenticate(session.token), null);
  await assert.rejects(() => app.reservations.holdSeat(session.token, SEAT), code('UNAUTHENTICATED'));
});

// 9 ---------------------------------------------------------------------------
test("ownership: user B cannot touch user A's hold (no IDOR)", async () => {
  const app = await appWith();
  const a = await loginAs(app, 'a@x.com');
  const b = await loginAs(app, 'b@x.com');

  await app.reservations.holdSeat(a.token, SEAT);
  await assert.rejects(() => app.reservations.cancelHold(b.token, SEAT), code('FORBIDDEN'));
  await assert.rejects(() => app.reservations.pay(b.token, SEAT, 'success'), code('NOT_HELD_BY_YOU'));
});

// 10 --------------------------------------------------------------------------
test('oversell backstop: an already-reserved seat cannot be held again', async () => {
  const app = await appWith();
  const a = await loginAs(app, 'a@x.com');
  const b = await loginAs(app, 'b@x.com');

  await app.reservations.holdSeat(a.token, SEAT);
  const { event } = await app.reservations.pay(a.token, SEAT, 'success');
  await app.reservations.confirmPayment(event);

  await assert.rejects(() => app.reservations.holdSeat(b.token, SEAT), code('SEAT_TAKEN'));
});

// 11 --------------------------------------------------------------------------
test('fairness: a user may hold up to the cap, but no more', async () => {
  const app = await appWith({ seatCount: 4, maxSeatsPerUser: 2 });
  const a = await loginAs(app, 'a@x.com');

  // Within the cap: a group buyer can hold several seats.
  await app.reservations.holdSeat(a.token, 'seat_A1');
  await app.reservations.holdSeat(a.token, 'seat_A2');

  // Re-selecting a seat already held is idempotent — it must not count against the cap.
  assert.equal((await app.reservations.holdSeat(a.token, 'seat_A1')).id, 'seat_A1');

  // One past the cap is rejected.
  await assert.rejects(() => app.reservations.holdSeat(a.token, 'seat_A3'), code('HOLD_LIMIT_REACHED'));
});

// 12 --------------------------------------------------------------------------
test('forged webhook signature is rejected', async () => {
  const app = await appWith();
  const a = await loginAs(app, 'a@x.com');

  await app.reservations.holdSeat(a.token, SEAT);
  const { event } = await app.reservations.pay(a.token, SEAT, 'success');
  const forged = { ...event, signature: 'deadbeef' };

  await assert.rejects(() => app.reservations.confirmPayment(forged), code('BAD_SIGNATURE'));
});
