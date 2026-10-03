import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Stripe from 'stripe';
import { createApp } from './app.js';
import { createSimulatedStripe } from './simulatedStripe.js';
import { createStore } from './store.js';

export function loadEnv(file = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

export function createRuntime(env = process.env) {
  const publicBaseUrl = env.PUBLIC_BASE_URL || `http://localhost:${env.PORT || 3000}`;
  const secret = env.STRIPE_SECRET_KEY || '';
  const simulate = env.STRIPE_SIMULATE === '1' && !secret;
  if (env.NODE_ENV === 'production' && !env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET is required in production.');
  }
  const stripe = secret
    ? new Stripe(secret)
    : simulate
      ? createSimulatedStripe({ publicBaseUrl })
      : null;
  const store = createStore({
    file: env.SCHEDI_DATA_FILE || path.join(process.cwd(), 'data', 'store.json'),
  });
  const config = {
    publicBaseUrl,
    publishableKey: env.STRIPE_PUBLISHABLE_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || (simulate ? 'whsec_schedi_simulate' : ''),
    sessionSecret: env.SESSION_SECRET || 'dev-only-change-me',
    simulate,
  };
  return { store, stripe, config, app: createApp({ store, stripe, config }) };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  loadEnv();
  const { app, config } = createRuntime();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`Schedi listening on ${config.publicBaseUrl}`);
  });
}
