"use client";

import dynamic from "next/dynamic";

const ConnectDashboard = dynamic(
  () => import("./connect-dashboard").then((mod) => mod.ConnectDashboard),
  { ssr: false },
);

export function ConnectDashboardLoader({ publishableKey }: { publishableKey: string }) {
  return <ConnectDashboard publishableKey={publishableKey} />;
}
