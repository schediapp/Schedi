import { NextResponse } from "next/server";
import { currentOwner } from "@/lib/auth";
import { createEmbeddedAccountSession } from "@/lib/connect";
import { errorMessage } from "@/lib/http";
import { getStore } from "@/lib/store";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

export async function POST() {
  const owner = await currentOwner();
  if (!owner) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const business = getStore().getBusinessByOwner(owner.id);
  if (!business?.stripeAccountId) {
    return NextResponse.json({ error: "Turn on card payments before onboarding." }, { status: 409 });
  }

  try {
    const session = await createEmbeddedAccountSession(getStripe(), business.stripeAccountId);
    return NextResponse.json({ clientSecret: session.client_secret });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
  }
}
