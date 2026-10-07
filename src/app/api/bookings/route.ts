import { placeBooking } from "@/lib/bookings";
import { errorMessage, publicOrigin, redirectTo } from "@/lib/http";
import { parsePaymentChoice } from "@/lib/payment-options";
import { getStore } from "@/lib/store";
import { stripeOrNull } from "@/lib/stripe";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const form = await request.formData();
  const slug = String(form.get("slug") || "");
  const payment = parsePaymentChoice(String(form.get("payment") || ""));
  const origin = publicOrigin(request);

  if (!payment) {
    return redirectTo(request, `/b/${slug}`, { error: "Choose how you'll pay." });
  }

  try {
    const { booking, redirectUrl } = await placeBooking(getStore(), stripeOrNull(), {
      slug,
      serviceId: String(form.get("service_id") || ""),
      startsAt: String(form.get("starts_at") || ""),
      clientName: String(form.get("client_name") || ""),
      clientEmail: String(form.get("client_email") || ""),
      method: payment.method,
      chargeKind: payment.chargeKind,
      successUrl: `${origin}/b/${slug}/booked?booking={BOOKING_ID}&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/b/${slug}?canceled=1`,
    });

    if (redirectUrl) return redirectTo(request, redirectUrl);
    return redirectTo(request, `/b/${slug}/booked`, { booking: booking.id });
  } catch (error) {
    return redirectTo(request, `/b/${slug || ""}`, { error: errorMessage(error) });
  }
}
