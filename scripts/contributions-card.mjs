// Builds contributions.svg from the GitHub contribution calendar.
// Usage: GITHUB_TOKEN=... node scripts/contributions-card.mjs <login> <output.svg>
// No dependencies: Node 18+ only. Private work is counted (as numbers only)
// when "Include private contributions on my profile" is on in GitHub settings.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const [login = "Ouraking", outFile = "dist/contributions.svg"] = process.argv.slice(2);
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "contributions-card" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(JSON.stringify(body.errors ?? body));
  return body.data;
}

const DAYS = `contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }`;

// Last 12 months, with the breakdown by contribution type.
const recent = (
  await gql(
    `query($login: String!) { user(login: $login) { contributionsCollection {
      contributionYears totalCommitContributions totalPullRequestContributions
      totalIssueContributions totalPullRequestReviewContributions restrictedContributionsCount
      ${DAYS} } } }`,
    { login },
  )
).user.contributionsCollection;

// Every calendar year, for the all-time total and the longest streak.
const days = new Map();
for (const year of recent.contributionYears) {
  const c = (
    await gql(
      `query($login: String!, $from: DateTime!, $to: DateTime!) { user(login: $login) {
        contributionsCollection(from: $from, to: $to) { ${DAYS} } } }`,
      { login, from: `${year}-01-01T00:00:00Z`, to: `${year}-12-31T23:59:59Z` },
    )
  ).user.contributionsCollection;
  for (const w of c.contributionCalendar.weeks) for (const d of w.contributionDays) days.set(d.date, d.contributionCount);
}
for (const w of recent.contributionCalendar.weeks) for (const d of w.contributionDays) days.set(d.date, d.contributionCount);

// The default (last 12 months) calendar ends today; year calendars run to Dec 31.
const lastDate = recent.contributionCalendar.weeks.at(-1).contributionDays.at(-1).date;
const sorted = [...days.entries()].filter(([d]) => d <= lastDate).sort(([a], [b]) => a.localeCompare(b));
const thisYear = lastDate.slice(0, 4);

let allTime = 0, yearTotal = 0, longest = 0, run = 0;
for (const [date, n] of sorted) {
  allTime += n;
  if (date.startsWith(thisYear)) yearTotal += n;
  run = n > 0 ? run + 1 : 0;
  longest = Math.max(longest, run);
}

// Current streak: today may still be empty, so it counts from yesterday.
let current = 0;
for (let i = sorted.length - 1; i >= 0; i--) {
  if (sorted[i][1] > 0) current++;
  else if (i === sorted.length - 1) continue;
  else break;
}

const last30 = sorted.slice(-30).reduce((s, [, n]) => s + n, 0);

// Weekly totals for the last 52 weeks.
const weeks = recent.contributionCalendar.weeks.slice(-52).map((w) => ({
  start: w.contributionDays[0].date,
  total: w.contributionDays.reduce((s, d) => s + d.contributionCount, 0),
}));

const fmt = (n) => n.toLocaleString("en-US");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Layout
const W = 1200, H = 420;
const chart = { x: 64, y: 236, w: 1072, h: 110 };
const maxWeek = Math.max(1, ...weeks.map((w) => w.total));
const slot = chart.w / weeks.length;
const barW = Math.max(4, slot - 6);

const bars = weeks
  .map((w, i) => {
    const h = w.total === 0 ? 3 : Math.max(6, (w.total / maxWeek) * chart.h);
    const x = chart.x + i * slot + (slot - barW) / 2;
    const y = chart.y + chart.h - h;
    const fill = w.total === 0 ? "#1A2440" : "url(#bar)";
    return `<rect class="b" style="animation-delay:${(i * 0.018).toFixed(3)}s" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${fill}"/>`;
  })
  .join("\n    ");

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
let prevMonth = -1;
let prevX = -Infinity;
const monthLabels = weeks
  .map((w, i) => {
    const m = Number(w.start.slice(5, 7)) - 1;
    if (m === prevMonth) return "";
    prevMonth = m;
    const x = chart.x + i * slot;
    // Keep labels apart, and skip a month that only starts in the last weeks.
    if (x - prevX < 48 || i > weeks.length - 3) return "";
    prevX = x;
    return `<text class="axis" x="${x.toFixed(1)}" y="${chart.y + chart.h + 24}">${MONTHS[m]}</text>`;
  })
  .join("");

const stats = [
  { label: `IN ${thisYear}`, value: fmt(yearTotal), color: "#2DD4BF" },
  { label: "LAST 30 DAYS", value: fmt(last30), color: "#F2F6FF" },
  { label: "CURRENT STREAK", value: `${current}d`, color: "#F5B942" },
  { label: "LONGEST STREAK", value: `${longest}d`, color: "#F2F6FF" },
  { label: "ALL TIME", value: fmt(allTime), color: "#AEE8DE" },
];
const colW = chart.w / stats.length;
const statBlocks = stats
  .map(
    (s, i) => `<g class="s" style="animation-delay:${(0.1 + i * 0.12).toFixed(2)}s">
      <text class="num" x="${chart.x + i * colW}" y="150" fill="${s.color}">${esc(s.value)}</text>
      <text class="lbl" x="${chart.x + i * colW + 2}" y="180">${esc(s.label)}</text>
    </g>`,
  )
  .join("\n    ");

const mix = [
  ["commits", recent.totalCommitContributions],
  ["pull requests", recent.totalPullRequestContributions],
  ["reviews", recent.totalPullRequestReviewContributions],
  ["issues", recent.totalIssueContributions],
  ["private", recent.restrictedContributionsCount],
]
  .filter(([, n]) => n > 0)
  .map(([k, n]) => `${fmt(n)} ${k}`)
  .join("  ·  ");

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(
  `${login} contributions: ${fmt(yearTotal)} in ${thisYear}, ${fmt(last30)} in the last 30 days, current streak ${current} days, longest streak ${longest} days, ${fmt(allTime)} all time`,
)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="${W}" y2="${H}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0A0F1E"/>
      <stop offset="0.55" stop-color="#0D1428"/>
      <stop offset="1" stop-color="#101A33"/>
    </linearGradient>
    <linearGradient id="bar" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#2DD4BF"/>
      <stop offset="1" stop-color="#F5B942"/>
    </linearGradient>
    <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#2DD4BF"/>
      <stop offset="1" stop-color="#F5B942" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="frame"><rect width="${W}" height="${H}" rx="18"/></clipPath>
    <style>
      .head { font: 600 14px ui-monospace, 'SFMono-Regular', Consolas, Menlo, monospace; fill: #8B97B8; letter-spacing: 3px; }
      .num  { font: 700 44px 'Segoe UI', Ubuntu, Helvetica, Arial, sans-serif; letter-spacing: 0.5px; }
      .lbl  { font: 500 12px ui-monospace, 'SFMono-Regular', Consolas, Menlo, monospace; fill: #8B97B8; letter-spacing: 2px; }
      .axis { font: 500 11px ui-monospace, 'SFMono-Regular', Consolas, Menlo, monospace; fill: #5D6A8C; letter-spacing: 1.5px; }
      .foot { font: 500 12px ui-monospace, 'SFMono-Regular', Consolas, Menlo, monospace; fill: #5D6A8C; letter-spacing: 1px; }
      .s { opacity: 0; animation: rise 0.7s ease-out forwards; }
      .b { transform-box: fill-box; transform-origin: bottom; transform: scaleY(0); animation: grow 0.9s cubic-bezier(.2,.8,.2,1) forwards; }
      .live { animation: blink 2.4s ease-in-out infinite; }
      @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes grow { to { transform: scaleY(1); } }
      @keyframes blink { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }
      @media (prefers-reduced-motion: reduce) { .s, .b, .live { animation: none; opacity: 1; transform: none; } }
    </style>
  </defs>
  <g clip-path="url(#frame)">
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <circle class="live" cx="${chart.x + 5}" cy="62" r="5" fill="#2DD4BF"/>
    <text class="head" x="${chart.x + 20}" y="67">CONTRIBUTIONS · LIVE</text>
    <text class="foot" x="${chart.x + chart.w}" y="67" text-anchor="end">updated ${esc(lastDate)}</text>
    <rect x="${chart.x}" y="84" width="420" height="2" fill="url(#rule)"/>
    ${statBlocks}
    <text class="lbl" x="${chart.x}" y="${chart.y - 16}">LAST 52 WEEKS</text>
    ${bars}
    ${monthLabels}
    <text class="foot" x="${chart.x}" y="${H - 24}">${esc(mix ? `Past year: ${mix}` : "")}</text>
  </g>
</svg>
`;

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, svg);
console.log(`wrote ${outFile}: ${fmt(yearTotal)} this year, ${current}d streak, ${fmt(allTime)} all time`);
