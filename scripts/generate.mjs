// Renders the profile cards into metrics/<card>-{light,dark}.svg.
// Usage: GITHUB_TOKEN=... node scripts/generate.mjs   (or --mock for an offline preview)
import { mkdir, readFile, writeFile } from "node:fs/promises";

const CONFIG = {
  role: "Developer",
  tagline: ["I love simulators!!"],
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

  // Pull requests you opened, grouped by repo (search covers private repos the token can read).
  // Merged ones also carry their merge commit, so squash merges credited to someone else still count.
  const prs = new Map();
  const mergedPrs = new Map();
  let prTotal = 0;
  cursor = null;
  for (let page = 0; page < 10; page++) {
    const d = await gql(`query($q: String!, $cursor: String) {
      search(type: ISSUE, query: $q, first: 100, after: $cursor) {
        issueCount pageInfo { hasNextPage endCursor }
        nodes { ... on PullRequest { merged mergedAt additions deletions repository { nameWithOwner }
          mergeCommit { oid } commits { totalCount } } }
      } }`, { q: `is:pr author:${v.login}`, cursor });
    prTotal = d.search.issueCount;
    for (const n of d.search.nodes) {
      const k = n.repository?.nameWithOwner;
      if (!k) continue;
      prs.set(k, (prs.get(k) ?? 0) + 1);
      if (n.merged) mergedPrs.set(k, [...(mergedPrs.get(k) ?? []), n]);
    }
    if (!d.search.pageInfo.hasNextPage) break;
    cursor = d.search.pageInfo.endCursor;
  }

  // Your commits on each repo's default branch. In your own repos, commits you authored. In team
  // repos, also commits that list you as a co-author, since squash merges are often credited to
  // whoever pressed merge. Then merged PRs of yours whose merge commit wasn't credited to you.
  const me = v.login.toLowerCase();
  const stats = new Map();
  const failed = [];
  const noContents = [];
  const bulkSkipped = [];
  const teamCredit = [];
  await pool(candidates, 4, async (repo) => {
    const [owner, name] = repo.nameWithOwner.split("/");
    const team = owner.toLowerCase() !== me;
    let commits = 0, coAuthored = 0, viaPrs = 0, additions = 0, deletions = 0, bulk = 0, after = null;
    let lastActive = null; // your own latest commit or merged PR here, not just anyone's push
    const seen = (iso) => { if (iso && (!lastActive || iso > lastActive)) lastActive = iso; };
    const mine = new Set();
    const add = (a, dl) => {
      if (a > CONFIG.bulkCommitLines) bulk++;
      else { additions += a; deletions += dl; }
    };
    try {
      for (let page = 0; page < 75; page++) {
        const d = await gql(`query($owner: String!, $name: String!, $author: CommitAuthor, $after: String) {
          repository(owner: $owner, name: $name) { isEmpty defaultBranchRef { target { ... on Commit {
            history(first: 40, after: $after, author: $author) {
              totalCount pageInfo { hasNextPage endCursor }
              nodes { oid committedDate additions deletions author { user { login } } authors(first: 8) { nodes { user { login } } } }
            } } } } } }`, { owner, name, author: team ? null : { id: v.id }, after });
        const h = d.repository?.defaultBranchRef?.target?.history;
        if (!h) {
          // A non-empty repo without readable history means the token can list it but not read its contents.
          if (!d.repository?.isEmpty) noContents.push(repo.nameWithOwner);
          break;
        }
        for (const n of h.nodes) {
          const isAuthor = !team || n.author?.user?.login?.toLowerCase() === me;
          const isCo = !isAuthor && n.authors.nodes.some((a) => a.user?.login?.toLowerCase() === me);
          if (!isAuthor && !isCo) continue;
          commits++;
          if (isCo) coAuthored++;
          mine.add(n.oid);
          seen(n.committedDate);
          add(n.additions, n.deletions);
        }
        if (!h.pageInfo.hasNextPage) break;
        after = h.pageInfo.endCursor;
      }
    } catch (e) {
      failed.push(`${repo.nameWithOwner}: ${e.message.slice(0, 120)}`);
    }
    for (const pr of mergedPrs.get(repo.nameWithOwner) ?? []) {
      if (pr.mergeCommit && mine.has(pr.mergeCommit.oid)) continue; // already credited above
      viaPrs += pr.commits.totalCount;
      seen(pr.mergedAt);
      add(pr.additions, pr.deletions);
    }
    commits += viaPrs;
    if (team && (coAuthored || viaPrs)) teamCredit.push(`${repo.nameWithOwner}: ${commits - coAuthored - viaPrs} authored, ${coAuthored} co-authored, ${viaPrs} via merged PRs`);
    if (bulk) bulkSkipped.push(`${repo.nameWithOwner} (${bulk})`);
    if (commits) stats.set(repo.nameWithOwner, { commits, additions, deletions, lastActive });
  });

  const worked = candidates
    .filter((r) => stats.has(r.nameWithOwner))
    .map((r) => ({ ...r, ...stats.get(r.nameWithOwner), prs: prs.get(r.nameWithOwner) ?? 0 }));

  // Diagnosis for the Actions log: where private work went missing, if it did.
  const restricted = v.contributionsCollection.restrictedContributionsCount;
  console.log(`token sees ${repos.size} repos (${[...repos.values()].filter((r) => r.isPrivate).length} private); ` +
    `inspected ${candidates.length}, found your commits in ${worked.length}`);
  if (teamCredit.length) console.log(`team repos: ${teamCredit.join("; ")}`);
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
    lastActive: new Date(Date.now() - daysAgo * 864e5).toISOString(),
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
  // The profile repo (login/login) only holds these cards, so it isn't counted anywhere.
  const profile = `${raw.login}/${raw.login}`.toLowerCase();
  const repos = raw.repos
    .filter((r) => r.nameWithOwner.toLowerCase() !== profile)
    .map((r) => ({ ...r, hidden: hidden.has(r.nameWithOwner.toLowerCase()) }));
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
    biggest: [...repos].sort((a, b) => b.additions - a.additions).slice(0, CONFIG.listRepos),
    recent: [...repos].sort((a, b) => (b.lastActive ?? b.pushedAt).localeCompare(a.lastActive ?? a.pushedAt)).slice(0, CONFIG.listRepos),
    teams: teams(repos, raw.login),
    languages, days, streak, best, busiest,
    yearTotal: raw.calendar.totalContributions,
  };
}

// ---------- rendering ----------

// "Wrapped"-style colour blocking: every card is a saturated block with heavy type, sticker
// labels and a few playful shapes. Cards carry their own backgrounds, so one version works
// on both GitHub themes.
const C = {
  ink: "#16123A", white: "#ffffff", violet: "#5B2EFF", lilac: "#B9A4FF",
  lime: "#C8F560", pink: "#FF5DA2", cyan: "#3DD9F5", orange: "#FF8A3D", yellow: "#FFD93D",
};
const BARS = [C.lime, C.pink, C.cyan, C.orange, C.yellow, C.lilac];
const W = 1000, GAP = 20, RADIUS = 32, PAD = 40;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (n) => Math.round(n).toLocaleString("en-US");
const compact = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
const ago = (iso) => {
  const d = Math.floor((Date.now() - new Date(iso)) / 864e5);
  return d < 1 ? "today" : d === 1 ? "yesterday" : d < 30 ? `${d}d ago` : d < 365 ? `${Math.floor(d / 30)}mo ago` : `${Math.floor(d / 365)}y ago`;
};
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const plural = (n, one, many = one + "s") => `${num(n)} ${n === 1 ? one : many}`;
const textWidth = (s, size, weight = 400) => s.length * size * (weight >= 800 ? 0.6 : weight >= 600 ? 0.55 : 0.5); // Inter, roughly

function text(x, y, s, { size = 14, fill = C.ink, weight = 400, anchor = "start", track = 0, opacity = 1 } = {}) {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"` +
    (track ? ` letter-spacing="${track}"` : "") + (opacity < 1 ? ` fill-opacity="${opacity}"` : "") + `>${esc(s)}</text>`;
}
const title = (x, y, s, fill = C.ink) => text(x, y, s, { size: 40, weight: 900, fill, track: -1.4 });

/** A rounded sticker label; `rotate` tilts it around its own centre. */
function pill(x, y, label, { bg, fg, size = 14, rotate = 0, anchor = "start" } = {}) {
  const w = textWidth(label, size, 800) + size * 1.6, h = size + size * 1.1;
  const x0 = anchor === "end" ? x - w : x;
  const cx = x0 + w / 2, cy = y + h / 2;
  return `<g transform="rotate(${rotate} ${cx.toFixed(1)} ${cy.toFixed(1)})">` +
    `<rect x="${x0.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(h / 2).toFixed(1)}" fill="${bg}"/>` +
    text(cx.toFixed(1), (cy + size * 0.36).toFixed(1), label, { size, weight: 800, fill: fg, anchor: "middle" }) + `</g>`;
}

function starburst(cx, cy, r, points, fill, cls = "") {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const a = (Math.PI * i) / points, rr = i % 2 ? r * 0.55 : r;
    pts.push(`${(cx + rr * Math.sin(a)).toFixed(1)},${(cy - rr * Math.cos(a)).toFixed(1)}`);
  }
  return `<g class="${cls}" style="transform-origin:${cx}px ${cy}px"><polygon points="${pts.join(" ")}" fill="${fill}"/></g>`;
}

const assets = {};
async function loadAssets() {
  assets.font = (await readFile(new URL("assets/inter-var.woff2", ROOT))).toString("base64");
}

/** A rounded colour block at (x, y); `body` uses block-local coordinates and is clipped to it. */
function tile(id, x, y, w, h, fill, body) {
  return `<clipPath id="c-${id}"><rect width="${w}" height="${h}" rx="${RADIUS}"/></clipPath>` +
    `<g transform="translate(${x} ${y})"><rect width="${w}" height="${h}" rx="${RADIUS}" fill="${fill}"/>` +
    `<g clip-path="url(#c-${id})">${body}</g></g>`;
}

function svg(h, label, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(label)}">
<style>
@font-face{font-family:"Inter Embedded";src:url(data:font/woff2;base64,${assets.font}) format("woff2");font-weight:100 900;font-display:swap}
text{font-family:"Inter Embedded",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-feature-settings:"tnum" 1}
.spin{animation:spin 24s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
</style>
${body}
</svg>`;
}

function heroCard(d) {
  const h = 420;
  let b = `<circle cx="905" cy="40" r="190" fill="${C.lime}"/>` +
    `<circle cx="1010" cy="345" r="135" fill="${C.pink}"/>` +
    `<circle cx="560" cy="430" r="70" fill="none" stroke="${C.yellow}" stroke-width="18"/>` +
    starburst(820, 214, 48, 12, C.white, "spin");
  b += pill(PAD, 44, CONFIG.role, { bg: C.lime, fg: C.ink, size: 15 });
  const [first, ...rest] = d.name.split(" ");
  b += text(PAD - 4, 176, first, { size: 100, weight: 900, fill: C.white, track: -4.5 });
  b += text(PAD - 4, 272, (rest.join(" ") || "") + ".", { size: 100, weight: 900, fill: C.white, track: -4.5 });
  CONFIG.tagline.forEach((line, i) => (b += text(PAD, 322 + i * 28, line, { size: 20, weight: 600, fill: C.white, opacity: 0.85 })));
  b += pill(600, 262, `${compact(d.additions)} lines`, { bg: C.yellow, fg: C.ink, size: 22, rotate: -8 });
  b += pill(640, 92, `${plural(d.privateCount, "private repo")}`, { bg: C.white, fg: C.ink, size: 18, rotate: 6 });
  return svg(h + GAP, `${d.name}, ${CONFIG.role}`, tile("hero", 0, 0, W, h, C.violet, b));
}

function statsCard(d) {
  const h = 210, w = (W - 3 * GAP) / 4;
  const items = [
    [C.lime, "LINES WRITTEN", compact(d.additions), "imports not counted"],
    [C.pink, "COMMITS", num(d.commits), "all time"],
    [C.cyan, "PULL REQUESTS", num(d.prTotal), "opened"],
    [C.orange, "REPOSITORIES", num(d.repoCount), `${num(d.privateCount)} private`],
  ];
  let b = "";
  items.forEach(([bg, label, v, sub], i) => {
    b += tile(`s${i}`, i * (w + GAP), 0, w, h, bg,
      text(28, 46, label, { size: 13, weight: 800, track: 1.2 }) +
      text(24, 140, v, { size: Math.min(76, Math.floor((w - 48) / (v.length * 0.6))), weight: 900, track: -3 }) +
      text(28, 178, sub, { size: 14, weight: 600, opacity: 0.7 }));
  });
  return svg(h + GAP, "Totals", b);
}

function biggestCard(d) {
  const rows = d.biggest.slice(0, 6), rowH = 62, top = 124, h = top + rows.length * rowH + 20;
  const x0 = 380, x1 = W - PAD - 70, max = Math.max(...rows.map((r) => r.additions), 1);
  let b = title(PAD, 84, "Biggest contributions", C.white) +
    pill(W - PAD, 56, "by lines written", { bg: C.lilac, fg: C.ink, size: 14, anchor: "end" });
  rows.forEach((r, i) => {
    const y = top + i * rowH, color = BARS[i % BARS.length];
    const bw = Math.max(18, (r.additions / max) * (x1 - x0));
    const meta = [r.primaryLanguage?.name, r.isPrivate ? "private" : null, plural(r.commits, "commit")].filter(Boolean).join(" · ");
    b += text(PAD, y + 31, String(i + 1).padStart(2, "0"), { size: 16, weight: 800, fill: color }) +
      text(PAD + 42, y + 25, clip(r.hidden ? "Private project" : r.name, 24), { size: 20, weight: 800, fill: C.white, track: -0.4 }) +
      text(PAD + 42, y + 45, meta, { size: 13, weight: 500, fill: C.white, opacity: 0.6 }) +
      `<rect x="${x0}" y="${y + 9}" width="${bw.toFixed(1)}" height="34" rx="17" fill="${color}"/>` +
      text(x0 + bw + 12, y + 32, compact(r.additions), { size: 18, weight: 800, fill: C.white });
  });
  return svg(h + GAP, "Biggest contributions", tile("big", 0, 0, W, h, C.ink, b));
}

function midCard(d) {
  const h = 420, w = (W - GAP) / 2;
  // Lately: where your latest commits and merged PRs landed.
  let a = title(PAD, 84, "Lately") + text(PAD, 112, "Where my latest work landed.", { size: 15, weight: 600, opacity: 0.7 });
  d.recent.slice(0, 5).forEach((r, i) => {
    const y = 140 + i * 54;
    a += text(PAD, y + 22, clip(r.hidden ? "Private project" : r.name, 22), { size: 20, weight: 800, track: -0.4 }) +
      text(PAD, y + 41, [r.primaryLanguage?.name, r.isPrivate ? "private" : null].filter(Boolean).join(" · "), { size: 13, weight: 500, opacity: 0.65 }) +
      pill(w - PAD, y + 6, ago(r.lastActive ?? r.pushedAt), { bg: C.ink, fg: C.lime, size: 13, anchor: "end" });
  });
  let b = tile("recent", 0, 0, w, h, C.lime, a);

  // Top languages as a big numbered chart list.
  const langs = d.languages.filter((l) => l.name !== "Other").slice(0, 5);
  let c = title(PAD, 84, "Top languages");
  langs.forEach((l, i) => {
    const y = 150 + i * 54;
    c += text(PAD, y, String(i + 1), { size: 40, weight: 900, track: -1 }) +
      text(PAD + 48, y - 4, clip(l.name, 16), { size: 26, weight: 800, track: -0.6 }) +
      text(w - PAD, y - 4, `${Math.round(l.pct * 100)}%`, { size: 22, weight: 800, anchor: "end" });
  });
  b += tile("langs", w + GAP, 0, w, h, C.pink, c);
  return svg(h + GAP, "Lately and top languages", b);
}

function bottomCard(d) {
  const h = 380, w = (W - GAP) / 2;
  // This year: the headline count over chunky weekly bars.
  const weeks = [];
  for (let i = 0; i < d.days.length; i += 7) weeks.push(d.days.slice(i, i + 7).reduce((s, x) => s + x.contributionCount, 0));
  const max = Math.max(...weeks, 1), span = w - 2 * PAD, bw = span / weeks.length, base = 296;
  let a = text(PAD - 4, 128, num(d.yearTotal), { size: 96, weight: 900, track: -4 }) +
    text(PAD, 162, "contributions this year", { size: 18, weight: 700 });
  weeks.forEach((v, i) => {
    const bh = Math.max(4, (v / max) * 100);
    a += `<rect x="${(PAD + i * bw + 1).toFixed(1)}" y="${(base - bh).toFixed(1)}" width="${(bw - 2.5).toFixed(1)}" height="${bh.toFixed(1)}" rx="2.5" fill="${C.ink}" fill-opacity="${v ? 1 : 0.2}"/>`;
  });
  const streak = `${num(d.streak)}-day streak`;
  a += pill(PAD, 318, streak, { bg: C.ink, fg: C.cyan, size: 14 }) +
    pill(PAD + textWidth(streak, 14, 800) + 34, 318, `best ${plural(d.best, "day")}`, { bg: C.white, fg: C.ink, size: 14 });
  let b = tile("year", 0, 0, w, h, C.cyan, a);

  // Teams: organisations and other people's repos you've shipped to.
  const shown = d.teams.slice(0, 4);
  let c = starburst(w - 70, h - 60, 92, 14, C.ink, "spin") + title(PAD, 84, "Teams");
  if (!shown.length) c += text(PAD, 130, "Solo so far.", { size: 20, weight: 700 });
  shown.forEach((g, i) => {
    const y = 120 + i * 58;
    c += text(PAD, y + 24, clip(g.owner, 20), { size: 24, weight: 800, track: -0.6 }) +
      text(PAD, y + 45, `${plural(g.commits, "commit")} · ${compact(g.additions)} lines · ${plural(g.repos, "repo")}`, { size: 14, weight: 600, opacity: 0.7 });
  });
  if (d.teams.length > 4) c += pill(PAD, h - 58, `+${d.teams.length - 4} more`, { bg: C.ink, fg: C.orange, size: 13 });
  b += tile("teams", w + GAP, 0, w, h, C.orange, c);
  return svg(h + GAP, "This year and teams", b);
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
const cards = { hero: heroCard, stats: statsCard, biggest: biggestCard, mid: midCard, bottom: bottomCard };
for (const [name, render] of Object.entries(cards)) await writeFile(new URL(`metrics/${name}.svg`, ROOT), render(d));
console.log(`${d.login}: ${d.repoCount} repos (${d.privateCount} private), ${d.commits} commits, ${d.additions} lines added, ${d.prTotal} PRs`);
