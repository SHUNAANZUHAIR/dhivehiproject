const ENV_MAP = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY'
};

// Verifies the caller's Supabase access token against Supabase's Auth
// service. If SUPABASE_URL / SUPABASE_ANON_KEY aren't configured yet, auth
// enforcement is skipped here (the frontend's own gate is the only check
// until sign-in is fully wired up) so the app doesn't hard-break mid-setup.
async function requireAuth(req) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) return { ok: true };

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, error: 'Sign in required.' };

  try {
    const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: supabaseAnonKey }
    });
    if (!r.ok) return { ok: false, error: 'Your session has expired. Please sign in again.' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'Could not verify your session. Please try again.' };
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

  try {
    let text;
    if (provider === 'anthropic') text = await callAnthropic(model, key, system, message);
    else if (provider === 'openai') text = await callOpenAI(model, key, system, message);
    else if (provider === 'google') text = await callGemini(model, key, system, message);
    res.status(200).json({ text });
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
  return (data.content && data.content[0] && data.content[0].text) || '';
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
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
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
  return (parts && parts.map(p => p.text || '').join('')) || '';
}
