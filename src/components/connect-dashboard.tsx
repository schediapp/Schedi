"use client";

import { loadConnectAndInitialize } from "@stripe/connect-js";
import {
  ConnectAccountManagement,
  ConnectAccountOnboarding,
  ConnectComponentsProvider,
  ConnectNotificationBanner,
  ConnectPayments,
  ConnectPayouts,
} from "@stripe/react-connect-js";
import { useMemo, useState } from "react";

export function ConnectDashboard({ publishableKey }: { publishableKey: string }) {
  const [error, setError] = useState<string | null>(null);
  const connectInstance = useMemo(
    () =>
      loadConnectAndInitialize({
        publishableKey,
        fetchClientSecret: async () => {
          const response = await fetch("/api/connect/session", { method: "POST" });
          const body = (await response.json()) as { clientSecret?: string; error?: string };
          if (!response.ok || !body.clientSecret) {
            throw new Error(body.error || "Could not open Stripe onboarding.");
          }
          return body.clientSecret;
        },
        appearance: {
          overlays: "dialog",
          variables: {
            colorPrimary: "#0e6b62",
            colorBackground: "#fffdf8",
            borderRadius: "12px",
          },
        },
      }),
    [publishableKey],
  );

  return (
    <ConnectComponentsProvider connectInstance={connectInstance}>
      <div className="connect-stack">
        <ConnectNotificationBanner onLoadError={({ error: loadError }) => setError(loadError.message ?? "Stripe could not load the notification banner.")} />
        <section>
          <h3>Verify the business</h3>
          <ConnectAccountOnboarding
            onExit={() => window.location.reload()}
            onLoadError={({ error: loadError }) => setError(loadError.message ?? "Stripe could not load onboarding.")}
          />
        </section>
        <section>
          <h3>Account</h3>
          <ConnectAccountManagement onLoadError={({ error: loadError }) => setError(loadError.message ?? "Stripe could not load account management.")} />
        </section>
        <section>
          <h3>Payments</h3>
          <ConnectPayments onLoadError={({ error: loadError }) => setError(loadError.message ?? "Stripe could not load payments.")} />
        </section>
        <section>
          <h3>Payouts</h3>
          <ConnectPayouts onLoadError={({ error: loadError }) => setError(loadError.message ?? "Stripe could not load payouts.")} />
        </section>
      </div>
      {error ? <p className="banner bad">{error}</p> : null}
    </ConnectComponentsProvider>
  );
}
