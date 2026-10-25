import { isApexWorkspace } from "./apRuntime";
import "./demoWorkspace.css";
export function DemoWorkspaceNav({ busy = false }: { busy?: boolean }) {
 const apex=isApexWorkspace(); const ap=new URLSearchParams(location.search).get("view")==="ap-system" || location.pathname==="/ap-system";
 return <nav onClick={event => { if (busy) event.preventDefault(); }} className="demo-workspace-nav" aria-label="Finance workspaces"><span>Finance workspace</span><a aria-disabled={busy || undefined} tabIndex={busy ? -1 : undefined} aria-current={!ap?"page":undefined} href="/?view=inbox#finance-workbench">Operations inbox</a><a aria-disabled={busy || undefined} tabIndex={busy ? -1 : undefined} aria-current={ap&&!apex?"page":undefined} href="/ap-system?view=ap-system">Connected AP</a><a aria-disabled={busy || undefined} tabIndex={busy ? -1 : undefined} aria-current={ap&&apex?"page":undefined} href="/ap-system?view=ap-system&apRuntime=apex">APEX demo</a></nav>;
}
