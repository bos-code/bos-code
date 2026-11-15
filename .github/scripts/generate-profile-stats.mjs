import { mkdir, writeFile } from "node:fs/promises";

const username = process.env.GITHUB_REPOSITORY_OWNER;
const outputDirectory = process.env.PROFILE_ASSET_DIR ?? "dist";
// Optional user-scoped token (read:user) enables private contribution aggregates.
const profileToken = process.env.PROFILE_STATS_TOKEN || process.env.GITHUB_TOKEN;

if (!username) {
  throw new Error("GITHUB_REPOSITORY_OWNER is required");
}

const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "bos-code-profile-readme",
};

if (process.env.GITHUB_TOKEN) {
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

async function request(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers });

  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

async function getRepositories() {
  const repositories = [];

  for (let page = 1; ; page += 1) {
    const batch = await request(
      `/users/${encodeURIComponent(username)}/repos?type=owner&sort=updated&per_page=100&page=${page}`,
    );
    repositories.push(...batch);

    if (batch.length < 100) break;
  }

  return repositories;
}

// Query contribution totals through GitHub's contribution model rather than
// searching public commits/PRs. Only aggregate numbers are ever rendered.
async function getContributionSummary() {
  if (!profileToken) {
    throw new Error("GITHUB_TOKEN or PROFILE_STATS_TOKEN is required");
  }

  const query = [
    "query ProfileContributionStats($login: String!) {",
    "  user(login: $login) {",
    "    contributionsCollection {",
    "      contributionCalendar { totalContributions weeks { contributionDays { contributionCount date } } }",
    "      totalPullRequestContributions",
    "    }",
    "  }",
    "}",
  ].join("\n");

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      ...headers,
      Authorization: "Bearer " + profileToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { login: username } }),
  });

  if (!response.ok) {
    throw new Error("GitHub GraphQL API " + response.status + ": " + (await response.text()));
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error("GitHub GraphQL: " + payload.errors.map((error) => error.message).join("; "));
  }

  const summary = payload.data?.user?.contributionsCollection;
  if (!summary) {
    throw new Error("GitHub did not return the contribution summary");
  }

  return summary;
}

const [profile, repositories, contributionSummary] = await Promise.all([
  request("/users/" + encodeURIComponent(username)),
  getRepositories(),
  getContributionSummary(),
]);

// GitHub's contribution calendar covers the trailing year. Private work is
// included only when permitted by profile visibility and token permissions.
const stats = [
  {
    value: contributionSummary.contributionCalendar.totalContributions,
    label: "CONTRIBUTIONS (1Y)",
  },
  {
    value: contributionSummary.totalPullRequestContributions,
    label: "PULL REQUESTS (1Y)",
  },
  {
    value: repositories
      .filter((repository) => !repository.fork)
      .reduce((total, repository) => total + repository.stargazers_count, 0),
    label: "PUBLIC STARS EARNED",
  },
  { value: profile.public_repos, label: "PUBLIC REPOS" },
];

const themes = {
  dark: {
    title: "#58A6FF",
    value: "#C9D1D9",
    label: "#8B949E",
    divider: "#30363D",
  },
  light: {
    title: "#0969DA",
    value: "#24292F",
    label: "#57606A",
    divider: "#D0D7DE",
  },
};

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function card(theme) {
  const positions = [
    { x: 25, y: 91 },
    { x: 265, y: 91 },
    { x: 25, y: 158 },
    { x: 265, y: 158 },
  ];

  const metrics = stats
    .map(({ value, label }, index) => {
      const { x, y } = positions[index];
      return `
        <g transform="translate(${x} ${y})">
          <text class="value">${escapeXml(Number(value).toLocaleString("en-US"))}</text>
          <text y="22" class="label">${escapeXml(label)}</text>
        </g>`;
    })
    .join("");

  return `<svg width="495" height="190" viewBox="0 0 495 190" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(username)}'s GitHub stats</title>
  <desc id="desc">${stats.map(({ value, label }) => `${value} ${label.toLowerCase()}`).join(", ")}</desc>
  <style>
    .title { font: 600 18px 'Segoe UI', Ubuntu, sans-serif; fill: ${theme.title}; }
    .value { font: 600 22px 'Segoe UI', Ubuntu, sans-serif; fill: ${theme.value}; }
    .label { font: 600 10px 'Segoe UI', Ubuntu, sans-serif; letter-spacing: 1px; fill: ${theme.label}; }
  </style>
  <text x="25" y="35" class="title">GitHub Stats</text>
  <path d="M25 52H470" stroke="${theme.divider}" />
  <path d="M247.5 67V171" stroke="${theme.divider}" />
  ${metrics}
</svg>\n`;
}


function typingCard(theme) {
  const phrases = [
    "React · Next.js · React Native · TypeScript",
    "Responsive interfaces with motion and intent",
    "Based in Nigeria · Collaborating worldwide",
  ];

  const lines = phrases.map((phrase, index) => {
    const delay = index === 0 ? 0 : index === 1 ? -8 : -4;
    return '<text class="phrase" style="animation-delay:' + delay + 's" x="350" y="34" text-anchor="middle">' +
      escapeXml(phrase) + '</text>';
  }).join("\n");

  return '<svg width="700" height="55" viewBox="0 0 700 55" xmlns="http://www.w3.org/2000/svg" role="img">' +
    '<title>Developer introduction</title>' +
    '<style>' +
    '.phrase {font:600 21px "Fira Code", "Segoe UI", Ubuntu, sans-serif;fill:' + theme.title + ';opacity:0;animation:rotate 12s linear infinite}' +
    '@keyframes rotate {0%,28% {opacity:1} 33%,99% {opacity:0} 100% {opacity:1}}' +
    '@media(prefers-reduced-motion:reduce){.phrase{animation:none}.phrase:first-of-type{opacity:1}}' +
    '</style>' + lines + '</svg>\n';
}

function activityGraph(theme) {
  // Aggregate activity at the week level; never include private repository metadata.
  const weeks = contributionSummary.contributionCalendar.weeks;
  if (!Array.isArray(weeks) || weeks.length === 0) {
    throw new Error("Contribution calendar did not include weeks");
  }

  const values = weeks.map((week) => week.contributionDays.reduce(
    (sum, day) => sum + day.contributionCount, 0,
  ));
  const peak = Math.max(1, ...values);
  const left = 55;
  const right = 855;
  const top = 72;
  const bottom = 225;
  const chartWidth = right - left;
  const chartHeight = bottom - top;
  const point = (value, index) => {
    const x = left + chartWidth * index / Math.max(values.length - 1, 1);
    const y = bottom - value / peak * chartHeight;
    return [x.toFixed(1), y.toFixed(1)];
  };
  const points = values.map((value, index) => point(value, index).join(",")).join(" ");
  const first = point(values[0], 0)[0];
  const last = point(values[values.length - 1], values.length - 1)[0];
  const area = first + "," + bottom + " " + points + " " + last + "," + bottom;
  const grid = [0, 0.5, 1].map((ratio) => {
    const y = (bottom - ratio * chartHeight).toFixed(1);
    return '<line x1="' + left + '" x2="' + right + '" y1="' + y + '" y2="' + y +
      '" stroke="' + theme.divider + '" stroke-dasharray="3,7"/>' +
      '<text x="46" y="' + (+y + 4) + '" text-anchor="end" class="label">' +
      Math.round(peak * ratio) + '</text>';
  }).join("");

  return '<svg width="910" height="275" viewBox="0 0 910 275" xmlns="http://www.w3.org/2000/svg" role="img">' +
    '<title>GitHub contribution activity across the past year</title>' +
    '<desc>' + escapeXml(contributionSummary.contributionCalendar.totalContributions) +
    ' contributions over the past year, grouped by week; includes private activity only when GitHub allows it.</desc>' +
    '<style>' +
    '.title{font:600 21px "Segoe UI",Ubuntu,sans-serif;fill:' + theme.title + '}' +
    '.value{font:600 16px "Segoe UI",Ubuntu,sans-serif;fill:' + theme.value + '}' +
    '.label{font:400 12px "Segoe UI",Ubuntu,sans-serif;fill:' + theme.label + '}' +
    '</style>' +
    '<text x="55" y="32" class="title">Contribution Activity</text>' +
    '<text x="855" y="31" text-anchor="end" class="value">' +
    escapeXml(contributionSummary.contributionCalendar.totalContributions.toLocaleString("en-US")) +
    ' total</text>' + grid +
    '<polygon points="' + area + '" fill="' + theme.title + '" opacity="0.12"/>' +
    '<polyline points="' + points + '" stroke="' + theme.title +
    '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" fill="none"/>' +
    '<text x="' + left + '" y="251" class="label">Past year</text>' +
    '<text x="' + right + '" y="251" text-anchor="end" class="label">Recent</text>' +
    '</svg>\n';
}

await mkdir(outputDirectory, { recursive: true });
await Promise.all(
  Object.entries(themes).map(([name, theme]) =>
    Promise.all([
      writeFile(`${outputDirectory}/stats-${name}.svg`, card(theme), "utf8"),
      writeFile(`${outputDirectory}/typing-${name}.svg`, typingCard(theme), "utf8"),
      writeFile(`${outputDirectory}/commit-activity-${name}.svg`, activityGraph(theme), "utf8"),
    ]),
  ),
);
