import { DurableObjectSql, type DurableSqlStorage, type DurableTransactionStorage } from "../../../src/connect/durable-sql";
import { handleConnectRequest } from "../../../src/connect/server";
import { connectConfigFrom } from "../../../src/lib/connect-config";
import { Store } from "../../../src/lib/db";
import { createStripeClient } from "../../../src/lib/stripe";

interface ConnectEnv {
  CONNECT_DB: {
    idFromName(name: string): { toString(): string };
    get(id: { toString(): string }): { fetch(request: Request): Promise<Response> };
  };
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_CONNECT_WEBHOOK_SECRET?: string;
  SCHEDI_CONNECT_PAID_SECRET?: string;
  SCHEDI_CONNECT_PAID_URL?: string;
  SCHEDI_CONNECT_READY_URL?: string;
  SCHEDI_PLAN_URL?: string;
  STRIPE_PRICE_STARTER?: string;
  STRIPE_PRICE_PRO?: string;
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?: string;
  CONNECT_PUBLIC_ORIGIN?: string;
  NODE_ENV?: string;
  SCHEDI_SEED?: string;
  SCHEDI_MIGRATION_SECRET?: string;
  CONNECT_OBJECT_NAME?: string;
  CONNECT_TEST_DELAY_MS?: string;
}

interface ConnectContext {
  storage: DurableTransactionStorage & { sql: DurableSqlStorage };
}

function runtimeEnv(env: ConnectEnv): Record<string, string | undefined> {
  return {
    STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET,
    STRIPE_CONNECT_WEBHOOK_SECRET: env.STRIPE_CONNECT_WEBHOOK_SECRET,
    SCHEDI_CONNECT_PAID_SECRET: env.SCHEDI_CONNECT_PAID_SECRET,
    SCHEDI_CONNECT_PAID_URL: env.SCHEDI_CONNECT_PAID_URL,
    SCHEDI_CONNECT_READY_URL: env.SCHEDI_CONNECT_READY_URL,
    SCHEDI_PLAN_URL: env.SCHEDI_PLAN_URL,
    STRIPE_PRICE_STARTER: env.STRIPE_PRICE_STARTER,
    STRIPE_PRICE_PRO: env.STRIPE_PRICE_PRO,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    CONNECT_PUBLIC_ORIGIN: env.CONNECT_PUBLIC_ORIGIN,
    NODE_ENV: env.NODE_ENV || "production",
    SCHEDI_SEED: env.SCHEDI_SEED ?? "0",
    SCHEDI_MIGRATION_SECRET: env.SCHEDI_MIGRATION_SECRET,
    CONNECT_TEST_DELAY_MS: env.CONNECT_TEST_DELAY_MS,
  };
}

/** Single-writer Connect database. The name is fixed so every request shares one SQLite. */
export class ConnectDatabase {
  constructor(
    private readonly ctx: ConnectContext,
    private readonly env: ConnectEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const config = connectConfigFrom(runtimeEnv(this.env));
    const store = new Store(new DurableObjectSql(this.ctx.storage.sql, this.ctx.storage));
    const stripe = config.stripeSecretKey ? createStripeClient(config.stripeSecretKey) : null;
    return handleConnectRequest(request, { store, config, stripe });
  }
}

export default {
  async fetch(request: Request, env: ConnectEnv): Promise<Response> {
    const name = env.CONNECT_OBJECT_NAME || "schedi-connect-migration";
    const id = env.CONNECT_DB.idFromName(name);
    return env.CONNECT_DB.get(id).fetch(request);
  },
};
