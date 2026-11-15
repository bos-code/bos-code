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
    "      contributionCalendar { totalContributions }",
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

await mkdir(outputDirectory, { recursive: true });
await Promise.all(
  Object.entries(themes).map(([name, theme]) =>
    writeFile(`${outputDirectory}/stats-${name}.svg`, card(theme), "utf8"),
  ),
);
