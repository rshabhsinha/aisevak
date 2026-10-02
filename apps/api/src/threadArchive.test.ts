import { describe, expect, it } from "vitest";
import type { DbPool } from "@aisevak/core";
import { assertThreadAcceptsInput, setThreadArchived } from "./threadArchive.js";
function fixture(archived=false) {
 const queries:string[]=[];const params:unknown[][]=[];
 const query=async(sql:string,args:unknown[]=[])=>{queries.push(sql);params.push(args);
  if(sql.startsWith("SELECT task_id")) return {rows:[{task_id:"task",archived_at:archived ? new Date():null}]};
  return {rows:[]};};
 return {queries,params,pool:{query,connect:async()=>({query,release(){}})} as unknown as DbPool};
}
describe("chat archive",()=>{
 it("fences and cancels every turn while preserving history",async()=>{
  const f=fixture();await setThreadArchived(f.pool,"chat",true);
  expect(f.queries.findIndex(sql=>sql.includes("FROM tasks"))).toBeLessThan(f.queries.findIndex(sql=>sql.includes("FROM agent_threads")&&sql.includes("FOR UPDATE")));
  expect(f.queries.some(sql=>sql.includes("ownership_generation = ownership_generation + 1"))).toBe(true);
  for(const table of ["task_runs","dispatcher_runs"]) {
   const update=f.queries.find(sql=>sql.startsWith(`UPDATE ${table}`));
   expect(update).toContain("status IN ('queued','running','cancel_requested')");expect(update).not.toContain("LIMIT 1");
  }
  expect(f.queries.filter(sql=>sql.startsWith("DELETE"))).toEqual(["DELETE FROM agent_tool_tokens WHERE agent_thread_id = $1"]);
 });
 it("restores through a durable provider barrier",async()=>{
  const f=fixture(true);await setThreadArchived(f.pool,"chat",false);
  expect(f.params.some(args=>args[0]==="chat"&&args[1]===false)).toBe(true);
  expect(f.queries.some(sql=>sql.includes("'restoring'"))).toBe(true);
  expect(f.queries.some(sql=>sql.startsWith("UPDATE task_runs"))).toBe(false);
 });
 it("makes repeated archive calls idempotent",async()=>{
  const f=fixture(true);await setThreadArchived(f.pool,"chat",true);
  expect(f.queries.some(sql=>sql.startsWith("UPDATE"))).toBe(false);
 });
 it.each([{archived_at:new Date(),cleanup_state:'pending'},{archived_at:null,cleanup_state:'restoring'}])("blocks input while archived or restoring",async(thread)=>{
  const client={query:async()=>({rows:[thread]})};
  await expect(assertThreadAcceptsInput(client as never,"chat")).rejects.toMatchObject({statusCode:409});
 });
});
