// Job Match backend — multi-source search with optional AI smart-ranking.
// Sources: Adzuna + JSearch (Google for Jobs: Indeed, LinkedIn, Glassdoor, ZipRecruiter...).
// Modes: "keyword" (fast, free) and "smart" (AI reads a paragraph + résumé, ranks to you).
// Every source is OPTIONAL: if its key is absent, it's skipped rather than erroring.
// Keys (Netlify env vars): ADZUNA_APP_ID, ADZUNA_APP_KEY, RAPIDAPI_KEY, ANTHROPIC_API_KEY

const ADZUNA_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_KEY = process.env.ADZUNA_APP_KEY;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const HAIKU = 'claude-haiku-4-5-20251001';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!ADZUNA_ID || !ADZUNA_KEY) {
    return json(500, { error: 'Server is missing ADZUNA_APP_ID / ADZUNA_APP_KEY. Add them in Netlify -> Project configuration -> Environment variables, then redeploy.' });
  }

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Could not read request.' }); }

  const mode = p.mode === 'smart' ? 'smart' : 'keyword';
  let f = normalizeFilters(p);
  let profile = '';
  let notes = [];

  // SMART: let the AI read the paragraph + résumé and derive the search.
  if (mode === 'smart') {
    if (!ANTHROPIC_KEY) {
      notes.push('Smart mode needs ANTHROPIC_API_KEY set in Netlify; searched on your text as keywords instead.');
      if (!f.what && p.paragraph) f.what = String(p.paragraph).slice(0, 120);
    } else {
      try {
        const ex = await smartExtract(p, f);
        f = mergeExtract(f, ex);
        profile = ex.profile || p.paragraph || '';
      } catch (e) {
        notes.push('Could not interpret the description; searched on your text as keywords.');
        if (!f.what && p.paragraph) f.what = String(p.paragraph).slice(0, 120);
      }
    }
  }

  // Fetch sources in parallel (each guarded).
  const [adz, js] = await Promise.all([ fetchAdzuna(f), fetchJSearch(f) ]);
  let jobs = dedupe([...(adz.jobs || []), ...(js.jobs || [])]);
  if (js.note) notes.push(js.note);

  if (f.salaryMin) jobs = jobs.filter(j => !j.salaryAnnual || j.salaryAnnual >= f.salaryMin);
  if (f.sort === 'date') jobs.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  // SMART: rank the fetched jobs to the candidate.
  if (mode === 'smart' && jobs.length && ANTHROPIC_KEY && profile) {
    try { jobs = await smartRank(profile, jobs); }
    catch (e) { notes.push('Showing results unranked (ranking step skipped).'); }
  }

  const count = adz.count || jobs.length;
  jobs.forEach(j => { delete j.salaryAnnual; delete j.ts; });
  return json(200, { count, jobs, mode, page: f.page, note: notes.join(' ') });
};

// ---------- filters ----------
function normalizeFilters(p) {
  return {
    what: (p.what || '').trim(),
    where: (p.where || '').trim(),
    exact: !!p.exact,
    distance: p.distance || '',
    jobTypes: Array.isArray(p.jobTypes) ? p.jobTypes : [],
    datePosted: p.datePosted || '',
    salaryMin: Number(p.salaryMin) || 0,
    remote: !!p.remote,
    sort: p.sort === 'date' ? 'date' : 'relevance',
    page: Math.max(1, Number(p.page) || 1)
  };
}

// ---------- Adzuna ----------
async function fetchAdzuna(f) {
  const params = new URLSearchParams({
    app_id: ADZUNA_ID, app_key: ADZUNA_KEY,
    results_per_page: '20', 'content-type': 'application/json',
    sort_by: f.sort === 'date' ? 'date' : 'relevance'
  });
  let what = f.what;
  if (f.jobTypes.includes('casual')) what = (what + ' casual').trim();
  if (f.remote) what = (what + ' remote').trim();
  if (what) params.set('what', what);
  if (f.where) {
    params.set('where', f.where);
    params.set('distance', String(f.exact ? 1 : (f.distance || 10)));
  }
  // Apply a single job-type flag when exactly one non-casual type is chosen.
  const primary = f.jobTypes.filter(t => t !== 'casual');
  if (primary.length === 1) {
    if (primary[0] === 'full_time') params.set('full_time', '1');
    if (primary[0] === 'part_time') params.set('part_time', '1');
    if (primary[0] === 'contract') params.set('contract', '1');
  }
  if (f.salaryMin) params.set('salary_min', String(f.salaryMin));
  if (f.datePosted) params.set('max_days_old', String(f.datePosted));

  const url = 'https://api.adzuna.com/v1/api/jobs/au/search/' + f.page + '?' + params.toString();
  try {
    const r = await fetch(url);
    const raw = await r.text();
    let d; try { d = JSON.parse(raw); } catch { return { jobs: [], count: 0 }; }
    if (!r.ok || d.exception) return { jobs: [], count: 0 };
    const jobs = (d.results || []).map(j => {
      const sal = fmtSalaryAnnual(j.salary_min, j.salary_max, j.salary_is_predicted);
      return {
        title: j.title || 'Untitled role',
        company: (j.company && j.company.display_name) || 'Not specified',
        location: (j.location && j.location.display_name) || f.where || 'Australia',
        salary: sal.text, salaryAnnual: sal.annual,
        posted: rel(j.created), ts: j.created ? Date.parse(j.created) : 0,
        type: (j.contract_time || '').replace('_', ' '),
        source: 'Adzuna', logo: '',
        summary: clip(j.description), url: j.redirect_url || ''
      };
    });
    return { jobs, count: d.count || jobs.length };
  } catch { return { jobs: [], count: 0 }; }
}

// ---------- JSearch (Google for Jobs) ----------
async function fetchJSearch(f) {
  if (!RAPIDAPI_KEY) return { jobs: [] };
  const typeMap = { casual: 'PARTTIME', part_time: 'PARTTIME', full_time: 'FULLTIME', contract: 'CONTRACTOR' };
  const dateMap = { '1': 'today', '3': '3days', '7': 'week', '14': 'month' };
  const qBits = [];
  if (f.what) qBits.push(f.what);
  if (f.where) qBits.push('in ' + f.where);
  if (!qBits.length) qBits.push('jobs in Australia');
  const params = new URLSearchParams({
    query: qBits.join(' '), page: String(f.page), num_pages: '1', country: 'au'
  });
  if (f.datePosted && dateMap[f.datePosted]) params.set('date_posted', dateMap[f.datePosted]);
  const types = [...new Set(f.jobTypes.map(t => typeMap[t]).filter(Boolean))];
  if (types.length) params.set('employment_types', types.join(','));
  if (f.remote) params.set('work_from_home', 'true');

  try {
    const r = await fetch('https://jsearch.p.rapidapi.com/search?' + params.toString(), {
      headers: { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' }
    });
    const raw = await r.text();
    let d; try { d = JSON.parse(raw); } catch { return { jobs: [], note: 'JSearch returned no data (check the RapidAPI key or free-tier limit).' }; }
    if (!r.ok) return { jobs: [], note: 'JSearch error ' + r.status + (r.status === 429 ? ' — free-tier limit reached for now.' : '.') };
    const jobs = (d.data || []).map(j => {
      const sal = fmtSalaryPeriod(j.job_min_salary, j.job_max_salary, j.job_salary_period);
      return {
        title: j.job_title || 'Untitled role',
        company: j.employer_name || 'Not specified',
        location: [j.job_city, j.job_state].filter(Boolean).join(', ') || 'Australia',
        salary: sal.text, salaryAnnual: sal.annual,
        posted: rel(j.job_posted_at_datetime_utc), ts: j.job_posted_at_datetime_utc ? Date.parse(j.job_posted_at_datetime_utc) : 0,
        type: (j.job_employment_type || '').toLowerCase().replace('fulltime', 'full time').replace('parttime', 'part time'),
        source: 'Google for Jobs', logo: j.employer_logo || '',
        summary: clip(j.job_description), url: j.job_apply_link || ''
      };
    });
    return { jobs };
  } catch { return { jobs: [], note: 'JSearch unavailable this run.' }; }
}

// ---------- AI: extract search from paragraph + résumé ----------
async function smartExtract(p, f) {
  const content = [];
  if (p.resume && p.resume.data) {
    if (p.resume.kind === 'pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.resume.data } });
    else content.push({ type: 'text', text: 'RÉSUMÉ:\n' + String(p.resume.data).slice(0, 12000) });
  }
  content.push({ type: 'text', text: 'WHAT THEY WANT:\n' + (p.paragraph || f.what || 'a suitable role') });
  const sys = 'Read the résumé (if any) and the description, then infer the best job search. Reply with ONLY JSON, no fences: {"what":"3-6 keyword search terms","where":"suburb/city or empty","jobTypes":["casual"|"part_time"|"full_time"|"contract"],"salaryMin":number_or_0,"remote":true/false,"profile":"2-sentence summary of the candidate and what they want, for matching"}';
  const text = await claude({ model: HAIKU, max_tokens: 400, system: sys, messages: [{ role: 'user', content }] });
  return parseJSON(text) || {};
}

function mergeExtract(f, ex) {
  return {
    ...f,
    what: f.what || ex.what || '',
    where: f.where || ex.where || '',
    jobTypes: f.jobTypes.length ? f.jobTypes : (Array.isArray(ex.jobTypes) ? ex.jobTypes : []),
    salaryMin: f.salaryMin || Number(ex.salaryMin) || 0,
    remote: f.remote || !!ex.remote
  };
}

// ---------- AI: rank fetched jobs to the candidate ----------
async function smartRank(profile, jobs) {
  const list = jobs.slice(0, 28).map((j, i) =>
    i + '. ' + j.title + ' — ' + j.company + ' (' + j.location + '). ' + (j.summary || '').slice(0, 140)
  ).join('\n');
  const sys = 'You match jobs to a candidate. Given their profile and a numbered job list, return ONLY JSON, no fences: {"order":[best-to-worst indices],"fits":{"index":"<12 words why it fits"}}. Include a fit note for the top 12 only.';
  const text = await claude({ model: HAIKU, max_tokens: 700, system: sys,
    messages: [{ role: 'user', content: 'CANDIDATE:\n' + profile + '\n\nJOBS:\n' + list }] });
  const parsed = parseJSON(text);
  if (!parsed || !Array.isArray(parsed.order)) return jobs;
  const seen = new Set();
  const ordered = [];
  parsed.order.forEach(i => { if (jobs[i] && !seen.has(i)) { seen.add(i); const j = jobs[i]; if (parsed.fits && parsed.fits[i]) j.fit = parsed.fits[i]; ordered.push(j); } });
  jobs.forEach((j, i) => { if (!seen.has(i)) ordered.push(j); });
  return ordered;
}

// ---------- helpers ----------
async function claude(body) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error((d.error && d.error.message) || ('anthropic ' + r.status));
  return (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}
function parseJSON(s) { const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a < 0 || b < 0) return null; try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; } }

function dedupe(list) {
  const seen = new Set(), out = [];
  for (const j of list) { const k = (j.title + '|' + j.company).toLowerCase().replace(/\s+/g, ' ').trim(); if (seen.has(k)) continue; seen.add(k); out.push(j); }
  return out;
}
function fmtSalaryAnnual(min, max, predicted) {
  if (!min && !max) return { text: '', annual: 0 };
  const f = n => '$' + Math.round(n).toLocaleString();
  let t = (min && max && min !== max) ? (f(min) + '–' + f(max)) : f(min || max);
  t += '/yr'; if (String(predicted) === '1') t += ' (est.)';
  return { text: t, annual: max || min };
}
function fmtSalaryPeriod(min, max, period) {
  if (!min && !max) return { text: '', annual: 0 };
  const p = (period || '').toUpperCase();
  const unit = p === 'HOUR' ? '/hr' : p === 'MONTH' ? '/mo' : p === 'WEEK' ? '/wk' : p === 'DAY' ? '/day' : '/yr';
  const mult = p === 'HOUR' ? 1976 : p === 'DAY' ? 260 : p === 'WEEK' ? 52 : p === 'MONTH' ? 12 : 1;
  const f = n => '$' + Math.round(n).toLocaleString();
  const val = max || min;
  let t = (min && max && min !== max) ? (f(min) + '–' + f(max)) : f(val);
  return { text: t + unit, annual: Math.round(val * mult) };
}
function rel(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (isNaN(days)) return '';
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return days + ' days ago';
  const m = Math.floor(days / 30); return m + (m === 1 ? ' month ago' : ' months ago');
}
function clip(html) {
  if (!html) return '';
  const t = String(html).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > 180 ? t.slice(0, 177) + '…' : t;
}
function json(statusCode, obj) { return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }; }
