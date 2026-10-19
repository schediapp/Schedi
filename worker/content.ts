// Public marketing copy served as HTML by the schedi-web Worker.
// Plan facts match the business portal: Free $0, Starter $29/mo, Pro $49/mo.

import { OWNER_SUBSCRIPTION_POLICY_TERMS } from "../src/lib/subscription-policy";
import { AEO_FAQS, barberPage, cleaningPage, comparePage, featuresPage } from "./aeo-pages";

export const APEX_ORIGIN = "https://schedi.app";

export type Faq = { question: string; answer: string };

export type MarketingPage = {
  path: string;
  title: string;
  description: string;
  h1: string;
  /** When true, the home document loads the owner-session redirect script. */
  portalBoot?: boolean;
  /** Hero illustration is the LCP image and is preloaded. */
  hero?: boolean;
  softwareJsonLd?: boolean;
  /** Rich marketing layout (hero, features, plan cards). Omit for plain article pages. */
  layout?: "home" | "pricing";
  /** Short line under the H1 in the rich layouts. */
  lede?: string;
  faqs: Faq[];
  /** HTML placed inside <article id="copy"> after the H1. Already safe. */
  bodyHtml: string;
  /**
   * scaffold: served for review, noindex, omitted from the sitemap, llms.txt,
   * and site navigation until published copy exists.
   */
  listing?: "public" | "scaffold";
};

const PLAN_FACTS =
  "Free is $0: pay at the appointment, one service, and five bookings a week. Those bookings confirm as soon as the client reserves. Starter is $29 a month: more than one service, no weekly booking cap, and Cash App, Venmo, Zelle, PayPal, plus pay at the appointment. Starter and Pro bookings stay pending until you accept or deny them. Pro is $49 a month and includes Starter. Card checkout and appointment deposits stay hidden until Stripe card payments and payouts are active. Repeating visits (weekly, biweekly, or monthly) are Pro only and stay off until you turn them on.";

export type PlanRow = {
  label: string;
  free: string;
  starter: string;
  pro: string;
  /**
   * Marketing-only. The portal cells stay Yes / Can charge.
   * Public pages show "Coming soon" for those affirmative cells, and never a checkmark.
   */
  comingSoon?: boolean;
};

/**
 * Mirror of schediPlanCompareRows() in site/index.html (signup Compare Plans).
 * Cell strings must match the portal. comingSoon is ignored by that comparison
 * and honored only by the marketing renderer.
 * tests/plan-rows-sync.test.ts fails if the row set drifts apart.
 */
export const PLAN_COMPARE_ROWS: PlanRow[] = [
  { label: "Monthly price", free: "$0", starter: "$29", pro: "$49" },
  { label: "Services", free: "1", starter: "Unlimited", pro: "Unlimited" },
  { label: "Bookings per week", free: "5", starter: "Unlimited", pro: "Unlimited" },
  { label: "Pay at appointment", free: "Yes", starter: "Yes", pro: "Yes" },
  { label: "Manual pay (Cash App, Venmo, Zelle, PayPal)", free: "No", starter: "Yes", pro: "Yes" },
  { label: "Card checkout (Stripe)", free: "No", starter: "No", pro: "Yes", comingSoon: true },
  { label: "Appointment deposits", free: "No", starter: "No", pro: "Yes", comingSoon: true },
  { label: "Cancellation fee on card", free: "Rule only", starter: "Rule only", pro: "Can charge", comingSoon: true },
  { label: "Booking approval", free: "Auto-confirm", starter: "Accept / Deny", pro: "Accept / Deny" },
  { label: "Repeating appointments", free: "No", starter: "No", pro: "Yes" },
  { label: "Agency Management", free: "No", starter: "No", pro: "Yes" },
];

/** Portal values that read as "this is available" on the marketing plan table and cards. */
const COMING_SOON_PORTAL_VALUES = new Set(["Yes", "Can charge"]);

export function marketingPlanValue(row: PlanRow, value: string): string {
  if (row.comingSoon && COMING_SOON_PORTAL_VALUES.has(value)) return "Coming soon";
  return value;
}

export function planCompareTableHtml(): string {
  const body = PLAN_COMPARE_ROWS.map((r) => {
    const cells = [r.free, r.starter, r.pro].map((value) => escapeHtml(marketingPlanValue(r, value)));
    return `<tr><th scope="row">${escapeHtml(r.label)}</th><td>${cells[0]}</td><td>${cells[1]}</td><td>${cells[2]}</td></tr>`;
  }).join("\n          ");
  return `<div class="table-wrap"><table>
        <caption>Compare every plan</caption>
        <thead>
          <tr><th scope="col">Feature</th><th scope="col">Free</th><th scope="col">Starter</th><th scope="col">Pro</th></tr>
        </thead>
        <tbody>
          ${body}
        </tbody>
      </table></div>`;
}

export const VERTICALS: { path: string; label: string }[] = [
  { path: "/for/barbers", label: "Barbers" },
  { path: "/for/hair-salons", label: "Hair salons" },
  { path: "/for/nail-salons", label: "Nail salons" },
  { path: "/for/cleaning-services", label: "Cleaning services" },
  { path: "/for/pet-groomers", label: "Pet groomers" },
  { path: "/for/personal-trainers", label: "Personal trainers" },
  { path: "/for/tattoo-artists", label: "Tattoo artists" },
  { path: "/for/massage-therapists", label: "Massage therapists" },
];

function p(text: string): string {
  return `<p>${text}</p>`;
}

function related(paths: string[]): string {
  const links = paths
    .map((path) => {
      const found = VERTICALS.find((item) => item.path === path);
      const label = found ? found.label : path;
      return `<a href="${path}">${label}</a>`;
    })
    .join(", ");
  return `<p>Related: ${links}. See <a href="/pricing">pricing</a> or go back to the <a href="/">Schedi home page</a>.</p>`;
}

const signupCta = `<p><a href="/signup">Create your page</a>. You can start on Free. Nothing is charged until checkout finishes.</p>`;

const shareLink =
  "The public page is one link, shaped like schedi.app/your-business. Copy it into a text, put it in a bio, or print that same URL as a QR code at the counter. Schedi does not draw the QR image. Any QR tool can encode the link you already have.";

const reminders =
  "Same-day reminder emails go to the client the morning of the appointment. They are on by default, and you pick the hour in the business's time zone. This is email, not a text message.";

const noShow =
  "A no-show still costs the time you held. The reminder email is the nudge the morning of the visit. Card checkout and appointment deposits stay hidden until Stripe card payments and payouts are active. A cancellation rule can be shown on the page. Charging that fee to a card stays hidden until those Stripe payments and payouts are active.";

const HELP_VIDEOS: { slug: string; title: string; desc: string; dur: string; v: number }[] = [
  { slug: "owner-01-create-your-page", title: "Create your booking page", desc: "Sign up and get your booking page ready in a few minutes.", dur: "0:24", v: 8 },
  { slug: "owner-02-add-services", title: "Add your services", desc: "Add each service with its length and an optional price.", dur: "0:21", v: 8 },
  { slug: "owner-03-set-hours", title: "Set your hours", desc: "Pick the days you work and your open and close times.", dur: "0:20", v: 9 },
  { slug: "owner-04-payment-options", title: "Payment options", desc: "Turn on Cash App, Zelle, Venmo, or PayPal, or keep pay at appointment.", dur: "0:28", v: 7 },
  { slug: "owner-05-share-booking-link", title: "Share your booking link", desc: "Copy or Share your link from the top of your portal. Open Public Page and Add to home screen are in More & settings.", dur: "0:20", v: 8 },
  { slug: "owner-06-accept-booking-request", title: "Accept a booking request", desc: "On phones, each booking is a card. Tap Accept and it shows as Accepted.", dur: "0:20", v: 8 },
  { slug: "owner-07-appointments-report", title: "Appointments report", desc: "See counts, recorded prices, marked paid, and walk-ins; export CSV or print.", dur: "0:21", v: 8 },
  { slug: "owner-08-add-manual-appointment", title: "Add a walk-in or phone booking", desc: "Log a walk-in or phone booking with the Walk-in toggle, saved-client suggest, open time slot, and payment status.", dur: "0:28", v: 8 },
  { slug: "owner-09-mark-paid", title: "Mark an appointment paid", desc: "Tap Mark paid, pick how the client paid, and the booking turns green.", dur: "0:22", v: 8 },
  { slug: "owner-10-reschedule", title: "Reschedule an appointment", desc: "Pick a new date and an open time slot, then tap Update Reservation.", dur: "0:23", v: 8 },
  { slug: "owner-11-cancel-appointment", title: "Cancel an appointment", desc: "Tap Cancel and confirm; the booking stays on your roster as Cancelled.", dur: "0:20", v: 8 },
  { slug: "owner-12-special-hours", title: "Special hours", desc: "Close or change your hours for one date without touching your weekly hours.", dur: "0:21", v: 9 },
  { slug: "owner-13-date-blocks", title: "Vacation and date blocks", desc: "Block a range of dates so clients cannot book them.", dur: "0:22", v: 9 },
  { slug: "owner-14-email-confirmations", title: "Email confirmations and reminders", desc: "Set your Reply-To email, an extra note, and same-day reminder emails.", dur: "0:23", v: 7 },
  { slug: "owner-15-recurring-visits-pro", title: "Recurring appointments", desc: "Let clients book weekly, every two weeks, or monthly. It stays off until you turn it on.", dur: "0:21", v: 7 },
  { slug: "owner-16-clients", title: "Clients list", desc: "Search, add, or remove clients. Clients added from a booking are labeled so you can tell.", dur: "0:24", v: 7 },
  { slug: "owner-17-import-clients-csv", title: "Import clients from CSV", desc: "Upload a CSV, match columns, preview, and import. Schedi never emails imports.", dur: "0:22", v: 8 },
  { slug: "owner-18-compare-plans", title: "Compare plans", desc: "Open the plan chart from your Schedi subscription card to see what each plan includes.", dur: "0:18", v: 8 },
  { slug: "owner-19-roster-week-month", title: "Week and month roster", desc: "Switch to Week or Month, move with Previous, Next, or Today, tap a booking for details, and tap a busy day.", dur: "0:22", v: 8 },
  { slug: "client-booking-demo", title: "How clients book", desc: "Clients pick a service, a day and time, enter their info, and choose how to pay.", dur: "0:29", v: 9 },
];

export const MARKETING_PAGES: MarketingPage[] = [
  {
    path: "/",
    title: "Schedi | Booking pages for service businesses",
    description:
      "Clients book on your link instead of texts and paper forms. Free, Starter $29/mo, or Pro $49/mo.",
    h1: "Your clients book online. You get your time back.",
    lede: "Schedi gives your business one simple booking link. Clients pick a service and a time, and the appointment lands in your portal. No more back-and-forth texts or paper forms.",
    layout: "home",
    hero: true,
    softwareJsonLd: true,
    faqs: [
      {
        question: "What does Schedi cost?",
        answer:
          "Free is $0. Starter is $29 a month. Pro is $49 a month. Nothing is charged until checkout finishes. " +
          OWNER_SUBSCRIPTION_POLICY_TERMS.join(" "),
      },
      {
        question: "Can clients pay by card?",
        answer:
          "Card checkout and appointment deposits stay hidden until Stripe card payments and payouts are active. They are not available to clients today. Cash App, Venmo, Zelle, PayPal, and pay at the appointment are separate. Free only allows pay at the appointment.",
      },
      {
        question: "How do reminders work?",
        answer:
          "Schedi can email the client a reminder on the morning of the appointment. The reminder is on by default, and the owner picks the hour in the business time zone.",
      },
      {
        question: "Where do I send clients?",
        answer:
          "Each business gets a link such as schedi.app/your-business. Share that link, or print it as a QR code. The client picks a service and an open time.",
      },
    ],
    bodyHtml: [
      p("Schedi gives a salon, a field trade, or an accountant one link. A client picks a service and a time. The appointment shows up in your portal."),
      `<section aria-label="Who Schedi is for">
        <h2>Who it is for</h2>
        <h3>Salon and beauty</h3>
        <p>One service on Free. Add more on Starter or Pro. Clients use your link instead of calling.</p>
        <h3>Field trades</h3>
        <p>Share the link from your phone. The client picks an open time inside the hours you set.</p>
        <h3>Accountants</h3>
        <p>A booking page for appointments you used to take on a form or in a text thread.</p>
      </section>`,
      `<section>
        <h2>How a page works</h2>
        <ol>
          <li><strong>Create the page.</strong> Sign up. Free is $0. You get a link like schedi.app/your-business.</li>
          <li><strong>Add a service and your hours.</strong> Free keeps one service and five bookings a week.</li>
          <li><strong>Send the link.</strong> The client chooses a time. You manage it in the business portal.</li>
        </ol>
      </section>`,
      p(shareLink),
      p(reminders),
      p(noShow),
      `<p>Read the pages for <a href="/for/barbers">barbers</a>, <a href="/for/hair-salons">hair salons</a>, <a href="/for/cleaning-services">cleaning services</a>, <a href="/features">features</a>, <a href="/compare">Schedi vs other booking tools</a>, and the rest of the <a href="/pricing">pricing</a> comparison. <a href="/signup">Create your page</a> or open <a href="/help">help</a>.</p>`,
    ].join("\n"),
  },
  {
    path: "/pricing",
    title: "Schedi pricing | Free, Starter, and Pro",
    description:
      "Compare Free at $0, Starter at $29/mo, and Pro at $49/mo. Paid plans are month-to-month.",
    h1: "Simple pricing that grows with you",
    lede: "Start free and upgrade when you're ready. Prices are monthly, and nothing is charged until checkout finishes.",
    layout: "pricing",
    softwareJsonLd: true,
    faqs: [
      ...AEO_FAQS,
      {
        question: "Can I start on Free?",
        answer:
          "Yes. Free is $0, with pay at the appointment, one service, and five bookings a week. Upgrade from the business portal when you need more.",
      },
      {
        question: "When is the Schedi plan charged?",
        answer:
          "Nothing is charged until checkout finishes. Card details for the owner subscription stay on Stripe. Free businesses are not charged.",
      },
      {
        question: "What does Pro add for client payments?",
        answer:
          "Card checkout and an optional appointment deposit stay hidden until Stripe card payments and payouts are active. They are not available to clients today.",
      },
    ],
    bodyHtml: [
      p("Prices are monthly. Upgrade or switch from the business portal. Nothing is charged until checkout finishes."),
      ...OWNER_SUBSCRIPTION_POLICY_TERMS.map((paragraph) => p(paragraph)),
      planCompareTableHtml(),
      p(PLAN_FACTS),
      p("Owner subscriptions bill on the Schedi platform account. Cash App, Zelle, Venmo, PayPal, and pay at the appointment do not create a Stripe charge. Card checkout and appointment deposits stay hidden until Stripe card payments and payouts are active."),
      p(reminders + " " + shareLink),
      p("A failed payment, or a subscription that has ended, pauses the public booking page. Canceling keeps access until the paid period ends and does not pause the page. Complimentary plans are unaffected."),
      `<p>Pages for specific businesses: <a href="/for/barbers">barbers</a>, <a href="/for/hair-salons">hair salons</a>, <a href="/for/nail-salons">nail salons</a>, <a href="/for/cleaning-services">cleaners</a>, <a href="/for/pet-groomers">pet groomers</a>, <a href="/for/personal-trainers">trainers</a>, <a href="/for/tattoo-artists">tattoo artists</a>, and <a href="/for/massage-therapists">massage therapists</a>.</p>`,
      signupCta,
    ].join("\n"),
  },
  {
    path: "/help",
    title: "Schedi help | Business portal steps",
    description:
      "Written steps for services, hours, payments, reminders, and the public booking link. Names match the buttons in the portal.",
    h1: "Help",
    faqs: [
      ...AEO_FAQS,
      {
        question: "Where is the booking link?",
        answer:
          "The link at the top of the business portal is the booking page. Copy link and Share use https://schedi.app/ and your slug.",
      },
      {
        question: "Why was a second service not saved?",
        answer: "Free keeps one service. A second service is not saved until the business is on Starter or Pro.",
      },
      {
        question: "Which plan can take a card?",
        answer:
          "Card checkout and appointment deposits stay hidden until Stripe card payments and payouts are active. They are not available to clients today. Starter can use Cash App, Venmo, Zelle, PayPal, and pay at the appointment. Starter doesn't include card checkout. Free only allows pay at the appointment.",
      },
    ],
    bodyHtml: [
      p("Short steps for the business portal. Names match the buttons on the screen."),
      helpVideosHtml(),
      `<section><h2>Sign in</h2><ol><li>Open Schedi and sign in to the Business Portal.</li><li>Enter the owner email and password.</li></ol></section>`,
      `<section><h2>Add a service</h2><ol><li>Open Manage Services.</li><li>Click Add service.</li><li>Enter the name, duration, optional price, and description, then save. Leave price blank if you do not want a price shown.</li><li>Use Edit or Delete on a service you already added.</li><li>Free keeps one service. A second service is not saved.</li></ol></section>`,
      `<section><h2>Set hours</h2><ol><li>Open Hours &amp; Blocked Times.</li><li>Check Open for a day, then set Start and End.</li><li>Choose Start times every 15 minutes, 30 minutes, or 1 hour.</li><li>Click Save Operating Hours.</li><li>Use Add Special Hours to open or change one date without editing the weekly schedule.</li><li>Use Add Recurring Outage or Add Date Block when you need time off.</li></ol></section>`,
      `<section><h2>Payments</h2><ol><li>Open Payment Options.</li><li>Free only allows Pay at Appointment.</li><li>Starter can use Cash App, Venmo, Zelle, PayPal, and Pay at Appointment. Starter doesn't include card checkout.</li><li>Credit / debit card checkout stays hidden until Stripe card payments and payouts are active. It is not offered to clients today.</li><li>Appointment deposits stay hidden until Stripe card payments and payouts are active.</li><li>Cancellation fee stays off until you turn it on. Set the hours (default 24) and a percent or a fixed amount. Charging that fee to a card stays hidden until Stripe card payments and payouts are active. Free and Starter only show the rule.</li><li>Click Save Payment Gateways.</li></ol></section>`,
      `<section><h2>Appointments</h2><ol><li>Open Appointments Roster.</li><li>Free bookings are confirmed as soon as the client reserves.</li><li>Starter and Pro bookings stay pending. Click Accept or Deny. Deny frees that time.</li><li>Mark paid, Reschedule, and Cancel are on the same row.</li><li>Add Manual Appointment records a visit you took in person.</li></ol></section>`,
      `<section><h2>Repeating visits</h2><ol><li>Open Email Confirmations.</li><li>On Pro, turn on Allow recurring appointments and click Save Email Settings.</li><li>Free and Starter do not show repeating visits on the booking page.</li></ol></section>`,
      `<section><h2>Your Schedi plan</h2>${OWNER_SUBSCRIPTION_POLICY_TERMS.map((paragraph) => p(paragraph)).join("")}<p>Use Cancel subscription to stop renewal at the end of the paid period. Resume subscription if you change your mind before then. Card updates stay in Manage billing.</p></section>`,
      `<section><h2>Your public page</h2><p>The link at the top of the portal is the booking page. Copy link and Share use https://schedi.app/ and your slug. Put that link in a text or on a QR code you print. Clients who need booking steps can open <a href="/help/booking">booking help</a> from the business page.</p></section>`,
      `<p><a href="/">Back to Schedi</a> · <a href="/pricing">Pricing</a> · <a href="/signup">Sign up</a></p>`,
    ].join("\n"),
  },
  featuresPage(),
  comparePage(),
  {
    path: "/terms",
    title: "Terms of Service | Schedi",
    description:
      "Owner plans are month-to-month with no contract. Cancel at period end. A first payment is refundable within 15 days.",
    h1: "Terms of Service",
    faqs: [],
    bodyHtml: [
      p("When someone books, Schedi collects their name, email, phone, and payment status."),
      p("The business owner is the controller of that appointment data. Schedi is the processor. Stripe and Firebase/Google are sub-processors."),
      p("Appointments are kept until the business or Schedi deletes them."),
      p("Schedi is not HIPAA compliant and must not be used to collect protected health information. That includes businesses using the Medical / Healthcare preset."),
      ...OWNER_SUBSCRIPTION_POLICY_TERMS.map((paragraph) => p(paragraph)),
      p("This page describes how the product works today. It is not a substitute for a lawyer."),
      `<p><a href="/privacy">Privacy Policy</a></p>`,
      `<p><a href="/">Back to Schedi</a></p>`,
    ].join("\n"),
  },
  {
    path: "/privacy",
    title: "Privacy Policy | Schedi",
    description:
      "Schedi collects a client's name, email, phone, and payment status when they book. The business owner controls that data.",
    h1: "Privacy Policy",
    faqs: [],
    bodyHtml: [
      p("When someone books, Schedi collects their name, email, phone, and payment status."),
      p("The business owner is the controller of that appointment data. Schedi is the processor. Stripe and Firebase/Google are sub-processors."),
      p("Appointments are kept until the business or Schedi deletes them."),
      p("Schedi is not HIPAA compliant and must not be used to collect protected health information. That includes businesses using the Medical / Healthcare preset."),
      p("This page describes how the product works today. It is not a substitute for a lawyer."),
      `<p><a href="/terms">Terms of Service</a></p>`,
      `<p><a href="/">Back to Schedi</a></p>`,
    ].join("\n"),
  },
  barberPage(),
  vertical({
    path: "/for/hair-salons",
    title: "Booking software for hair salons | Schedi",
    description:
      "Let cut and color clients pick an open time from your link. A reminder email goes out the morning of the appointment.",
    h1: "Booking pages built for hair salons",
    related: ["/for/barbers", "/for/nail-salons"],
    paragraphs: [
      "A salon day falls apart when color appointments live in Instagram messages. A partial highlight takes a long block, and a double-booked afternoon cannot be fixed by scrolling. Schedi gives the salon one booking page. You add each service with its own duration and an optional price. The client picks the service and a start time that still fits before you close.",
      "The visits that hurt are the ones that vanish the morning of a three-hour color. A same-day reminder email goes out at the hour you choose. Card checkout and appointment deposits stay hidden until Stripe card payments and payouts are active. Cash App, Venmo, Zelle, PayPal, and pay at the appointment stay available when you turn them on.",
      "Free holds one service and five bookings a week, enough to try a single cut. A menu with a cut, a blowout, and a color needs Starter at $29 a month or Pro at $49 a month, or the extra services are not saved. Starter and Pro bookings wait for Accept or Deny, which matters when you need to check a color correction first. Special hours cover a late open. A date block covers a class week. Share schedi.app/your-salon, or print that link as a QR code at the desk.",
    ],
  }),
  vertical({
    path: "/for/nail-salons",
    title: "Booking software for nail salons | Schedi",
    description:
      "One booking link for manicures, pedicures, and fills. Starter saves more than one service.",
    h1: "Nail salon booking without the DM thread",
    related: ["/for/hair-salons", "/for/massage-therapists"],
    paragraphs: [
      "Nail appointments get booked in comment threads and then forgotten. A fill and a full set do not take the same amount of time, so a single message does not tell you whether the chair is open. On Schedi the client chooses the service you named and a start time that fits the duration you saved.",
      "A no-show costs the next set that could have taken that chair. Schedi sends a reminder email the morning of the visit. Card checkout and appointment deposits stay hidden until Stripe card payments and payouts are active. A cancellation rule can be shown on the page. Charging that fee to a card stays hidden until those Stripe payments and payouts are active. Free and Starter only display the rule.",
      "Free keeps one service, which is a fair trial for a basic manicure, and caps the week at five bookings. Gel, acrylic, and a pedicure need Starter ($29 a month) or Pro ($49 a month) or the extra services will not be saved. Starter also adds Cash App, Venmo, Zelle, and PayPal. Starter doesn't include card checkout. Log a walk-in as a manual appointment so the public page is not offering a chair someone is already sitting in. The link can go in a bio or on a QR code you print.",
    ],
  }),
  cleaningPage(),
  vertical({
    path: "/for/pet-groomers",
    title: "Booking software for pet groomers | Schedi",
    description:
      "Put baths and full grooms on one booking page. Reminder emails go out the morning of the appointment.",
    h1: "Pet grooming appointments without the phone tag",
    related: ["/for/barbers", "/for/cleaning-services"],
    paragraphs: [
      "Grooming days are a stack of baths, haircuts, and nails, and the phone is a bad way to stack them. A full groom is not the same length as a bath. Schedi lets you name each service, set how long it takes, and optionally set a price. The client picks one and an open start time. The form asks for the client's name, phone, and email. It does not collect a pet profile or medical notes.",
      "Keep health details off the page. Schedi is not HIPAA compliant and is not a place for protected health information. Put the kind of visit in the service name, for example bath or full groom. A no-show still burns the tub time. The morning reminder email is on by default. Card checkout and appointment deposits stay hidden until Stripe card payments and payouts are active.",
      "Free saves one service and five bookings a week, paid at pickup. Starter at $29 a month is where a bath, a haircut, and nails can all exist, with Cash App, Venmo, Zelle, or PayPal if you want them. Pro is $49 a month. Card checkout stays hidden until Stripe card payments and payouts are active. Use date blocks when the shop is closed and special hours when Saturday is short baths only. The booking link can sit in a text or on a QR code at the counter. Schedi does not generate that QR image.",
    ],
  }),
  vertical({
    path: "/for/personal-trainers",
    title: "Booking software for trainers | Schedi",
    description:
      "Clients reserve a session from your link instead of a text. Pro adds repeating weekly sessions.",
    h1: "Session booking for personal trainers",
    related: ["/for/massage-therapists", "/for/cleaning-services"],
    paragraphs: [
      "Trainers lose sessions between a text that says 'you around after work?' and a calendar that never got updated. Schedi is a booking page for the sessions you actually teach. Add a service for the length you sell, set the hours you are on the floor, and send the link. The client chooses a time that is still open.",
      "A missed session is an empty hour. Schedi emails a reminder the morning of the session. On Pro a client can book a weekly, biweekly, or monthly series, and that control stays off until you turn it on. Card checkout and appointment deposits stay hidden until Stripe card payments and payouts are active. Free and Starter sell one visit at a time. Schedi does not add a waitlist or a second trainer's calendar. It is one page and the hours you set.",
      "Free is $0: one session type, five bookings a week, pay at the session, confirmed immediately. Starter is $29 a month and removes the cap, lets you list more than one session, and adds Cash App, Venmo, Zelle, and PayPal. Pro is $49 a month. Starter doesn't include card checkout. Accept or deny, on Starter and Pro, lets you talk to a new client before the hour locks. Put schedi.app/your-name in a bio or on a QR code at the desk.",
    ],
  }),
  vertical({
    path: "/for/tattoo-artists",
    title: "Booking software for tattoo artists | Schedi",
    description:
      "Hold a tattoo session on your booking page. A reminder email goes out the morning of the visit.",
    h1: "Tattoo session booking on your own page",
    related: ["/for/barbers", "/for/hair-salons"],
    paragraphs: [
      "A tattoo session is a long block, and a no-show is not a ten-minute gap. Artists already ask for a deposit for that reason. Schedi is the page where the client picks the service you created, such as a consultation or a session, and a start time inside your hours. The request lands in the portal for you to accept or deny on Starter and Pro.",
      "Card checkout and appointment deposits stay hidden until Stripe card payments and payouts are active. The client can still choose Cash App, Zelle, Venmo, PayPal, or pay at the appointment when those are on. Schedi does not add an application fee.",
      "Free is a poor fit for custom work: one service, five bookings a week, and the visit confirms immediately. Starter is $29 a month and keeps new bookings pending so you can accept a design you have seen. Pro is $49 a month. A reminder email goes out the morning of the session. Share schedi.app/your-studio, or print that link as a QR code in the shop. Use a date block when you are on a guest spot and the books are closed.",
    ],
  }),
  vertical({
    path: "/for/massage-therapists",
    title: "Booking software for massage | Schedi",
    description:
      "A booking page for massage appointments, with morning reminder emails. Schedi is not HIPAA compliant.",
    h1: "Massage booking that stays off medical charts",
    related: ["/for/personal-trainers", "/for/nail-salons"],
    paragraphs: [
      "Massage appointments get scattered across texts, and a 90-minute block that disappears the same day is hard to fill. Schedi gives you a page where the client picks the service, for example a 60-minute or 90-minute session, and an open time. You set the duration when you add the service. The portal shows the booking with the client's name, phone, and email.",
      "Schedi is not HIPAA compliant and must not be used to collect protected health information. Do not ask clients to put injuries, diagnoses, medications, or treatment notes in the booking. The form collects contact details and the service you defined. Intake that belongs in a medical record belongs somewhere else. That is the same limit shown to businesses on the Medical preset.",
      "A no-show still leaves an empty table. The reminder email goes out the morning of the appointment. Card checkout and appointment deposits stay hidden until Stripe card payments and payouts are active. Repeating visits on Pro can hold the same weekday, and they stay hidden until you enable them. Free is one service and five bookings a week. Starter at $29 a month adds more services and Cash App, Venmo, Zelle, or PayPal. Pro is $49 a month. Share the link, or print it as a QR code. Schedi does not draw the QR image.",
    ],
  }),
];

function vertical(input: {
  path: string;
  title: string;
  description: string;
  h1: string;
  related: string[];
  paragraphs: string[];
}): MarketingPage {
  return {
    path: input.path,
    title: input.title,
    description: input.description,
    h1: input.h1,
    hero: true,
    faqs: [
      {
        question: "How does a client book?",
        answer:
          "They open your Schedi link, choose a service, pick an open time, and enter their name, phone, and email. They can choose a payment option you turned on.",
      },
      {
        question: "What helps with no-shows?",
        answer:
          "Schedi emails a reminder the morning of the appointment. Card checkout and appointment deposits stay hidden until Stripe card payments and payouts are active.",
      },
      {
        question: "Which plan do I need for card payments?",
        answer:
          "Card checkout and appointment deposits stay hidden until Stripe card payments and payouts are active. They are not available to clients today. Starter at $29 a month adds Cash App, Venmo, Zelle, and PayPal. Free is pay at the appointment.",
      },
    ],
    bodyHtml: [...input.paragraphs.map(p), related(input.related), signupCta].join("\n"),
  };
}

function helpVideosHtml(): string {
  const cards = HELP_VIDEOS.map((video) => {
    const poster = `/assets/help-videos/${video.slug}.jpg?v=${video.v}`;
    const file = `/assets/help-videos/${video.slug}.mp4?v=${video.v}`;
    const title = escapeHtml(video.title);
    const desc = escapeHtml(video.desc);
    return `<figure>
      <video class="schedi-help-video" controls preload="none" poster="${poster}" width="720" height="1280">
        <source src="${file}" type="video/mp4">
      </video>
      <figcaption><strong>${title}</strong> (${escapeHtml(video.dur)}). ${desc}</figcaption>
    </figure>`;
  }).join("\n");
  return `<section class="help-clips"><h2>Video tutorials</h2><p>Short videos, about 20 seconds each. They load when you press play.</p><div class="help-clip-grid">${cards}</div></section>`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

const byPath = new Map(MARKETING_PAGES.map((page) => [page.path, page]));

export function marketingPage(path: string): MarketingPage | null {
  return byPath.get(path) ?? null;
}

export function publicPaths(): string[] {
  return MARKETING_PAGES.filter((page) => page.listing !== "scaffold").map((page) => page.path);
}

for (const page of MARKETING_PAGES) {
  if (page.title.length > 60) {
    throw new Error(`Title too long (${page.title.length}): ${page.title}`);
  }
  if (page.description.length > 155) {
    throw new Error(`Description too long (${page.description.length}): ${page.path}`);
  }
  if (new Set(MARKETING_PAGES.map((item) => item.title)).size !== MARKETING_PAGES.length) {
    throw new Error("Marketing titles must be unique");
  }
  if (new Set(MARKETING_PAGES.map((item) => item.h1)).size !== MARKETING_PAGES.length) {
    throw new Error("Marketing H1s must be unique");
  }
}
