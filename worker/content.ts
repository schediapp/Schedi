// Public marketing copy served as HTML by the schedi-web Worker.
// Plan facts match the business portal: Free $0, Starter $29/mo, Pro $49/mo.

import { OWNER_SUBSCRIPTION_POLICY_TERMS } from "../src/lib/subscription-policy";

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
  faqs: Faq[];
  /** HTML placed inside <article id="copy"> after the H1. Already safe. */
  bodyHtml: string;
};

const PLAN_FACTS =
  "Free is $0: pay at the appointment, one service, and five bookings a week. Those bookings confirm as soon as the client reserves. Starter is $29 a month: more than one service, no weekly booking cap, and Cash App, Venmo, Zelle, PayPal, plus pay at the appointment. Starter and Pro bookings stay pending until you accept or deny them. Pro is $49 a month and includes Starter. Card checkout and an appointment deposit are Pro settings. Both stay off until you turn them on. A card charge, including a deposit, is created on the business's Stripe account. Schedi does not take a cut of that charge. Repeating visits (weekly, biweekly, or monthly) are Pro only and stay off until you turn them on.";

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
  "A no-show still costs the time you held. The reminder email is the nudge the morning of the visit. On Pro, a card deposit can be required before the appointment is confirmed, and it stays off until you turn it on. Free and Starter cannot collect a card deposit. If a client who already paid by card cancels inside the window you set, Pro can charge that cancellation fee. Free and Starter can show the rule and do not charge a card.";

const HELP_VIDEOS: { slug: string; title: string; desc: string; dur: string }[] = [
  { slug: "owner-01-create-your-page", title: "Create your booking page", desc: "Sign up, get your free page, and compare Free, Starter, and Pro.", dur: "0:24" },
  { slug: "owner-02-add-services", title: "Add your services", desc: "Add each service with its length and an optional price.", dur: "0:21" },
  { slug: "owner-03-set-hours", title: "Set your hours", desc: "Pick the days you work and your open and close times.", dur: "0:20" },
  { slug: "owner-04-payment-options", title: "Payment options", desc: "Turn on Cash App, Zelle, Venmo, or PayPal on Starter and Pro, or keep pay at appointment.", dur: "0:28" },
  { slug: "owner-05-share-booking-link", title: "Share your booking link", desc: "Copy your link for your bio and see what clients see.", dur: "0:20" },
  { slug: "owner-14-email-confirmations", title: "Email confirmations and reminders", desc: "Set your reply-to email and same-day reminder emails.", dur: "0:23" },
  { slug: "client-booking-demo", title: "How clients book", desc: "Clients pick a service, a day and time, enter their info, and choose how to pay.", dur: "0:29" },
];

export const MARKETING_PAGES: MarketingPage[] = [
  {
    path: "/",
    title: "Schedi | Booking pages for service businesses",
    description:
      "Clients book on your link instead of texts and paper forms. Free, Starter $29/mo, or Pro $49/mo with card payments and deposits.",
    h1: "Clients book on your page. You stop collecting appointments by text and paper forms.",
    portalBoot: true,
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
          "Card checkout and card deposits are Pro settings. They stay off until the owner turns them on. The charge is created on that business's Stripe account. Cash App, Venmo, Zelle, PayPal, and pay at the appointment never touch that account. Free only allows pay at the appointment.",
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
      `<section>
        <h2>Plans</h2>
        <p>Free is $0. Starter is $29/mo. Pro is $49/mo. Nothing is charged until checkout finishes.</p>
        <h3>Free</h3>
        <p>$0. Pay at the appointment. One service. Five bookings a week.</p>
        <h3>Starter</h3>
        <p>$29/mo. Pay at the appointment. Cash App, Venmo, Zelle, and PayPal. More than one service. No weekly booking cap.</p>
        <h3>Pro</h3>
        <p>$49/mo. Everything in Starter. Card checkout, off until you turn it on. Card deposit, off until you turn it on. Repeating visits, off until you turn it on.</p>
        <p>Card checkout, a card deposit, and repeating visits are Pro settings. They stay off until you turn them on. Free only allows pay at the appointment.</p>
      </section>`,
      p(shareLink),
      p(reminders),
      p(noShow),
      `<p>Read the pages for <a href="/for/barbers">barbers</a>, <a href="/for/hair-salons">hair salons</a>, <a href="/for/cleaning-services">cleaning services</a>, and the rest of the <a href="/pricing">pricing</a> comparison. <a href="/signup">Create your page</a> or open <a href="/help">help</a>.</p>`,
    ].join("\n"),
  },
  {
    path: "/pricing",
    title: "Schedi pricing | Free, Starter, and Pro",
    description:
      "Compare Free at $0, Starter at $29/mo, and Pro at $49/mo. Pro adds client card payments and deposits through Stripe.",
    h1: "Schedi pricing",
    softwareJsonLd: true,
    faqs: [
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
          "Pro can turn on card checkout and an optional appointment deposit. Both stay off until you turn them on. The client's card payment is a charge on the business's Stripe account.",
      },
      {
        question: "Can I get a refund?",
        answer: OWNER_SUBSCRIPTION_POLICY_TERMS.join(" "),
      },
    ],
    bodyHtml: [
      p("Prices are monthly. Upgrade or switch from the business portal. Nothing is charged until checkout finishes."),
      ...OWNER_SUBSCRIPTION_POLICY_TERMS.map((paragraph) => p(paragraph)),
      `<table>
        <caption>Plan comparison</caption>
        <thead>
          <tr><th>Feature</th><th>Free</th><th>Starter</th><th>Pro</th></tr>
        </thead>
        <tbody>
          <tr><th>Monthly price</th><td>$0</td><td>$29</td><td>$49</td></tr>
          <tr><th>Services</th><td>1</td><td>Unlimited</td><td>Unlimited</td></tr>
          <tr><th>Bookings per week</th><td>5</td><td>Unlimited</td><td>Unlimited</td></tr>
          <tr><th>Pay at appointment</th><td>Yes</td><td>Yes</td><td>Yes</td></tr>
          <tr><th>Manual pay (Cash App, Venmo, Zelle, PayPal)</th><td>No</td><td>Yes</td><td>Yes</td></tr>
          <tr><th>Card checkout (Stripe)</th><td>No</td><td>No</td><td>Yes</td></tr>
          <tr><th>Appointment deposits</th><td>No</td><td>No</td><td>Yes</td></tr>
          <tr><th>Cancellation fee on card</th><td>Rule only</td><td>Rule only</td><td>Can charge</td></tr>
          <tr><th>Booking approval</th><td>Auto-confirm</td><td>Accept / Deny</td><td>Accept / Deny</td></tr>
          <tr><th>Repeating appointments</th><td>No</td><td>No</td><td>Yes</td></tr>
        </tbody>
      </table>`,
      p(PLAN_FACTS),
      p("Owner subscriptions bill on the Schedi platform account. Client card payments are separate: they are direct charges on the connected account the business finishes in Stripe. Cash App, Zelle, Venmo, PayPal, and pay at the appointment do not create a Stripe charge."),
      p(reminders + " " + shareLink),
      p("A failed payment, or a subscription that has ended, pauses the public booking page. Canceling keeps access until the paid period ends and does not pause the page. Complimentary plans are unaffected. A failed client card does not, by itself, pause the page."),
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
          "Pro can turn on credit or debit card checkout through Stripe. Card checkout and deposits stay off until you turn them on. Starter can use Cash App, Venmo, Zelle, PayPal, and pay at the appointment. Free only allows pay at the appointment.",
      },
    ],
    bodyHtml: [
      p("Short steps for the business portal. Names match the buttons on the screen."),
      helpVideosHtml(),
      `<section><h2>Sign in</h2><ol><li>Open Schedi and sign in to the Business Portal.</li><li>Enter the owner email and password.</li></ol></section>`,
      `<section><h2>Add a service</h2><ol><li>Open Manage Services.</li><li>Click Add New Service.</li><li>Enter the name, duration, optional price, and description, then save. Leave price blank if you do not want a price shown.</li><li>Use Edit or Delete on a service you already added.</li><li>Free keeps one service. A second service is not saved.</li></ol></section>`,
      `<section><h2>Set hours</h2><ol><li>Open Hours &amp; Blocked Times.</li><li>Check Open for a day, then set Start and End.</li><li>Choose Start times every 15 minutes, 30 minutes, or 1 hour.</li><li>Click Save Operating Hours.</li><li>Use Add Special Hours to open or change one date without editing the weekly schedule.</li><li>Use Add Recurring Outage or Add Date Block when you need time off.</li></ol></section>`,
      `<section><h2>Payments</h2><ol><li>Open Payment Options.</li><li>Free only allows Pay at Appointment.</li><li>Starter can use Cash App, Venmo, Zelle, PayPal, and Pay at Appointment. Card checkout is not offered.</li><li>Pro can also turn on Credit / Debit Card (Stripe).</li><li>On Pro, Appointment deposit can be a percent of the service price or a fixed amount. It stays off until you turn it on. Percent deposits skip services with no price; card checkout also needs a price. Free and Starter cannot collect a card deposit.</li><li>Cancellation fee stays off until you turn it on. Set the hours (default 24) and a percent or a fixed amount. Pro charges a card already used for that visit. Free and Starter only show the rule.</li><li>Click Save Payment Gateways.</li></ol></section>`,
      `<section><h2>Appointments</h2><ol><li>Open Appointments Roster.</li><li>Free bookings are confirmed as soon as the client reserves.</li><li>Starter and Pro bookings stay pending. Click Accept or Deny. Deny frees that time.</li><li>Mark paid, Reschedule, and Cancel are on the same row.</li><li>Add Manual Appointment records a visit you took in person.</li></ol></section>`,
      `<section><h2>Repeating visits</h2><ol><li>Open Email Confirmations.</li><li>On Pro, turn on Allow recurring appointments and click Save Email Settings.</li><li>Free and Starter do not show repeating visits on the booking page.</li></ol></section>`,
      `<section><h2>Your Schedi plan</h2>${OWNER_SUBSCRIPTION_POLICY_TERMS.map((paragraph) => p(paragraph)).join("")}<p>Use Cancel subscription to stop renewal at the end of the paid period. Resume subscription if you change your mind before then. Card updates stay in Manage billing.</p></section>`,
      `<section><h2>Your public page</h2><p>The link at the top of the portal is the booking page. Copy link and Share use https://schedi.app/ and your slug. Put that link in a text or on a QR code you print. Clients who need booking steps can open <a href="/help/booking">booking help</a> from the business page.</p></section>`,
      `<p><a href="/">Back to Schedi</a> · <a href="/pricing">Pricing</a> · <a href="/signup">Sign up</a></p>`,
    ].join("\n"),
  },
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
  vertical({
    path: "/for/barbers",
    title: "Booking software for barbers | Schedi",
    description:
      "A booking link for the chair, morning reminder emails, and card deposits on Pro. Start free and upgrade when the week fills up.",
    h1: "Online booking for barbershops",
    related: ["/for/hair-salons", "/for/tattoo-artists"],
    paragraphs: [
      "A barbershop loses the chair when a fade is booked in a text and then nobody shows. The thread is a bad calendar: you scroll to find who wanted a beard trim at 4, and that time was never blocked. Schedi is a booking page for the chair. The client opens your link, picks the service you created, and takes an open time inside the hours you set. The visit shows up in the business portal instead of in your messages.",
      "A missed lineup still costs a slot you could have given to someone already in the shop. Schedi emails a reminder the morning of the appointment, on by default, at the hour you pick. On Pro you can require a card deposit before the visit is confirmed. The deposit stays off until you turn it on. Free and Starter cannot collect a card deposit. If a client who already paid by card cancels inside the window you set, Pro can charge that fee. Free and Starter only show the rule.",
      "The public page is one link, like schedi.app/your-shop. Put it in a text, a bio, or a QR code you print at the counter. Schedi does not draw the QR image. Free is $0: pay at the appointment, one service, and five bookings a week, confirmed as soon as the client reserves. Starter is $29 a month: more services, no weekly cap, and Cash App, Venmo, Zelle, or PayPal. Pro is $49 a month and adds card checkout on your Stripe account. Log a walk-in from the portal so the page stops offering that time.",
    ],
  }),
  vertical({
    path: "/for/hair-salons",
    title: "Booking software for hair salons | Schedi",
    description:
      "Let cut and color clients pick an open time from your link. Morning reminders, and card deposits on Pro for the long appointments.",
    h1: "Booking pages built for hair salons",
    related: ["/for/barbers", "/for/nail-salons"],
    paragraphs: [
      "A salon day falls apart when color appointments live in Instagram messages. A partial highlight takes a long block, and a double-booked afternoon cannot be fixed by scrolling. Schedi gives the salon one booking page. You add each service with its own duration and an optional price. The client picks the service and a start time that still fits before you close.",
      "The visits that hurt are the ones that vanish the morning of a three-hour color. A same-day reminder email goes out at the hour you choose. On Pro, a card deposit can be required before that appointment is confirmed, and it stays off until you turn it on. Card charges are created on the salon's Stripe account. Cash App, Venmo, Zelle, PayPal, and pay at the appointment stay available when you turn them on.",
      "Free holds one service and five bookings a week, enough to try a single cut. A menu with a cut, a blowout, and a color needs Starter at $29 a month or Pro at $49 a month, or the extra services are not saved. Starter and Pro bookings wait for Accept or Deny, which matters when you need to check a color correction first. Special hours cover a late open. A date block covers a class week. Share schedi.app/your-salon, or print that link as a QR code at the desk.",
    ],
  }),
  vertical({
    path: "/for/nail-salons",
    title: "Booking software for nail salons | Schedi",
    description:
      "One booking link for manicures, pedicures, and fills. Starter saves more than one service. Pro can take a card deposit.",
    h1: "Nail salon booking without the DM thread",
    related: ["/for/hair-salons", "/for/massage-therapists"],
    paragraphs: [
      "Nail appointments get booked in comment threads and then forgotten. A fill and a full set do not take the same amount of time, so a single message does not tell you whether the chair is open. On Schedi the client chooses the service you named and a start time that fits the duration you saved.",
      "A no-show costs the next set that could have taken that chair. Schedi sends a reminder email the morning of the visit. On Pro you can ask for a card deposit before the appointment is confirmed. Leave it off until you want it, and leave it off entirely on Free and Starter. If someone who paid by card cancels inside your window, Pro can charge the cancellation fee you set. The other plans only display the rule.",
      "Free keeps one service, which is a fair trial for a basic manicure, and caps the week at five bookings. Gel, acrylic, and a pedicure need Starter ($29 a month) or Pro ($49 a month) or the extra services will not be saved. Starter also adds Cash App, Venmo, Zelle, and PayPal. Pro adds card checkout on your Stripe account. Log a walk-in as a manual appointment so the public page is not offering a chair someone is already sitting in. The link can go in a bio or on a QR code you print.",
    ],
  }),
  vertical({
    path: "/for/cleaning-services",
    title: "Booking software for cleaners | Schedi",
    description:
      "Share a link for cleaning visits. Clients pick a time inside your hours. Pro adds card payments, deposits, and repeating visits.",
    h1: "Let cleaning clients book a visit from your link",
    related: ["/for/personal-trainers", "/for/pet-groomers"],
    paragraphs: [
      "A cleaning business often schedules from texts while driving between houses. The client asks for Thursday, you say maybe, and the time is not blocked until you are parked. Schedi puts the open times on a page. You set the days and the hours. The client picks a service, such as a standard clean or a deep clean, and a slot that is still inside those hours.",
      "A no-show on a deep clean wastes a morning you cannot refill from the driveway. The reminder email goes out the morning of the job. On Pro, a card deposit can be required before a first visit is confirmed, and repeating cleans can be weekly, biweekly, or monthly. Both switches stay off until you turn them on. Free and Starter do not show repeating visits and cannot collect a card deposit.",
      "Free is $0, one service, five bookings a week, pay when you arrive. Starter is $29 a month: more than one service, no weekly cap, and Cash App, Venmo, Zelle, or PayPal. Pro is $49 a month and adds the card charge on your Stripe account. Share schedi.app/your-cleaning-business in a text, or print that URL as a QR code on a leave-behind card. Block a week you are out, and add a manual appointment when someone calls so the page and the roster agree.",
    ],
  }),
  vertical({
    path: "/for/pet-groomers",
    title: "Booking software for pet groomers | Schedi",
    description:
      "Put baths and full grooms on one booking page. Reminder emails go out the morning of the appointment. Pro can take a deposit.",
    h1: "Pet grooming appointments without the phone tag",
    related: ["/for/barbers", "/for/cleaning-services"],
    paragraphs: [
      "Grooming days are a stack of baths, haircuts, and nails, and the phone is a bad way to stack them. A full groom is not the same length as a bath. Schedi lets you name each service, set how long it takes, and optionally set a price. The client picks one and an open start time. The form asks for the client's name, phone, and email. It does not collect a pet profile or medical notes.",
      "Keep health details off the page. Schedi is not HIPAA compliant and is not a place for protected health information. Put the kind of visit in the service name, for example bath or full groom. A no-show still burns the tub time. The morning reminder email is on by default. On Pro, a card deposit can be required before a full groom is confirmed. It stays off until you turn it on.",
      "Free saves one service and five bookings a week, paid at pickup. Starter at $29 a month is where a bath, a haircut, and nails can all exist, with Cash App, Venmo, Zelle, or PayPal if you want them. Pro at $49 a month adds the card deposit on your Stripe account. Use date blocks when the shop is closed and special hours when Saturday is short baths only. The booking link can sit in a text or on a QR code at the counter. Schedi does not generate that QR image.",
    ],
  }),
  vertical({
    path: "/for/personal-trainers",
    title: "Booking software for trainers | Schedi",
    description:
      "Clients reserve a session from your link instead of a text. Pro adds card payments, deposits, and repeating weekly sessions.",
    h1: "Session booking for personal trainers",
    related: ["/for/massage-therapists", "/for/cleaning-services"],
    paragraphs: [
      "Trainers lose sessions between a text that says 'you around after work?' and a calendar that never got updated. Schedi is a booking page for the sessions you actually teach. Add a service for the length you sell, set the hours you are on the floor, and send the link. The client chooses a time that is still open.",
      "A missed session is an empty hour. Schedi emails a reminder the morning of the session. On Pro you can require a card deposit before the hour is confirmed, and a client can book a weekly, biweekly, or monthly series. Those controls stay off until you turn them on. Free and Starter sell one visit at a time and do not take a card deposit. Schedi does not add a waitlist or a second trainer's calendar. It is one page and the hours you set.",
      "Free is $0: one session type, five bookings a week, pay at the session, confirmed immediately. Starter is $29 a month and removes the cap, lets you list more than one session, and adds Cash App, Venmo, Zelle, and PayPal. Pro is $49 a month and adds card checkout on your Stripe account. Accept or deny, on Starter and Pro, lets you talk to a new client before the hour locks. Put schedi.app/your-name in a bio or on a QR code at the desk.",
    ],
  }),
  vertical({
    path: "/for/tattoo-artists",
    title: "Booking software for tattoo artists | Schedi",
    description:
      "Hold a tattoo session on your booking page. On Pro, a card deposit can be required before the visit is confirmed.",
    h1: "Tattoo booking with a deposit you control",
    related: ["/for/barbers", "/for/hair-salons"],
    paragraphs: [
      "A tattoo session is a long block, and a no-show is not a ten-minute gap. Artists already ask for a deposit for that reason. Schedi is the page where the client picks the service you created, such as a consultation or a session, and a start time inside your hours. The request lands in the portal for you to accept or deny on Starter and Pro.",
      "On Pro the deposit can be a percent of the price or a fixed amount. It applies when the client chooses card, and it stays off until you turn it on. A percent deposit skips a service with no price, and card checkout needs a price too. The client can still choose Cash App, Zelle, Venmo, PayPal, or pay at the appointment when those are on. The card charge is created on the artist's Stripe account. Schedi does not add an application fee. Card checkout stays hidden until Stripe card payments and payouts are active.",
      "Free is a poor fit for custom work: one service, five bookings a week, and the visit confirms immediately. Starter is $29 a month and keeps new bookings pending so you can accept a design you have seen. Pro is $49 a month and is the plan that can take the card deposit. A reminder email goes out the morning of the session. Share schedi.app/your-studio, or print that link as a QR code in the shop. Use a date block when you are on a guest spot and the books are closed.",
    ],
  }),
  vertical({
    path: "/for/massage-therapists",
    title: "Booking software for massage | Schedi",
    description:
      "A booking page for massage appointments, with morning reminders and Pro card deposits. Schedi is not HIPAA compliant.",
    h1: "Massage booking that stays off medical charts",
    related: ["/for/personal-trainers", "/for/nail-salons"],
    paragraphs: [
      "Massage appointments get scattered across texts, and a 90-minute block that disappears the same day is hard to fill. Schedi gives you a page where the client picks the service, for example a 60-minute or 90-minute session, and an open time. You set the duration when you add the service. The portal shows the booking with the client's name, phone, and email.",
      "Schedi is not HIPAA compliant and must not be used to collect protected health information. Do not ask clients to put injuries, diagnoses, medications, or treatment notes in the booking. The form collects contact details and the service you defined. Intake that belongs in a medical record belongs somewhere else. That is the same limit shown to businesses on the Medical preset.",
      "A no-show still leaves an empty table. The reminder email goes out the morning of the appointment. On Pro, a card deposit can cover the longer sessions and stays off until you turn it on. Repeating visits on Pro can hold the same weekday, and they stay hidden until you enable them. Free is one service and five bookings a week. Starter at $29 a month adds more services and Cash App, Venmo, Zelle, or PayPal. Pro at $49 a month adds the card charge on your Stripe account. Share the link, or print it as a QR code. Schedi does not draw the QR image.",
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
          "Schedi emails a reminder the morning of the appointment. On Pro you can require a card deposit before the visit is confirmed. The deposit stays off until you turn it on.",
      },
      {
        question: "Which plan do I need for card payments?",
        answer:
          "Client card payments and deposits are on Pro at $49 a month. Starter at $29 a month adds Cash App, Venmo, Zelle, and PayPal. Free is pay at the appointment.",
      },
    ],
    bodyHtml: [...input.paragraphs.map(p), related(input.related), signupCta].join("\n"),
  };
}

function helpVideosHtml(): string {
  const cards = HELP_VIDEOS.map((video) => {
    const poster = `/assets/help-videos/${video.slug}.jpg?v=4`;
    const file = `/assets/help-videos/${video.slug}.mp4?v=4`;
    const title = escapeHtml(video.title);
    const desc = escapeHtml(video.desc);
    return `<figure>
      <img src="${poster}" alt="${title}" width="480" height="270" loading="lazy" decoding="async">
      <video class="schedi-help-video" controls preload="none" poster="${poster}" width="480" height="270">
        <source src="${file}" type="video/mp4">
      </video>
      <figcaption><strong>${title}</strong> (${escapeHtml(video.dur)}). ${desc}</figcaption>
    </figure>`;
  }).join("\n");
  return `<section><h2>Video tutorials</h2><p>Short videos, about 20 seconds each. They load when you press play.</p>${cards}</section>`;
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
  return MARKETING_PAGES.map((page) => page.path);
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
