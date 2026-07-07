# Job Match

Your own AI job-search chat. Describe any role, schedule, or location and it searches live
job sites (Seek, Indeed, LinkedIn, Jora, Glassdoor, Adzuna, Gumtree, Airtasker, company pages)
and returns what's actually posted, with apply links. Attach a résumé, a job ad, or a screenshot
and it uses them to match you better.

It's a static page plus one small serverless function. The function holds your API key server-side
(never in the browser) and makes the Claude call — which is also why the search works here but not
inside a sandboxed preview.

## Why the backend exists
A website can't safely put an API key in browser code, and Anthropic blocks direct browser calls.
So `netlify/functions/chat.js` runs on Netlify, keeps your key in an environment variable, and does
the request for the page. That's the whole reason for the tiny bit of setup below.

## Deploy (your usual Netlify flow)
1. Push this folder to a **GitHub** repo (private is fine).
2. In **Netlify**: *Add new site → Import from GitHub → pick the repo → Deploy*. No build command
   needed; `netlify.toml` handles it.
3. In **Site settings → Environment variables**, add:
   - `ANTHROPIC_API_KEY` = your key from https://console.anthropic.com
4. Trigger a redeploy. Open the site — done. It's yours, on your domain.

Local test (optional): `npm i -g netlify-cli` then `netlify dev` with the key in a `.env`
(`ANTHROPIC_API_KEY=...`). Opening `index.html` directly by double-click won't work — the function
has to be running.

## Using it
- Type what you want: "part-time bookkeeper, remote, 20 hrs/week", "graduate mechanical engineer in
  Perth", etc. Set an optional home city top-right.
- Click the 📎 to attach files as context:
  - **PDF** (e.g. a résumé) and **images** (a screenshot of a job ad) are read directly.
  - **.txt / .md / .csv** are read as text.
  - Keep files under ~4.5MB (serverless request limit).
- Follow up in the same thread: "only permanent roles", "widen to 25km", "which fit my résumé best".

## Make it yours
- **Model:** change `claude-sonnet-5` in `chat.js` (e.g. a cheaper or newer model).
- **Behaviour:** edit the `SYSTEM` prompt in `index.html` — add preferred boards, tone, or filters.
- **Starter prompts:** edit the `.chip` buttons in `index.html`.
- **Multiple users:** it's stateless and generic — anyone who opens the site can use it for any job.

## Cost
You pay only for what you use via your Anthropic key (pay-as-you-go, prepaid credits). A search-and-
answer turn is typically a few cents. Netlify's free tier covers the hosting and function calls.
