/**
 * Demo businesses include a sample account whose card capabilities are marked
 * active in local data. That data stays out of production unless explicitly
 * requested, so a fresh deploy does not present card checkout before a real
 * connected account exists.
 */
export function shouldSeedDemo(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SCHEDI_SEED === "0") return false;
  if (env.SCHEDI_SEED === "1") return true;
  return env.NODE_ENV !== "production";
}
