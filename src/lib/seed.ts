import type { Store } from "./db";

export function seedDemo(store: Store): void {
  const lumen = store.createOwner({ email: "ava@lumen.studio", name: "Ava Chen" });
  const lumenBiz = store.createBusiness({
    ownerId: lumen.id,
    name: "Lumen Studio",
    slug: "lumen",
    plan: "pro",
    subscriptionStatus: "active",
    depositEnabled: true,
    depositAmountCents: 5000,
    venmo: "@lumenstudio",
    payAtAppointment: true,
  });
  store.createService({
    businessId: lumenBiz.id,
    name: "Portrait session",
    durationMinutes: 60,
    priceCents: 18000,
  });

  const harbor = store.createOwner({ email: "nia@harbor.example", name: "Nia Brooks" });
  const harborBiz = store.createBusiness({
    ownerId: harbor.id,
    name: "Harbor Nails",
    slug: "harbor",
    plan: "pro",
    subscriptionStatus: "active",
    stripeAccountId: "acct_harbor",
    cardPaymentsStatus: "pending",
    payoutsStatus: "pending",
    depositEnabled: true,
    depositAmountCents: 1500,
    cashApp: "$HarborNails",
    zelle: "nia@harbor.example",
    payAtAppointment: true,
  });
  store.createService({
    businessId: harborBiz.id,
    name: "Manicure",
    durationMinutes: 45,
    priceCents: 4500,
  });

  const north = store.createOwner({ email: "leo@northwind.example", name: "Leo Park" });
  const northBiz = store.createBusiness({
    ownerId: north.id,
    name: "Northwind Cuts",
    slug: "northwind",
    plan: "pro",
    subscriptionStatus: "active",
    stripeAccountId: "acct_northwind",
    cardPaymentsStatus: "active",
    payoutsStatus: "active",
    depositEnabled: true,
    depositAmountCents: 2500,
    paypal: "leo@northwind.example",
    payAtAppointment: true,
  });
  store.createService({
    businessId: northBiz.id,
    name: "Haircut",
    durationMinutes: 45,
    priceCents: 8000,
  });

  const field = store.createOwner({ email: "sam@fieldwork.example", name: "Sam Rivera" });
  const fieldBiz = store.createBusiness({
    ownerId: field.id,
    name: "Fieldwork",
    slug: "fieldwork",
    plan: "starter",
    subscriptionStatus: "active",
    paypal: "hello@fieldwork.example",
    payAtAppointment: true,
  });
  store.createService({
    businessId: fieldBiz.id,
    name: "Consultation",
    durationMinutes: 50,
    priceCents: 6000,
  });

  const paused = store.createOwner({
    email: "rory@paused.example",
    name: "Rory Hale",
    stripeCustomerId: "cus_rory",
  });
  const pausedBiz = store.createBusiness({
    ownerId: paused.id,
    name: "Paused Studio",
    slug: "paused",
    plan: "pro",
    subscriptionStatus: "past_due",
    stripeSubscriptionId: "sub_paused",
    stripeAccountId: "acct_paused",
    cardPaymentsStatus: "active",
    payoutsStatus: "active",
    payAtAppointment: true,
  });
  store.createService({
    businessId: pausedBiz.id,
    name: "Private session",
    durationMinutes: 60,
    priceCents: 9000,
  });

  const free = store.createOwner({ email: "june@freedesk.example", name: "June Patel" });
  const freeBiz = store.createBusiness({
    ownerId: free.id,
    name: "Free Desk",
    slug: "free-desk",
    plan: "free",
    subscriptionStatus: "none",
    zelle: "june@freedesk.example",
    payAtAppointment: true,
  });
  store.createService({
    businessId: freeBiz.id,
    name: "Tutoring hour",
    durationMinutes: 60,
    priceCents: 4000,
  });
}
