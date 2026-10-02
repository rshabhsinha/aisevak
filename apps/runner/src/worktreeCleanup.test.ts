import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, lstat, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeCleanManagedWorktree, recreateManagedWorktree, hasLiveWorktreeProcess } from "./worktreeCleanup.js";
const exec=promisify(execFile); let roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture() {
 const root=await realpath(await mkdtemp(join(tmpdir(),"aisevak-cleanup-")));roots.push(root);
 const repo=join(root,"repo"),path=join(root,"worktrees","task","agent-branch");await mkdir(repo);await mkdir(join(root,"worktrees","task"),{recursive:true});
 const git=async(args:string[],cwd=repo)=>(await exec("git",args,{cwd})).stdout;
 await git(["init"]);await git(["symbolic-ref","HEAD","refs/heads/main"]);await git(["config","user.email","test@example.com"]);await git(["config","user.name","Test"]);
 await writeFile(join(repo,".gitignore"),"node_modules/\nlocal-secret\n");await git(["add","."]);await git(["commit","-m","initial"]);
 await git(["worktree","add","-b","agent/branch",path]);
 return {root,repo,path,branch:"agent/branch",git,hasLiveProcess:async()=>false};
}
describe("managed worktree cleanup",()=>{
 it("removes a clean checkout with dependencies and recreates its unpushed branch",async()=>{
  const f=await fixture();await writeFile(join(f.path,"kept.txt"),"unpushed work");await f.git(["add","."],f.path);await f.git(["commit","-m","unpushed"],f.path);
  const head=(await f.git(["rev-parse","HEAD"],f.path)).trim();await mkdir(join(f.path,"node_modules"));await writeFile(join(f.path,"node_modules","cache"),"rebuildable");
  await removeCleanManagedWorktree(f);await expect(lstat(f.path)).rejects.toMatchObject({code:"ENOENT"});
  await recreateManagedWorktree(f.repo,f.path,f.branch,"main");expect((await f.git(["rev-parse","HEAD"],f.path)).trim()).toBe(head);
 });
 it.each(["tracked","untracked","ignored","busy","symlink","primary"])("protects %s workspaces",async(kind)=>{
  const f=await fixture();
  if(kind==="tracked") await writeFile(join(f.path,".gitignore"),"modified");
  if(kind==="untracked") await writeFile(join(f.path,"work.txt"),"untracked");
  if(kind==="ignored") await writeFile(join(f.path,"local-secret"),"keep");
  if(kind==="busy") f.hasLiveProcess=async()=>true;
  if(kind==="symlink") {await f.git(["worktree","remove",f.path]);await symlink(f.repo,f.path);}
  if(kind==="primary") f.path=f.repo;
  await expect(removeCleanManagedWorktree(f)).rejects.toThrow();expect(await lstat(f.path)).toBeTruthy();
 });
});

describe("Linux process liveness",()=>{
 it("protects a still-existing process whose main thread cwd is gone",async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),"aisevak-proc-test-")));roots.push(root);
  await mkdir(join(root,"123"));await writeFile(join(root,"123","status"),"State:\tZ (zombie leader)\nThreads:\t2\n");
  await expect(hasLiveWorktreeProcess("/worktree",[],root)).rejects.toThrow("Cannot verify liveness");
 });
 it("ignores a confirmed zombie without a cwd",async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),"aisevak-proc-test-")));roots.push(root);
  await mkdir(join(root,"123"));await writeFile(join(root,"123","status"),"State:\tZ (zombie)\nThreads:\t1\n");
  expect(await hasLiveWorktreeProcess("/worktree",[],root)).toBe(false);
 });
});
