// IndexNow: https://www.indexnow.org/documentation
// The key is never hardcoded. Generate one with: openssl rand -hex 32
// (32 to 128 hex characters; IndexNow allows 8–128, Schedi requires 32+).

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

export interface IndexNowEnv {
  INDEXNOW_KEY?: string;
  INDEXNOW_ENABLED?: string;
  /** Must be exactly schedi.app. Preview workers leave this unset or set another host. */
  INDEXNOW_HOST?: string;
}

export function indexNowKey(env: IndexNowEnv): string | null {
  const key = String(env.INDEXNOW_KEY || "").trim().toLowerCase();
  if (!/^[a-f0-9]{32,128}$/.test(key)) return null;
  return key;
}

export type IndexNowSkipReason = "disabled" | "host" | "key";

/** Production pings only. Preview deploys must not set both the flag and host schedi.app. */
export function indexNowGate(env: IndexNowEnv): { ok: true; key: string } | { ok: false; reason: IndexNowSkipReason } {
  if (String(env.INDEXNOW_ENABLED || "").trim() !== "true") return { ok: false, reason: "disabled" };
  if (String(env.INDEXNOW_HOST || "").trim().toLowerCase() !== "schedi.app") return { ok: false, reason: "host" };
  const key = indexNowKey(env);
  if (!key) return { ok: false, reason: "key" };
  return { ok: true, key };
}

export function indexNowPayload(key: string, urlList: string[]): {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
} {
  return {
    host: "schedi.app",
    key,
    keyLocation: `https://schedi.app/${key}.txt`,
    urlList,
  };
}

export async function submitIndexNow(
  env: IndexNowEnv,
  urlList: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ submitted: false; reason: IndexNowSkipReason } | { submitted: true; status: number }> {
  const gate = indexNowGate(env);
  if (!gate.ok) return { submitted: false, reason: gate.reason };
  const response = await fetchImpl(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(indexNowPayload(gate.key, urlList)),
  });
  return { submitted: true, status: response.status };
}
