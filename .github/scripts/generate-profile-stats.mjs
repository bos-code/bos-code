import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

// GitHub Readme Stats' one-year rank formula (MIT; see profile-stats.md).
export function calculateRank({commits, prs, issues, reviews, stars, followers}) {
  const exponential = x => 1 - 2 ** -x;
  const logarithmic = x => x / (1 + x);
  const score = (2 * exponential(commits / 250) + 3 * exponential(prs / 50)
    + exponential(issues / 25) + exponential(reviews / 2)
    + 4 * logarithmic(stars / 50) + logarithmic(followers / 10)) / 12;
  const percentile = 100 * (1 - score);
  const thresholds = [1, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];
  return {level: ['S','A+','A','A-','B+','B','B-','C+','C'][thresholds.findIndex(t => percentile <= t)], percentile};
}

export function streaks(days) {
  const ordered = [...days].sort((a,b) => a.date.localeCompare(b.date));
  let longest = 0, run = 0, previous;
  for (const day of ordered) {
    const adjacent = previous && Date.parse(day.date) - Date.parse(previous) === 86400000;
    run = day.contributionCount > 0 ? (adjacent ? run + 1 : 1) : 0;
    longest = Math.max(longest, run);
    previous = day.date;
  }
  // An unfinished final day with no contributions does not break yesterday's streak.
  let end = ordered.length - 1;
  if (ordered[end]?.contributionCount === 0) end--;
  let current = 0;
  for (let i=end; i>=0 && ordered[i].contributionCount>0; i--) {
    if (i < end && Date.parse(ordered[i+1].date) - Date.parse(ordered[i].date) !== 86400000) break;
    current++;
  }
  return {current, longest};
}

export async function collect({username, token, personalToken = false, now = new Date(), fetcher = fetch}) {
  if (!username || !token) throw new Error('GITHUB_REPOSITORY_OWNER and a GitHub token are required');
  const until = new Date(now);
  const from = new Date(now); from.setUTCFullYear(from.getUTCFullYear() - 1);
  const headers = {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'bos-code-profile-readme'};
  async function graphql(query, variables = {}) {
    const response = await fetcher('https://api.github.com/graphql', {
      method:'POST', headers:{...headers,'Content-Type':'application/json'},
      body:JSON.stringify({query, variables}), signal:AbortSignal.timeout(60000),
    });
    // Never print private API payloads, repository names, or credentials on errors.
    if (!response.ok) throw new Error(`GitHub request failed (${response.status}); check token access`);
    const payload = await response.json();
    if (payload.errors?.length || !payload.data) throw new Error('GitHub GraphQL failed; check token permissions and query');
    return payload.data;
  }
  const languageFields = 'id isFork isPrivate languages(first:100) { totalSize pageInfo { hasNextPage } edges { size node { name color } } }';
  const data = await graphql(`query Profile($login:String!, $from:DateTime!, $to:DateTime!, $opened:String!, $merged:String!) {
    viewer { login }
    user(login:$login) {
      followers { totalCount }
      contributionsCollection(from:$from, to:$to) {
        restrictedContributionsCount
        totalCommitContributions totalIssueContributions totalPullRequestReviewContributions
        contributionCalendar { totalContributions weeks { contributionDays { date contributionCount contributionLevel } } }
        commitContributionsByRepository(maxRepositories:100) { repository { ${languageFields} } }
        pullRequestContributionsByRepository(maxRepositories:100) { repository { ${languageFields} } }
      }
    }
    opened:search(query:$opened, type:ISSUE) { issueCount }
    merged:search(query:$merged, type:ISSUE) { issueCount }
  }`, {login:username,from:from.toISOString(),to:until.toISOString(),
    opened:`author:${username} is:pr created:${from.toISOString()}..${until.toISOString()}`,
    merged:`author:${username} is:pr is:merged merged:${from.toISOString()}..${until.toISOString()}`});
  if (!data.user) throw new Error('Profile not found');
  if (personalToken && data.viewer.login.toLowerCase() !== username.toLowerCase()) {
    throw new Error('PROFILE_STATS_TOKEN must belong to the profile owner');
  }
  const c = data.user.contributionsCollection;
  const days = c.contributionCalendar.weeks.flatMap(w=>w.contributionDays);
  if (!days.length || days.reduce((n,d)=>n+d.contributionCount,0) !== c.contributionCalendar.totalContributions) {
    throw new Error('Incomplete or inconsistent contribution calendar');
  }
  const repos = new Map();
  for (const group of [c.commitContributionsByRepository,c.pullRequestContributionsByRepository]) {
    if (group.length === 100) throw new Error('Contribution repository limit reached; refusing incomplete language totals');
    for (const {repository:r} of group) repos.set(r.id,r);
  }
  // Page owned repositories too. The contribution lists above add organization work.
  let cursor = null, stars = 0;
  do {
    const page = await graphql(`query Owned($login:String!, $cursor:String) {
      user(login:$login) { repositories(first:100, after:$cursor, ownerAffiliations:[OWNER], isFork:false) {
        pageInfo { hasNextPage endCursor }
        nodes { ${languageFields} stargazerCount }
      } }
    }`, {login:username,cursor});
    const connection = page.user.repositories;
    for (const r of connection.nodes) {
      repos.set(r.id,r);
      if (!r.isPrivate) stars += r.stargazerCount;
    }
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);
  const languages = new Map(); let privateRepos = 0;
  for (const r of repos.values()) {
    if (r.isFork) continue;
    if (r.languages.pageInfo.hasNextPage) throw new Error('Language limit reached; refusing incomplete totals');
    if (r.isPrivate) privateRepos++;
    for (const {size,node} of r.languages.edges) {
      const old = languages.get(node.name) ?? {name:node.name,color:node.color ?? '#8B949E',bytes:0};
      old.bytes += size; languages.set(node.name,old);
    }
  }
  const metrics = {commits:c.totalCommitContributions, prs:data.opened.issueCount,
    merged:data.merged.issueCount, issues:c.totalIssueContributions,
    reviews:c.totalPullRequestReviewContributions, stars, followers:data.user.followers.totalCount};
  return {username, updatedAt:now.toISOString(), from:from.toISOString(), to:until.toISOString(),
    personalToken, privateRepos, restricted:c.restrictedContributionsCount,
    calendar:c.contributionCalendar, days, metrics, rank:calculateRank(metrics), streak:streaks(days),
    languages:[...languages.values()].sort((a,b)=>b.bytes-a.bytes)};
}

const themes = {
  dark:{title:'#58A6FF',value:'#C9D1D9',label:'#8B949E',divider:'#30363D',dots:['#161B22','#0C2D48','#145374','#1B7F8C','#2DD4BF']},
  light:{title:'#0969DA',value:'#24292F',label:'#57606A',divider:'#D0D7DE',dots:['#EBEDF0','#DDF4FF','#80CCFF','#38BDF8','#0F8B8D']},
};
function svg(width,height,title,theme,body,desc=title) {
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc"><title id="title">${escapeXml(title)}</title><desc id="desc">${escapeXml(desc)}</desc><style>text{font-family:'Segoe UI',Ubuntu,sans-serif;fill:${theme.value}}.title{font-size:18px;font-weight:600;fill:${theme.title}}.value{font-size:22px;font-weight:600}.label{font-size:11px;fill:${theme.label}}.small{font-size:10px;fill:${theme.label}}</style>${body}</svg>\n`;
}
function text(x,y,value,cls='label',extra='') {return `<text x="${x}" y="${y}" class="${cls}" ${extra}>${escapeXml(value)}</text>`;}
const number = n => Number(n).toLocaleString('en-US');
function coverage(s) {
  return s.personalToken ? 'Token-visible activity · private access depends on permissions' : 'Limited access · PROFILE_STATS_TOKEN not configured';
}
function stamp(s) {return `Updated ${s.updatedAt.slice(0,16).replace('T',' ')} UTC`;}
function card(s,t) {
  const rows = [['Contributions',s.calendar.totalContributions],['Commits',s.metrics.commits],
    ['PRs opened',s.metrics.prs],['PRs merged',s.metrics.merged],['Reviews',s.metrics.reviews],['Issues',s.metrics.issues]];
  const body = text(25,32,'GitHub Stats', 'title') + text(25,50,'Past year · GitHub-visible totals','small')
    + rows.map(([label,value],i)=>text(25,78+i*23,label)+text(295,78+i*23,number(value),'label','text-anchor="end"')).join('')
    + `<circle cx="405" cy="115" r="43" stroke="${t.divider}" stroke-width="5"/><circle cx="405" cy="115" r="43" stroke="${t.title}" stroke-width="5" stroke-dasharray="${(100-s.rank.percentile)/100*270.18} 270.18" transform="rotate(-90 405 115)"/>`
    + text(405,123,s.rank.level,'value','text-anchor="middle"')+text(405,177,'Activity rank','small','text-anchor="middle"')
    + text(25,224,stamp(s),'small');
  return svg(495,255,'GitHub Stats',t,body,`${rows.map(([label,value])=>label+': '+value).join(', ')}. Rank ${s.rank.level}. ${stamp(s)}. PRs merged counts merges during the year, including older PRs.`);
}
function languageCard(s,t) {
  const top = s.languages.slice(0,8), total = s.languages.reduce((a,l)=>a+l.bytes,0);
  let x=25;
  const bar = top.map(l=>{const width=445*l.bytes/(total||1);const r=`<rect x="${x}" y="62" width="${width}" height="8" fill="${escapeXml(l.color)}"/>`;x+=width;return r;}).join('');
  const other = Math.max(0,470-x);
  const labels = top.map((l,i)=>{
    const x=25+(i%2)*225, y=98+Math.floor(i/2)*25;
    return `<circle cx="${x+4}" cy="${y-4}" r="4" fill="${escapeXml(l.color)}"/>`+text(x+16,y,`${l.name} ${(100*l.bytes/(total||1)).toFixed(1)}%`);
  }).join('');
  return svg(495,255,'Most Used Languages',t,text(25,32,'Most Used Languages','title')
    +text(25,50,'Repository bytes · owned + contributed repositories (1Y)','small')+bar
    +`<rect x="${x}" y="62" width="${other}" height="8" fill="${t.divider}"/>`+labels
    +text(25,224,stamp(s),'small')+text(25,242,'Accessible, non-fork repos; not personal lines written.','small'));
}
function streakCard(s,t) {
  return svg(495,195,'Contribution Streak',t,text(25,30,'Contribution Streak','title')
    +[[85,s.calendar.totalContributions,'Contributions'],[247,s.streak.current,'Current streak'],[410,s.streak.longest,'Longest streak']].map(([x,v,l])=>
      text(x,87,number(v),'value','text-anchor="middle"')+text(x,111,l,'label','text-anchor="middle"')).join('')
    +text(247,139,'Days · past-year calendar · same data as activity and snake','small','text-anchor="middle"')
    +text(25,163,stamp(s),'small'));
}
// Deterministic serpentine route across the same calendar. Counts drive cell colours;
// the snake only visits existing calendar cells. No second API or public-only scrape.
export function snakeCard(s,t) {
  const cells=[];
  s.calendar.weeks.forEach((w,x)=>w.contributionDays.forEach(d=>{
    cells.push({...d,x:24+x*16,y:22+new Date(d.date+'T00:00:00Z').getUTCDay()*16});
  }));
  const path=[...cells].sort((a,b)=>a.x-b.x || ((Math.round((a.x-24)/16)%2) ? b.y-a.y : a.y-b.y));
  const points=path.map(c=>`${c.x+6},${c.y+6}`);
  const colors={NONE:0,FIRST_QUARTILE:1,SECOND_QUARTILE:2,THIRD_QUARTILE:3,FOURTH_QUARTILE:4};
  const board=cells.map(c=>`<rect x="${c.x}" y="${c.y}" width="12" height="12" rx="2" fill="${t.dots[colors[c.contributionLevel]??0]}"/>`).join('');
  const snake=Array.from({length:5},(_,i)=>`<rect class="snake" x="-5" y="-5" width="10" height="10" rx="3" fill="${t.title}" opacity="${1-i*.12}"><animateMotion dur="36s" begin="-${i*.10}s" repeatCount="indefinite" calcMode="linear" path="M${points.join(' L')} L${points[0]}"/></rect>`).join('');
  return svg(910,165,'Contribution Snake',t,`<style>@media(prefers-reduced-motion:reduce){.snake{display:none}}</style>${board}${snake}`
    +text(24,154,`${stamp(s)} · ${number(s.calendar.totalContributions)} contributions`,'small'),`Animated snake over the past-year contribution calendar.`);
}

export function typingCard(theme) {
  const phrases = [
    'React · Next.js · TypeScript · Go · Python',
    'Building web, desktop and backend systems',
    'Based in Nigeria · Collaborating worldwide',
  ];
  const lines = phrases.map((phrase,index) => {
    const width = phrase.length * 12.6;
    const left = (700 - width) / 2;
    // Discrete character positions type, pause, then erase before the next line.
    const values = [0], times = [0];
    for (let i=0;i<=phrase.length;i++) {values.push(i*12.6);times.push(.02+.16*i/phrase.length);}
    values.push(width); times.push(.26);
    for (let i=phrase.length-1;i>=0;i--) {values.push(i*12.6);times.push(.26+.06*(phrase.length-i)/phrase.length);}
    values.push(0); times.push(1);
    const animation = `<animate attributeName="width" values="${values.join(';')}" keyTimes="${times.join(';')}" calcMode="discrete" dur="12s" begin="${index*4}s" repeatCount="indefinite"/>`;
    return `<defs><clipPath id="typing-${index}"><rect x="${left}" y="7" width="0" height="39">${animation}</rect></clipPath></defs>
      <g class="typing-line" opacity="0"><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.32;0.333333;1" calcMode="discrete" dur="12s" begin="${index*4}s" repeatCount="indefinite"/>
      <text x="${left}" y="34" clip-path="url(#typing-${index})" textLength="${width}" lengthAdjust="spacingAndGlyphs">${escapeXml(phrase)}</text>
      <rect x="${left}" y="10" width="2" height="28" fill="${theme.title}"><animate attributeName="x" values="${values.map(v=>left+v).join(';')}" keyTimes="${times.join(';')}" calcMode="discrete" dur="12s" begin="${index*4}s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0" dur="0.8s" calcMode="discrete" repeatCount="indefinite"/></rect></g>`;
  }).join('');
  return `<svg width="700" height="55" viewBox="0 0 700 55" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="typing-title"><title id="typing-title">Software engineer — web, desktop and backend systems</title><style>text{font:600 21px monospace;fill:${theme.title}}.static-intro{display:none}@media(prefers-reduced-motion:reduce){.typing-line{display:none}.static-intro{display:block}}</style>${lines}<text class="static-intro" x="350" y="34" text-anchor="middle">${escapeXml(phrases[0])}</text></svg>\n`;
}

function activityGraph(s, theme) {
  const contributionSummary = {contributionCalendar:s.calendar};
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
    ' contributions over the past year, grouped by week.</desc>' +
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
    '<text x="' + right + '" y="251" text-anchor="end" class="label">' + escapeXml(stamp(s)) + '</text>' +
    '</svg>\n';
}


export async function generate(s, directory) {
  await mkdir(directory,{recursive:true});
  const files={};
  for (const [name,t] of Object.entries(themes)) {
    files[`stats-${name}.svg`]=card(s,t);
    files[`top-langs-${name}.svg`]=languageCard(s,t);
    files[`streak-${name}.svg`]=streakCard(s,t);
    files[`typing-${name}.svg`]=typingCard(t);
    files[`commit-activity-${name}.svg`]=activityGraph(s,t);
    files[name==='dark'?'github-contribution-grid-snake-dark.svg':'github-contribution-grid-snake.svg']=snakeCard(s,t);
  }
  // Deliberate allowlist: never serialize raw GraphQL objects, tokens or repo metadata.
  files['profile-summary.json']=JSON.stringify({updatedAt:s.updatedAt,from:s.from,to:s.to,
    coverage:coverage(s),metrics:s.metrics,contributions:s.calendar.totalContributions,
    restrictedContributions:s.restricted,rank:s.rank,streak:s.streak,
    languages:s.languages.map(({name,bytes})=>({name,bytes}))},null,2)+'\n';
  await Promise.all(Object.entries(files).map(([path,content])=>writeFile(`${directory}/${path}`,content,'utf8')));
  return files;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const s=await collect({username:process.env.GITHUB_REPOSITORY_OWNER,
      token:process.env.PROFILE_STATS_TOKEN || process.env.GITHUB_TOKEN,
      personalToken:Boolean(process.env.PROFILE_STATS_TOKEN)});
    await generate(s,process.env.PROFILE_ASSET_DIR ?? 'dist');
    if (!s.personalToken) console.warn('::warning::PROFILE_STATS_TOKEN is missing; see the workflow documentation for data coverage.');
    console.log(`Generated profile visuals. ${coverage(s)}`);
  } catch {
    // Do not leak potentially private request or error details into public logs.
    console.error('::error::Profile refresh failed. Check API availability, owner token access and validation tests. Previous published assets were not replaced.');
    process.exitCode=1;
  }
}
