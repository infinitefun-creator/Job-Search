// Secure backend proxy: holds your API key, calls Claude with live web search,
// and passes through any uploaded files (PDF / image / text) as context.
// Runs as a Netlify Function at /.netlify/functions/chat

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return json(500, {
      error: 'Server is missing ANTHROPIC_API_KEY. Add it in Netlify → Site settings → Environment variables, then redeploy.'
    });
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Could not read request.' }); }

  const { system, messages } = payload;
  if (!Array.isArray(messages)) return json(400, { error: 'messages must be an array.' });

  const convo = messages.slice();
  let finalText = '';

  try {
    // Loop to resume any multi-step ("pause_turn") web searches.
    for (let step = 0; step < 6; step++) {
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
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }]
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
