// Meta Model API client, plus the two guards every call goes through:
// a model guard (no Contributor models on customer data) and a hard spend cap.
import fs from 'node:fs';
import OpenAI from 'openai';

if (!process.env.MODEL_API_KEY && fs.existsSync('.env')) process.loadEnvFile('.env');
if (!process.env.MODEL_API_KEY) throw new Error('MODEL_API_KEY is not set (put it in .env)');

export const meta = new OpenAI({ baseURL: 'https://api.meta.ai/v1', apiKey: process.env.MODEL_API_KEY });

// Contributor models let Meta train on the request, and Meta's terms forbid
// personal data there. Product-only bench clips may use them; claims may not.
export function assertModel(model: string, opts: { customerData: boolean }) {
  if (opts.customerData && model.includes('contributor')) {
    throw new Error(`refusing ${model}: customer data must use a Standard model`);
  }
}

// Published prices (USD). Video is billed per frame with a 50-frame minimum per request.
export const PRICE = {
  samImage: 2.5 / 1000,
  samFrame: 0.2 / 1000,
  samMinFrames: 50,
  sparkIn: 1.25 / 1e6,
  sparkOut: 4.25 / 1e6,
};

const LEDGER = 'data/spend.json';
const CAP_USD = Number(process.env.SPEND_CAP_USD ?? 120);

function spent(): number {
  if (!fs.existsSync(LEDGER)) return 0;
  const usd = JSON.parse(fs.readFileSync(LEDGER, 'utf8')).usd;
  if (!Number.isFinite(usd)) throw new Error(`${LEDGER} is unreadable; fix it before spending more`);
  return usd;
}

// ponytail: one local ledger file, single process; move to a DB row once the bench runs unattended.
export function spend<T>(estimateUsd: number, label: string, call: () => Promise<T>): Promise<T> {
  const before = spent();
  if (!Number.isFinite(estimateUsd) || estimateUsd < 0) throw new Error(`refusing ${label}: bad cost estimate ${estimateUsd}`);
  if (before + estimateUsd > CAP_USD) {
    throw new Error(`spend cap: $${before.toFixed(4)} spent + $${estimateUsd.toFixed(4)} would pass $${CAP_USD}`);
  }
  return call().then((result) => {
    fs.mkdirSync('data', { recursive: true });
    // Re-read: other calls may have finished while this one ran.
    fs.writeFileSync(LEDGER, JSON.stringify({ usd: spent() + estimateUsd, last: label, at: new Date().toISOString() }));
    return result;
  });
}
