# Connect portal email sign-in

`POST /api/session` on the Connect app used to start a session for whatever email was in the form. Knowing an owner's email was enough to open the portal.

Both the Railway Next route and the Cloudflare worker route in this migration branch now accept only `intent=sign-out`. They do not create an owner or a session from an email. A new session is created by `POST /api/connect/handoff` after the signed token is checked and `/billing/connect-plan` says that owner may use cards. Sign-out still deletes the cookie's session.

The live Railway deployment is `f234d253`, which still has the email form. The auth-only branch is the patch that can be attached to that service without the migration schema. This file describes the migration branch. Deploying either one is a separate, authorized step. Nothing here has been deployed.
