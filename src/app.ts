import { InMemoryStore } from './store.ts';
import { AuthService } from './auth-service.ts';
import { MockPaymentGateway } from './payment-gateway.ts';
import { ReservationService } from './reservation-service.ts';
import { Seat } from './domain.ts';
import type { Clock } from './clock.ts';
import type { IdGen } from './types.ts';

/** Deterministic id generator (no Math.random / Date) so runs are reproducible. */
export function createIdGen(): IdGen {
  let n = 0;
  return (prefix = 'id') => `${prefix}_${(n += 1)}`;
}

export interface App {
  store: InMemoryStore;
  auth: AuthService;
  gateway: MockPaymentGateway;
  reservations: ReservationService;
  idGen: IdGen;
}

export interface CreateAppOptions {
  clock: Clock;
  latencyMs?: number;
  holdTtlMs?: number;
  seatCount?: number;
}

/**
 * Compose the whole system from its parts and seed `seatCount` available seats.
 * Everything time- and money-related is injected (clock, gateway) so tests and the demo
 * stay deterministic. This is the single place wiring lives.
 */
export async function createApp({ clock, latencyMs = 0, holdTtlMs, seatCount = 3 }: CreateAppOptions): Promise<App> {
  const idGen = createIdGen();
  const store = new InMemoryStore({ latencyMs });
  const auth = new AuthService({ store, clock, idGen });
  const gateway = new MockPaymentGateway({ clock, idGen });
  const reservations = new ReservationService({ store, clock, gateway, auth, idGen, holdTtlMs });

  for (let i = 0; i < seatCount; i += 1) {
    const label = `A${i + 1}`;
    await store.putSeat(new Seat({ id: `seat_${label}`, label }));
  }

  return { store, auth, gateway, reservations, idGen };
}
