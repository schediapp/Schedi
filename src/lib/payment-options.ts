import { formatUsd } from "./money";
import { isCardCheckoutReady } from "./readiness";
import type { Business, ChargeKind, PaymentMethod, Service } from "./types";

export interface PaymentChoice {
  method: PaymentMethod;
  chargeKind: ChargeKind | null;
  amountCents: number | null;
  label: string;
  detail: string;
  value: string;
}

export function depositAmountFor(service: Service, business: Business): number | null {
  if (!business.depositEnabled || business.depositAmountCents == null) return null;
  if (business.depositAmountCents < 50) return null;
  if (business.depositAmountCents >= service.priceCents) return null;
  return business.depositAmountCents;
}

export function listPaymentOptions(business: Business, service: Service): PaymentChoice[] {
  const options: PaymentChoice[] = [];

  if (isCardCheckoutReady(business)) {
    options.push({
      method: "card",
      chargeKind: "full",
      amountCents: service.priceCents,
      label: `Pay ${formatUsd(service.priceCents)} by card`,
      detail: `${business.name} is the merchant on this charge.`,
      value: "card:full",
    });

    const deposit = depositAmountFor(service, business);
    if (deposit != null) {
      const rest = service.priceCents - deposit;
      options.push({
        method: "card",
        chargeKind: "deposit",
        amountCents: deposit,
        label: `Pay a ${formatUsd(deposit)} card deposit`,
        detail: `The remaining ${formatUsd(rest)} is collected in person.`,
        value: "card:deposit",
      });
    }
  }

  if (business.cashApp) {
    options.push(offPlatform("cash_app", "Cash App", business.cashApp));
  }
  if (business.zelle) {
    options.push(offPlatform("zelle", "Zelle", business.zelle));
  }
  if (business.venmo) {
    options.push(offPlatform("venmo", "Venmo", business.venmo));
  }
  if (business.paypal) {
    options.push(offPlatform("paypal", "PayPal", business.paypal));
  }
  if (business.payAtAppointment) {
    options.push({
      method: "pay_at_appointment",
      chargeKind: null,
      amountCents: null,
      label: "Pay at the appointment",
      detail: "No card charge. Pay the business when you arrive.",
      value: "pay_at_appointment",
    });
  }

  return options;
}

function offPlatform(method: PaymentMethod, name: string, handle: string): PaymentChoice {
  return {
    method,
    chargeKind: null,
    amountCents: null,
    label: name,
    detail: handle,
    value: method,
  };
}

export function parsePaymentChoice(value: string): { method: PaymentMethod; chargeKind: ChargeKind | null } | null {
  if (value === "card:full") return { method: "card", chargeKind: "full" };
  if (value === "card:deposit") return { method: "card", chargeKind: "deposit" };
  if (
    value === "cash_app" ||
    value === "zelle" ||
    value === "venmo" ||
    value === "paypal" ||
    value === "pay_at_appointment"
  ) {
    return { method: value, chargeKind: null };
  }
  return null;
}
