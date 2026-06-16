import { User, Session } from './domain.ts';
import type { Clock } from './clock.ts';
import type { IdGen } from './types.ts';
import type { InMemoryStore } from './store.ts';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Authentication + sessions.
 *
 * The brief requires "login with session expiry at 90 days". We model server-side
 * sessions (a token row with an `expiresAt`) rather than a stateless JWT, because the
 * store-backed session is revocable — `logout` actually invalidates it. The 90-day
 * window is enforced on every `authenticate` against the injected clock, so the rule is
 * testable by advancing time rather than waiting three months.
 *
 * Login is intentionally trivial (passwordless: "who are you") — credentials/magic-link
 * are an integration detail, not the core business logic this harness exists to prove.
 */
export class AuthService {
  private store: InMemoryStore;
  private clock: Clock;
  private idGen: IdGen;
  private sessionTtlMs: number;

  constructor({ store, clock, idGen, sessionTtlMs = NINETY_DAYS_MS }: { store: InMemoryStore; clock: Clock; idGen: IdGen; sessionTtlMs?: number }) {
    this.store = store;
    this.clock = clock;
    this.idGen = idGen;
    this.sessionTtlMs = sessionTtlMs;
  }

  async login(email: string): Promise<{ user: User; session: Session }> {
    let user = await this.store.findUserByEmail(email);
    if (!user) {
      user = new User({ id: this.idGen('usr'), email });
      await this.store.putUser(user);
    }

    const now = this.clock.now();
    const session = new Session({
      token: this.idGen('sess'),
      userId: user.id,
      createdAt: now,
      expiresAt: now + this.sessionTtlMs, // 90-day expiry
    });
    await this.store.putSession(session);
    return { user, session };
  }

  /** Returns a valid session, or null if missing / expired. */
  async authenticate(token: string | null | undefined): Promise<Session | null> {
    if (!token) return null;
    const session = await this.store.getSession(token);
    if (!session) return null;
    if (!session.isValidAt(this.clock.now())) return null;
    return session;
  }

  /** Revoke a session immediately (the reason we keep sessions server-side). */
  async logout(token: string): Promise<void> {
    await this.store.deleteSession(token);
  }
}
