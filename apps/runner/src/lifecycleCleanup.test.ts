import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbPool } from "@aisevak/core";
const mocks=vi.hoisted(()=>({archive:vi.fn(),remove:vi.fn(),live:vi.fn().mockResolvedValue(false)}));
vi.mock("./appServerClient.js",()=>({cachedCodexProcessIds:()=>[],closeIdleCodexSession:async()=>true,setCodexThreadArchived:mocks.archive}));
vi.mock("./acpClient.js",()=>({cachedAcpProcessIds:()=>[],closeIdleAcpSession:async()=>true}));
vi.mock("./worktreeCleanup.js",async original=>({...await original<typeof import('./worktreeCleanup.js')>(),hasLiveWorktreeProcess:mocks.live,removeCleanManagedWorktree:mocks.remove}));
import { sweepLifecycleCleanup } from "./lifecycleCleanup.js";
let root:string;
afterEach(async()=>{vi.clearAllMocks();mocks.archive.mockReset();mocks.live.mockResolvedValue(false);if(root)await rm(root,{recursive:true,force:true});});
async function fixture(options:{restore?:boolean;busy?:boolean;shared?:boolean}={}) {
 root=await realpath(await mkdtemp(join(tmpdir(),"aisevak-lifecycle-")));
 const home=join(root,"codex-homes","chat");await mkdir(join(home,".agents","skills"),{recursive:true});await writeFile(join(home,"history.jsonl"),"retained transcript");
 const thread={id:'chat',task_id:'task',runtime_home:home,provider_thread_id:'provider',driver:'codex',archived_at:options.restore?null:new Date(),cleanup_state:options.restore?'restoring':'pending',provider_archived_at:null};
 const queries:Array<{sql:string;params:unknown[]}>=[];
 const query=async(sql:string,params:unknown[]=[])=>{queries.push({sql,params});
  if(sql.includes("SELECT id, task_id FROM agent_threads"))return {rows:[{id:'chat',task_id:'task'}]};
  if(sql.includes('provider_instances.driver'))return {rows:[thread]};
  if(sql.includes('SELECT 1 FROM (SELECT agent_thread_id'))return {rows:options.busy?[{id:'run'}]:[]};
  if(sql.includes('runtime_home = $2'))return {rows:options.shared?[{id:'another-chat'}]:[]};
  return {rows:[]};};
 const pool={query,connect:async()=>({query,release(){}})} as unknown as DbPool;
 return {home,thread,queries,pool};
}
describe('durable lifecycle cleanup',()=>{
 it('archives Codex and removes generated skills while retaining chat history',async()=>{
  const f=await fixture();await sweepLifecycleCleanup(f.pool,root,'codex');
  expect(mocks.archive).toHaveBeenCalledWith(expect.anything(),'provider',true);
  await expect(lstat(join(f.home,'.agents','skills'))).rejects.toMatchObject({code:'ENOENT'});
  expect(await readFile(join(f.home,'history.jsonl'),'utf8')).toBe('retained transcript');
  expect(f.queries.some(q=>q.sql.includes("ELSE 'done' END"))).toBe(true);
 });
 it.each(['busy','shared'] as const)('defers %s owners without touching their provider',async(flag)=>{
  const f=await fixture({[flag]:true});await sweepLifecycleCleanup(f.pool,root,'codex');
  expect(mocks.archive).not.toHaveBeenCalled();expect(await lstat(join(f.home,'.agents','skills'))).toBeTruthy();
  expect(f.queries.some(q=>q.sql.includes('SET cleanup_error = $2'))).toBe(true);
 });
 it('retains pending retry state after archive RPC failure',async()=>{
  const f=await fixture();mocks.archive.mockRejectedValue(new Error('provider unavailable'));
  await sweepLifecycleCleanup(f.pool,root,'codex');
  expect(f.queries.find(q=>q.sql.includes('SET cleanup_error = $2'))?.params).toEqual(['chat','provider unavailable']);
  expect(f.queries.some(q=>q.sql.includes("ELSE 'done' END"))).toBe(false);
 });
 it('always unarchives a restore request, including a prior DB failure',async()=>{
  const f=await fixture({restore:true});await sweepLifecycleCleanup(f.pool,root,'codex');
  expect(mocks.archive).toHaveBeenCalledWith(expect.anything(),'provider',false);
  expect(await lstat(join(f.home,'.agents','skills'))).toBeTruthy();
 });
});

describe("completed task cleanup",()=>{
 it.each([false,true])("guards queued turns before removing a terminal checkout, busy=%s",async busy=>{
  root=await realpath(await mkdtemp(join(tmpdir(),"aisevak-terminal-cleanup-")));
  const worktree={task_id:'task',path:join(root,'worktrees','task','branch'),repo:join(root,'repo'),branch:'agent/branch'};
  const queries:Array<{sql:string;params:unknown[]}>=[];
  const query=async(sql:string,params:unknown[]=[])=>{queries.push({sql,params});
   if(sql.includes('SELECT DISTINCT runs.task_id'))return {rows:[worktree]};
   if(sql.startsWith('SELECT status FROM tasks'))return {rows:[{status:'completed'}]};
   if(sql.includes(') runs WHERE status'))return {rows:busy?[{id:'queued'}]:[]};
   return {rows:[]};};
  await sweepLifecycleCleanup({query,connect:async()=>({query,release(){}})} as unknown as DbPool,root,'codex');
  if(busy)expect(mocks.remove).not.toHaveBeenCalled();
  else expect(mocks.remove).toHaveBeenCalledWith({root,repo:worktree.repo,path:worktree.path,branch:worktree.branch});
  const saved=queries.find(q=>q.sql.includes('INSERT INTO worktree_cleanup_attempts'));
  expect(saved?.params[1]).toBe(busy?'Queued or active runs still own this worktree':null);
 });
});
