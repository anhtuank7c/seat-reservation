/**
 * Narrated walk-through of the core business behaviour. Run with: `node demo.ts`
 *
 * Uses a FakeClock so time-based rules (hold TTL) happen instantly and deterministically.
 */
import { FakeClock } from './src/clock.ts';
import { createApp } from './src/app.ts';
import { SeatStatus } from './src/domain.ts';
import type { App } from './src/app.ts';

const SEAT = 'seat_A1';
const log = (msg: string): void => console.log(msg);
const head = (title: string): void => console.log(`\n${'─'.repeat(68)}\n${title}\n${'─'.repeat(68)}`);
const seatStatus = async (app: App): Promise<string> => (await app.store.getSeat(SEAT))!.status;

// Scenario A — the happy path -------------------------------------------------
async function happyPath(): Promise<void> {
  head('A. Happy path:  login → hold → pay → reserved');
  const app = await createApp({ clock: new FakeClock(0) });
  const { session } = await app.auth.login('alice@example.com');
  log(`alice logs in — session expires in 90 days (at ${new Date(session.expiresAt).toISOString()})`);

  await app.reservations.holdSeat(session.token, SEAT);
  log(`alice holds ${SEAT}            → seat is ${await seatStatus(app)}`);

  const { event } = await app.reservations.pay(session.token, SEAT, 'success');
  const result = await app.reservations.confirmPayment(event);
  log(`payment ${result.payment.status}, webhook confirmed → seat is ${await seatStatus(app)}`);
  log(`reservation ${result.reservation!.id} recorded for alice ✅`);
}

// Scenario B — concurrency: naive bug vs. the compare-and-set fix --------------
async function concurrency(): Promise<void> {
  head('B. Two buyers race for the same seat');

  const naive = await createApp({ clock: new FakeClock(0), latencyMs: 5 });
  const a1 = (await naive.auth.login('a@x.com')).session;
  const b1 = (await naive.auth.login('b@x.com')).session;
  const naiveRes = await Promise.allSettled([
    naive.reservations.holdSeatNaive(a1.token, SEAT),
    naive.reservations.holdSeatNaive(b1.token, SEAT),
  ]);
  const naiveWinners = naiveRes.filter((r) => r.status === 'fulfilled').length;
  log(`  naive (read → check → blind write):  ${naiveWinners} winners  ${naiveWinners === 2 ? '💥 DOUBLE BOOKED' : ''}`);

  const safe = await createApp({ clock: new FakeClock(0), latencyMs: 5 });
  const a2 = (await safe.auth.login('a@x.com')).session;
  const b2 = (await safe.auth.login('b@x.com')).session;
  const safeRes = await Promise.allSettled([
    safe.reservations.holdSeat(a2.token, SEAT),
    safe.reservations.holdSeat(b2.token, SEAT),
  ]);
  const safeWinners = safeRes.filter((r) => r.status === 'fulfilled').length;
  log(`  compare-and-set hold:                ${safeWinners} winner   ${safeWinners === 1 ? '✅ exactly one' : ''}`);
}

// Scenario C — paid, but the hold expired first → refund ----------------------
async function paidButExpired(): Promise<void> {
  head('C. Customer pays, but the hold lapsed first → automatic refund');
  const clock = new FakeClock(0);
  const app = await createApp({ clock, holdTtlMs: 60_000 });
  const { session } = await app.auth.login('carol@example.com');

  await app.reservations.holdSeat(session.token, SEAT);
  const { event } = await app.reservations.pay(session.token, SEAT, 'success');
  log('carol holds the seat and is charged…');

  clock.advance(60_001); // hold lapses before the webhook is processed
  log('…but the webhook lands after the 60s hold expired.');

  const result = await app.reservations.confirmPayment(event);
  log(`outcome: payment ${result.payment.status}, reservation = ${result.reservation}`);
  log(`seat is ${(await app.store.getSeat(SEAT))!.status === SeatStatus.RESERVED ? 'RESERVED' : 'still free'} — money returned, no orphaned charge ✅`);
}

async function main(): Promise<void> {
  await happyPath();
  await concurrency();
  await paidButExpired();
  console.log('\nDone. Run `node --test` for the full business-case suite.\n');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
