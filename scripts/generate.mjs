// Renders the profile cards into metrics/<card>-{light,dark}.svg.
// Usage: GITHUB_TOKEN=... node scripts/generate.mjs   (or --mock for an offline preview)
import { mkdir, readFile, writeFile } from "node:fs/promises";

const CONFIG = {
  role: "Flight Simulation Engineer",
  tagline: ["Avionics, flight models and the tooling", "that keeps virtual aircraft in the air."],
  maxRepos: 150, // most recently pushed repos to inspect for your commits
  bulkCommitLines: 10_000, // a single commit adding more than this is an import or generated code, not written lines
  listRepos: 8,
  hide: [], // "owner/name" entries that must never appear by name
  ignoredLangs: "html css scss tex less dockerfile makefile qmake lex cmake shell gnuplot batchfile powershell".split(" "),
};

const ROOT = new URL("../", import.meta.url);
const API = "https://api.github.com";

// ---------- data ----------

const rawToken = process.env.GITHUB_TOKEN ?? "";
const token = rawToken.trim(); // pasted secrets often carry a trailing newline
const headers = {
  Authorization: `bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

async function gql(query, variables = {}) {
  // GitHub answers heavy queries with a 502/504 HTML page now and then; back off and retry those.
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}/graphql`, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
    const body = await res.text();
    if (res.status >= 500 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      continue;
    }
    let json;
    try { json = JSON.parse(body); } catch { throw new Error(`HTTP ${res.status}: ${body.slice(0, 80)}`); }
    if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json));
    return json.data;
  }
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

const REPO_FIELDS = `nameWithOwner name isPrivate isFork pushedAt owner { login __typename }
  primaryLanguage { name color }
  languages(first: 10, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name color } } }`;

async function fetchData() {
  const base = await gql(`{
    viewer {
      id login name createdAt followers { totalCount }
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

  // Your commits on each repo's default branch, matched to your account (all linked emails),
  // with per-commit line counts. Unlike /stats/contributors this isn't a lazily built cache.
  const stats = new Map();
  const failed = [];
  const noContents = [];
  const bulkSkipped = [];
  await pool(candidates, 4, async (repo) => {
    const [owner, name] = repo.nameWithOwner.split("/");
    let commits = 0, additions = 0, deletions = 0, bulk = 0, after = null;
    try {
      for (let page = 0; page < 75; page++) {
        const d = await gql(`query($owner: String!, $name: String!, $author: ID!, $after: String) {
          repository(owner: $owner, name: $name) { isEmpty defaultBranchRef { target { ... on Commit {
            history(first: 40, after: $after, author: {id: $author}) {
              totalCount pageInfo { hasNextPage endCursor } nodes { additions deletions }
            } } } } } }`, { owner, name, author: v.id, after });
        const h = d.repository?.defaultBranchRef?.target?.history;
        if (!h) {
          // A non-empty repo without readable history means the token can list it but not read its contents.
          if (!d.repository?.isEmpty) noContents.push(repo.nameWithOwner);
          break;
        }
        commits = h.totalCount;
        for (const n of h.nodes) {
          if (n.additions > CONFIG.bulkCommitLines) { bulk++; continue; }
          additions += n.additions; deletions += n.deletions;
        }
        if (!h.pageInfo.hasNextPage) break;
        after = h.pageInfo.endCursor;
      }
    } catch (e) {
      failed.push(`${repo.nameWithOwner}: ${e.message.slice(0, 120)}`);
    }
    if (bulk) bulkSkipped.push(`${repo.nameWithOwner} (${bulk})`);
    if (commits) stats.set(repo.nameWithOwner, { commits, additions, deletions });
  });

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
  console.log(`counted: ${[...worked].sort((a, b) => b.commits - a.commits).map((r) => `${r.nameWithOwner} (${r.commits})`).join(", ")}`);
  console.log(`commits this year by repo: ${yearly.map((c) => `${c.repository.nameWithOwner} (${c.contributions.totalCount})`).join(", ") || "none"}`);
  if (restricted) console.warn(`::warning::${restricted} contributions this year are in repos this token cannot read. ` +
    "Give the token the `repo` scope and authorize it for your organisation's SSO (Settings > Developer settings > Tokens > Configure SSO).");
  if (noContents.length) console.warn(`::warning::The token can see but not read the commits of ${noContents.length} repos ` +
    `(${noContents.join(", ")}). Use a classic token with the \`repo\` scope (fine-grained tokens need Contents: Read, ` +
    "and can't reach repos owned by other users at all).");
  if (bulkSkipped.length) console.log(`left out of line counts as bulk imports (>${CONFIG.bulkCommitLines} lines in one commit): ${bulkSkipped.join(", ")}`);
  if (failed.length) console.warn(`::warning::Could not read commit history for ${failed.length} repos: ${failed.join("; ")}`);

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
    owner: { login: nameWithOwner.split("/")[0], __typename: nameWithOwner.startsWith("SgtDevRupesh/") ? "User" : "Organization" },
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
      repo("SFL-Devs/sensor-sim", true, ["C++", "Python"], 388, 61_903, 34, 6),
      repo("SgtDevRupesh/dcs-hud-overlay", false, ["Lua"], 233, 21_448, 9, 9),
      repo("Airplane-Team/dcs-bridge", true, ["TypeScript"], 197, 44_017, 28, 12),
      repo("SgtDevRupesh/trim-solver", false, ["Python", "Rust"], 96, 8_812, 4, 30),
      repo("SgtDevRupesh/dotfiles", false, ["Lua"], 41, 1_210, 0, 50),
    ],
  };
}

// Work grouped by the organisations (or other people's accounts) that own the repos.
function teams(repos, login) {
  const by = new Map();
  for (const r of repos) {
    const owner = r.owner?.login ?? r.nameWithOwner.split("/")[0];
    if (owner.toLowerCase() === login.toLowerCase()) continue;
    const g = by.get(owner) ?? { owner, isOrg: r.owner?.__typename !== "User", repos: 0, commits: 0, additions: 0 };
    g.repos++; g.commits += r.commits; g.additions += r.additions;
    by.set(owner, g);
  }
  return [...by.values()].sort((a, b) => b.commits - a.commits);
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
    teams: teams(repos, raw.login),
    languages, days, streak, best, busiest,
    yearTotal: raw.calendar.totalContributions,
  };
}

// ---------- rendering ----------

// Apple Store look: soft rounded tiles, two-tone headlines, one warm accent for eyebrows,
// and gradient colour used sparingly for the numbers that matter.
const THEMES = {
  light: {
    fg: "#1d1d1f", fg2: "#6e6e73", tile: "#f5f5f7", line: "rgba(0,0,0,.08)", eyebrow: "#bf4800",
    rings: ["#ff2d55", "#34c759", "#007aff"], spark: "#0071e3", pill: "rgba(0,0,0,.06)",
    grad: ["#0066cc", "#8a3ffc"], aurora: [["#5ac8fa", 0.55], ["#af52de", 0.4], ["#ff9f0a", 0.3]],
  },
  dark: {
    fg: "#f5f5f7", fg2: "#86868b", tile: "#1d1d1f", line: "rgba(255,255,255,.1)", eyebrow: "#f56300",
    rings: ["#ff375f", "#30d158", "#0a84ff"], spark: "#2997ff", pill: "rgba(255,255,255,.12)",
    grad: ["#2997ff", "#bf5af2"], aurora: [["#0a84ff", 0.5], ["#bf5af2", 0.42], ["#ff9f0a", 0.22]],
  },
};
const W = 1000, GAP = 20, RADIUS = 28, PAD = 36;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (n) => Math.round(n).toLocaleString("en-US");
const compact = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
const ago = (iso) => {
  const d = Math.floor((Date.now() - new Date(iso)) / 864e5);
  return d < 1 ? "today" : d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : d < 365 ? `${Math.floor(d / 30)} mo ago` : `${Math.floor(d / 365)} yr ago`;
};
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const plural = (n, word) => `${num(n)} ${word}${n === 1 ? "" : "s"}`;
const textWidth = (s, size, weight = 400) => s.length * size * (weight >= 600 ? 0.5 : 0.48); // Inter, roughly

function text(x, y, s, { size = 14, fill, weight = 400, anchor = "start", track = 0 } = {}) {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"` +
    (track ? ` letter-spacing="${track}"` : "") + `>${esc(s)}</text>`;
}
const eyebrow = (x, y, s, t) => text(x, y, s, { size: 15, weight: 600, fill: t.eyebrow });
const headline = (x, y, s, t) => text(x - 1, y, s, { size: 32, weight: 600, fill: t.fg, track: -0.8 });

const assets = {};
async function loadAssets() {
  assets.font = (await readFile(new URL("assets/inter-var.woff2", ROOT))).toString("base64");
}

/** A rounded tile at (x, y); `body` uses tile-local coordinates and is clipped to the tile. */
function tile(id, x, y, w, h, t, body) {
  return `<clipPath id="c-${id}"><rect width="${w}" height="${h}" rx="${RADIUS}"/></clipPath>` +
    `<g transform="translate(${x} ${y})"><rect width="${w}" height="${h}" rx="${RADIUS}" fill="${t.tile}"/>` +
    `<g clip-path="url(#c-${id})">${body}</g></g>`;
}

function svg(h, t, label, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(label)}">
<defs>
<linearGradient id="num" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.grad[0]}"/><stop offset="1" stop-color="${t.grad[1]}"/></linearGradient>
<filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="58"/></filter>
</defs>
<style>
@font-face{font-family:"Inter Embedded";src:url(data:font/woff2;base64,${assets.font}) format("woff2");font-weight:100 900;font-display:swap}
text{font-family:"Inter Embedded",-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Helvetica,Arial,sans-serif;font-feature-settings:"tnum" 1}
.drift{animation:drift 14s ease-in-out infinite alternate}
@keyframes drift{from{transform:translate(0,0)}to{transform:translate(-24px,14px)}}
@media (prefers-reduced-motion:reduce){.drift{animation:none}}
</style>
${body}
</svg>`;
}

function heroCard(d, t) {
  const h = 360;
  // A soft aurora of colour on the right, the way Apple's product pages glow.
  const [c1, c2, c3] = t.aurora;
  let b = `<g filter="url(#soft)"><g class="drift">` +
    `<circle cx="790" cy="110" r="170" fill="${c1[0]}" fill-opacity="${c1[1]}"/>` +
    `<circle cx="900" cy="280" r="160" fill="${c2[0]}" fill-opacity="${c2[1]}"/>` +
    `<circle cx="670" cy="300" r="120" fill="${c3[0]}" fill-opacity="${c3[1]}"/></g></g>`;
  b += eyebrow(PAD + 8, 78, CONFIG.role, t);
  b += text(PAD + 5, 150, `${d.name}.`, { size: 64, weight: 600, fill: t.fg, track: -1.9 });
  CONFIG.tagline.forEach((line, i) => (b += text(PAD + 8, 200 + i * 32, line, { size: 24, weight: 600, fill: t.fg2, track: -0.5 })));
  const updated = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  b += text(PAD + 8, h - PAD - 4, `Updated ${updated}`, { size: 14, fill: t.fg2 });
  return svg(h + GAP, t, `${d.name}: ${CONFIG.role}`, tile("hero", 0, 0, W, h, t, b));
}

function statsCard(d, t) {
  const h = 300, big = 580;
  let a = text(PAD, 58, "Lines of code written", { size: 17, weight: 600, fill: t.fg2 });
  a += text(PAD - 6, 190, compact(d.additions), { size: 128, weight: 600, fill: "url(#num)", track: -5 });
  a += text(PAD, 232, `Across ${num(d.repoCount)} ${d.repoCount === 1 ? "repository" : "repositories"}, public and private.`, { size: 17, fill: t.fg2 });
  a += text(PAD, 256, "Bulk imports and generated files not counted.", { size: 15, fill: t.fg2 });
  let b = tile("lines", 0, 0, big, h, t, a);

  const small = [["Commits", d.commits], ["Pull requests", d.prTotal], ["Repositories", d.repoCount], ["Private", d.privateCount]];
  const sw = (W - big - 2 * GAP) / 2, sh = (h - GAP) / 2;
  small.forEach(([label, v], i) => {
    const x = big + GAP + (i % 2) * (sw + GAP), y = Math.floor(i / 2) * (sh + GAP);
    b += tile(`s${i}`, x, y, sw, sh, t,
      text(24, 42, label, { size: 15, weight: 600, fill: t.fg2 }) + text(22, 108, num(v), { size: 48, weight: 600, fill: t.fg, track: -1.6 }));
  });
  return svg(h + GAP, t, "Engineering totals", b);
}

function ringArc(cx, cy, r, frac) {
  const f = Math.min(Math.max(frac, 0.02), 0.9999), a = f * 2 * Math.PI;
  const x = (cx + r * Math.sin(a)).toFixed(2), y = (cy - r * Math.cos(a)).toFixed(2);
  return `M${cx} ${cy - r}A${r} ${r} 0 ${f > 0.5 ? 1 : 0} 1 ${x} ${y}`;
}

/** Smooth line through points (Catmull-Rom converted to cubic Béziers). */
function smooth(pts) {
  let p = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, p1, p2, p3] = [pts[i - 1] ?? pts[i], pts[i], pts[i + 1], pts[i + 2] ?? pts[i + 1]];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    p += `C${c1.map((v) => v.toFixed(1)).join(" ")} ${c2.map((v) => v.toFixed(1)).join(" ")} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return p;
}

function craftCard(d, t) {
  const h = 380, w = (W - GAP) / 2;

  // Languages as activity rings: one ring per top language, filled to its share.
  const named = d.languages.filter((l) => l.name !== "Other");
  const top = named.slice(0, 3);
  let a = eyebrow(PAD, 54, "Languages", t) + headline(PAD, 94, `Mostly ${top[0]?.name ?? "code"}.`, t);
  const cx = 138, cy = 248, sw = 20;
  top.forEach((l, i) => {
    const r = 94 - i * (sw + 4), c = t.rings[i];
    a += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c}" stroke-opacity=".16" stroke-width="${sw}"/>` +
      `<path d="${ringArc(cx, cy, r, l.pct)}" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round"/>`;
  });
  top.forEach((l, i) => {
    const y = 182 + i * 50;
    a += text(272, y, l.name, { size: 15, weight: 600, fill: t.fg2 }) +
      text(271, y + 26, `${(l.pct * 100).toFixed(0)}%`, { size: 26, weight: 600, fill: t.rings[i], track: -0.5 });
  });
  const rest = named.slice(3).map((l) => l.name);
  if (rest.length) a += text(272, 182 + top.length * 50 + 4, clip(`Also ${rest.join(", ")}.`, 24), { size: 14, fill: t.fg2 });
  let b = tile("langs", 0, 0, w, h, t, a);

  // The year as a smooth weekly line, Health-app style.
  const weeks = [];
  for (let i = 0; i < d.days.length; i += 7) weeks.push(d.days.slice(i, i + 7).reduce((s, x) => s + x.contributionCount, 0));
  const max = Math.max(...weeks, 1), x0 = PAD, x1 = w - PAD, y0 = 136, y1 = 280;
  const pts = weeks.map((v, i) => [x0 + (i / (weeks.length - 1)) * (x1 - x0), y1 - (v / max) * (y1 - y0)]);
  const line = smooth(pts);
  let c = eyebrow(PAD, 54, "This year", t) + headline(PAD, 94, `${num(d.yearTotal)} contributions.`, t);
  c += `<linearGradient id="spark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.spark}" stop-opacity=".28"/><stop offset="1" stop-color="${t.spark}" stop-opacity="0"/></linearGradient>` +
    `<path d="${line}L${x1} ${y1}L${x0} ${y1}Z" fill="url(#spark)"/>` +
    `<path d="${line}" fill="none" stroke="${t.spark}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<line x1="${x0}" y1="${y1 + 0.5}" x2="${x1}" y2="${y1 + 0.5}" stroke="${t.line}"/>`;
  const busy = new Date(d.busiest.date + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  [[plural(d.streak, "day"), "Current streak"], [plural(d.best, "day"), "Longest streak"], [String(d.busiest.contributionCount), `Busiest day, ${busy}`]]
    .forEach(([v, label], i) => {
      const x = PAD + i * 140;
      c += text(x, 322, v, { size: 20, weight: 600, fill: t.fg, track: -0.3 }) + text(x, 344, label, { size: 13, fill: t.fg2 });
    });
  b += tile("year", w + GAP, 0, w, h, t, c);
  return svg(h + GAP, t, "Languages and activity", b);
}

function reposCard(d, t) {
  const rows = d.top.slice(0, 6), rowH = 58, lw = 620, h = 140 + rows.length * rowH + 16;
  const colC = 468, colL = lw - PAD;
  let a = eyebrow(PAD, 54, "Repositories", t) + headline(PAD, 94, "Where the work happens.", t);
  a += text(colC, 130, "Commits", { size: 13, weight: 600, fill: t.fg2, anchor: "end" }) +
    text(colL, 130, "Lines", { size: 13, weight: 600, fill: t.fg2, anchor: "end" });
  rows.forEach((r, i) => {
    const y = 140 + i * rowH, name = clip(r.hidden ? "Private project" : r.name, 24);
    a += `<line x1="${PAD}" y1="${y}" x2="${colL}" y2="${y}" stroke="${t.line}"/>`;
    a += text(PAD, y + 26, name, { size: 17, weight: 600, fill: t.fg, track: -0.2 });
    if (r.isPrivate) {
      const px = PAD + textWidth(name, 17, 600) + 10;
      a += `<rect x="${px.toFixed(0)}" y="${y + 12}" width="52" height="19" rx="9.5" fill="${t.pill}"/>` +
        text(px + 26, y + 25.5, "Private", { size: 11, weight: 600, fill: t.fg2, anchor: "middle" });
    }
    a += text(PAD, y + 46, [r.primaryLanguage?.name, ago(r.pushedAt)].filter(Boolean).join(" · "), { size: 13, fill: t.fg2 });
    a += text(colC, y + 36, num(r.commits), { size: 17, weight: 600, fill: t.fg, anchor: "end" }) +
      text(colL, y + 36, compact(r.additions), { size: 17, fill: t.fg2, anchor: "end" });
  });
  let b = tile("repos", 0, 0, lw, h, t, a);

  // The most active project gets the product shot.
  const star = rows.find((r) => !r.hidden) ?? rows[0];
  const pw = W - lw - GAP;
  let p = eyebrow(PAD, 54, "Most active", t);
  if (star) {
    p += text(PAD - 1, 92, clip(star.name, 19), { size: 28, weight: 600, fill: t.fg, track: -0.7 }) +
      text(PAD, 120, [plural(star.commits, "commit"), star.primaryLanguage?.name, star.isPrivate ? "Private" : null].filter(Boolean).join(" · "), { size: 15, fill: t.fg2 });
  }
  if (star) {
    // Ring: this repo's share of all your commits.
    const share = star.commits / Math.max(1, d.commits), cx = pw / 2, cy = h - 168, r = 96;
    p += `<linearGradient id="ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.grad[0]}"/><stop offset="1" stop-color="${t.grad[1]}"/></linearGradient>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${t.pill}" stroke-width="22"/>` +
      `<path d="${ringArc(cx, cy, r, share)}" fill="none" stroke="url(#ring)" stroke-width="22" stroke-linecap="round"/>` +
      text(cx, cy + 8, `${Math.round(share * 100)}%`, { size: 40, weight: 600, fill: t.fg, anchor: "middle", track: -1 }) +
      text(cx, cy + 32, "of all my commits", { size: 13, fill: t.fg2, anchor: "middle" });
  }
  b += tile("star", lw + GAP, 0, pw, h, t, p);
  return svg(h + GAP, t, "Repositories I work on", b);
}

function teamsCard(d, t) {
  const shown = d.teams.slice(0, 3);
  if (!shown.length) return svg(1, t, "Teams", "");
  const h = 176, w = (W - GAP * (shown.length - 1)) / shown.length;
  let b = "";
  shown.forEach((g, i) => {
    const more = i === shown.length - 1 && d.teams.length > 3 ? ` · +${d.teams.length - 3} more teams` : "";
    b += tile(`team${i}`, i * (w + GAP), 0, w, h, t,
      eyebrow(PAD, 52, g.isOrg ? "Organisation" : "Collaboration", t) +
      text(PAD - 1, 92, clip(g.owner, Math.floor((w - PAD * 2) / 15)), { size: 28, weight: 600, fill: t.fg, track: -0.7 }) +
      text(PAD, 124, `${plural(g.commits, "commit")} · ${compact(g.additions)} lines`, { size: 15, fill: t.fg2 }) +
      text(PAD, 146, `${num(g.repos)} ${g.repos === 1 ? "repository" : "repositories"}${more}`, { size: 15, fill: t.fg2 }));
  });
  return svg(h + GAP, t, "Teams I contribute to", b);
}

// ---------- main ----------

const mock = process.argv.includes("--mock");
if (!mock && !token) {
  console.log("::error::GHUB_TOKEN is empty here. Check the secret exists (repo secrets, or the 'production' environment).");
  process.exit(1);
}
if (!mock) {
  // Describe the token without revealing it, then check GitHub accepts it.
  const kind = token.startsWith("ghp_") ? "classic (ghp_)" : token.startsWith("github_pat_") ? "fine-grained (github_pat_)" : `unrecognised prefix "${token.slice(0, 3)}…"`;
  console.log(`token: ${kind}, ${token.length} chars, ${rawToken === token ? "no" : "had"} surrounding whitespace`);
  const me = await fetch(`${API}/user`, { headers });
  if (me.status === 401) {
    console.log(`::error::GitHub rejected GHUB_TOKEN (401 Bad credentials). It is ${kind}, ${token.length} chars ` +
      "(a classic token is 40). It's revoked, expired, or not the value you meant to paste. " +
      "If a GHUB_TOKEN exists under Settings > Environments > production, that one is used, not the repo secret.");
    process.exit(1);
  }
  console.log(`token accepted for ${(await me.json()).login}; scopes: ${me.headers.get("x-oauth-scopes") || "(fine-grained, no scope list)"}`);
}
await loadAssets();
const d = digest(mock ? mockData() : await fetchData());
await mkdir(new URL("metrics/", ROOT), { recursive: true });
const cards = { hero: heroCard, stats: statsCard, craft: craftCard, repos: reposCard, teams: teamsCard };
for (const [name, render] of Object.entries(cards))
  for (const [theme, t] of Object.entries(THEMES))
    await writeFile(new URL(`metrics/${name}-${theme}.svg`, ROOT), render(d, t));
console.log(`${d.login}: ${d.repoCount} repos (${d.privateCount} private), ${d.commits} commits, ${d.additions} lines added, ${d.prTotal} PRs`);
