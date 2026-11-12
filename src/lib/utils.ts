/** Join class names. Schedi charts do not use a second Tailwind theme. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
