const ENV_MAP = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY'
};

// Daily per-user token allowance. Override with DAILY_TOKEN_LIMIT in Vercel
// env vars. Resets at midnight UTC (see get_today_usage() in Supabase).
const DAILY_TOKEN_LIMIT = parseInt(process.env.DAILY_TOKEN_LIMIT, 10) || 100000;

// Comma-separated list of admin emails (set ADMIN_EMAILS in Vercel env vars).
// Admins get the raw provider response + token counts back in the API
// response for their own requests only — regular users never see this.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// Verifies the caller's Supabase access token against Supabase's Auth
// service. If SUPABASE_URL / SUPABASE_ANON_KEY aren't configured yet, auth
// enforcement (and usage tracking) is skipped so the app doesn't hard-break
// mid-setup.
async function requireAuth(req) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return { ok: true, token: null, supabaseUrl: null, supabaseAnonKey: null, email: null };
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, error: 'Sign in required.' };

  try {
    const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: supabaseAnonKey }
    });
    if (!r.ok) return { ok: false, error: 'Your session has expired. Please sign in again.' };
    const userData = await r.json().catch(() => null);
    const email = (userData && userData.email) || null;
    return { ok: true, token, supabaseUrl, supabaseAnonKey, email };
  } catch (err) {
    return { ok: false, error: 'Could not verify your session. Please try again.' };
  }
}

// Reads today's token usage for the signed-in user via the get_today_usage()
// Postgres function (runs with the user's own JWT, so it's automatically
// scoped to them). Fails open (returns 0) if anything goes wrong.
async function getTodayUsage(supabaseUrl, anonKey, token) {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/get_today_usage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: anonKey, 'content-type': 'application/json' },
      body: '{}'
    });
    if (!r.ok) return 0;
    const val = await r.json();
    return typeof val === 'number' ? val : 0;
  } catch (err) {
    return 0;
  }
}

// Adds tokens to today's usage row via the increment_usage() Postgres
// function. Best-effort — a failure here shouldn't break the user's
// response, just means the usage counter may lag slightly.
async function addUsage(supabaseUrl, anonKey, token, tokens) {
  if (!tokens) return;
  try {
    await fetch(`${supabaseUrl}/rest/v1/rpc/increment_usage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ p_tokens: tokens })
    });
  } catch (err) {
    // ignore — best effort
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = await requireAuth(req);
  if (!auth.ok) {
    res.status(401).json({ error: auth.error });
    return;
  }

  const isAdmin = !!(auth.email && ADMIN_EMAILS.includes(auth.email.toLowerCase()));

  const { provider, model, system, message, apiKeyOverride } = req.body || {};

  if (!provider || !model || !message) {
    res.status(400).json({ error: 'Missing provider, model, or message.' });
    return;
  }

  const envVarName = ENV_MAP[provider];
  if (!envVarName) {
    res.status(400).json({ error: 'Unknown provider: ' + provider });
    return;
  }

  const key = (apiKeyOverride && apiKeyOverride.trim()) || process.env[envVarName];
  if (!key) {
    res.status(400).json({
      error: `No API key available for ${provider}. Set ${envVarName} in this Vercel project's Settings -> Environment Variables (then redeploy), or paste a personal key in Settings to override.`
    });
    return;
  }

  const usageTrackingEnabled = !!(auth.token && auth.supabaseUrl && auth.supabaseAnonKey);
  let usedSoFar = 0;
  if (usageTrackingEnabled) {
    usedSoFar = await getTodayUsage(auth.supabaseUrl, auth.supabaseAnonKey, auth.token);
    if (usedSoFar >= DAILY_TOKEN_LIMIT) {
      res.status(429).json({
        error: `Daily usage limit reached (${DAILY_TOKEN_LIMIT.toLocaleString()} tokens). It resets at midnight UTC.`,
        usage: { tokensUsed: usedSoFar, limit: DAILY_TOKEN_LIMIT }
      });
      return;
    }
  }

  try {
    let result;
    if (provider === 'anthropic') result = await callAnthropic(model, key, system, message);
    else if (provider === 'openai') result = await callOpenAI(model, key, system, message);
    else if (provider === 'google') result = await callGemini(model, key, system, message);
    else throw new Error('Unknown provider: ' + provider);

    const requestTokens = result.totalTokens || 0;
    const newTotal = usedSoFar + requestTokens;
    if (usageTrackingEnabled && requestTokens) {
      await addUsage(auth.supabaseUrl, auth.supabaseAnonKey, auth.token, requestTokens);
    }

    // Normalize each provider's usage object into Gemini-style field names
    // for the admin debug payload, while still keeping the raw response
    // exactly as the provider sent it.
    const rawUsage = (result.raw && (result.raw.usageMetadata || result.raw.usage)) || null;
    const promptTokenCount = rawUsage
      ? (rawUsage.promptTokenCount ?? rawUsage.input_tokens ?? rawUsage.prompt_tokens ?? null)
      : null;
    const candidatesTokenCount = rawUsage
      ? (rawUsage.candidatesTokenCount ?? rawUsage.output_tokens ?? rawUsage.completion_tokens ?? null)
      : null;
    const totalTokenCount = rawUsage
      ? (rawUsage.totalTokenCount ?? rawUsage.total_tokens ?? requestTokens)
      : requestTokens;

    res.status(200).json({
      text: result.text,
      usage: usageTrackingEnabled
        ? { tokensUsed: newTotal, limit: DAILY_TOKEN_LIMIT, lastRequestTokens: requestTokens }
        : null,
      debug: isAdmin
        ? {
            provider,
            model,
            usageMetadata: rawUsage,
            promptTokenCount,
            candidatesTokenCount,
            totalTokenCount,
            rawResponse: result.raw
          }
        : undefined
    });
  } catch (err) {
    res.status(500).json({ error: (err && err.message) || 'Unknown error calling provider.' });
  }
}

async function callAnthropic(model, key, system, message) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system,
      messages: [{ role: 'user', content: message }]
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data && data.error && data.error.message) || `Anthropic HTTP ${r.status}`);
  const text = (data.content && data.content[0] && data.content[0].text) || '';
  const totalTokens = (data.usage && ((data.usage.input_tokens || 0) + (data.usage.output_tokens || 0))) || 0;
  return { text, totalTokens, raw: data };
}

async function callOpenAI(model, key, system, message) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: 'Bearer ' + key
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: message }
      ]
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data && data.error && data.error.message) || `OpenAI HTTP ${r.status}`);
  const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  const totalTokens = (data.usage && data.usage.total_tokens) || 0;
  return { text, totalTokens, raw: data };
}

async function callGemini(model, key, system, message) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: message }] }]
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data && data.error && data.error.message) || `Gemini HTTP ${r.status}`);
  const cand = data.candidates && data.candidates[0];
  const parts = cand && cand.content && cand.content.parts;
  const text = (parts && parts.map(p => p.text || '').join('')) || '';
  const totalTokens = (data.usageMetadata && data.usageMetadata.totalTokenCount) || 0;
  return { text, totalTokens, raw: data };
}
