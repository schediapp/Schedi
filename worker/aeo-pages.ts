// Published answer pages. Mark's internal section "Held for later (not for publishing)"
// is not rendered on any page, in llms.txt, or in JSON-LD.

import type { Faq, MarketingPage } from "./content";
import { OWNER_SUBSCRIPTION_POLICY_TERMS } from "../src/lib/subscription-policy";

function p(html: string): string {
  return `<p>${html}</p>`;
}

function h2(id: string, text: string): string {
  const anchor = id ? ` id="${id}"` : "";
  return `<h2${anchor}>${text}</h2>`;
}

const POLICY = OWNER_SUBSCRIPTION_POLICY_TERMS.join(" ");

export const AEO_FAQS: Faq[] = [
  {
    question: "How much does Schedi cost?",
    answer:
      "Schedi has three plans: Free at $0, Starter at $29 a month, and Pro at $49 a month. Paid plans are month-to-month with no contract. Free includes one service and up to 5 bookings a week. Starter adds unlimited services and bookings, manual payment options, and accept or deny for each request. Pro includes everything in Starter, plus repeating appointments that can be weekly, biweekly, or monthly.",
  },
  {
    question: "What do I get on the Free plan?",
    answer:
      "The Free plan costs $0. It includes one service and up to 5 bookings a week (Monday through Sunday). Clients pay at the appointment, and bookings confirm instantly. Your booking page shows a Schedi badge. The Free plan does not include repeating appointments or the option to accept or deny requests.",
  },
  {
    question: "What does the Starter plan add?",
    answer:
      "Starter costs $29 a month and removes the Free plan's limits: you get unlimited services and unlimited bookings. It also adds manual payment options and lets you accept or deny each booking request. The manual payment options are Cash App, Venmo, Zelle, PayPal, and pay at the appointment. Each service has its own price and duration, so you can list a 30-minute lesson and a 60-minute lesson side by side. Starter does not include card checkout or repeating appointments.",
  },
  {
    question: "What does the Pro plan add?",
    answer:
      "Pro costs $49 a month and includes everything in Starter, plus repeating appointments. Repeating appointments can be weekly, biweekly, or monthly.",
  },
  {
    question: "What payment methods can my clients use?",
    answer:
      "It depends on your plan. On Free, clients pay at the appointment. On Starter, you can offer Cash App, Venmo, Zelle, PayPal, or pay at the appointment. Pro includes the Starter payment options. Starter does not include card checkout.",
  },
  {
    question: "Can I approve or decline bookings before they're confirmed?",
    answer:
      "Yes, on Starter and Pro. You can accept or deny each booking request. On the Free plan, bookings confirm instantly, and there is no accept or deny step.",
  },
  {
    question: "Can clients book repeating appointments?",
    answer:
      "Yes, on Pro. Pro supports repeating appointments every week, every two weeks, or every month. Free and Starter do not include repeating appointments. Repeating appointments are different from repeating blocks, which are back-office blocks for time you're regularly unavailable, like a daily lunch break.",
  },
  {
    question: "Is there a contract, and what are the cancellation and refund terms?",
    answer: POLICY,
  },
  {
    question: "Who is Schedi for?",
    answer:
      "Schedi is booking software for service businesses run by one owner. It fits barbers, salons, cleaners, pet groomers and pet care, lawn care, auto detailers, photographers, notaries, and lesson teachers. You get a public booking page where clients book, and a back office where you manage your roster, services, prices, durations, weekly hours, and time off. It is built around one owner's schedule, not a team's.",
  },
];

const signupCta = `<p><a href="/signup">Create your page</a>. You can start on Free. Nothing is charged until checkout finishes.</p>`;

export function barberPage(): MarketingPage {
  return {
    path: "/for/barbers",
    title: "Booking software for barbers | Schedi",
    description:
      "Booking software for barbers who run their own chair. Free is $0, Starter is $29/mo, and Pro is $49/mo.",
    h1: "Booking software for barbers",
    hero: true,
    faqs: [
      {
        question: "Can I take walk-ins and online bookings together?",
        answer: "Yes. Add walk-ins manually in your roster, alongside the bookings clients make online.",
      },
      {
        question: "Can I block off my lunch break every day?",
        answer: "Yes. Add a repeating block for the time you're unavailable.",
      },
      {
        question: "Can I take a week off without clients booking it?",
        answer: "Yes. Add a vacation or date block for those days.",
      },
    ],
    bodyHtml: [
      p("Schedi is booking software for barbers who run their own chair. Clients book from your public booking page, and you handle walk-ins, changes, and time off from one back office."),
      p("Plans are Free at $0, Starter at $29 a month, and Pro at $49 a month. Paid plans are month-to-month with no contract."),
      h2("", "What you get"),
      p("Public booking page: clients choose a service and book a time inside the hours you set. You don't need your own website. Share your booking page link anywhere you talk to clients."),
      p("Services with prices and durations: list each cut the way you sell it, such as a haircut, a skin fade, a beard trim, or a kids' cut, each with its own price and length. The Free plan includes one service. Starter and Pro include unlimited services."),
      p("A roster you control: reschedule or cancel any appointment, and add walk-ins by hand so walk-ins and online bookings sit in the same roster."),
      p("Your hours and time off: set weekly hours, add repeating blocks for things like a daily lunch break, and block vacation days or single dates."),
      p("Branded confirmation email: clients get a confirmation email with your branding when they book."),
      h2("", "Getting paid"),
      p("On Free, clients pay at the appointment. On Starter, clients can pay with Cash App, Venmo, Zelle, PayPal, or at the appointment."),
      h2("", "Regulars on a set schedule"),
      p("Pro includes repeating appointments, so a regular who comes in every week, every two weeks, or every month can keep the same slot without rebooking each time."),
      h2("", "Which plan fits a barber"),
      p("Free ($0): you want to try online booking with one service and up to 5 bookings a week. Bookings confirm instantly."),
      p("Starter ($29 a month): you offer more than one service, take more than 5 bookings a week, want to accept or deny each request, or get paid through Cash App, Venmo, Zelle, or PayPal."),
      p("Pro ($49 a month): you want standing appointments for regulars."),
      h2("", "What Schedi doesn't do"),
      p(`Schedi is built for one barber's schedule. It is not a multi-chair or team calendar. If you run a multi-chair shop, a barbershop platform like Squire offers multiple barber accounts and a waitlist on its shop plans (see <a href="/compare#squire">Schedi vs Squire</a>).`),
      p(`Related: <a href="/for/hair-salons">hair salons</a>, <a href="/for/tattoo-artists">tattoo artists</a>. See <a href="/pricing">pricing</a> or the <a href="/compare">comparison with other booking tools</a>.`),
      signupCta,
    ].join("\n"),
  };
}

export function cleaningPage(): MarketingPage {
  return {
    path: "/for/cleaning-services",
    title: "Booking software for cleaning businesses | Schedi",
    description:
      "Booking software for a cleaning business run by one owner. Free $0, Starter $29/mo, Pro $49/mo with recurring cleans.",
    h1: "Booking software for cleaning businesses",
    hero: true,
    faqs: [
      {
        question: "Can cleaning clients book a repeating clean?",
        answer:
          "Yes, on Pro. Pro ($49 a month) includes repeating appointments every week, every two weeks, or every month. Free and Starter do not include repeating appointments.",
      },
      {
        question: "Does Schedi calculate drive time between cleans?",
        answer:
          "No. Schedi does not calculate drive time. You can build travel into a service's duration, set weekly hours for the window you are willing to be on the road, and use date blocks for days you are booked.",
      },
    ],
    bodyHtml: [
      p("Schedi is booking software for cleaning businesses run by one owner. Clients book cleans from your public booking page, and on Pro you can set recurring cleans weekly, biweekly, or monthly."),
      p("Plans are Free at $0, Starter at $29 a month, and Pro at $49 a month."),
      h2("", "Recurring cleans"),
      p("Most cleaning clients want the same day on a regular cycle. Schedi Pro ($49 a month) includes repeating appointments every week, every two weeks, or every month, so a biweekly client stays on your schedule without rebooking."),
      p("Free and Starter do not include repeating appointments. If most of your work is recurring, Pro is the plan to look at."),
      h2("", "Planning for travel to the client"),
      p("You go to the client, so your schedule has to leave room for driving. Schedi does not calculate drive time. You can plan for it with the tools it has:"),
      p("Build travel into each service's duration. For example, if a standard clean takes 2.5 hours and you usually need 30 minutes to get to the next job, set that service's duration to 3 hours."),
      p("Set weekly hours that match the window you're willing to be on the road, and use date blocks for days you're booked with a large job."),
      p("On Starter and Pro, accept or deny each request, so you can decline jobs that are too far away or outside your area before they're confirmed."),
      h2("", "Services and prices"),
      p("List each type of clean with its own price and duration, such as a standard clean, a deep clean, or a move-out clean. The Free plan includes one service. Starter and Pro include unlimited services."),
      h2("", "Getting paid"),
      p("On Free, clients pay at the appointment. On Starter, clients can pay with Cash App, Venmo, Zelle, PayPal, or at the appointment."),
      h2("", "Managing your week"),
      p("Your roster shows every booking. You can reschedule or cancel a clean, and add a job by hand when a client calls or texts you directly. Repeating blocks cover regular unavailable time, and vacation or date blocks cover days off. Clients get a branded confirmation email when they book."),
      h2("", "Which plan fits a cleaning business"),
      p("Free ($0): one service, up to 5 bookings a week, bookings confirm instantly, and clients pay at the appointment."),
      p("Starter ($29 a month): unlimited services and bookings, approval of each request, and payment by Cash App, Venmo, Zelle, PayPal, or at the appointment. No recurring cleans."),
      p("Pro ($49 a month): everything in Starter plus recurring cleans (weekly, biweekly, monthly)."),
      h2("", "What Schedi doesn't do"),
      p("Schedi is built for one owner's schedule. It does not manage multiple cleaners or crews."),
      p(`See <a href="/pricing">pricing</a>, <a href="/compare#jobber">Schedi vs Jobber</a>, or the <a href="/">Schedi home page</a>.`),
      signupCta,
    ].join("\n"),
  };
}

export function featuresPage(): MarketingPage {
  return {
    path: "/features",
    title: "Schedi features | Booking page and back office",
    description:
      "A public booking page and back office for one owner. Free $0, Starter $29/mo, and Pro $49/mo, month-to-month.",
    h1: "Features of Schedi",
    softwareJsonLd: true,
    faqs: AEO_FAQS.filter((faq) =>
      faq.question === "How much does Schedi cost?" || faq.question === "Who is Schedi for?",
    ),
    bodyHtml: [
      p("Schedi is a public booking page and a back office for a service business run by one owner. Clients pick a service and a time. You manage the roster, services, prices, durations, weekly hours, and time off in one place."),
      p("Plans are Free at $0, Starter at $29 a month, and Pro at $49 a month. Paid plans are month-to-month with no contract."),
      h2("", "Public booking page"),
      p("You don't need your own website. Share one link, shaped like schedi.app/your-business. Clients choose a service and an open time inside the hours you set. They enter their name, phone, and email."),
      h2("", "Services"),
      p("Each service has its own price and duration. The Free plan includes one service and up to 5 bookings a week. Starter and Pro include unlimited services and unlimited bookings."),
      h2("", "Roster"),
      p("Reschedule or cancel a booking, and add a walk-in or a phone booking by hand so it sits on the same roster. On Starter and Pro you accept or deny each request. On Free, bookings confirm instantly."),
      h2("", "Hours and time off"),
      p("Set weekly hours, add repeating blocks for time you are regularly unavailable (such as a lunch break), and add vacation or date blocks for days off."),
      h2("", "Getting paid"),
      p("On Free, clients pay at the appointment. On Starter, clients can pay with Cash App, Venmo, Zelle, PayPal, or at the appointment. Starter does not include card checkout. Pro includes the Starter payment options and adds repeating appointments."),
      h2("", "Repeating appointments"),
      p("Pro ($49 a month) lets a client keep a weekly, biweekly, or monthly slot. Free and Starter do not include repeating appointments. A repeating appointment is not the same thing as a repeating block for your own time off."),
      p(`Read <a href="/pricing">pricing</a>, <a href="/for/barbers">booking software for barbers</a>, <a href="/for/cleaning-services">booking software for cleaning businesses</a>, or <a href="/compare">Schedi vs other booking tools</a>.`),
    ].join("\n"),
  };
}

export function comparePage(): MarketingPage {
  return {
    path: "/compare",
    title: "Schedi vs other booking tools | Schedi",
    description:
      "Schedi compared with Squire, Booksy, Vagaro, Acuity Scheduling, and Jobber. Prices as of Oct 2026, from each vendor's pricing page.",
    h1: "Schedi vs other booking tools",
    softwareJsonLd: true,
    faqs: [],
    bodyHtml: [
      p("Schedi is a simple public booking page and back office for one owner, with a $0 Free plan, Starter at $29 a month, and Pro at $49 a month. The five tools below generally do more, such as automated reminders, team calendars, and marketing tools, and this page says plainly where each one does."),
      p("Prices as of Oct 2026. Prices as listed on each vendor's site on Oct 17, 2026. The source URL is listed in each section."),
      h2("", "Why these five tools"),
      p("Squire: built specifically for barbershops, with a plan for individual barbers."),
      p("Booksy: a booking app and client marketplace for barbers and beauty pros with one published monthly price, so it comes up when barbers and salon owners compare apps."),
      p("Vagaro: an all-in-one salon and appointment business system with a one-person price; the closest all-in-one comparison for salons and groomers."),
      p("Acuity Scheduling: a general appointment scheduler with a one-calendar plan; the natural comparison for photographers, lesson teachers, and notaries."),
      p("Jobber: field-service software with online booking, quotes, and invoicing; the main comparison for cleaners, lawn care, and auto detailers who travel to the client."),

      h2("squire", "Schedi vs Squire"),
      p("Squire does more than Schedi for barbers: its Independent plan for solo barbers costs $30 a month and includes automated email and text reminders, no-show protection, and a branded app, and its shop plans add multiple barber accounts and a waitlist. Schedi is a simpler booking page and back office, with a $0 Free plan and Starter at $29 a month."),
      p('Source: <a href="https://getsquire.com/pricing" rel="nofollow noopener noreferrer">https://getsquire.com/pricing</a> (checked Oct 17, 2026).'),
      p('Squire pricing as listed: Independent (individual barbers) $30 a month with a 14-day free trial. Pro (single-location shops) $50 a month. Executive $150 a month per shop. Titan $250 a month per shop. Prices are published, but the Pro, Executive, and Titan plans start with a "Get a demo" request instead of a self-serve trial.'),
      p("Where Squire does more: automated email and SMS reminders on the Independent plan, online booking with no-show protection, a Flex branded app, Tap to Pay on iPhone and Android, and group appointments. Pro adds multiple barber accounts, Google and Instagram booking, and a waitlist. Executive adds unlimited email and SMS marketing. Titan adds multi-location support, a loyalty program, and gift cards."),
      p("Where Schedi is different: a $0 Free plan (one service, up to 5 bookings a week). Starter at $29 a month lets clients pay with Cash App, Venmo, Zelle, PayPal, or at the appointment, and lets you accept or deny each request. Pro adds repeating appointments. Billing is month-to-month, and a new subscriber's first payment is fully refundable within 15 days."),
      p("Best fit: choose Squire if you run a shop with several barbers or want text reminders and a branded app now. Choose Schedi if you work your own chair and want a simple booking page with manual payment apps."),

      h2("booksy", "Schedi vs Booksy"),
      p("Booksy includes more features than Schedi for one flat price: $29.99 a month plus tax covers reminders, text marketing, waitlists, no-show protection, and a client marketplace. Schedi has a $0 Free plan and a $29 Starter plan, and focuses on a simple booking page, manual payment apps, and request approval."),
      p('Source: <a href="https://biz.booksy.com/en-us/pricing" rel="nofollow noopener noreferrer">https://biz.booksy.com/en-us/pricing</a> (checked Oct 17, 2026).'),
      p("Booksy pricing as listed: $29.99 a month plus tax, with all features included. Each additional team member is $20 a month. 14-day free trial with no credit card. No commitment; cancel anytime. Card processing: 2.69% + $0.30 for mobile payments and keyed-in entry, 2.49% + $0.10 on the Booksy Card Reader, 2.49% + $0.20 for Tap to Pay. Boost (optional marketplace visibility) charges a one-time 30% fee on a Boost client's first visit, up to $100."),
      p("Where Booksy does more: appointment confirmations and reminders, email marketing, text message marketing (2,000 free SMS marketing messages a month), custom forms and liability waivers, Reserve with Google, waitlists, no-show protection, online gift cards, memberships and packages, team members, card readers, and a client marketplace."),
      p("Where Schedi is different: a $0 Free plan, Cash App, Venmo, Zelle, and PayPal as manual payment options on Starter, accept or deny for each request on Starter and Pro, and repeating appointments on Pro."),
      p("Best fit: choose Booksy if you want marketing tools, a marketplace, and reminders in one subscription. Choose Schedi if you want a free starting point or a simple booking page where clients pay you through the apps you already use."),

      h2("vagaro", "Schedi vs Vagaro"),
      p("Vagaro is a fuller business system than Schedi, with reminders, a waitlist, a marketplace listing, payments, and memberships included. For one person, Vagaro's pricing page showed $30.00 a month, with an introductory $23.99 a month for the first 6 months (exclusions apply); Schedi's plans are $0, $29, and $49 a month."),
      p('Source: <a href="https://www.vagaro.com/pro/pricing" rel="nofollow noopener noreferrer">https://www.vagaro.com/pro/pricing</a> (checked Oct 17, 2026).'),
      p('Vagaro pricing as listed: "Just Me" (one person) $30.00 a month, or $23.99 a month for the first 6 months as an exclusive rate (exclusions apply). Each bookable calendar license costs $10, up to seven licenses; after seven, more employees can be added at no extra cost. 30-day free trial. Cancel anytime with no cancellation fees. A free card reader is offered when you sign up for Vagaro Merchant Services.'),
      p("Where Vagaro does more: included features listed on every plan are AI-powered business tools and marketing, payments, calendar and resource management, customer waitlist options, memberships, packages, and gift certificates, 1,000 free emails monthly, advanced reporting, customer loyalty programs, SOAP notes, inventory tracking, invoices, a free listing on the Vagaro Marketplace, unlimited notifications and appointment reminders, and online booking on Vagaro, Instagram, Facebook, and Apple Maps."),
      p("Where Schedi is different: fewer moving parts (a booking page plus a back office with a roster, services, weekly hours, and blocks), a $0 Free plan, manual payment options (Cash App, Venmo, Zelle, PayPal, pay at the appointment) on Starter, and accept or deny for each request."),
      p("Best fit: choose Vagaro if you want one system for booking, payments, marketing, memberships, and inventory, or you have staff. Choose Schedi if you work alone and only need clients to book and you to manage the schedule."),

      h2("acuity", "Schedi vs Acuity Scheduling"),
      p("Acuity Scheduling has no free plan but offers more scheduling tools than Schedi, such as intake forms, an online-meeting integration, and text reminders on its Standard plan. Acuity's one-calendar Starter plan is $20 a month billed monthly ($16 a month billed annually); Schedi has a $0 Free plan and Starter at $29 a month."),
      p('Source: <a href="https://acuityscheduling.com/pricing" rel="nofollow noopener noreferrer">https://acuityscheduling.com/pricing</a> (checked Oct 17, 2026).'),
      p("Acuity pricing as listed (annual price / monthly price): Starter $16 / $20 a month, 1 calendar. Standard $27 / $34 a month, up to 6 calendars. Premium $55 / $69 a month, up to 36 calendars. 7-day free trial with no credit card. No free plan. No setup or cancellation fees; cancel anytime. Prices exclude taxes."),
      p("Where Acuity does more: every plan includes client self-scheduling, unlimited services and appointments, payments and deposits through providers including Stripe, PayPal, and Venmo, email confirmations and reminders, custom intake forms, automatic time zone conversion, Google Meet, Zoom, and GoToMeeting integrations, and a mobile admin app. Standard adds text message reminders, an appointment waitlist, packages and memberships, and gift certificates. Premium adds removal of the Acuity logo, a HIPAA BAA, and custom API and CSS."),
      p("Where Schedi is different: a $0 Free plan, pay-at-the-appointment and manual payment apps including Cash App and Zelle on Starter, accept or deny for each request, repeating appointments on Pro, and a branded confirmation email. Billing is month-to-month, and a new subscriber's first payment is fully refundable within 15 days."),
      p("Best fit: choose Acuity if you need intake forms, online sessions, packages, or text reminders. Choose Schedi if you want to start free and keep booking simple."),

      h2("jobber", "Schedi vs Jobber"),
      p("Jobber is a full field-service system with quotes, invoicing, and team tools, and it costs more: the Core plan for one user is $49 a month with no commitment ($29 a month billed annually). Schedi is a simpler booking page and back office for one owner, with recurring cleans and other repeating appointments on Pro at $49 a month."),
      p('Source: <a href="https://www.getjobber.com/pricing/" rel="nofollow noopener noreferrer">https://www.getjobber.com/pricing/</a> (checked Oct 17, 2026).'),
      p("Jobber pricing as listed for one user: Core $49 a month with no commitment, $39 a month with a 1-year commitment, or $29 a month billed annually. Connect $139 / $119 / $99 a month. Grow $199 / $169 / $149 a month. Extra users are $29 a month each. 14-day free trial with full access to Grow features and no credit card. Card processing: 2.9% + 30 cents online, 2.7% + 30 cents for Tap to Pay, 1% for bank (ACH) payments."),
      p('Where Jobber does more: Core includes online job booking and scheduling, quotes, invoices and online payments, a website, reporting, and an app marketplace with 100+ tools. Connect adds automated client reminders, automatic payments, checklists, QuickBooks Online sync, and time and expense tracking. Grow adds two-way SMS, job costing, and custom automations. Jobber also lists route optimization, GPS tracking, a "Find a Time" tool that recommends slots based on travel times, crew scheduling, and iOS and Android mobile apps. Plan availability for these is not shown clearly on the pricing page.'),
      p("Where Schedi is different: a $0 Free plan, Starter at $29 a month billed monthly, accept or deny for each request, manual payment apps (Cash App, Venmo, Zelle, PayPal, pay at the appointment), and repeating appointments every week, two weeks, or month on Pro. Schedi does not calculate drive time or manage multiple cleaners or crews."),
      p("Best fit: choose Jobber if you send quotes and invoices, run a crew, or want routing and drive-time tools. Choose Schedi if you work alone, book set services at set prices, and want a simple way to keep recurring clients on the calendar."),

      h2("", "Quick guide"),
      `<ul>
        <li>Barbers: Squire and Booksy do more (reminders, marketing, shop tools); Schedi is the simpler option with a free plan.</li>
        <li>Salons and pet groomers: Vagaro does more as an all-in-one system; Schedi covers booking and the schedule only.</li>
        <li>Photographers, lesson teachers, and notaries: Acuity offers forms, online sessions, and text reminders on Standard; Schedi offers a free plan and request approval.</li>
        <li>Cleaners, lawn care, and auto detailers: Jobber covers quoting, invoicing, crews, and routing; Schedi covers booking, recurring appointments on Pro, and request approval for one owner.</li>
      </ul>`,
      p('Pages for specific businesses: <a href="/for/barbers">barbers</a> and <a href="/for/cleaning-services">cleaning businesses</a>. See <a href="/pricing">pricing</a>.'),
    ].join("\n"),
  };
}
