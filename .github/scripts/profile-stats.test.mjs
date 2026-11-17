import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {calculateRank, collect, generate, streaks} from './generate-profile-stats.mjs';

const repo=(id,bytes,isPrivate=false,isFork=false)=>({id,isPrivate,isFork,stargazerCount:4,
  name:'PRIVATE-NAME-MUST-NOT-LEAK',languages:{totalSize:bytes,pageInfo:{hasNextPage:false},edges:[{size:bytes,node:{name:'Go',color:'#00ADD8'}}]}});
function fixture(options={}) {
  const calls=[];
  const shared=repo('private-repo',200,true);
  const calendar={totalContributions:9,weeks:[{contributionDays:[
    {date:'2026-11-15',contributionCount:4,contributionLevel:'THIRD_QUARTILE'},
    {date:'2026-11-16',contributionCount:5,contributionLevel:'FOURTH_QUARTILE'},
    {date:'2026-11-17',contributionCount:0,contributionLevel:'NONE'},
  ]}]};
  const main={viewer:{login:options.viewer??'bos-code'},user:{followers:{totalCount:10},contributionsCollection:{
    restrictedContributionsCount:3,totalCommitContributions:4,totalIssueContributions:1,totalPullRequestReviewContributions:2,
    contributionCalendar:calendar,commitContributionsByRepository:[{repository:shared}],
    pullRequestContributionsByRepository:[{repository:shared},{repository:repo('fork',1000,false,true)}]}},
    opened:{issueCount:8},merged:{issueCount:10}};
  const fetcher=async(url,init)=>{
    assert.equal(url,'https://api.github.com/graphql');
    assert.equal(init.headers.Authorization,'Bearer TEST-PRIVATE-TOKEN');
    const body=JSON.parse(init.body); calls.push(body);
    const data=body.query.includes('query Profile')?main:{user:{repositories:{
      nodes:body.variables.cursor?[repo('second-page',50)]:[shared,repo('public',100)],
      pageInfo:body.variables.cursor?{hasNextPage:false,endCursor:null}:{hasNextPage:true,endCursor:'next'},
    }}};
    if (options.mutate) options.mutate(data,body);
    return {ok:true,json:async()=>({data})};
  };
  return {calls,fetcher,main};
}
const config={username:'bos-code',token:'TEST-PRIVATE-TOKEN',personalToken:true,now:new Date('2026-11-17T12:00:00Z')};
test('private repo languages are included, deduplicated, paginated and forks excluded',async()=>{
  const f=fixture(),s=await collect({...config,fetcher:f.fetcher});
  assert.equal(s.languages[0].bytes,350);
  assert.equal(s.privateRepos,1);
  assert.equal(s.metrics.stars,8);
  assert.equal(s.metrics.prs,8); assert.equal(s.metrics.merged,10);
  assert.equal(s.calendar.totalContributions,9); // restricted 3 is already in total
  assert.equal(f.calls.length,3);
  assert.match(f.calls[0].variables.opened,/created:2025-11-17T12:00:00.000Z/);
  assert.match(f.calls[0].variables.merged,/merged:2025-11-17T12:00:00.000Z/);
});
test('wrong-owner personal token fails instead of claiming private coverage',async()=>{
  await assert.rejects(collect({...config,fetcher:fixture({viewer:'another-user'}).fetcher}),/profile owner/);
});
test('coverage remains in metadata without profile footnotes',async()=>{
  const s=await collect({...config,personalToken:false,fetcher:fixture().fetcher});
  const dir=await mkdtemp(join(tmpdir(),'profile-limited-'));
  try {const files=await generate(s,dir); assert.doesNotMatch(files['stats-dark.svg'],/Limited access|PROFILE_STATS_TOKEN|private access/); assert.match(files['profile-summary.json'],/Limited access/);} finally {await rm(dir,{recursive:true});}
});
test('API failures and partial GraphQL responses do not generate zero-filled stats',async()=>{
  await assert.rejects(collect({...config,fetcher:async()=>({ok:false,status:401})}),/401/);
  await assert.rejects(collect({...config,fetcher:async()=>({ok:true,json:async()=>({data:{},errors:[{message:'private content'}]})})}),/GraphQL failed/);
});
test('truncated repository/language lists and inconsistent calendars fail',async()=>{
  for (const mutate of [
    d=>{if(d.user?.contributionsCollection)d.user.contributionsCollection.contributionCalendar.totalContributions=999;},
    d=>{if(d.user?.contributionsCollection)d.user.contributionsCollection.commitContributionsByRepository=Array(100).fill({repository:repo('x',1)});},
    d=>{if(d.user?.repositories)d.user.repositories.nodes[0].languages.pageInfo.hasNextPage=true;},
  ]) await assert.rejects(collect({...config,fetcher:fixture({mutate}).fetcher}));
});
test('streak handles unfinished today, a real break and missing dates',()=>{
  const days=counts=>counts.map((n,i)=>({date:`2026-11-${String(i+10).padStart(2,'0')}`,contributionCount:n}));
  assert.deepEqual(streaks(days([2,2,0])),{current:2,longest:2});
  assert.deepEqual(streaks(days([2,0,0])),{current:0,longest:1});
  assert.deepEqual(streaks(days([2,0,1])),{current:1,longest:1});
  assert.deepEqual(streaks([{date:'2026-11-10',contributionCount:2},{date:'2026-11-12',contributionCount:1}]),{current:1,longest:1});
});
test('upstream rank formula boundaries and monotonicity',()=>{
  const zero={commits:0,prs:0,issues:0,reviews:0,stars:0,followers:0};
  assert.deepEqual(calculateRank(zero),{level:'C',percentile:100});
  const median={commits:250,prs:50,issues:25,reviews:2,stars:50,followers:10};
  assert.deepEqual(calculateRank(median),{level:'B+',percentile:50});
  assert.equal(calculateRank(Object.fromEntries(Object.keys(zero).map(k=>[k,1e8]))).level,'S');
  assert.ok(calculateRank({...median,prs:100}).percentile<50);
});
test('all twelve SVGs and aggregate JSON share one snapshot without private identifiers',async()=>{
  const s=await collect({...config,fetcher:fixture().fetcher}),dir=await mkdtemp(join(tmpdir(),'profile-'));
  try {
    const files=await generate(s,dir);
    assert.equal(Object.keys(files).filter(p=>p.endsWith('.svg')).length,12);
    const output=Object.values(files).join('\n');
    for(const secret of ['TEST-PRIVATE-TOKEN','private-repo','PRIVATE-NAME-MUST-NOT-LEAK']) assert.ok(!output.includes(secret));
    for(const theme of ['dark','light']) {
      assert.match(files[`stats-${theme}.svg`],/PRs merged/);
      assert.match(files[`stats-${theme}.svg`],/Activity rank/);
      assert.doesNotMatch(files[`top-langs-${theme}.svg`],/Private repositories|none visible/);
      assert.match(files[`typing-${theme}.svg`],/attributeName="width"/);
      assert.match(files[`typing-${theme}.svg`],/calcMode="discrete"/);
      assert.match(files[`typing-${theme}.svg`],/Go · Python/);
      assert.match(files[`commit-activity-${theme}.svg`],/9 total/);
    }
    const saved=JSON.parse(await readFile(join(dir,'profile-summary.json'),'utf8'));
    assert.equal(saved.contributions,9); assert.equal(saved.updatedAt,s.updatedAt);
    assert.equal(saved.streak.current,2);
    assert.match(files['github-contribution-grid-snake.svg'],/#0F8B8D/);
  } finally {await rm(dir,{recursive:true});}
});
