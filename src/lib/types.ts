export type Plan = "free" | "starter" | "pro";

export type SubscriptionStatus =
  | "none"
  | "active"
  | "trialing"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "incomplete"
  | "incomplete_expired";

export type PaymentMethod =
  | "card"
  | "cash_app"
  | "zelle"
  | "venmo"
  | "paypal"
  | "pay_at_appointment";

export type ChargeKind = "full" | "deposit";

export type BookingStatus = "pending_payment" | "confirmed" | "payment_failed";

export interface Owner {
  id: string;
  email: string;
  name: string;
  stripeCustomerId: string | null;
}

export interface Business {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  plan: Plan;
  subscriptionStatus: SubscriptionStatus;
  stripeSubscriptionId: string | null;
  /** True after the owner asks to cancel. Access continues until currentPeriodEnd. */
  cancelAtPeriodEnd: boolean;
  /** ISO timestamp for the end of the paid period, when Stripe has one. */
  currentPeriodEnd: string | null;
  stripeAccountId: string | null;
  cardPaymentsStatus: string | null;
  payoutsStatus: string | null;
  depositEnabled: boolean;
  depositAmountCents: number | null;
  cashApp: string | null;
  zelle: string | null;
  venmo: string | null;
  paypal: string | null;
  payAtAppointment: boolean;
  country: string;
}

export interface Service {
  id: string;
  businessId: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
}

export interface Booking {
  id: string;
  businessId: string;
  serviceId: string;
  clientName: string;
  clientEmail: string;
  startsAt: string;
  paymentMethod: PaymentMethod;
  chargeKind: ChargeKind | null;
  amountCents: number;
  status: BookingStatus;
  stripeCheckoutSessionId: string | null;
  stripePaymentIntentId: string | null;
  createdAt: string;
}

export const PLANS = {
  free: { name: "Free", monthlyCents: 0 },
  starter: { name: "Starter", monthlyCents: 2900 },
  pro: { name: "Pro", monthlyCents: 4900 },
} as const;

export const OFF_PLATFORM_METHODS = [
  "cash_app",
  "zelle",
  "venmo",
  "paypal",
  "pay_at_appointment",
] as const satisfies readonly PaymentMethod[];
