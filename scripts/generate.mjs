// Renders the profile cards into metrics/<card>-{light,dark}.svg.
// Usage: GITHUB_TOKEN=... node scripts/generate.mjs   (or --mock for an offline preview)
import { mkdir, readFile, writeFile } from "node:fs/promises";

const CONFIG = {
  role: "Flight Simulation Engineer",
  tagline: ["Avionics, flight models and the tooling", "that keeps virtual aircraft in the air."],
  maxRepos: 150, // most recently pushed repos to inspect for your commits
  listRepos: 8,
  hide: [], // "owner/name" entries that must never appear by name
  ignoredLangs: "html css scss tex less dockerfile makefile qmake lex cmake shell gnuplot batchfile powershell".split(" "),
};

const ROOT = new URL("../", import.meta.url);
const API = "https://api.github.com";

// ---------- data ----------

const token = process.env.GITHUB_TOKEN;
const headers = {
  Authorization: `bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

async function gql(query, variables = {}) {
  const res = await fetch(`${API}/graphql`, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json));
  return json.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

const REPO_FIELDS = `nameWithOwner name isPrivate isFork pushedAt
  primaryLanguage { name color }
  languages(first: 10, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name color } } }`;

async function fetchData() {
  const base = await gql(`{
    viewer {
      login name createdAt followers { totalCount }
      contributionsCollection {
        restrictedContributionsCount
        commitContributionsByRepository(maxRepositories: 100) {
          contributions { totalCount } repository { ${REPO_FIELDS} }
        }
        contributionCalendar { totalContributions weeks { contributionDays { date contributionCount weekday } } }
      }
      repositoriesContributedTo(first: 100, includeUserRepositories: false,
        contributionTypes: [COMMIT, PULL_REQUEST], orderBy: {field: PUSHED_AT, direction: DESC}) {
        nodes { ${REPO_FIELDS} }
      }
    }
  }`);
  const v = base.viewer;

  // Every repo you own, collaborate on, or can see through an org, newest first.
  const repos = new Map();
  let cursor = null;
  do {
    const page = await gql(`query($cursor: String) { viewer {
      repositories(first: 100, after: $cursor, ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
        orderBy: {field: PUSHED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor } nodes { ${REPO_FIELDS} }
      } } }`, { cursor });
    const r = page.viewer.repositories;
    for (const n of r.nodes) if (!n.isFork) repos.set(n.nameWithOwner, n);
    cursor = r.pageInfo.hasNextPage && repos.size < CONFIG.maxRepos ? r.pageInfo.endCursor : null;
  } while (cursor);
  for (const n of v.repositoriesContributedTo.nodes) if (!n.isFork) repos.set(n.nameWithOwner, n);
  // Repos your commits landed in this year, including private org repos, if the token can read them.
  const yearly = v.contributionsCollection.commitContributionsByRepository;
  for (const { repository: n } of yearly) if (!n.isFork) repos.set(n.nameWithOwner, n);
  const yearlyNames = new Set(yearly.map((c) => c.repository.nameWithOwner));
  const candidates = [...repos.values()]
    .sort((a, b) => yearlyNames.has(b.nameWithOwner) - yearlyNames.has(a.nameWithOwner) || new Date(b.pushedAt) - new Date(a.pushedAt))
    .slice(0, CONFIG.maxRepos);

  // Per-repo commits and line counts for you. GitHub answers 202 while it computes these; retry those.
  const me = v.login.toLowerCase();
  const stats = new Map();
  let pending = candidates;
  for (let round = 0; round < 10 && pending.length; round++) {
    if (round) await sleep(Math.min(5000 * round, 20000)); // ~2.5 min in total
    const retry = [];
    await pool(pending, 8, async (repo) => {
      const res = await fetch(`${API}/repos/${repo.nameWithOwner}/stats/contributors`, { headers });
      if (res.status === 202) return retry.push(repo);
      if (res.status !== 200) return;
      const all = await res.json();
      const mine = all.find((c) => c.author?.login?.toLowerCase() === me);
      if (!mine) return;
      const sum = (weeks, k) => weeks.reduce((s, w) => s + w[k], 0);
      const added = sum(mine.weeks, "a");
      stats.set(repo.nameWithOwner, {
        commits: mine.total,
        additions: added,
        deletions: sum(mine.weeks, "d"),
      });
    });
    pending = retry;
  }
  const stillPending = pending;

  // Pull requests you authored, grouped by repo (search covers private repos the token can read).
  const prs = new Map();
  let prTotal = 0;
  cursor = null;
  for (let page = 0; page < 10; page++) {
    const d = await gql(`query($q: String!, $cursor: String) {
      search(type: ISSUE, query: $q, first: 100, after: $cursor) {
        issueCount pageInfo { hasNextPage endCursor }
        nodes { ... on PullRequest { repository { nameWithOwner } } }
      } }`, { q: `is:pr author:${v.login}`, cursor });
    prTotal = d.search.issueCount;
    for (const n of d.search.nodes) {
      const k = n.repository?.nameWithOwner;
      if (k) prs.set(k, (prs.get(k) ?? 0) + 1);
    }
    if (!d.search.pageInfo.hasNextPage) break;
    cursor = d.search.pageInfo.endCursor;
  }

  const worked = candidates
    .filter((r) => stats.has(r.nameWithOwner))
    .map((r) => ({ ...r, ...stats.get(r.nameWithOwner), prs: prs.get(r.nameWithOwner) ?? 0 }));

  // Diagnosis for the Actions log: where private work went missing, if it did.
  const restricted = v.contributionsCollection.restrictedContributionsCount;
  console.log(`token sees ${repos.size} repos (${[...repos.values()].filter((r) => r.isPrivate).length} private); ` +
    `inspected ${candidates.length}, found your commits in ${worked.length}`);
  console.log(`commits this year by repo: ${yearly.map((c) => `${c.repository.nameWithOwner} (${c.contributions.totalCount})`).join(", ") || "none"}`);
  if (restricted) console.warn(`::warning::${restricted} contributions this year are in repos this token cannot read. ` +
    "Give the token the `repo` scope and authorize it for your organisation's SSO (Settings > Developer settings > Tokens > Configure SSO).");
  if (stillPending.length) console.warn(`::warning::GitHub was still computing stats for ${stillPending.length} repos ` +
    `(${stillPending.map((r) => r.nameWithOwner).join(", ")}); they'll appear on the next run.`);
  const noMatch = yearly.filter((c) => !stats.has(c.repository.nameWithOwner) && !stillPending.includes(repos.get(c.repository.nameWithOwner)));
  if (noMatch.length) console.warn(`::warning::No commits attributed to ${v.login} in: ${noMatch.map((c) => c.repository.nameWithOwner).join(", ")}. ` +
    "If you commit there with another email, add it to your GitHub account (Settings > Emails).");

  return {
    login: v.login,
    name: v.name ?? v.login,
    prTotal,
    calendar: v.contributionsCollection.contributionCalendar,
    repos: worked,
  };
}

function mockData() {
  const days = [];
  const start = Date.now() - 370 * 864e5;
  for (let i = 0; i < 371; i++) {
    const d = new Date(start + i * 864e5);
    const busy = Math.sin(i / 19) * 0.6 + Math.random() * 1.4 - (d.getUTCDay() % 6 === 0 ? 0.6 : 0);
    days.push({ date: d.toISOString().slice(0, 10), weekday: d.getUTCDay(), contributionCount: busy > 0.5 ? Math.round(busy * 5 + Math.random() * 4) : 0 });
  }
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push({ contributionDays: days.slice(i, i + 7) });
  const L = { "C++": "#f34b7d", C: "#555555", Lua: "#000080", Python: "#3572A5", Rust: "#dea584", TypeScript: "#3178c6", "C#": "#178600" };
  const repo = (nameWithOwner, isPrivate, langs, commits, additions, prs, daysAgo) => ({
    nameWithOwner, name: nameWithOwner.split("/")[1], isPrivate, isFork: false,
    pushedAt: new Date(Date.now() - daysAgo * 864e5).toISOString(),
    primaryLanguage: { name: langs[0], color: L[langs[0]] },
    languages: { edges: langs.map((l, i) => ({ size: 1e6 / (i + 1), node: { name: l, color: L[l] } })) },
    commits, additions, deletions: Math.round(additions * 0.38), prs,
  });
  return {
    login: "SgtDevRupesh", name: "Rupesh Prasad", prTotal: 412,
    calendar: { totalContributions: 2140, weeks },
    repos: [
      repo("acme/flight-model-core", true, ["C++", "C"], 1284, 412_880, 143, 0),
      repo("acme/mission-server", true, ["C#", "Python"], 862, 198_402, 97, 1),
      repo("acme/avionics-mfd", true, ["C++", "Lua"], 641, 154_210, 61, 2),
      repo("SgtDevRupesh/F16-Flight-Control-Law", false, ["C++"], 412, 88_120, 22, 4),
      repo("acme/sensor-sim", true, ["C++", "Python"], 388, 61_903, 34, 6),
      repo("SgtDevRupesh/dcs-hud-overlay", false, ["Lua"], 233, 21_448, 9, 9),
      repo("acme/ops-dashboard", true, ["TypeScript"], 197, 44_017, 28, 12),
      repo("SgtDevRupesh/trim-solver", false, ["Python", "Rust"], 96, 8_812, 4, 30),
      repo("SgtDevRupesh/dotfiles", false, ["Lua"], 41, 1_210, 0, 50),
    ],
  };
}

function digest(raw) {
  const hidden = new Set(CONFIG.hide.map((s) => s.toLowerCase()));
  const repos = raw.repos.map((r) => ({ ...r, hidden: hidden.has(r.nameWithOwner.toLowerCase()) }));
  const sum = (k) => repos.reduce((s, r) => s + r[k], 0);

  // Language mix: each repo's language split, weighted by the lines you added there.
  const ignored = new Set(CONFIG.ignoredLangs);
  const langs = new Map();
  for (const r of repos) {
    const edges = r.languages.edges.filter((e) => !ignored.has(e.node.name.toLowerCase()));
    const total = edges.reduce((s, e) => s + e.size, 0) || 1;
    for (const { size, node } of edges) {
      const cur = langs.get(node.name) ?? { name: node.name, color: node.color ?? "#8e8e93", w: 0 };
      cur.w += (size / total) * r.additions;
      langs.set(node.name, cur);
    }
  }
  const lw = [...langs.values()].reduce((s, l) => s + l.w, 0) || 1;
  let languages = [...langs.values()].sort((a, b) => b.w - a.w).map((l) => ({ ...l, pct: l.w / lw }));
  if (languages.length > 6) {
    const rest = languages.slice(5).reduce((s, l) => s + l.pct, 0);
    languages = [...languages.slice(0, 5), { name: "Other", color: "#8e8e93", pct: rest }];
  }

  const days = raw.calendar.weeks.flatMap((w) => w.contributionDays).slice(-364);
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].contributionCount > 0) streak++;
    else if (i !== days.length - 1) break; // today may still be empty
  }
  let best = 0, run = 0;
  for (const d of days) best = Math.max(best, (run = d.contributionCount > 0 ? run + 1 : 0));
  const busiest = days.reduce((a, b) => (b.contributionCount > a.contributionCount ? b : a), days[0]);

  return {
    ...raw,
    commits: sum("commits"),
    additions: sum("additions"),
    repoCount: repos.length,
    privateCount: repos.filter((r) => r.isPrivate).length,
    top: [...repos].sort((a, b) => b.commits - a.commits).slice(0, CONFIG.listRepos),
    languages, days, streak, best, busiest,
    yearTotal: raw.calendar.totalContributions,
  };
}

// ---------- rendering ----------

const THEMES = {
  light: { fg: "#1d1d1f", fg2: "#6e6e73", fg3: "#86868b", line: "rgba(0,0,0,.1)", accent: "#0071e3", well: "rgba(0,0,0,.06)", grad: ["#1d1d1f", "#48484a"] },
  dark: { dark: true, fg: "#f5f5f7", fg2: "#a1a1a6", fg3: "#6e6e73", line: "rgba(255,255,255,.14)", accent: "#2997ff", well: "rgba(255,255,255,.08)", grad: ["#ffffff", "#98989d"] },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (n) => Math.round(n).toLocaleString("en-US");
const compact = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
const ago = (iso) => {
  const d = Math.floor((Date.now() - new Date(iso)) / 864e5);
  return d < 1 ? "today" : d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : d < 365 ? `${Math.floor(d / 30)} mo ago` : `${Math.floor(d / 365)} yr ago`;
};
// Language colours like Lua's navy disappear on a dark page; lift them toward white until readable.
function legible(hex, t) {
  if (!t.dark || !/^#[0-9a-f]{6}$/i.test(hex ?? "")) return hex ?? t.fg3;
  let [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lum = () => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  while (lum() < 0.35) [r, g, b] = [r, g, b].map((c) => Math.round(c + (255 - c) * 0.15));
  return "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function text(x, y, s, { size = 14, fill, weight = 400, anchor = "start", track = 0 } = {}) {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"` +
    (track ? ` letter-spacing="${track}"` : "") + `>${esc(s)}</text>`;
}

function jpegSize(buf) {
  for (let i = 2; i < buf.length; ) {
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error("not a jpeg");
}

const assets = {};
async function loadAssets() {
  assets.font = (await readFile(new URL("assets/inter-var.woff2", ROOT))).toString("base64");
  for (const name of ["f16", "patriot", "harm"]) {
    const rgb = await readFile(new URL(`assets/${name}_rgb.jpg`, ROOT));
    const mask = await readFile(new URL(`assets/${name}_mask.jpg`, ROOT));
    assets[name] = { ...jpegSize(rgb), rgb: rgb.toString("base64"), mask: mask.toString("base64") };
  }
}

const photoHeight = (name, w) => Math.round((assets[name].h / assets[name].w) * w);

/** A cut-out photo: JPEG colour masked by a JPEG luminance mask (far smaller than an RGBA PNG). */
function photo(name, x, y, w, cls, erode = 1) {
  const a = assets[name], h = photoHeight(name, w);
  // Erode + feather trims the 1-2px fringe of original background that cut-outs leave behind.
  return `<filter id="e-${name}"><feMorphology operator="erode" radius="${erode}"/><feGaussianBlur stdDeviation=".7"/></filter>` +
    `<mask id="m-${name}" maskUnits="userSpaceOnUse" x="${x}" y="${y}" width="${w}" height="${h}">` +
    `<image href="data:image/jpeg;base64,${a.mask}" x="${x}" y="${y}" width="${w}" height="${h}" filter="url(#e-${name})"/></mask>` +
    `<g class="${cls}"><image href="data:image/jpeg;base64,${a.rgb}" x="${x}" y="${y}" width="${w}" height="${h}" mask="url(#m-${name})"/></g>`;
}

function svg(w, h, t, label, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">
<defs><linearGradient id="hg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.grad[0]}"/><stop offset="1" stop-color="${t.grad[1]}"/></linearGradient></defs>
<style>
@font-face{font-family:"Inter Embedded";src:url(data:font/woff2;base64,${assets.font}) format("woff2");font-weight:100 900;font-display:swap}
text{font-family:"Inter Embedded",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-feature-settings:"tnum" 1}
.float{animation:float 7s ease-in-out infinite alternate}
.float-slow{animation:float 9s ease-in-out infinite alternate}
@keyframes float{from{transform:translateY(0)}to{transform:translateY(-8px)}}
@media (prefers-reduced-motion:reduce){.float,.float-slow{animation:none}}
</style>
${body}
</svg>`;
}

function eyebrow(x, y, s, t) {
  return text(x, y, s.toUpperCase(), { size: 13, weight: 600, fill: t.accent, track: 1.6 });
}

function heroCard(d, t) {
  const W = 1000, jetW = 600, jetH = photoHeight("f16", jetW);
  let b = photo("f16", W - jetW, 20, jetW, "float");
  b += eyebrow(0, 60, CONFIG.role, t);
  const [first, ...rest] = d.name.split(" ");
  b += text(-3, 132, first, { size: 72, weight: 700, fill: "url(#hg)", track: -2.2 });
  if (rest.length) b += text(-3, 206, rest.join(" ") + ".", { size: 72, weight: 700, fill: "url(#hg)", track: -2.2 });
  CONFIG.tagline.forEach((line, i) => (b += text(0, 256 + i * 28, line, { size: 20, fill: t.fg2, track: -0.2 })));

  const y = Math.max(360, 20 + jetH - 30);
  b += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${t.line}"/>`;
  const stats = [
    [compact(d.additions), "lines of code written"],
    [num(d.commits), "commits"],
    [num(d.prTotal), d.prTotal === 1 ? "pull request" : "pull requests"],
    [num(d.repoCount), `repositories · ${d.privateCount} private`],
  ];
  stats.forEach(([v, label], i) => {
    b += text(i * 250, y + 72, v, { size: 46, weight: 700, fill: t.fg, track: -1.4 }) +
      text(i * 250, y + 100, label, { size: 15, fill: t.fg2 });
  });
  const updated = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  b += text(0, y + 140, `All-time totals across public and private repositories · Updated ${updated}`, { size: 12, fill: t.fg3 });
  return svg(W, y + 150, t, `${d.name}: engineering summary`, b);
}

function reposCard(d, t) {
  const W = 1000, x0 = 430, rowH = 54, headY = 150;
  const H = Math.max(headY + 30 + d.top.length * rowH + 10, 480);
  const samW = 420, samH = photoHeight("patriot", samW);
  let b = photo("patriot", -20, Math.max(10, H - samH - 10), samW, "float-slow", 1.4);
  b += eyebrow(x0, 40, "Repositories", t);
  b += text(x0 - 2, 88, "Where the work happens.", { size: 38, weight: 700, fill: t.fg, track: -1.1 });
  b += text(x0, 120, `${d.repoCount} repositories with my commits, ${d.privateCount} of them private.`, { size: 16, fill: t.fg2 });

  const cols = [[780, "Commits"], [890, "Lines +"], [W, "PRs"]];
  b += text(x0, headY + 16, "PROJECT", { size: 11, weight: 600, fill: t.fg3, track: 1 });
  for (const [x, label] of cols) b += text(x, headY + 16, label.toUpperCase(), { size: 11, weight: 600, fill: t.fg3, track: 1, anchor: "end" });
  d.top.forEach((r, i) => {
    const y = headY + 30 + i * rowH;
    b += `<line x1="${x0}" y1="${y}" x2="${W}" y2="${y}" stroke="${t.line}"/>`;
    const meta = [r.primaryLanguage?.name, r.isPrivate ? "Private" : null, ago(r.pushedAt)].filter(Boolean).join("  ·  ");
    b += text(x0, y + 24, clip(r.hidden ? "Private project" : r.name, 30), { size: 17, weight: 600, fill: t.fg, track: -0.2 });
    if (r.primaryLanguage) b += `<circle cx="${x0 + 4}" cy="${y + 40.5}" r="4" fill="${legible(r.primaryLanguage.color, t)}"/>`;
    b += text(x0 + (r.primaryLanguage ? 14 : 0), y + 45, meta, { size: 13, fill: t.fg2 });
    b += text(780, y + 33, num(r.commits), { size: 17, weight: 600, fill: t.fg, anchor: "end" });
    b += text(890, y + 33, compact(r.additions), { size: 17, weight: 500, fill: t.fg2, anchor: "end" });
    b += text(W, y + 33, num(r.prs), { size: 17, weight: 500, fill: t.fg2, anchor: "end" });
  });
  return svg(W, H, t, "Repositories I work on", b);
}

function craftCard(d, t) {
  const W = 1000, x0 = 520, barW = W - x0;
  const harmW = 480, harmH = photoHeight("harm", harmW);
  let b = photo("harm", -20, 30, harmW, "float");
  b += eyebrow(x0, 40, "Languages", t);
  b += text(x0 - 2, 88, "What I write in.", { size: 38, weight: 700, fill: t.fg, track: -1.1 });
  b += text(x0, 120, "Weighted by the lines I added, in every repository.", { size: 16, fill: t.fg2 });

  // Segmented bar, then a two-column legend.
  let x = x0;
  b += `<clipPath id="bar"><rect x="${x0}" y="150" width="${barW}" height="10" rx="5"/></clipPath><g clip-path="url(#bar)">`;
  d.languages.forEach((l, i) => {
    const w = Math.max(2, l.pct * barW - (i < d.languages.length - 1 ? 3 : 0));
    b += `<rect x="${x.toFixed(1)}" y="150" width="${w.toFixed(1)}" height="10" fill="${legible(l.color, t)}"/>`;
    x += l.pct * barW;
  });
  b += `</g>`;
  d.languages.forEach((l, i) => {
    const lx = x0 + (i % 2) * (barW / 2), ly = 196 + Math.floor(i / 2) * 34;
    b += `<circle cx="${lx + 5}" cy="${ly - 5}" r="5" fill="${legible(l.color, t)}"/>` +
      text(lx + 18, ly, l.name, { size: 15, weight: 500, fill: t.fg }) +
      text(lx + barW / 2 - 24, ly, `${(l.pct * 100).toFixed(1)}%`, { size: 15, fill: t.fg2, anchor: "end" });
  });

  // Last 12 months: headline numbers over a quiet dot calendar.
  const y = Math.max(320, 30 + harmH + 10);
  b += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${t.line}"/>`;
  b += eyebrow(0, y + 36, "Last 12 months", t);
  const busy = new Date(d.busiest.date + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const stats = [[num(d.yearTotal), "contributions"], [`${d.streak}d`, "current streak"], [`${d.best}d`, "longest streak"], [String(d.busiest.contributionCount), `busiest day · ${busy}`]];
  stats.forEach(([v, label], i) => {
    b += text(i * 250, y + 86, v, { size: 36, weight: 700, fill: t.fg, track: -1 }) + text(i * 250, y + 110, label, { size: 14, fill: t.fg2 });
  });

  const top = y + 136, cell = W / 53, r = cell * 0.32;
  const max = Math.max(...d.days.map((x) => x.contributionCount), 1);
  d.days.forEach((day, i) => {
    const k = i + d.days[0].weekday, cx = Math.floor(k / 7) * cell + cell / 2, cy = top + (k % 7) * cell + cell / 2;
    if (cx > W) return;
    const n = day.contributionCount;
    b += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${n ? t.accent : t.well}"` +
      (n ? ` fill-opacity="${(0.25 + 0.75 * Math.sqrt(n / max)).toFixed(2)}"` : "") + "/>";
  });
  return svg(W, top + 7 * cell + 4, t, "Languages and activity", b);
}

// ---------- main ----------

const mock = process.argv.includes("--mock");
if (!mock && !token) throw new Error("Set GITHUB_TOKEN or pass --mock");
await loadAssets();
const d = digest(mock ? mockData() : await fetchData());
await mkdir(new URL("metrics/", ROOT), { recursive: true });
const cards = { hero: heroCard, repos: reposCard, craft: craftCard };
for (const [name, render] of Object.entries(cards))
  for (const [theme, t] of Object.entries(THEMES))
    await writeFile(new URL(`metrics/${name}-${theme}.svg`, ROOT), render(d, t));
console.log(`${d.login}: ${d.repoCount} repos (${d.privateCount} private), ${d.commits} commits, ${d.additions} lines added, ${d.prTotal} PRs`);
