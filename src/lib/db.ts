import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SchediError } from "./errors";
import type {
  Booking,
  BookingStatus,
  Business,
  ChargeKind,
  Owner,
  PaymentMethod,
  Plan,
  Service,
  SubscriptionStatus,
} from "./types";

export interface CreateBusinessInput {
  ownerId: string;
  name: string;
  slug: string;
  plan?: Plan;
  subscriptionStatus?: SubscriptionStatus;
  stripeSubscriptionId?: string | null;
  stripeAccountId?: string | null;
  cardPaymentsStatus?: string | null;
  payoutsStatus?: string | null;
  depositEnabled?: boolean;
  depositAmountCents?: number | null;
  cashApp?: string | null;
  zelle?: string | null;
  venmo?: string | null;
  paypal?: string | null;
  payAtAppointment?: boolean;
  country?: string;
}

export interface PaymentSettingsInput {
  cashApp: string | null;
  zelle: string | null;
  venmo: string | null;
  paypal: string | null;
  payAtAppointment: boolean;
  depositEnabled: boolean;
  depositAmountCents: number | null;
}

export interface CreateBookingInput {
  businessId: string;
  serviceId: string;
  clientName: string;
  clientEmail: string;
  startsAt: string;
  paymentMethod: PaymentMethod;
  chargeKind: ChargeKind | null;
  amountCents: number;
  status: BookingStatus;
}

interface OwnerRow {
  id: string;
  email: string;
  name: string;
  stripe_customer_id: string | null;
}

interface BusinessRow {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  plan: Plan;
  subscription_status: SubscriptionStatus;
  stripe_subscription_id: string | null;
  cancel_at_period_end: number;
  current_period_end: string | null;
  stripe_account_id: string | null;
  card_payments_status: string | null;
  payouts_status: string | null;
  deposit_enabled: number;
  deposit_amount_cents: number | null;
  cash_app: string | null;
  zelle: string | null;
  venmo: string | null;
  paypal: string | null;
  pay_at_appointment: number;
  country: string;
}

interface ServiceRow {
  id: string;
  business_id: string;
  name: string;
  duration_minutes: number;
  price_cents: number;
}

interface BookingRow {
  id: string;
  business_id: string;
  service_id: string;
  client_name: string;
  client_email: string;
  starts_at: string;
  payment_method: PaymentMethod;
  charge_kind: ChargeKind | null;
  amount_cents: number;
  status: BookingStatus;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  created_at: string;
}

function mapOwner(row: OwnerRow): Owner {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    stripeCustomerId: row.stripe_customer_id,
  };
}

function mapBusiness(row: BusinessRow): Business {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    slug: row.slug,
    plan: row.plan,
    subscriptionStatus: row.subscription_status,
    stripeSubscriptionId: row.stripe_subscription_id,
    cancelAtPeriodEnd: row.cancel_at_period_end === 1,
    currentPeriodEnd: row.current_period_end,
    stripeAccountId: row.stripe_account_id,
    cardPaymentsStatus: row.card_payments_status,
    payoutsStatus: row.payouts_status,
    depositEnabled: row.deposit_enabled === 1,
    depositAmountCents: row.deposit_amount_cents,
    cashApp: row.cash_app,
    zelle: row.zelle,
    venmo: row.venmo,
    paypal: row.paypal,
    payAtAppointment: row.pay_at_appointment === 1,
    country: row.country,
  };
}

function mapService(row: ServiceRow): Service {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    durationMinutes: row.duration_minutes,
    priceCents: row.price_cents,
  };
}

function mapBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    businessId: row.business_id,
    serviceId: row.service_id,
    clientName: row.client_name,
    clientEmail: row.client_email,
    startsAt: row.starts_at,
    paymentMethod: row.payment_method,
    chargeKind: row.charge_kind,
    amountCents: row.amount_cents,
    status: row.status,
    stripeCheckoutSessionId: row.stripe_checkout_session_id,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    createdAt: row.created_at,
  };
}

export class Store {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS owners (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        stripe_customer_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS businesses (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL UNIQUE REFERENCES owners(id),
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        plan TEXT NOT NULL,
        subscription_status TEXT NOT NULL,
        stripe_subscription_id TEXT,
        cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
        current_period_end TEXT,
        stripe_account_id TEXT,
        card_payments_status TEXT,
        payouts_status TEXT,
        deposit_enabled INTEGER NOT NULL DEFAULT 0,
        deposit_amount_cents INTEGER,
        cash_app TEXT,
        zelle TEXT,
        venmo TEXT,
        paypal TEXT,
        pay_at_appointment INTEGER NOT NULL DEFAULT 1,
        country TEXT NOT NULL DEFAULT 'US',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS services (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL REFERENCES businesses(id),
        name TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL,
        price_cents INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL REFERENCES businesses(id),
        service_id TEXT NOT NULL REFERENCES services(id),
        client_name TEXT NOT NULL,
        client_email TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        payment_method TEXT NOT NULL,
        charge_kind TEXT,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        stripe_checkout_session_id TEXT,
        stripe_payment_intent_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owners(id),
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stripe_events (
        id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL
      );
    `);
    ensureBusinessBillingColumns(this.db);
  }

  createOwner(input: { email: string; name: string; stripeCustomerId?: string | null }): Owner {
    const id = randomUUID();
    const email = input.email.trim().toLowerCase();
    this.db
      .prepare(
        `INSERT INTO owners (id, email, name, stripe_customer_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, email, input.name.trim(), input.stripeCustomerId ?? null, new Date().toISOString());
    return this.getOwner(id);
  }

  getOwner(id: string): Owner {
    const row = this.db.prepare("SELECT * FROM owners WHERE id = ?").get(id) as OwnerRow | undefined;
    if (!row) throw new SchediError("Owner not found.", 404);
    return mapOwner(row);
  }

  getOwnerByEmail(email: string): Owner | null {
    const row = this.db.prepare("SELECT * FROM owners WHERE email = ?").get(email.trim().toLowerCase()) as
      | OwnerRow
      | undefined;
    return row ? mapOwner(row) : null;
  }

  getOwnerByStripeCustomer(customerId: string): Owner | null {
    const row = this.db.prepare("SELECT * FROM owners WHERE stripe_customer_id = ?").get(customerId) as
      | OwnerRow
      | undefined;
    return row ? mapOwner(row) : null;
  }

  setOwnerCustomer(ownerId: string, customerId: string): Owner {
    const owner = this.getOwner(ownerId);
    if (owner.stripeCustomerId === customerId) return owner;
    if (owner.stripeCustomerId) {
      throw new SchediError("This owner already has a Stripe customer.", 409);
    }
    const result = this.db
      .prepare(
        `UPDATE owners SET stripe_customer_id = ?
         WHERE id = ? AND stripe_customer_id IS NULL`,
      )
      .run(customerId, ownerId);
    if (result.changes !== 1) {
      throw new SchediError("This owner already has a Stripe customer.", 409);
    }
    return this.getOwner(ownerId);
  }

  createBusiness(input: CreateBusinessInput): Business {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO businesses (
          id, owner_id, name, slug, plan, subscription_status, stripe_subscription_id,
          stripe_account_id, card_payments_status, payouts_status, deposit_enabled,
          deposit_amount_cents, cash_app, zelle, venmo, paypal, pay_at_appointment,
          country, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.ownerId,
        input.name.trim(),
        input.slug,
        input.plan ?? "free",
        input.subscriptionStatus ?? "none",
        input.stripeSubscriptionId ?? null,
        input.stripeAccountId ?? null,
        input.cardPaymentsStatus ?? null,
        input.payoutsStatus ?? null,
        input.depositEnabled ? 1 : 0,
        input.depositAmountCents ?? null,
        blankToNull(input.cashApp),
        blankToNull(input.zelle),
        blankToNull(input.venmo),
        blankToNull(input.paypal),
        input.payAtAppointment === false ? 0 : 1,
        (input.country ?? "US").toUpperCase(),
        new Date().toISOString(),
      );
    return this.getBusiness(id);
  }

  getBusiness(id: string): Business {
    const row = this.db.prepare("SELECT * FROM businesses WHERE id = ?").get(id) as BusinessRow | undefined;
    if (!row) throw new SchediError("Business not found.", 404);
    return mapBusiness(row);
  }

  getBusinessBySlug(slug: string): Business | null {
    const row = this.db.prepare("SELECT * FROM businesses WHERE slug = ?").get(slug) as BusinessRow | undefined;
    return row ? mapBusiness(row) : null;
  }

  getBusinessByOwner(ownerId: string): Business | null {
    const row = this.db.prepare("SELECT * FROM businesses WHERE owner_id = ?").get(ownerId) as BusinessRow | undefined;
    return row ? mapBusiness(row) : null;
  }

  listBusinesses(): Business[] {
    const rows = this.db.prepare("SELECT * FROM businesses ORDER BY name").all() as unknown as BusinessRow[];
    return rows.map(mapBusiness);
  }

  updatePaymentSettings(businessId: string, input: PaymentSettingsInput): Business {
    this.db
      .prepare(
        `UPDATE businesses SET
          cash_app = ?, zelle = ?, venmo = ?, paypal = ?, pay_at_appointment = ?,
          deposit_enabled = ?, deposit_amount_cents = ?
         WHERE id = ?`,
      )
      .run(
        blankToNull(input.cashApp),
        blankToNull(input.zelle),
        blankToNull(input.venmo),
        blankToNull(input.paypal),
        input.payAtAppointment ? 1 : 0,
        input.depositEnabled ? 1 : 0,
        input.depositAmountCents,
        businessId,
      );
    return this.getBusiness(businessId);
  }

  setStripeAccount(
    businessId: string,
    stripeAccountId: string,
    statuses: { cardPaymentsStatus: string | null; payoutsStatus: string | null },
  ): Business {
    this.db
      .prepare(
        `UPDATE businesses
         SET stripe_account_id = ?, card_payments_status = ?, payouts_status = ?
         WHERE id = ?`,
      )
      .run(stripeAccountId, statuses.cardPaymentsStatus, statuses.payoutsStatus, businessId);
    return this.getBusiness(businessId);
  }

  setCapabilities(
    businessId: string,
    statuses: { cardPaymentsStatus: string | null; payoutsStatus: string | null },
  ): Business {
    this.db
      .prepare("UPDATE businesses SET card_payments_status = ?, payouts_status = ? WHERE id = ?")
      .run(statuses.cardPaymentsStatus, statuses.payoutsStatus, businessId);
    return this.getBusiness(businessId);
  }

  setSubscription(
    ownerId: string,
    patch: {
      status: SubscriptionStatus;
      plan?: Plan;
      stripeSubscriptionId?: string | null;
      cancelAtPeriodEnd?: boolean;
      currentPeriodEnd?: string | null;
    },
  ): Business {
    const business = this.getBusinessByOwner(ownerId);
    if (!business) throw new SchediError("Business not found.", 404);
    const cancelAtPeriodEnd =
      patch.cancelAtPeriodEnd === undefined ? business.cancelAtPeriodEnd : patch.cancelAtPeriodEnd;
    const currentPeriodEnd =
      patch.currentPeriodEnd === undefined ? business.currentPeriodEnd : patch.currentPeriodEnd;
    this.db
      .prepare(
        `UPDATE businesses
         SET subscription_status = ?, plan = ?, stripe_subscription_id = ?,
             cancel_at_period_end = ?, current_period_end = ?
         WHERE id = ?`,
      )
      .run(
        patch.status,
        patch.plan ?? business.plan,
        patch.stripeSubscriptionId === undefined ? business.stripeSubscriptionId : patch.stripeSubscriptionId,
        cancelAtPeriodEnd ? 1 : 0,
        currentPeriodEnd,
        business.id,
      );
    return this.getBusiness(business.id);
  }

  createService(input: {
    businessId: string;
    name: string;
    durationMinutes: number;
    priceCents: number;
  }): Service {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO services (id, business_id, name, duration_minutes, price_cents)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.businessId, input.name.trim(), input.durationMinutes, input.priceCents);
    return this.getService(id);
  }

  getService(id: string): Service {
    const row = this.db.prepare("SELECT * FROM services WHERE id = ?").get(id) as ServiceRow | undefined;
    if (!row) throw new SchediError("Service not found.", 404);
    return mapService(row);
  }

  listServices(businessId: string): Service[] {
    const rows = this.db
      .prepare("SELECT * FROM services WHERE business_id = ? ORDER BY price_cents")
      .all(businessId) as unknown as ServiceRow[];
    return rows.map(mapService);
  }

  createBooking(input: CreateBookingInput): Booking {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO bookings (
          id, business_id, service_id, client_name, client_email, starts_at,
          payment_method, charge_kind, amount_cents, status, stripe_checkout_session_id,
          stripe_payment_intent_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        id,
        input.businessId,
        input.serviceId,
        input.clientName.trim(),
        input.clientEmail.trim().toLowerCase(),
        input.startsAt,
        input.paymentMethod,
        input.chargeKind,
        input.amountCents,
        input.status,
        createdAt,
      );
    return this.getBooking(id);
  }

  getBooking(id: string): Booking {
    const row = this.db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as BookingRow | undefined;
    if (!row) throw new SchediError("Booking not found.", 404);
    return mapBooking(row);
  }

  updateBooking(
    id: string,
    patch: Partial<Pick<Booking, "status" | "stripeCheckoutSessionId" | "stripePaymentIntentId">>,
  ): Booking {
    const current = this.getBooking(id);
    this.db
      .prepare(
        `UPDATE bookings SET status = ?, stripe_checkout_session_id = ?, stripe_payment_intent_id = ?
         WHERE id = ?`,
      )
      .run(
        patch.status ?? current.status,
        patch.stripeCheckoutSessionId === undefined ? current.stripeCheckoutSessionId : patch.stripeCheckoutSessionId,
        patch.stripePaymentIntentId === undefined ? current.stripePaymentIntentId : patch.stripePaymentIntentId,
        id,
      );
    return this.getBooking(id);
  }

  listBookings(businessId: string): Booking[] {
    const rows = this.db
      .prepare("SELECT * FROM bookings WHERE business_id = ? ORDER BY created_at DESC")
      .all(businessId) as unknown as BookingRow[];
    return rows.map(mapBooking);
  }

  hasStripeEvent(id: string): boolean {
    const row = this.db.prepare("SELECT id FROM stripe_events WHERE id = ?").get(id) as { id: string } | undefined;
    return Boolean(row);
  }

  markStripeEvent(id: string): void {
    this.db
      .prepare("INSERT INTO stripe_events (id, processed_at) VALUES (?, ?)")
      .run(id, new Date().toISOString());
  }

  createSession(ownerId: string): string {
    const token = randomUUID() + randomUUID();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare("INSERT INTO sessions (token, owner_id, expires_at) VALUES (?, ?, ?)").run(token, ownerId, expires);
    return token;
  }

  getOwnerBySession(token: string): Owner | null {
    const row = this.db.prepare("SELECT owner_id, expires_at FROM sessions WHERE token = ?").get(token) as
      | { owner_id: string; expires_at: string }
      | undefined;
    if (!row) return null;
    if (row.expires_at < new Date().toISOString()) {
      this.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
      return null;
    }
    return this.getOwner(row.owner_id);
  }

  deleteSession(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }
}

function ensureBusinessBillingColumns(db: DatabaseSync): void {
  const rows = db.prepare("PRAGMA table_info(businesses)").all() as { name: string }[];
  const names = new Set(rows.map((row) => row.name));
  if (!names.has("cancel_at_period_end")) {
    db.exec("ALTER TABLE businesses ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.has("current_period_end")) {
    db.exec("ALTER TABLE businesses ADD COLUMN current_period_end TEXT");
  }
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function openStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  return new Store(new DatabaseSync(path));
}

let singleton: Store | null = null;

export function getStore(): Store {
  if (!singleton) {
    const path = process.env.SCHEDI_DB_PATH ?? "data/schedi.sqlite";
    singleton = openStore(path);
  }
  return singleton;
}
