/* ============================================================
   VARETH — BACKEND (single file)
   Run: node server.js
   Requires a .env file in the same folder (see LAUNCH.txt)
   ============================================================ */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Stripe from 'stripe';
import Anthropic from '@anthropic-ai/sdk';
import formData from 'form-data';
import Mailgun from 'mailgun.js';

/* ---------- config ---------- */
const PORT = process.env.PORT || 5000;
const SITE_URL = process.env.SITE_URL || 'http://localhost:8000';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'IsaiahWilliams@varethsystems.com';
const FROM_EMAIL = process.env.FROM_EMAIL || `Vareth <no-reply@${process.env.MAILGUN_DOMAIN}>`;

const TIERS = {
  starter: { name: 'Starter', price: 65,  modules: 3,  refreshDays: 30, priceId: process.env.STRIPE_PRICE_STARTER },
  growth:  { name: 'Growth',  price: 175, modules: 7,  refreshDays: 14, priceId: process.env.STRIPE_PRICE_GROWTH  },
  scale:   { name: 'Scale',   price: 425, modules: 12, refreshDays: 7,  priceId: process.env.STRIPE_PRICE_SCALE   }
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const mg = new Mailgun(formData).client({ username: 'api', key: process.env.MAILGUN_API_KEY });

/* ---------- tiny file store (no database to install) ---------- */
const STORE = path.join(process.cwd(), 'vareth-data.store');
function load() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); }
  catch { return { assessments: {}, users: {} }; }
}
function save(db) { fs.writeFileSync(STORE, JSON.stringify(db, null, 2)); }
let db = load();
const persist = () => save(db);

/* ---------- helpers ---------- */
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const newSalt = () => crypto.randomBytes(16).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');
const tempPassword = () => crypto.randomBytes(4).toString('hex').toUpperCase();

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = Object.values(db.users).find(u => u.token === token);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}

async function sendMail({ to, subject, text }) {
  if (!process.env.MAILGUN_API_KEY) { console.log('[mail skipped]', to, subject); return; }
  try {
    await mg.messages.create(process.env.MAILGUN_DOMAIN, { from: FROM_EMAIL, to, subject, text });
    console.log('[mail sent]', to, '—', subject);
  } catch (e) { console.error('[mail failed]', e.message); }
}

/* ---------- Claude module generation ---------- */
async function generateModule({ topic, agency, answers, weakest }) {
  const context = answers.map(a => `${a.label}: ${a.answer}`).join('\n');
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content:
`You are writing an operations module for a home care agency called "${agency}".

Their assessment responses:
${context}

Their weakest areas: ${weakest.join(', ')}

Write a complete, implementable operations module on: ${topic}

Format it exactly like this, in plain text (no markdown headers, no preamble):

TITLE: <module title>

WHY THIS MATTERS FOR YOUR AGENCY
<2-3 sentences referencing their specific situation>

THE SYSTEM
<the actual process, step by step, numbered>

WEEK ONE: WHAT TO DO
<5 concrete actions with day assignments>

TEMPLATES AND SCRIPTS
<fill-in-the-blank templates they can copy and use today>

WHAT TO MEASURE
<3-4 metrics with target numbers>

WHERE THIS GOES WRONG
<3 common failure points and how to avoid each>

Be specific to home care. No filler, no consultant language, no disclaimers.`
    }]
  });
  return msg.content.map(c => c.text || '').join('\n');
}

const TOPIC_BANK = {
  'Staffing & Retention': ['Caregiver Retention System', 'Hiring and Onboarding Pipeline', 'Caregiver Performance Reviews'],
  'Scheduling & Client Management': ['Scheduling System and Shift Coverage', 'Call-Off and Emergency Coverage Protocol', 'Client Intake and Assessment Process'],
  'Compliance & Documentation': ['Compliance and Certification Tracking', 'Documentation Standards and Audit Prep', 'Incident Reporting System'],
  'Billing & Financial Controls': ['Billing and Collections Workflow', 'Payroll and Margin Controls', 'Authorization and Claims Tracking'],
  'Quality & Operations': ['Quality Assurance and Client Satisfaction', 'Operations Dashboard and KPIs', 'Client Communication System']
};

function pickTopics(pillars, count) {
  const sorted = [...pillars].sort((a, b) => a.score - b.score);
  const topics = [];
  let round = 0;
  while (topics.length < count && round < 3) {
    for (const p of sorted) {
      const bank = TOPIC_BANK[p.name] || [];
      if (bank[round] && topics.length < count) topics.push(bank[round]);
    }
    round++;
  }
  return topics;
}

async function buildModulesFor(userEmail) {
  const user = db.users[userEmail];
  if (!user) return;
  const a = db.assessments[user.assessmentId];
  if (!a) return;
  const tier = TIERS[user.tier];
  const weakest = [...a.pillars].sort((x, y) => x.score - y.score).slice(0, 2).map(p => p.name);
  const topics = pickTopics(a.pillars, tier.modules);

  user.generating = true; persist();
  const built = [];
  for (const topic of topics) {
    try {
      const body = await generateModule({ topic, agency: user.agencyName, answers: a.answers, weakest });
      built.push({ topic, body, created: new Date().toISOString() });
      user.modules = built; persist();
      console.log(`[module] ${user.email} — ${topic}`);
    } catch (e) { console.error('[module failed]', topic, e.message); }
  }
  user.generating = false;
  user.lastRefresh = new Date().toISOString();
  persist();

  await sendMail({
    to: user.email,
    subject: `Your ${tier.name} modules are ready`,
    text:
`${user.agencyName} —

Your ${built.length} custom modules are built and waiting in your portal.

Log in: ${SITE_URL}/app.html?view=portal
Email: ${user.email}

They were built from your assessment answers, focused on your two weakest areas: ${weakest.join(' and ')}.

Your plan refreshes every ${tier.refreshDays} days — regenerate from the portal any time after that.

— Isaiah
${SUPPORT_EMAIL}`
  });
}

/* ---------- app ---------- */
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* Save an assessment, return its id */
app.post('/api/assessment', (req, res) => {
  const { name, email, answers, pillars, overall } = req.body || {};
  if (!email || !Array.isArray(answers)) return res.status(400).json({ error: 'Missing assessment data' });
  const id = crypto.randomUUID();
  db.assessments[id] = { id, name, email, answers, pillars, overall, created: new Date().toISOString() };
  persist();
  console.log('[assessment]', email, overall);
  res.json({ id });
});

/* Start a Stripe subscription checkout */
app.post('/api/checkout', async (req, res) => {
  try {
    const { assessmentId, tier, email, agencyName } = req.body || {};
    const t = TIERS[tier];
    if (!t) return res.status(400).json({ error: 'Unknown tier' });
    if (!t.priceId) return res.status(500).json({ error: `No Stripe price ID set for ${tier}. Add STRIPE_PRICE_${tier.toUpperCase()} to .env` });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: t.priceId, quantity: 1 }],
      customer_email: email,
      success_url: `${SITE_URL}/app.html?view=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/app.html?view=results`,
      metadata: { assessmentId: assessmentId || '', tier, agencyName: agencyName || '' }
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('[checkout]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* After payment: create the account, email the one-time password, build modules */
app.get('/api/session/:id', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.id);
    if (session.payment_status !== 'paid') return res.status(402).json({ error: 'Payment not complete' });

    const email = (session.customer_email || session.customer_details?.email || '').toLowerCase();
    const tier = session.metadata?.tier || 'growth';
    const agencyName = session.metadata?.agencyName || 'Your agency';
    const assessmentId = session.metadata?.assessmentId || '';

    if (db.users[email]) return res.json({ email, tier, existing: true });

    const pw = tempPassword();
    const salt = newSalt();
    db.users[email] = {
      email, agencyName, tier, assessmentId,
      salt, pwHash: hash(pw, salt), mustChange: true,
      token: null, modules: [], generating: false,
      stripeCustomer: session.customer, stripeSub: session.subscription,
      created: new Date().toISOString(), lastRefresh: null
    };
    persist();

    await sendMail({
      to: email,
      subject: 'Your Vareth login',
      text:
`${agencyName} —

You're in. Here's your one-time password:

    ${pw}

Log in: ${SITE_URL}/app.html?view=portal
Email: ${email}

You'll be asked to set a real password on first login.

Your custom modules are being built right now — you'll get a second email the moment they're ready (usually a few minutes).

— Isaiah
${SUPPORT_EMAIL}`
    });

    buildModulesFor(email).catch(e => console.error('[build]', e.message));
    res.json({ email, tier, existing: false });
  } catch (e) {
    console.error('[session]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* Login */
app.post('/api/login', (req, res) => {
  const email = (req.body?.email || '').toLowerCase();
  const password = req.body?.password || '';
  const user = db.users[email];
  if (!user || hash(password, user.salt) !== user.pwHash) return res.status(401).json({ error: 'Wrong email or password' });
  user.token = newToken();
  persist();
  res.json({ token: user.token, mustChange: user.mustChange });
});

/* Who am I + my modules */
app.get('/api/me', auth, (req, res) => {
  const t = TIERS[req.user.tier];
  const next = req.user.lastRefresh
    ? new Date(new Date(req.user.lastRefresh).getTime() + t.refreshDays * 864e5)
    : null;
  res.json({
    email: req.user.email,
    agencyName: req.user.agencyName,
    tier: req.user.tier,
    tierName: t.name,
    price: t.price,
    refreshDays: t.refreshDays,
    mustChange: req.user.mustChange,
    generating: req.user.generating,
    canRefresh: next ? Date.now() >= next.getTime() : false,
    nextRefresh: next ? next.toISOString() : null,
    modules: (req.user.modules || []).map((m, i) => ({ i, topic: m.topic, created: m.created }))
  });
});

/* Download one module */
app.get('/api/modules/:i/download', (req, res) => {
  const token = req.query.token || '';
  const user = Object.values(db.users).find(u => u.token === token);
  if (!user) return res.status(401).send('Not logged in');
  const m = (user.modules || [])[Number(req.params.i)];
  if (!m) return res.status(404).send('Not found');
  const file = m.topic.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.txt';
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  res.send(m.body);
});

/* Change password */
app.post('/api/change-password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  if (hash(currentPassword || '', req.user.salt) !== req.user.pwHash) return res.status(401).json({ error: 'Current password is wrong' });
  req.user.salt = newSalt();
  req.user.pwHash = hash(newPassword, req.user.salt);
  req.user.mustChange = false;
  persist();
  res.json({ ok: true });
});

/* Regenerate modules (respects tier cadence) */
app.post('/api/refresh', auth, (req, res) => {
  const t = TIERS[req.user.tier];
  const last = req.user.lastRefresh ? new Date(req.user.lastRefresh).getTime() : 0;
  if (Date.now() < last + t.refreshDays * 864e5) return res.status(429).json({ error: `Your plan refreshes every ${t.refreshDays} days.` });
  if (req.user.generating) return res.status(409).json({ error: 'Already generating.' });
  buildModulesFor(req.user.email).catch(e => console.error('[refresh]', e.message));
  res.json({ ok: true });
});

/* Contact / help */
app.post('/api/help', async (req, res) => {
  const { email, message } = req.body || {};
  await sendMail({ to: SUPPORT_EMAIL, subject: `Help request — ${email}`, text: message || '' });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\nVARETH backend running — http://localhost:${PORT}`);
  console.log(`Site URL: ${SITE_URL}`);
  console.log(`Stripe: ${process.env.STRIPE_SECRET_KEY ? 'connected' : 'MISSING KEY'}`);
  console.log(`Mailgun: ${process.env.MAILGUN_API_KEY ? 'connected' : 'MISSING KEY'}`);
  console.log(`Claude: ${process.env.ANTHROPIC_API_KEY ? 'connected' : 'MISSING KEY'} (${MODEL})\n`);
});
