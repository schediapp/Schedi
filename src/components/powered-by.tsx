export const POWERED_BY_HREF =
  "https://schedi.app/?utm_source=booking_page&utm_medium=referral&utm_campaign=powered_by";

/** Footer on customer booking pages. Not used in the owner portal. */
export function PoweredBySchedi() {
  return (
    <p className="powered-by">
      <a href={POWERED_BY_HREF}>Powered by Schedi</a>
    </p>
  );
}
