import crypto from 'node:crypto';
import type { Clock } from './clock.ts';
import type { IdGen } from './types.ts';

export interface PaymentIntent {
  id: string;
  amount: number;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
  status: string;
}

export interface WebhookEvent {
  payload: {
    id: string;
    type: string;
    createdAt: number;
    data: {
      intentId: string;
      amount: number;
      idempotencyKey: string;
      metadata: Record<string, unknown>;
    };
  };
  body: string;
  signature: string;
}

export type CaptureScenario = 'success' | 'decline';

/**
 * Mock payment provider, shaped like a real one (Stripe-ish): you create an intent, the
 * provider captures it, and it notifies you out-of-band via a *signed webhook event*.
 *
 * The two real-world properties that matter here are modelled:
 *
 *  - Idempotent intent creation. Calling `createIntent` twice with the same
 *    `idempotencyKey` returns the same intent — a retry never double-charges.
 *  - Authenticated webhooks. Every event is HMAC-signed; the consumer must `verify` it
 *    before trusting it. Anyone can POST to a webhook URL — the signature is what makes
 *    "the customer paid" trustworthy.
 *
 * `capture(intentId, scenario)` lets a caller choose the outcome ('success' | 'decline')
 * so every payment branch is exercisable without real money or network.
 */
export class MockPaymentGateway {
  private clock: Clock;
  private idGen: IdGen;
  private secret: string;
  private _intents = new Map<string, PaymentIntent>();
  private _intentByKey = new Map<string, string>();

  constructor({ clock, idGen, secret = 'whsec_demo_secret' }: { clock: Clock; idGen: IdGen; secret?: string }) {
    this.clock = clock;
    this.idGen = idGen;
    this.secret = secret;
  }

  createIntent({ amount, idempotencyKey, metadata = {} }: { amount: number; idempotencyKey: string; metadata?: Record<string, unknown> }): PaymentIntent {
    const existingId = this._intentByKey.get(idempotencyKey);
    if (existingId) return { ...this._intents.get(existingId)! };

    const intent: PaymentIntent = {
      id: this.idGen('pi'),
      amount,
      idempotencyKey,
      metadata,
      status: 'requires_capture',
    };
    this._intents.set(intent.id, intent);
    this._intentByKey.set(idempotencyKey, intent.id);
    return { ...intent };
  }

  /** Capture an intent and return the signed webhook event the provider would deliver. */
  capture(intentId: string, scenario: CaptureScenario = 'success'): WebhookEvent {
    const intent = this._intents.get(intentId);
    if (!intent) throw new Error('NO_SUCH_INTENT');

    if (scenario === 'decline') {
      intent.status = 'failed';
      return this._signEvent('payment.failed', intent);
    }
    intent.status = 'succeeded';
    return this._signEvent('payment.succeeded', intent);
  }

  refund(intentId: string): WebhookEvent {
    const intent = this._intents.get(intentId);
    if (!intent) throw new Error('NO_SUCH_INTENT');
    intent.status = 'refunded';
    return this._signEvent('payment.refunded', intent);
  }

  /** Constant-time signature check. Reject anything we did not sign. */
  verify(body: string, signature: string): boolean {
    const expected = this.sign(body);
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  sign(body: string): string {
    return crypto.createHmac('sha256', this.secret).update(body).digest('hex');
  }

  private _signEvent(type: string, intent: PaymentIntent): WebhookEvent {
    const payload = {
      id: this.idGen('evt'),
      type,
      createdAt: this.clock.now(),
      data: {
        intentId: intent.id,
        amount: intent.amount,
        idempotencyKey: intent.idempotencyKey,
        metadata: intent.metadata,
      },
    };
    const body = JSON.stringify(payload);
    return { payload, body, signature: this.sign(body) };
  }
}
