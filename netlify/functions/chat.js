// Secure backend proxy: holds your API key, calls Claude with live web search,
// and passes through any uploaded files (PDF / image / text) as context.
// Runs as a Netlify Function at /.netlify/functions/chat
//
// Tuned to finish inside Netlify's ~30s function limit: it caps how many
// live searches happen per request and bails out gracefully before the cutoff,
// so it always returns results instead of being killed mid-run.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return json(500, {
      error: 'Server is missing ANTHROPIC_API_KEY. Add it in Netlify -> Project configuration -> Environment variables, then redeploy.'
    });
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Could not read request.' }); }

  const { system, messages } = payload;
  if (!Array.isArray(messages)) return json(400, { error: 'messages must be an array.' });

  const convo = messages.slice();
  let finalText = '';
  const DEADLINE = Date.now() + 25000; // leave margin under Netlify's ~30s cap

  try {
    // Resume any multi-step ("pause_turn") searches, but stop if we're low on time.
    for (let step = 0; step < 3; step++) {
      if (Date.now() > DEADLINE) break;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 1500,
          system: system || '',
          messages: convo,
          // Fewer searches per turn keeps us safely under the time limit.
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
        })
      });

      const data = await r.json();
      if (!r.ok || data.error) {
        return json(r.status || 500, {
          error: (data.error && data.error.message) || ('Anthropic API error ' + r.status)
        });
      }

      const blocks = Array.isArray(data.content) ? data.content : [];
      finalText += blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      convo.push({ role: 'assistant', content: blocks });

      if (data.stop_reason === 'pause_turn') continue;
      break;
    }

    return json(200, { text: finalText.trim() });
  } catch (e) {
    return json(502, { error: 'Upstream failure: ' + (e.message || String(e)) });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}
