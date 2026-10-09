// Renders cockpit-MFD style GitHub metrics cards into metrics/*.svg.
// Usage: GITHUB_TOKEN=... node scripts/generate.mjs   (or --mock for offline preview)
import { mkdir, writeFile } from "node:fs/promises";

const OUT = new URL("../metrics/", import.meta.url);
const IGNORED_LANGS = new Set(
  "html css tex less dockerfile makefile qmake lex cmake shell gnuplot".split(" ")
);
const SIM_KEYWORDS =
  /flight|sim|avionic|cockpit|aircraft|aero|hud|mfd|dcs|x-?plane|msfs|prepar3d|p3d|falcon|bms|f-?\d{2}|jet|pilot|autopilot|fcs|atc|radar/i;

const C = {
  green: "#3dff8a",
  dim: "#1f7a46",
  faint: "#0f3a22",
  cyan: "#4fd8ff",
  amber: "#ffb000",
  magenta: "#ff4fd8",
  screen: "#020a06",
};
const FONT = `'JetBrains Mono','SF Mono',Menlo,Monaco,'Cascadia Code',Consolas,'DejaVu Sans Mono','Liberation Mono',monospace`;

// ---------- data ----------

const QUERY = `query {
  viewer {
    login name createdAt
    followers { totalCount }
    repositories(ownerAffiliations: OWNER, first: 100, orderBy: {field: PUSHED_AT, direction: DESC}) {
      totalCount
      nodes {
        name description isPrivate isFork stargazerCount forkCount pushedAt
        primaryLanguage { name color }
        repositoryTopics(first: 10) { nodes { topic { name } } }
        languages(first: 10, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name color } } }
      }
    }
    contributionsCollection {
      totalCommitContributions totalPullRequestContributions totalIssueContributions
      totalPullRequestReviewContributions restrictedContributionsCount
      contributionCalendar { totalContributions weeks { contributionDays { date contributionCount weekday } } }
    }
  }
}`;

async function fetchData(token) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: QUERY }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json));
  return json.data.viewer;
}

function mockData() {
  const days = [];
  const start = Date.now() - 370 * 864e5;
  for (let i = 0; i < 371; i++) {
    const d = new Date(start + i * 864e5);
    const busy = Math.sin(i / 23) + Math.random() * 1.6;
    days.push({
      date: d.toISOString().slice(0, 10),
      weekday: d.getUTCDay(),
      contributionCount: busy > 0.7 ? Math.round(busy * 6 * Math.random() + 1) : 0,
    });
  }
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push({ contributionDays: days.slice(i, i + 7) });
  const repo = (name, lang, color, stars, daysAgo, description = "", priv = false) => ({
    name, description, isPrivate: priv, isFork: false, stargazerCount: stars, forkCount: Math.floor(stars / 5),
    pushedAt: new Date(Date.now() - daysAgo * 864e5).toISOString(),
    primaryLanguage: { name: lang, color },
    repositoryTopics: { nodes: [] },
    languages: { edges: [{ size: stars * 9000 + 40000, node: { name: lang, color } }] },
  });
  return {
    login: "SgtDevRupesh", name: "Rupesh Prasad", createdAt: "2019-06-14T00:00:00Z",
    followers: { totalCount: 87 },
    repositories: {
      totalCount: 34,
      nodes: [
        repo("F16-Flight-Control-Law", "C++", "#f34b7d", 128, 1, "Fly-by-wire FLCS model"),
        repo("dcs-hud-overlay", "Lua", "#000080", 64, 3, "DCS World HUD export"),
        repo("xplane-avionics-kit", "C", "#555555", 41, 6, "X-Plane plugin avionics"),
        repo("msfs-wasm-gauges", "Rust", "#dea584", 22, 11, "MSFS WASM gauge toolkit"),
        repo("secret-project", "C++", "#f34b7d", 0, 0, "", true),
        repo("atc-voice-bridge", "Python", "#3572A5", 17, 15, "ATC speech bridge"),
        repo("dotfiles", "Shell", "#89e051", 3, 20),
        repo("trim-solver", "Python", "#3572A5", 9, 30, "Aircraft trim solver"),
        repo("ts-telemetry-dash", "TypeScript", "#3178c6", 12, 40, "Sim telemetry dashboard"),
      ],
    },
    contributionsCollection: {
      totalCommitContributions: 1284, totalPullRequestContributions: 212, totalIssueContributions: 48,
      totalPullRequestReviewContributions: 95, restrictedContributionsCount: 310,
      contributionCalendar: { totalContributions: 1640, weeks },
    },
  };
}

function digest(v) {
  const repos = v.repositories.nodes.filter((r) => !r.isFork);
  const isSim = (r) =>
    SIM_KEYWORDS.test(
      [r.name, r.description ?? "", ...r.repositoryTopics.nodes.map((t) => t.topic.name)].join(" ")
    );

  // Languages: aggregate bytes across all owned repos (private included, names never shown).
  const langs = new Map();
  for (const r of repos)
    for (const { size, node } of r.languages.edges) {
      if (IGNORED_LANGS.has(node.name.toLowerCase())) continue;
      const cur = langs.get(node.name) ?? { name: node.name, color: node.color ?? C.green, size: 0 };
      cur.size += size;
      langs.set(node.name, cur);
    }
  const langTotal = [...langs.values()].reduce((s, l) => s + l.size, 0) || 1;
  const languages = [...langs.values()]
    .sort((a, b) => b.size - a.size)
    .slice(0, 6)
    .map((l) => ({ ...l, pct: l.size / langTotal }));

  const days = v.contributionsCollection.contributionCalendar.weeks.flatMap((w) => w.contributionDays);
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].contributionCount > 0) streak++;
    else if (i !== days.length - 1) break; // today may still be empty
  }
  let best = 0, run = 0;
  for (const d of days) best = Math.max(best, (run = d.contributionCount > 0 ? run + 1 : 0));
  const peak = days.reduce((a, b) => (b.contributionCount > a.contributionCount ? b : a), days[0]);

  const pub = repos.filter((r) => !r.isPrivate);
  const stores = [...pub]
    .sort((a, b) => isSim(b) - isSim(a) || b.stargazerCount - a.stargazerCount)
    .slice(0, 6)
    .map((r) => ({ ...r, sim: isSim(r) }));
  const sorties = pub.slice(0, 6); // already ordered by PUSHED_AT

  const cc = v.contributionsCollection;
  return {
    login: v.login,
    name: v.name ?? v.login,
    createdAt: new Date(v.createdAt),
    followers: v.followers.totalCount,
    repoCount: v.repositories.totalCount,
    stars: repos.reduce((s, r) => s + r.stargazerCount, 0),
    simRepos: repos.filter(isSim).length,
    commits: cc.totalCommitContributions + cc.restrictedContributionsCount,
    prs: cc.totalPullRequestContributions,
    reviews: cc.totalPullRequestReviewContributions,
    issues: cc.totalIssueContributions,
    total: cc.contributionCalendar.totalContributions,
    days: days.slice(-364),
    streak, best, peak,
    languages, stores, sorties,
  };
}

// ---------- svg helpers ----------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (n) => n.toLocaleString("en-US");
const fix = (n) => +n.toFixed(2);
const polar = (cx, cy, r, deg) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [fix(cx + r * Math.cos(a)), fix(cy + r * Math.sin(a))];
};
const arc = (cx, cy, r, from, to) => {
  const [x1, y1] = polar(cx, cy, r, from);
  const [x2, y2] = polar(cx, cy, r, to);
  return `M${x1} ${y1}A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
};
const ago = (iso) => {
  const h = (Date.now() - new Date(iso)) / 36e5;
  if (h < 1) return "NOW";
  if (h < 24) return `${Math.floor(h)}H`;
  if (h < 24 * 60) return `${Math.floor(h / 24)}D`;
  return `${Math.floor(h / 24 / 30)}MO`;
};
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const t = (x, y, s, { size = 12, fill = C.green, anchor = "start", weight = 500, cls = "", extra = "" } = {}) =>
  `<text x="${fix(x)}" y="${fix(y)}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-weight="${weight}"${cls ? ` class="${cls}"` : ""}${extra}>${esc(s)}</text>`;

/** Wraps content in a glass-cockpit MFD bezel. Screen origin is (P, P). */
const P = 26;
function mfd(w, h, id, osbTop, osbBottom, active, body, css = "") {
  const sw = w - P * 2, sh = h - P * 2;
  // Option-select buttons on the bezel, with their legends just inside the screen edge.
  const osbX = (labels, i) => P + (sw / labels.length) * (i + 0.5);
  const buttons = (labels, y) =>
    labels.map((_, i) => `<rect x="${fix(osbX(labels, i) - 14)}" y="${y}" width="28" height="10" rx="2" fill="url(#btn)" stroke="#000" stroke-opacity=".6"/>`).join("");
  const legends = (labels, y) =>
    labels
      .map((label, i) => {
        if (!label) return "";
        const x = osbX(labels, i), on = label === active;
        return (on ? `<rect x="${fix(x - 18)}" y="${y - 9}" width="36" height="12" fill="${C.green}" rx="1"/>` : "") +
          t(x, y, label, { size: 9, anchor: "middle", fill: on ? C.screen : C.dim, weight: 700 });
      })
      .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}" role="img" aria-label="${esc(id)}">
<defs>
  <linearGradient id="bezel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a4048"/><stop offset=".08" stop-color="#22272d"/><stop offset=".92" stop-color="#171a1f"/><stop offset="1" stop-color="#0c0e11"/></linearGradient>
  <linearGradient id="btn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a5058"/><stop offset="1" stop-color="#1c2025"/></linearGradient>
  <radialGradient id="glow" cx=".5" cy=".45" r=".75"><stop offset="0" stop-color="#0a2a18"/><stop offset="1" stop-color="${C.screen}"/></radialGradient>
  <pattern id="scan" width="4" height="3" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="#000" fill-opacity=".35"/></pattern>
  <filter id="bloom" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <clipPath id="screen"><rect x="${P}" y="${P}" width="${sw}" height="${sh}" rx="6"/></clipPath>
</defs>
<style>
  .blink{animation:blink 1.2s steps(2,start) infinite}
  @keyframes blink{to{visibility:hidden}}
  ${css}
</style>
<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="16" fill="url(#bezel)" stroke="#000"/>
<rect x="5" y="5" width="${w - 10}" height="${h - 10}" rx="13" fill="none" stroke="#fff" stroke-opacity=".06"/>
${[[10, 10], [w - 14, 10], [10, h - 14], [w - 14, h - 14]].map(([x, y]) => `<circle cx="${x + 2}" cy="${y + 2}" r="2.2" fill="#0c0e11" stroke="#555b63" stroke-width=".8"/>`).join("")}
<rect x="${P - 3}" y="${P - 3}" width="${sw + 6}" height="${sh + 6}" rx="8" fill="#000"/>
<rect x="${P}" y="${P}" width="${sw}" height="${sh}" rx="6" fill="url(#glow)"/>
<g clip-path="url(#screen)">
  <g filter="url(#bloom)">${body}${legends(osbTop, P + 14)}${legends(osbBottom, h - P - 6)}</g>
  <rect x="${P}" y="${P}" width="${sw}" height="${sh}" fill="url(#scan)" pointer-events="none"/>
</g>
${buttons(osbTop, 8)}${buttons(osbBottom, h - 18)}
</svg>`;
}

// ---------- cards ----------

function statusCard(d) {
  const w = 860, h = 230;
  const x0 = P + 16, y0 = P + 34;
  const now = new Date();
  const svcMonths = (now.getFullYear() - d.createdAt.getFullYear()) * 12 + now.getMonth() - d.createdAt.getMonth();
  const hdg = Math.round((now - new Date(now.getFullYear(), 0, 1)) / 864e5 / 365 * 360) % 360;

  // Heading tape across the top of the screen.
  const tapeCx = w / 2, tapeW = 300;
  let tape = "";
  for (let deg = hdg - 40; deg <= hdg + 40; deg += 5) {
    const x = tapeCx + ((deg - hdg) / 40) * (tapeW / 2);
    const major = ((deg % 10) + 10) % 10 === 0;
    tape += `<line x1="${fix(x)}" y1="${P + 22}" x2="${fix(x)}" y2="${P + 22 + (major ? 8 : 4)}" stroke="${C.green}" stroke-width="1"/>`;
    if (((deg % 30) + 30) % 30 === 0)
      tape += t(x, P + 42, String((((deg % 360) + 360) % 360) / 10).padStart(2, "0"), { size: 9, anchor: "middle", fill: C.dim });
  }
  tape += `<rect x="${tapeCx - 18}" y="${P + 6}" width="36" height="14" fill="${C.screen}" stroke="${C.green}"/>` +
    t(tapeCx, P + 17, String(hdg).padStart(3, "0"), { size: 11, anchor: "middle", weight: 700 }) +
    `<path d="M${tapeCx - 4} ${P + 20}L${tapeCx} ${P + 25}L${tapeCx + 4} ${P + 20}" fill="${C.green}"/>`;

  const id =
    t(x0, y0 + 10, "CALLSIGN", { size: 9, fill: C.dim, weight: 700 }) +
    t(x0, y0 + 36, d.login.toUpperCase(), { size: 26, weight: 800 }) +
    `<rect x="${x0 + d.login.length * 16 + 6}" y="${y0 + 16}" width="10" height="22" fill="${C.green}" class="blink"/>` +
    t(x0, y0 + 56, `${d.name.toUpperCase()} · FLIGHT SIM DEV`, { size: 11, fill: C.cyan }) +
    t(x0, y0 + 82, "IN SERVICE", { size: 9, fill: C.dim, weight: 700 }) +
    t(x0 + 78, y0 + 82, `${Math.floor(svcMonths / 12)}Y ${svcMonths % 12}M`, { size: 11 }) +
    t(x0 + 150, y0 + 82, "SINCE", { size: 9, fill: C.dim, weight: 700 }) +
    t(x0 + 192, y0 + 82, d.createdAt.toISOString().slice(0, 10), { size: 11 }) +
    t(x0, y0 + 102, "SQUADRON", { size: 9, fill: C.dim, weight: 700 }) +
    t(x0 + 78, y0 + 102, `${num(d.followers)} FOLLOWERS`, { size: 11 });

  const stats = [
    ["COMMITS", d.commits], ["PULL REQ", d.prs], ["REVIEWS", d.reviews],
    ["ISSUES", d.issues], ["STARS", d.stars], ["REPOS", d.repoCount],
  ];
  const gx = 340, gy = y0 + 4;
  const grid = stats
    .map(([label, v], i) => {
      const x = gx + (i % 3) * 112, y = gy + Math.floor(i / 3) * 52;
      return `<path d="M${x} ${y + 6}V${y}H${x + 6}M${x + 92} ${y}H${x + 98}V${y + 6}M${x} ${y + 36}V${y + 42}H${x + 6}M${x + 92} ${y + 42}H${x + 98}V${y + 36}" stroke="${C.dim}" fill="none"/>` +
        t(x + 49, y + 15, label, { size: 9, anchor: "middle", fill: C.dim, weight: 700 }) +
        t(x + 49, y + 35, num(v), { size: 18, anchor: "middle", weight: 700 });
    })
    .join("") + t(gx, gy + 112, `LAST 12 MO · ${num(d.total)} TOTAL CONTRIBUTIONS`, { size: 9, fill: C.dim });

  const lights = [
    ["STREAK", d.streak >= 7, C.green], ["SIM OPS", d.simRepos > 0, C.cyan],
    ["100+ CMT", d.commits >= 100, C.green], ["PR LEAD", d.prs >= 50, C.green],
    ["MASTER", d.streak === 0, C.amber], ["STARS", d.stars >= 100, C.amber],
  ];
  const lx = w - P - 150, ly = y0 + 4;
  const ann = t(lx, ly - 6, "ANNUNCIATOR", { size: 9, fill: C.dim, weight: 700 }) +
    lights
      .map(([label, on, col], i) => {
        const x = lx + (i % 2) * 70, y = ly + Math.floor(i / 2) * 30;
        return `<rect x="${x}" y="${y}" width="64" height="24" rx="2" fill="${on ? col : "#07140d"}" fill-opacity="${on ? 0.18 : 1}" stroke="${on ? col : C.faint}"${label === "MASTER" && on ? ' class="blink"' : ""}/>` +
          t(x + 32, y + 16, label === "MASTER" ? "NO ACT" : label, { size: 9, anchor: "middle", fill: on ? col : C.faint, weight: 700 });
      })
      .join("") +
    t(lx, ly + 106, `STREAK ${d.streak}D · BEST ${d.best}D`, { size: 9, fill: C.cyan });

  return mfd(w, h, `${d.login} status`, ["STAT", "RDR", "", "ENG", "STRS"], ["", "SMS", "", "HSI", "", "DCLT", ""], "STAT", tape + id + grid + ann);
}

function radarCard(d) {
  const w = 420, h = 420, cx = w / 2, cy = h / 2 + 8, rMax = 150, rMin = 34;
  const counts = d.days.map((x) => x.contributionCount).filter(Boolean).sort((a, b) => a - b);
  const q = (p) => counts[Math.floor(p * (counts.length - 1))] ?? 1;
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)];

  let g = "";
  for (let i = 0; i <= 3; i++) {
    const r = rMin + ((rMax - rMin) * i) / 3;
    g += `<circle cx="${cx}" cy="${cy}" r="${fix(r)}" fill="none" stroke="${C.faint}" ${i === 3 ? "" : 'stroke-dasharray="2 4"'}/>`;
  }
  for (let deg = 0; deg < 360; deg += 10) {
    const [x1, y1] = polar(cx, cy, rMax, deg);
    const [x2, y2] = polar(cx, cy, rMax + (deg % 30 ? 4 : 8), deg);
    g += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${C.dim}"/>`;
  }
  g += `<line x1="${cx - rMax}" y1="${cy}" x2="${cx + rMax}" y2="${cy}" stroke="${C.faint}"/><line x1="${cx}" y1="${cy - rMax}" x2="${cx}" y2="${cy + rMax}" stroke="${C.faint}"/>`;

  // Contacts: angle = week of year (clockwise from north), radius = weekday.
  const weeks = Math.ceil(d.days.length / 7);
  let lastMonth = -1;
  d.days.forEach((day, i) => {
    const wk = Math.floor(i / 7);
    const deg = (wk / weeks) * 360 + 3;
    const month = new Date(day.date).getUTCMonth();
    if (day.weekday === 0 && month !== lastMonth && wk < weeks - 2) {
      lastMonth = month;
      const [mx, my] = polar(cx, cy, rMax + 18, deg);
      g += t(mx, my + 3, new Date(day.date).toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase(), { size: 8, anchor: "middle", fill: C.dim, weight: 700 });
    }
    const n = day.contributionCount;
    if (!n) return;
    const r = rMin + ((rMax - rMin) * day.weekday) / 6;
    const [x, y] = polar(cx, cy, r, deg);
    const s = n >= q3 ? 3.6 : n >= q2 ? 2.8 : n >= q1 ? 2.2 : 1.6;
    const col = n >= q3 ? C.amber : C.green;
    const op = n >= q2 ? 1 : 0.55;
    g += `<rect x="${fix(x - s)}" y="${fix(y - s)}" width="${fix(s * 2)}" height="${fix(s * 2)}" transform="rotate(45 ${x} ${y})" fill="${col}" fill-opacity="${op}"/>`;
  });

  // Ownship + sweep (trail faked with stacked wedges).
  g += `<path d="M${cx} ${cy - 7}L${cx + 5} ${cy + 5}L${cx} ${cy + 2}L${cx - 5} ${cy + 5}Z" fill="${C.cyan}"/>`;
  const wedges = [0, 6, 12, 20, 30].map((spread, i) => {
    const [x1, y1] = polar(cx, cy, rMax, -spread);
    return `<path d="M${cx} ${cy}L${x1} ${y1}A${rMax} ${rMax} 0 0 1 ${cx} ${cy - rMax}Z" fill="${C.green}" fill-opacity="${[0.22, 0.12, 0.07, 0.04, 0.02][i]}"/>`;
  }).join("");
  g += `<g class="sweep">${wedges}<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - rMax}" stroke="${C.green}" stroke-width="1.5"/></g>`;

  const peak = d.peak;
  g += t(P + 10, P + 34, "CONTACTS", { size: 9, fill: C.dim, weight: 700 }) +
    t(P + 10, P + 50, num(d.total), { size: 15, weight: 700 }) +
    t(w - P - 10, P + 34, "PEAK", { size: 9, fill: C.dim, weight: 700, anchor: "end" }) +
    t(w - P - 10, P + 50, `${peak.contributionCount} · ${peak.date.slice(5)}`, { size: 12, fill: C.amber, weight: 700, anchor: "end" }) +
    t(P + 10, h - P - 22, "RNG", { size: 9, fill: C.dim, weight: 700 }) +
    t(P + 34, h - P - 22, "SUN→SAT", { size: 9 }) +
    t(w - P - 10, h - P - 22, `STREAK ${d.streak}D`, { size: 11, fill: C.cyan, weight: 700, anchor: "end" });

  return mfd(w, h, "contribution radar", ["RWS", "RDR", "12MO"], ["", "", ""], "RDR", g,
    `.sweep{transform-origin:${cx}px ${cy}px;animation:sweep 5s linear infinite}@keyframes sweep{to{transform:rotate(360deg)}}`);
}

function enginesCard(d) {
  const w = 420, h = 420;
  const cols = 3, cw = (w - P * 2) / cols, r = 38;
  let g = t(w / 2, P + 34, "ENGINE PAGE · LANGUAGE MIX", { size: 9, fill: C.dim, weight: 700, anchor: "middle" });
  d.languages.forEach((l, i) => {
    const cx = P + cw * (i % cols) + cw / 2;
    const cy = P + 110 + Math.floor(i / cols) * 140;
    const from = -125, to = 125, val = from + (to - from) * Math.min(1, l.pct / Math.max(0.5, d.languages[0].pct));
    const hot = i === 0;
    g += `<path d="${arc(cx, cy, r, from, to)}" stroke="${C.faint}" stroke-width="5" fill="none"/>` +
      `<path d="${arc(cx, cy, r, from, val)}" stroke="${hot ? C.amber : C.green}" stroke-width="5" fill="none"/>`;
    for (let k = 0; k <= 10; k++) {
      const deg = from + ((to - from) * k) / 10;
      const [x1, y1] = polar(cx, cy, r + 5, deg), [x2, y2] = polar(cx, cy, r + (k % 5 ? 8 : 11), deg);
      g += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${C.dim}"/>`;
    }
    const [nx, ny] = polar(cx, cy, r - 8, val);
    g += `<line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="${C.green}" stroke-width="2"/><circle cx="${cx}" cy="${cy}" r="3" fill="${C.green}"/>` +
      t(cx, cy + 24, `${(l.pct * 100).toFixed(1)}%`, { size: 13, anchor: "middle", weight: 700, fill: hot ? C.amber : C.green }) +
      `<rect x="${fix(cx - 30)}" y="${cy + 33}" width="60" height="16" fill="none" stroke="${C.dim}"/>` +
      `<rect x="${fix(cx - 30)}" y="${cy + 33}" width="3" height="16" fill="${l.color}"/>` +
      t(cx + 1, cy + 45, clip(l.name.toUpperCase(), 7), { size: 10, anchor: "middle", weight: 700 });
  });
  const total = d.languages.reduce((s, l) => s + l.size, 0);
  const fuel = total > 1e6 ? `${(total / 1e6).toFixed(1)} MB` : `${Math.round(total / 1e3)} KB`;
  g += t(P + 12, h - P - 22, "FUEL", { size: 9, fill: C.dim, weight: 700 }) +
    t(P + 46, h - P - 22, `${fuel} SOURCE`, { size: 11, weight: 700 }) +
    t(w - P - 12, h - P - 22, `${d.languages.length} ENG ONLINE`, { size: 9, fill: C.cyan, anchor: "end", weight: 700 });
  return mfd(w, h, "language engines", ["ENG", "FUEL", "HYD"], ["", "", ""], "ENG", g);
}

function storesCard(d) {
  const rows = Math.max(d.stores.length, d.sorties.length, 1);
  const w = 860, h = P * 2 + 80 + rows * 30;
  const x0 = P + 14, y0 = P + 40;
  let g = t(x0, y0 - 6, "STORES · TOP PROJECTS", { size: 9, fill: C.dim, weight: 700 }) +
    t(x0 + 478, y0 - 6, "★", { size: 9, fill: C.dim, anchor: "end" }) +
    t(x0 + 520, y0 - 6, "FRK", { size: 9, fill: C.dim, anchor: "end", weight: 700 });
  d.stores.forEach((r, i) => {
    const y = y0 + 10 + i * 30;
    g += `<rect x="${x0}" y="${y}" width="22" height="20" fill="none" stroke="${r.sim ? C.amber : C.dim}"/>` +
      t(x0 + 11, y + 14, String(i + 1), { size: 11, anchor: "middle", weight: 700, fill: r.sim ? C.amber : C.green }) +
      t(x0 + 32, y + 11, clip(r.name, 28), { size: 12, weight: 700 }) +
      t(x0 + 32, y + 23, clip((r.description ?? "").toUpperCase(), 52), { size: 8, fill: C.dim }) +
      (r.sim ? `<rect x="${x0 + 290}" y="${y + 2}" width="30" height="12" fill="${C.amber}" fill-opacity=".15" stroke="${C.amber}"/>` + t(x0 + 305, y + 11, "SIM", { size: 8, anchor: "middle", fill: C.amber, weight: 700 }) : "") +
      t(x0 + 330, y + 11, clip((r.primaryLanguage?.name ?? "—").toUpperCase(), 10), { size: 9, fill: C.cyan }) +
      t(x0 + 478, y + 11, num(r.stargazerCount), { size: 12, anchor: "end", weight: 700 }) +
      t(x0 + 520, y + 11, num(r.forkCount), { size: 12, anchor: "end" });
  });

  const lx = x0 + 556;
  g += `<line x1="${lx - 14}" y1="${y0 - 16}" x2="${lx - 14}" y2="${h - P - 14}" stroke="${C.faint}"/>` +
    t(lx, y0 - 6, "FLIGHT LOG · RECENT SORTIES", { size: 9, fill: C.dim, weight: 700 });
  d.sorties.forEach((r, i) => {
    const y = y0 + 10 + i * 30;
    g += t(lx, y + 13, ago(r.pushedAt).padStart(3, " "), { size: 10, fill: C.cyan, weight: 700 }) +
      t(lx + 34, y + 13, "PUSH ▸", { size: 9, fill: C.dim }) +
      t(lx + 76, y + 13, clip(r.name, 20), { size: 11, weight: 600 });
  });
  g += t(lx, h - P - 12, "▌", { size: 11, cls: "blink" });
  return mfd(w, h, "projects and flight log", ["STAT", "RDR", "ENG", "STRS", "LOG"], ["", "", "", "", ""], "STRS", g);
}

// ---------- main ----------

const mock = process.argv.includes("--mock");
const token = process.env.GITHUB_TOKEN;
if (!mock && !token) throw new Error("Set GITHUB_TOKEN or pass --mock");
const d = digest(mock ? mockData() : await fetchData(token));
await mkdir(OUT, { recursive: true });
const cards = { status: statusCard, radar: radarCard, engines: enginesCard, stores: storesCard };
for (const [name, render] of Object.entries(cards)) await writeFile(new URL(`${name}.svg`, OUT), render(d));
console.log(`wrote ${Object.keys(cards).length} cards for ${d.login}`);
