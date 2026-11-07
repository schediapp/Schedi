# Connect portal email sign-in

The Railway route `POST /api/session` still signs in an existing owner when the form contains that owner's email. There is no password, magic link, or handoff on that route. Anyone who knows the email can open the portal, request an embedded Stripe client secret, and change billing or Connect settings.

That behavior is already in production. This change does not alter that route, because a merge to `main` may deploy Railway and this fix must not ship by surprise.

The verified identity Schedi already has is the Connect handoff. `schedi.app/billing/connect-handoff` checks the owner session, signs a two-minute token with `SCHEDI_CONNECT_PAID_SECRET`, and the Connect app burns the nonce and re-reads `/billing/connect-plan` before it creates a session. The token is not an email typed into a form.

The Cloudflare worker refuses email sign-in and email account creation. Sign-out of an existing cookie still works. A new session is created only by that handoff. The sign-in page tells the owner to use Set up Stripe in Schedi.

Minimum safe remediation for the current Railway host, when you choose to deploy it: make `POST /api/session` accept only `intent=sign-out`, and send owners through the handoff. Do that in a separate change after owners are told, and only if you intend to deploy Railway. Do not turn on a public preview of the worker with a live secret key just to try the portal.
