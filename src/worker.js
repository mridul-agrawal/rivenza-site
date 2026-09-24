// Rivenza site worker.
// Serves the static site as before, and handles POST /api/apply/illustrator by writing
// the application into the Candidates table of the Illustrator Hiring Airtable base.
//
// Settings (Cloudflare dashboard > Workers > rivenza-site > Settings > Variables and secrets):
//   AIRTABLE_TOKEN     secret   Airtable personal access token (scopes: data.records:read, data.records:write; base: Illustrator Hiring)
//   AIRTABLE_BASE_ID   variable appMISRQ22WObO7Ci (also set in wrangler.jsonc)
//   AIRTABLE_TABLE_ID  variable tblkxadDikWYn0FAW (also set in wrangler.jsonc)
//   TURNSTILE_SECRET   secret   optional; when set, every submission must pass Cloudflare Turnstile

const ROUTE = '/api/apply/illustrator';
const MAX_FILES = 5;
const MAX_BYTES = 5 * 1024 * 1024; // Airtable's limit for direct attachment uploads
const FILE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
const LIMITS = { short: 300, long: 5000 };

// Question order and wording, used for the readable "Application answers" record.
const QUESTIONS = [
  ['name', 'Name'], ['email', 'Email'], ['location', 'Based in'],
  ['portfolio', 'Portfolio'], ['profiles', 'Other profiles'],
  ['years_illustration', 'Years as a 2D illustrator or digital artist'],
  ['years_games', 'Years as an artist on video games'],
  ['best_artwork', 'Artwork they are proudest of'],
  ['logo', 'Game logos or title lettering'], ['ai', 'Generative AI use'],
  ['capsule', 'Has made capsule, key art or game marketing art'],
  ['capsule_games', 'Capsule and key art projects'],
  ['years_capsule', 'Years making capsule or key art'],
  ['best_capsule', 'Capsule piece they are proudest of'],
  ['pay', 'Pay in most recent role or gig'],
  ['availability', 'Could start'], ['anything', 'Questions or anything else'],
];

const REQUIRED = ['name', 'email', 'location', 'portfolio', 'years_illustration', 'years_games',
  'best_artwork', 'logo', 'ai', 'capsule', 'pay', 'availability'];
const REQUIRED_IF_CAPSULE = ['capsule_games', 'years_capsule', 'best_capsule'];
const URL_FIELDS = ['portfolio', 'best_artwork', 'best_capsule'];

// Source tracking. utm_source is the platform, utm_medium the kind of placement,
// utm_content the exact place (subreddit, server and channel, group, site), utm_term an
// optional extra detail, and utm_campaign the hiring round. The old ?src= tag still works.
const PLATFORM = {
  reddit: 'Reddit', discord: 'Discord', whatsapp: 'WhatsApp', telegram: 'Telegram',
  linkedin: 'LinkedIn', x: 'X', twitter: 'X', instagram: 'Instagram', facebook: 'Facebook',
  artstation: 'ArtStation', behance: 'Behance', cara: 'Cara', workwithindies: 'Work With Indies',
  jobboard: 'Job board', email: 'Email', college: 'College or placement cell', referral: 'Referral',
  event: 'Event', website: 'Other website', site: 'rivenza.in', direct: 'Direct',
};
const SOURCE_CHANNEL = {
  reddit: 'Reddit', discord: 'Discord and chat groups', whatsapp: 'Discord and chat groups',
  telegram: 'Discord and chat groups', facebook: 'Discord and chat groups', linkedin: 'Job board',
  workwithindies: 'Job board', jobboard: 'Job board', artstation: 'Job board', behance: 'Job board',
  college: 'Placement cell', referral: 'Referral', event: 'Event',
};
const slug = v => str(v).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
const nice = v => { const t = str(v).replace(/[_-]+/g, ' ').trim(); return t ? t.charAt(0).toUpperCase() + t.slice(1) : ''; };
function readTracking(fd) {
  const source = slug(fd.get('utm_source') || fd.get('src')) || 'direct';
  const t = {
    source,
    platform: PLATFORM[source] || nice(source),
    type: nice(slug(fd.get('utm_medium'))),
    place: str(fd.get('utm_content')).slice(0, 150),
    detail: str(fd.get('utm_term')).slice(0, 150),
    campaign: str(fd.get('utm_campaign')).slice(0, 100),
    referrer: str(fd.get('referrer')).slice(0, 300),
    landing: str(fd.get('landing')).slice(0, 500),
  };
  t.summary = [t.platform, t.place, t.detail, t.type].filter(Boolean).join(' / ');
  return t;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === ROUTE) {
      if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
      try {
        return await handleApplication(request, env);
      } catch (err) {
        console.error('application failed', err && err.stack || err);
        return json({ ok: false, error: 'Something went wrong on our side while saving your application.' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleApplication(request, env) {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('multipart/form-data')) return json({ ok: false, error: 'Unexpected request format.' }, 400);
  const fd = await request.formData();

  // Honeypot: real people never see this field, so anything in it is a bot. Pretend success.
  if (str(fd.get('website'))) return json({ ok: true });

  if (env.TURNSTILE_SECRET) {
    const passed = await turnstile(env.TURNSTILE_SECRET, str(fd.get('cf-turnstile-response')), request.headers.get('CF-Connecting-IP'));
    if (!passed) return json({ ok: false, error: 'The security check did not pass. Refresh the page and try again.' }, 400);
  }

  // Collect and clean answers.
  const a = {};
  for (const [key] of QUESTIONS) {
    const long = ['capsule_games', 'pay', 'anything', 'profiles'].includes(key);
    a[key] = str(fd.get(key)).slice(0, long ? LIMITS.long : LIMITS.short);
  }
  a.email = a.email.toLowerCase();
  const tr = readTracking(fd);
  const hasCapsule = a.capsule === 'Yes';
  if (!hasCapsule) { a.capsule_games = ''; a.years_capsule = ''; a.best_capsule = ''; }

  // Validate on the server too, since anyone can post to this endpoint.
  const missing = [...REQUIRED, ...(hasCapsule ? REQUIRED_IF_CAPSULE : [])].filter(k => !a[k]);
  if (missing.length) return json({ ok: false, error: 'Some required answers are missing.' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(a.email)) return json({ ok: false, error: 'That email address does not look right.' }, 400);
  for (const k of URL_FIELDS) {
    if (a[k] && !isHttpUrl(a[k])) return json({ ok: false, error: 'One of the links is not a valid web address.' }, 400);
  }

  const files = hasCapsule ? fd.getAll('capsule_files').filter(f => f && typeof f === 'object' && f.size > 0) : [];
  if (files.length > MAX_FILES) return json({ ok: false, error: 'Upload at most 5 files.' }, 400);
  for (const f of files) {
    if (!FILE_TYPES.includes(f.type)) return json({ ok: false, error: `${f.name} is not a PNG, JPG, WebP or PDF.` }, 400);
    if (f.size > MAX_BYTES) return json({ ok: false, error: `${f.name} is larger than 5 MB.` }, 400);
  }

  const at = airtable(env);
  const today = new Date().toISOString().slice(0, 10);
  const answers = `Applied through rivenza.in on ${today}\n\n` +
    QUESTIONS.filter(([k]) => a[k]).map(([k, label]) => `${label}\n${a[k]}`).join('\n\n') +
    `\n\nArrived from\n${tr.summary}`;

  // Fields filled from the application. Staff fields (Stage, scores, notes) are only set on first contact.
  const fields = {
    'Name': a.name,
    'Email': a.email,
    'Location': a.location,
    'Portfolio URL': a.portfolio,
    'Contact channel': 'Email',
    'Contact info': a.profiles ? `${a.email} | Other profiles: ${a.profiles.replace(/\s+/g, ' ')}` : a.email,
    'Years as illustrator': a.years_illustration,
    'Years in games': a.years_games,
    'Best artwork': a.best_artwork,
    'Logo and lettering evidence': ({ 'Yes, and my portfolio shows it': 'Yes', 'Yes, but it is not in my portfolio': 'Weak', 'No': 'No' })[a.logo],
    'AI use': a.ai === 'No, never' ? 'Confirmed none' : 'Uses',
    fld9q45fgkQVub945: a.pay, // Recent pay (by field ID so renaming the field never breaks the form)
    'Availability': a.availability,
  };
  if (hasCapsule) {
    fields['Steam games worked on'] = a.capsule_games;
    fields['Years in capsule art'] = a.years_capsule;
    fields['Best capsule piece'] = a.best_capsule;
  } else {
    fields['Steam capsule experience'] = 'None';
  }

  const sourceFields = {
    'Found via': `Application form: ${tr.summary}`,
    'Source channel': SOURCE_CHANNEL[tr.source] || 'Owned inbound',
    'Source platform': tr.platform,
    'Source type': tr.type || null,
    'Source place': tr.place,
    'Source detail': tr.detail,
    'Campaign': tr.campaign,
    'Referrer': tr.referrer,
    'Landing page': tr.landing,
  };

  // Create a new candidate, or update the existing row when this email has applied or been sourced before.
  const existing = await at.findByEmail(a.email);
  let recordId;
  if (existing) {
    const previous = existing.fields['Application answers'] ? `\n\n---- earlier ----\n\n${existing.fields['Application answers']}` : '';
    fields['Application answers'] = (answers + previous).slice(0, 90000);
    if (a.anything) fields['Notes'] = appendNote(existing.fields['Notes'], `Application (${today}): ${a.anything}`);
    fields['Last contact'] = today;
    if (!existing.fields['Source platform']) Object.assign(fields, sourceFields);
    recordId = (await at.update(existing.id, fields)).id;
  } else {
    fields['Application answers'] = answers;
    if (a.anything) fields['Notes'] = `Application (${today}): ${a.anything}`;
    Object.assign(fields, sourceFields);
    fields['Direction'] = 'Inbound';
    fields['Stage'] = 'New';
    fields['Date added'] = today;
    recordId = (await at.create(fields)).id;
  }

  // Attach uploads to the record. A failed upload never loses the application itself.
  const failed = [];
  for (const f of files) {
    try { await at.upload(recordId, 'Capsule work uploads', f); }
    catch (err) { console.error('upload failed', f.name, err); failed.push(f.name); }
  }
  if (failed.length) {
    await at.update(recordId, { 'Red flags': appendNote(existing && existing.fields['Red flags'], `Upload failed for: ${failed.join(', ')}. Ask the applicant to email these files.`) }).catch(() => {});
  }

  return json({ ok: true, updated: !!existing });
}

function airtable(env) {
  if (!env.AIRTABLE_TOKEN || !env.AIRTABLE_BASE_ID || !env.AIRTABLE_TABLE_ID) throw new Error('Airtable settings are missing on the worker.');
  const base = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}`;
  const headers = { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };
  const call = async (url, init) => {
    const res = await fetch(url, { ...init, headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
    return body;
  };
  return {
    async findByEmail(email) {
      const formula = `LOWER({Email}) = "${email.replace(/"/g, '')}"`;
      const q = new URLSearchParams({ filterByFormula: formula, maxRecords: '1' });
      ['Application answers', 'Notes', 'Red flags', 'Source platform'].forEach(f => q.append('fields[]', f));
      const out = await call(`${base}?${q}`, { method: 'GET' });
      return out.records && out.records[0];
    },
    create: (fields) => call(base, { method: 'POST', body: JSON.stringify({ fields, typecast: true }) }),
    update: (id, fields) => call(`${base}/${id}`, { method: 'PATCH', body: JSON.stringify({ fields, typecast: true }) }),
    async upload(recordId, fieldName, file) {
      const url = `https://content.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${recordId}/${encodeURIComponent(fieldName)}/uploadAttachment`;
      const body = { contentType: file.type, filename: file.name.slice(0, 200), file: toBase64(await file.arrayBuffer()) };
      return call(url, { method: 'POST', body: JSON.stringify(body) });
    },
  };
}

async function turnstile(secret, token, ip) {
  if (!token) return false;
  const body = new FormData();
  body.append('secret', secret); body.append('response', token);
  if (ip) body.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  const out = await res.json().catch(() => ({}));
  return !!out.success;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const str = v => (typeof v === 'string' ? v.trim() : '');
const isHttpUrl = v => { try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; } };
const appendNote = (old, line) => (old ? `${old}\n${line}` : line);
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
