import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const exec=promisify(execFile), publisher=resolve('scripts/publish-codex-runtime.sh');
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(version='v1',root?:string) {
 root??=await realpath(await mkdtemp(join(tmpdir(),'aisevak codex runtime ')));if(!roots.includes(root))roots.push(root);
 const vendor=join(root,'source '+version), harness=join(root,'shared harness');
 await mkdir(join(vendor,'bin'),{recursive:true});await mkdir(join(vendor,'codex-path'));await mkdir(join(vendor,'codex-resources'));
 await writeFile(join(vendor,'bin','codex'),`#!/bin/sh\nif [ "\${1:-}" = --version ]; then echo codex-${version}; exit 0; fi\nruntime="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\ncat "$runtime/codex-resources/marker"\n"$runtime/bin/codex-code-mode-host" "$@"\nrg\n`);
 await writeFile(join(vendor,'bin','codex-code-mode-host'),`#!/bin/sh\nprintf 'host:${version}|%s|%s\\n' "$1" "$PWD"\n`);
 await writeFile(join(vendor,'codex-path','rg'),`#!/bin/sh\necho rg:${version}\n`);
 await writeFile(join(vendor,'codex-resources','marker'),`resource:${version}\n`,{mode:0o600});
 await chmod(join(vendor,'codex-resources'),0o700);
 for(const file of ['bin/codex','bin/codex-code-mode-host','codex-path/rg'])await chmod(join(vendor,file),0o755);
 return {root,vendor,harness,native:join(vendor,'bin','codex')};
}
describe('Codex native runtime publication',()=>{
 it('executes the sibling host and packaged tools/resources without the npm source tree',async()=>{
  const f=await fixture();await exec('bash',[publisher,f.native,f.harness,'release-1']);
  await rm(f.vendor,{recursive:true});
  const {stdout}=await exec(join(f.harness,'codex'),['argument with spaces'],{cwd:f.root});
  expect(stdout).toBe(`resource:v1\nhost:v1|argument with spaces|${f.root}\nrg:v1\n`);
  const bundle=(await readdir(f.harness)).find(name=>name.startsWith('codex-runtime-'))!;
  expect((await stat(join(f.harness,bundle,'codex-resources','marker'))).mode&0o004).toBe(4);
  expect((await stat(join(f.harness,bundle,'codex-resources'))).mode&0o001).toBe(1);
 });
 it('keeps the previous executable and companions together across upgrades',async()=>{
  const first=await fixture();await exec('bash',[publisher,first.native,first.harness,'release-1']);
  const old=join(first.harness,'old-codex');await copyFile(join(first.harness,'codex'),old);
  const second=await fixture('v2',first.root);await exec('bash',[publisher,second.native,second.harness,'release-2']);
  expect((await exec(join(first.harness,'codex'),['probe'],{cwd:first.root})).stdout).toContain('host:v2|probe|');
  expect((await exec(old,['probe'],{cwd:first.root})).stdout).toContain('host:v1|probe|');
  expect((await readdir(first.harness)).filter(name=>name.startsWith('codex-runtime-'))).toHaveLength(2);
 });
 it('reuses unchanged package contents across repeated deployments',async()=>{
  const f=await fixture();await exec('bash',[publisher,f.native,f.harness,'release-1']);
  await exec('bash',[publisher,f.native,f.harness,'release-2']);
  expect((await readdir(f.harness)).filter(name=>name.startsWith('codex-runtime-'))).toHaveLength(1);
  expect((await exec(join(f.harness,'codex'),['probe'],{cwd:f.root})).stdout).toContain('host:v1|probe|');
 });
 it('rejects an incomplete package without replacing the working launcher',async()=>{
  const first=await fixture();await exec('bash',[publisher,first.native,first.harness,'release-1']);
  const launcher=await readFile(join(first.harness,'codex'),'utf8');
  const broken=await fixture('v2',first.root);await rm(join(broken.vendor,'bin','codex-code-mode-host'));
  await expect(exec('bash',[publisher,broken.native,broken.harness,'release-2'])).rejects.toThrow('runtime is incomplete');
  expect(await readFile(join(first.harness,'codex'),'utf8')).toBe(launcher);
  expect((await readdir(first.harness)).filter(name=>name.startsWith('.'))).toEqual([]);
 });
 it('cleans a failed startup probe and retains the prior runtime',async()=>{
  const first=await fixture();await exec('bash',[publisher,first.native,first.harness,'release-1']);
  const before=await readdir(first.harness),broken=await fixture('v2',first.root);
  await writeFile(broken.native,'#!/bin/sh\nexit 47\n');
  await expect(exec('bash',[publisher,broken.native,broken.harness,'release-2'])).rejects.toMatchObject({code:47});
  expect(await readdir(first.harness)).toEqual(before);
 });
});
