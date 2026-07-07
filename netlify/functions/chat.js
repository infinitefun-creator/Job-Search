// Live job search via the Adzuna API (Australia).
// Holds your Adzuna keys server-side and returns clean, current listings —
// each with a real apply link, posted date, and salary when available.
// Runs at /.netlify/functions/chat

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const id = process.env.ADZUNA_APP_ID;
  const key = process.env.ADZUNA_APP_KEY;
  if (!id || !key) {
    return json(500, {
      error: 'Server is missing ADZUNA_APP_ID / ADZUNA_APP_KEY. Add both in Netlify -> Project configuration -> Environment variables, then redeploy.'
    });
  }

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Could not read request.' }); }

  const what = (p.what || '').trim();
  const where = (p.where || '').trim();
  const distance = p.distance;

  const params = new URLSearchParams({
    app_id: id,
    app_key: key,
    results_per_page: '20',
    'content-type': 'application/json',
    sort_by: 'date'
  });
  if (what) params.set('what', what);
  if (where) {
    params.set('where', where);
    if (distance) params.set('distance', String(distance));
  }

  const url = 'https://api.adzuna.com/v1/api/jobs/au/search/1?' + params.toString();

  try {
    const r = await fetch(url);
    const data = await r.json();
    if (!r.ok) {
      return json(r.status, { error: (data && (data.exception || data.error)) || ('Adzuna error ' + r.status) });
    }
    const jobs = (data.results || []).map(j => ({
      title: j.title || 'Untitled role',
      company: (j.company && j.company.display_name) || 'Not specified',
      location: (j.location && j.location.display_name) || where || 'Australia',
      salary: fmtSalary(j),
      posted: rel(j.created),
      contract: [j.contract_time, j.contract_type].filter(Boolean).join(' · ').replace(/_/g, ' '),
      summary: clip(j.description),
      url: j.redirect_url || ''
    }));
    return json(200, { count: data.count || jobs.length, jobs });
  } catch (e) {
    return json(502, { error: 'Upstream failure: ' + (e.message || String(e)) });
  }
};

function fmtSalary(j) {
  const min = j.salary_min, max = j.salary_max;
  if (!min && !max) return '';
  const f = n => '$' + Math.round(n).toLocaleString();
  let s = (min && max && min !== max) ? (f(min) + '–' + f(max)) : f(min || max);
  s += '/yr';
  if (String(j.salary_is_predicted) === '1') s += ' (est.)';
  return s;
}

function rel(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  const days = Math.floor((now - d) / 86400000);
  if (isNaN(days)) return '';
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return days + ' days ago';
  const m = Math.floor(days / 30);
  return m + (m === 1 ? ' month ago' : ' months ago');
}

function clip(html) {
  if (!html) return '';
  const t = String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ').replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return t.length > 170 ? t.slice(0, 167) + '…' : t;
}

function json(statusCode, obj) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}
