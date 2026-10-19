# Cohesion audit: public booking and Agency HQ vs the new owner dashboard

Assessment only. No product code in this change. Screenshots are local, from Harbor Studio mock data, with Firebase and `schedi.app` blocked. No credentials were used.

The reference is the owner dashboard on this branch (`?newdash=1`, demo Harbor Studio). The other two surfaces are the public booking page (the client page generated from the same `index.html`) and Agency HQ (the sign-in document at `/auth/agency`, plus the HQ shell split out in PR #26).

## What was opened

| Surface | How it was opened | Data |
| --- | --- | --- |
| Owner dashboard | `/?demo=1&newdash=1` | `schediBuildDemoTenant()` in `index.html`. Harbor Studio, Pro, America/New_York. |
| Public booking | HTML from `generateStandaloneHtmlForTenant()` for that same tenant | Seed data, with two switches turned on for the payment shots only: card and PayPal. The seed ships with both off (`paymentGateways.card` and `paypal` are false), so a straight demo would hide Card, the deposit chooser, and PayPal. |
| Reschedule / cancel | `renderManageAppointment()` for sample visit `HB-1006` | Same Harbor tenant. This screen is not inside the booking document. |
| `/auth/agency` | The document returned by `hqLoginDocument()` in `worker/public-shell.ts` | Empty form. Nothing was submitted. |
| HQ screens | `site/hq.html` at `/hq`, then three mock businesses written in the page | Harbor Studio (active Pro), Northwind Clinic (paused Starter, no services, no pay method), Lumen Studio (complimentary Pro, $0). |

Viewports: desktop 1280×900 and phone 390×844. Themes: `localStorage['schedi.theme']` and `html.schedi-light`. The Schedi wordmark (`/assets/logo-dark.svg` and `logo-light.svg`) is not in this repo. It lives in the deploy asset bucket. Both the dashboard and the public header request it, and it does not load in this checkout. That is not evidence the live site is missing the file.

## Where the code lives

These are three skins, not one.

- **Owner dashboard.** CSS is the block `#schediNewDashStyle` in `index.html`. Every selector includes `schedi-newdash`. It only wraps `#tenantPortalSection`. Tokens are `--sd-bg`, `--sd-panel`, `--sd-text`, `--sd-brand`, and the rest. On `schedi.app` it stays off unless `?newdash=1` (or a saved `schediNewDash=1`). Off `schedi.app` it turns on by itself.
- **Public booking.** `generateStandaloneHtmlForTenant()` returns a second HTML document (own `<style>`, Tailwind, `.glass-card`). `enterPublicBookingMode()` puts that document in an iframe. The template is hash-pinned by `tests/owner-dashboard-preview.test.ts`. A later edit has to update that pin on purpose. The new-dashboard CSS cannot reach this document.
- **Reschedule / cancel.** `renderManageAppointment()` in the parent shell, around the manage route `/{slug}/manage/{token}`. Old glass card. Not the new dashboard, and not inside the booking template.
- **HQ shell.** `site/hq.html`. Full copy of the shell plus the blocks between `SCHEDI_HQ_START` and `SCHEDI_HQ_END`. No `schedi-newdash` anywhere in that file. The worker serves it only with an agency session. Public routes get the stripped shell.
- **HQ sign-in.** `hqLoginDocument()` in `worker/public-shell.ts`. Its own short stylesheet. Signed-out `/hq`, `/agency`, and the form's `POST /auth/agency` use this document, not the glass "Agency HQ Master Login" card that is still inside `hq.html`.

Shared on purpose today: Inter, the existing slate and emerald colors, `html.schedi-light`, and `localStorage` key `schedi.theme`. Service icons, payment badges, cards, and the sidebar are not shared. The public template and the HQ file each carry their own copy of the light-theme overrides.

## Reference: the owner dashboard

Desktop is a left sidebar (Today, Appointments, Services, Hours, Payments, Emails, Reports, Clients, profile, billing) and a top bar. Phone hides the sidebar and uses a bottom bar: Today, Calendar, a + button, Clients, More. More opens a sheet. + opens Appointment, Walk-in, or Recurring series.

Today is "Your day": four stat cards, request rows with Decline / Accept, and a schedule. Each row has a per-service mark and a payment badge. Badges seen on the Harbor sample: Card (Stripe), Unpaid, Square, Venmo, In person / Cash. Services use the same marks (scissors, user, droplet, chat, palette) from `serviceIconMarkup()`. Hours shows the weekly shift, a 15 minute break after appointments, minimum notice, a month calendar, custom hours (Fri Oct 16, 11:00 AM–3:00 PM in this sample), and blocks (Lunch every day at noon, Vendor pickup, Out of studio).

Type is Inter, extra-bold, tight tracking (`-0.03em` on the big title). Kickers are 13px uppercase emerald. Cards are solid panels (`--sd-panel`), about a 16–20px radius, a hairline border, no glass blur. Buttons are `--sd-brand` (`#10b981` dark, `#059669` light) with dark or white ink, or a ghost panel button. Empty copy is a quiet line: "No new requests.", "Nothing on the book today.", and a client search that says no one matches.

Light mode swaps the same tokens (`#f4f7fb` page, white panels, darker green). It is the existing Schedi light scheme.

## Public booking

The page is one long column, max width about 56rem, numbered steps: 1 Select a Service, 2 Date and time, 2b Repeat, 3 Client info and payment, then a confirmation card. There is no sidebar and no bottom bar. The header is a Schedi image, a theme toggle, Help, and a "Live Booking Open" pill.

### What already matches

- Same Inter, same emerald (`#10b981` / `#047857` in light), same page background (`#07090e` public vs `#06080d` dashboard; light `#f4f7fb` on both).
- Theme toggle uses the same `schedi.theme` key.
- A business logo slot exists (`.biz-logo`) and a cover slot exists. They stay hidden when `logoUrl` / `coverUrl` are empty. Harbor's demo has both empty, so the sample shows neither. That part is data, not a missing feature.
- Recurring is there for this Pro sample: One-time, Weekly, Biweekly, Monthly, Pick my own dates.
- Deposit and cancellation fee copy is on the form. With card enabled for the shot: "a deposit of $25.00 is due now" and "the rest ($40.00) is due at the appointment." Cancel fee: $15 within 24 hours.
- Breaks and blocked times already change the calendar. On a Saturday in the sample, 11:30 AM and 12:00 PM are disabled and titled "Lunch" (a 45 minute cut overlaps the noon break). Booked times are struck through and titled "Booked." Nov 4–6 2026 render as Away days for the all-day "Out of studio" block. Oct 21 "Vendor pickup" is a partial block, so that day stays open and only the overlapping slots drop.
- Confirmation, after the 600ms reserve delay: "Booking Requested", the business still has to accept, a code like `#BK-…`, the time in Eastern, and a Cash App box (`$HarborStudio`, $65). Add to calendar and book-another are there.
- Manage is present: service, date, time, reference, the $15 fee, open times, "Save new time", and "Cancel appointment."

### What does not match

**Service icons are not drawn.** `renderSvc()` prints the name, price, and duration only. The Harbor services already have `icon` (`fa-scissors`, `fa-user`, `fa-droplet`, `fa-comments`, `fa-palette`). The dashboard paints those. The public list had zero `<i>`, `<svg>`, or `<img>` inside the service cards. The icon string is only sitting in the embedded JSON.

**Payment choices are a shorter list, with different words.** Public buttons, once card and PayPal are on: Card, Cash App, Zelle, Venmo, PayPal, Pay at Appt. No Square. No "In person." The dashboard records Square and "In person / Cash" as their own badges and paid methods. "Pay at Appt" is the public stand-in for paying the person, and it does not use the dashboard's cash badge.

**The payment code hides whenever a deposit is configured**, including Cash App. `paintPayCodeBox()` bails out when `quote.required` is true. The deposit notice still says Cash App, Zelle, Venmo, PayPal, and pay-at-appointment stay available. The code the client is supposed to put in the payment note does not show for those methods while the $25 card deposit is on. Confirmation for Cash App still shows the cashtag and the full $65. The code gap is on the form, before submit.

**Away days say "Away", not the reason.** The owner block note is "Out of studio." The public day label is only "Away."

**Visual system is the old glass page.** Steps use `.glass-card` (blur, translucent slate), `rounded-2xl`, `p-6`, `text-xl font-extrabold` titles, and `text-xs text-slate-400` help. The primary button is a full-width emerald-to-sky gradient with a glow. The dashboard button is a flat brand fill. Calendar days, time chips, and recurring pills are the older slate boxes, not the dashboard chips. Selected service rows use an emerald glow border. Quantity buttons are 32px, under the dashboard's 44px phone target.

**Phone is a stacked form, not a phone app.** At 390px the same cards stack and the time grid goes to two columns. There is no bottom navigation. The header wraps. It is usable and it does not share the dashboard's tab bar, sheet, or spacing.

**Manage does not look like either the dashboard or a finished client page.** It is one glass card in the parent shell: a table, a date input, time chips, a green "Save new time", and a rose "Cancel appointment." No service icon, no payment badge, no dashboard type scale.

**Empty and error states** are rose and amber slabs ("Closed", "Unavailable — …", "No open times"). The dashboard empty state is one muted sentence.

## Agency / HQ

### Sign-in at `/auth/agency`

A single card: "Schedi HQ", email, password, green "Sign in." Background `#0b1220`, panel `#111827`, button `#10b981`. Font stack is `Inter, ui-sans-serif, system-ui` with no webfont load. There are no `schedi-light` rules. The light-theme screenshots are the same picture as the dark ones. At 390px the card already fits.

`hq.html` still contains a second, older gate: "Agency HQ Master Login", shield icon, glass card, gradient button. That is what the shell shows if it is opened with no session. Production does not do that. Signed-out `/hq` returns `hqLoginDocument()` and strips the HQ markers. The glass gate is leftover UI in the session-only file.

### HQ screens (mock session)

No sidebar, no bottom tabs, no `--sd-*` tokens. The old site header stays (Schedi mark, Business Portal, theme toggle). Content is a stack of glass cards.

- Stat row: Managed Business Sites, Agency MRR, Total System Bookings, Active Booking Pages. With the mock, sites = 3 and MRR = $49. Lumen is complimentary at $0 and Northwind is paused, so they do not add to MRR. Bookings stay "—" until `appointmentCounts` is filled; the mock filled the directory health columns separately.
- Two long settings cards under that: payment gateways (Stripe copy, a PayPal client id field, a webhook field) and booking email. These are the old glass forms.
- Client Business Directory: search, sort, plan, status. Desktop is an `.hq-table` (10px uppercase headers). Columns that matter for ops: plan, status, this month, unpaid, last booking, health warnings, Manage. Phone (`md` breakpoint, 768px) swaps in stacked cards with `.hq-stat` tiles. Harbor showed Active, 18 this month, 3 unpaid. Northwind showed Paused. Lumen's row can say Complimentary Pro via `schediBillingLabel()` on the desktop table.
- Empty filter: "No businesses match these filters." Dashed border, small slate text.
- Edit business modal: name, slug, owner, plan (Free $0, Starter $29, Pro $49), and **Complimentary Pro** ("Billing exempt. Unlocks Pro, shows $0, stays active, and never starts Stripe Checkout."). This is the billing/comp screen. It is a glass dialog, not a dashboard sheet.

Light mode works on the shell through the shared `html.schedi-light` overrides and a few `.hq-table` / `.hq-stat` rules. It does not use the dashboard tokens, so borders, type size, and card fill still read as the old portal.

## Ranked changes

Impact is how far the screen feels from the owner dashboard a client or Axel would compare it with. Size is the change itself: **S** a focused edit in one function or one small document, **M** a screen's CSS and markup with the behavior left alone, **L** a new frame across a large separate file.

### Public booking

| # | Change | Size | Shared or separate |
| --- | --- | --- | --- |
| 1 | Restyle the booking document to the dashboard type, cards, buttons, and spacing. Keep the steps. | M | Separate. The template's own `<style>`. Do not unscoped-inject dashboard CSS into the parent shell. |
| 2 | Draw the per-service icon (and a custom image when `imageUrl` is an https URL) on each service row. | S | The icon id is already on the service. `serviceIconMarkup()` lives only in the portal script. The template needs its own small renderer, or a shared snippet copied into the template on purpose. |
| 3 | Make payment choices use the dashboard words and badges: Card, Cash App, Zelle, Venmo, PayPal, Square, In person. | M | Separate lists today. Public `renderPay()` has no Square and says "Pay at Appt" instead of "In person / Cash." Adding Square or a distinct in-person choice is a product decision, not only paint. If clients should not pick Square, say so and still rename "Pay at Appt" so the badge matches. |
| 4 | Show the payment code for Cash App, Zelle, Venmo, and PayPal even when a card deposit exists. | S | `paintPayCodeBox()` inside the template. Behavior fix. The deposit notice can stay card-only. |
| 5 | Restyle Lunch, Booked, Away, Special, and Closed so they read like the owner calendar. Put the block note on Away days ("Out of studio"), not only the word Away. | S | Logic already works in the template (`blockedRules`, `blockedTimes`, `isDateFullyBlocked`). Visual and label only. |
| 6 | When `logoUrl` is set, show it in the same lockup as a dashboard identity row. Keep the Schedi mark, but use the dashboard's 28px wordmark treatment once the asset bucket file is present. | S | Markup is already in the template (`.biz-logo`, `.schedi-logo`). Harbor's demo has no logo, so this needs a business that uploaded one to see it. |
| 7 | Restyle reschedule / cancel (date, open times, save, cancel, fee) with the same flag. | M | Separate. `renderManageAppointment()` in the parent shell. Scope every new selector the way `schedi-newdash` is scoped, or the portal picks it up. |
| 8 | Phone: 44px targets on service, time, and pay controls, and the same page padding as the dashboard's phone inset. No need to copy the owner tab bar onto a client form. | S | Template CSS only. |
| 9 | Empty and error lines in the dashboard's muted style instead of rose/amber slabs. | S | Template CSS. |

### Agency / HQ

| # | Change | Size | Shared or separate |
| --- | --- | --- | --- |
| 1 | Put the HQ shell in the dashboard frame: top bar, solid cards, the same type scale. Keep the stat row, directory, and billing modal. | L | Separate file `site/hq.html`. It does not contain the new-dashboard CSS. A flag class on that document is the safe way in. |
| 2 | Directory and the phone cards: dashboard badges for plan, status, unpaid, and warnings. Keep this month, unpaid, and last booking. | M | Markup in `hqDirRender()` plus `.hq-table` / `.hq-stat` in the HQ style block. |
| 3 | Billing / comp modal: same fields and the Complimentary Pro checkbox, dashboard form controls. | M | `openEditTenantModal()` and `#editTenantModal` in `hq.html` only. |
| 4 | `/auth/agency` login: same card, button, type, and a real light theme. | S | Separate document in `worker/public-shell.ts`. This is the live gate. |
| 5 | Empty directory state as a dashboard empty line. | S | `hqDirRender()` in `hq.html`. |
| 6 | Leave the in-shell "Agency HQ Master Login" card alone unless someone can still open the full shell signed out. The live sign-in is item 4. | S | `hq.html`, not the login document. Low impact. |

## Phased plan

Flags stay off until Axel turns them on. Do not copy the owner-dashboard trick that enables itself off `schedi.app`. A local booking page and a local `/hq` should keep today's look unless the query is present.

Suggested names, matching `?newdash=1`:

- `?newbook=1` on the public booking document and on `/{slug}/manage/…`
- `?newhq=1` on the HQ shell and on `hqLoginDocument()`

No `localStorage` default. A shared browser must not stick the new skin onto live `schedi.app`.

| Phase | What ships | Flag | Size | Live effect with the flag off |
| --- | --- | --- | --- | --- |
| 1 | One token sheet (colors, type, radius, button, card, badge) that only the flags load. Values copied from `--sd-*`, not a new palette. | none by itself | M | None. The sheet is not linked. |
| 2 | Public booking skin: header, service cards, calendar, times, recurring, payment, confirmation, phone spacing. | `?newbook=1` | M | None. Template hash in `tests/owner-dashboard-preview.test.ts` will change once and should be updated in that same change. Default HTML must still look like today. |
| 3 | Icons, payment labels, payment-code fix, Away note, blocked-time styling, manage page. | `?newbook=1` | M | None beyond the hash pin. Manage styles stay under a `schedi-newbook` class so the owner portal is untouched. |
| 4 | HQ frame, directory, ops stats, billing/comp modal, empty state. | `?newhq=1` | L | None. `site/hq.html` is already withheld without an agency session. |
| 5 | Login document, including light mode. | `?newhq=1` | S | None. Signed-out `/hq` stays the current dark card. |

Order that keeps review small: phase 5 (the sign-in card is one screen), then phase 2 (the client page people see), then phase 3 (the features the dashboard already has), then phase 4 (HQ is the large separate file). Phase 1 can land inside phase 2 if a standalone sheet is more moving parts than it is worth. Do not turn either flag on for `schedi.app` in the same change that adds it.

## Screenshots

All of these are under `/opt/cursor/artifacts/cohesion/`. Names are `{surface}-{screen}-{desktop|phone}-{dark|light}.png`.

Owner reference: `owner-today-*`, `owner-calendar-*`, `owner-clients-*`, `owner-clients-empty-desktop-dark.png`, `owner-services-*`, `owner-payments-*`, `owner-hours-*`, `owner-hours-blocks-*` (custom hours and blocks), `owner-more-phone-*`, `owner-add-phone-*`.

Public booking: `public-services-*`, `public-calendar-*`, `public-times-*` (Lunch and Booked), `public-away-*` (Nov 4–6 Away), `public-recurring-*`, `public-payment-*` (Card through Pay at Appt, deposit, cancel fee), `public-confirm-*`, `public-manage-*`.

Agency: `agency-login-*` (the `/auth/agency` document; light matches dark), `agency-shell-login-*` (legacy glass gate inside `hq.html`), `agency-overview-*`, `agency-directory-*`, `agency-directory-empty-desktop-dark.png`, `agency-billing-*` (plan tiers and Complimentary Pro).
