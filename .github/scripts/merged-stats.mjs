// .github/scripts/merged-stats.mjs
import fs from "node:fs/promises";

const TOKEN = process.env.STATS_TOKEN;
const USER = process.env.GITHUB_USER;

if (!TOKEN) throw new Error("Missing env STATS_TOKEN");
if (!USER) throw new Error("Missing env GITHUB_USER");

const endpoint = "https://api.github.com/graphql";

async function gql(query, variables) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `bearer ${TOKEN}`,
      "user-agent": "merged-stats-action",
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (!res.ok || json.errors) {
    console.error(JSON.stringify(json, null, 2));
    throw new Error(`GitHub GraphQL failed: HTTP ${res.status}`);
  }
  return json.data;
}

const fmt = (n) => new Intl.NumberFormat("en-US").format(n);

const pinnedQ = `
query($login: String!) {
  user(login: $login) {
    pinnedItems(first: 6, types: [REPOSITORY]) {
      nodes {
        ... on Repository {
          nameWithOwner
          stargazerCount
        }
      }
    }
  }
}
`;

const pinnedData = await gql(pinnedQ, { login: USER });
const pinnedNodes = pinnedData?.user?.pinnedItems?.nodes;

if (!Array.isArray(pinnedNodes)) {
  throw new Error(
    "Pinned repos not readable (pinnedItems.nodes is not an array). If your pinned repos are in an SSO-protected org, authorize this PAT for that org in 'Configure SSO'."
  );
}

const pinnedRepos = pinnedNodes.filter(Boolean);

const reposQ = `
query($login: String!, $cursor: String) {
  user(login: $login) {
    repositories(
      first: 100,
      after: $cursor,
      ownerAffiliations: OWNER,
      isFork: false
    ) {
      nodes {
        nameWithOwner
        stargazerCount
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
`;

let cursor = null;
let personalStars = 0;
const personalSet = new Set();

while (true) {
  const data = await gql(reposQ, { login: USER, cursor });
  const conn = data.user.repositories;
  for (const r of conn.nodes ?? []) {
    if (!r) continue;
    personalSet.add(r.nameWithOwner);
    personalStars += r.stargazerCount ?? 0;
  }
  if (!conn.pageInfo.hasNextPage) break;
  cursor = conn.pageInfo.endCursor;
}

let pinnedExtraStars = 0;
for (const r of pinnedRepos) {
  if (!personalSet.has(r.nameWithOwner)) pinnedExtraStars += r.stargazerCount ?? 0;
}

const mergedStars = personalStars + pinnedExtraStars;

const to = new Date();
const from = new Date(to);
from.setUTCDate(from.getUTCDate() - 365);

const contribQ = `
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar { totalContributions }
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      totalPullRequestReviewContributions
    }
  }
}
`;

const contribData = await gql(contribQ, {
  login: USER,
  from: from.toISOString(),
  to: to.toISOString(),
});

const cc = contribData.user.contributionsCollection;
const totalContrib = cc.contributionCalendar.totalContributions ?? 0;

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="520" height="180" viewBox="0 0 520 180" role="img" aria-label="Combined GitHub stats">
  <style>
    .t{font:700 18px -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; fill:#24292f}
    .l{font:600 12px -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; fill:#57606a}
    .v{font:800 22px -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; fill:#24292f}
    .s{font:500 11px -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; fill:#57606a}
  </style>

  <rect x="0.5" y="0.5" width="519" height="179" rx="12" fill="#ffffff" stroke="#d0d7de"/>

  <text x="20" y="32" class="t">${USER} — Combined Stats</text>

  <text x="20" y="62" class="l">Stars (Pinned 6 + Personal)</text>
  <text x="20" y="88" class="v">${fmt(mergedStars)}</text>

  <text x="280" y="62" class="l">Contributions (last 365d)</text>
  <text x="280" y="88" class="v">${fmt(totalContrib)}</text>

  <text x="20" y="120" class="l">Commits</text>
  <text x="20" y="142" class="v" style="font-size:18px">${fmt(cc.totalCommitContributions ?? 0)}</text>

  <text x="160" y="120" class="l">PRs</text>
  <text x="160" y="142" class="v" style="font-size:18px">${fmt(cc.totalPullRequestContributions ?? 0)}</text>

  <text x="280" y="120" class="l">Issues</text>
  <text x="280" y="142" class="v" style="font-size:18px">${fmt(cc.totalIssueContributions ?? 0)}</text>

  <text x="400" y="120" class="l">Reviews</text>
  <text x="400" y="142" class="v" style="font-size:18px">${fmt(cc.totalPullRequestReviewContributions ?? 0)}</text>

  <text x="20" y="168" class="s">Updated ${to.toISOString().slice(0,10)} • Stars merged = personal repos + pinned repos (deduped)</text>
</svg>
`;

await fs.mkdir("dist", { recursive: true });
await fs.writeFile("dist/merged-stats.svg", svg, "utf8");
console.log("Wrote dist/merged-stats.svg");
