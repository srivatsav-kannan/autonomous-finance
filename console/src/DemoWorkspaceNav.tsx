import { isApexWorkspace } from "./apRuntime";
import "./demoWorkspace.css";
export function DemoWorkspaceNav({ busy = false }: { busy?: boolean }) {
 const apex=isApexWorkspace(), params=new URLSearchParams(location.search); const ap=params.get("view")==="ap-system" || location.pathname==="/ap-system"; const learning=ap&&params.get("apWorkspace")==="learning";
 const learningPath=`/ap-system?view=ap-system&apWorkspace=learning${apex?"&apRuntime=apex":""}`;
 return <nav onClick={event => { if (busy) event.preventDefault(); }} className="demo-workspace-nav" aria-label="Finance workspaces"><span>Finance workspace</span><a aria-disabled={busy || undefined} tabIndex={busy ? -1 : undefined} aria-current={!ap?"page":undefined} href="/?view=inbox#finance-workbench">Operations inbox</a><a aria-disabled={busy || undefined} tabIndex={busy ? -1 : undefined} aria-current={ap&&!apex&&!learning?"page":undefined} href="/ap-system?view=ap-system">Connected AP</a><a aria-disabled={busy || undefined} tabIndex={busy ? -1 : undefined} aria-current={ap&&apex&&!learning?"page":undefined} href="/ap-system?view=ap-system&apRuntime=apex">APEX demo</a><a aria-disabled={busy || undefined} tabIndex={busy ? -1 : undefined} aria-current={learning?"page":undefined} href={learningPath}>Learning &amp; demo</a></nav>;
}
