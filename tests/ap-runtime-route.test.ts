import { afterEach, expect, it, vi } from 'vitest';
import { apRequestPath } from '../console/src/apRuntime';
import { apProtectedFetch, configureAPSession } from '../console/src/apAuthSession';
afterEach(()=>{configureAPSession(null);vi.unstubAllGlobals();});
it('keeps the connected gateway and APEX proxy paths separate',()=>{
 expect(apRequestPath('/api/ap-system/sources/id/revisions/2',false)).toBe('/api/ap-system/sources/id/revisions/2');
 expect(apRequestPath('/api/ap-system/sources/id/revisions/2',true)).toBe('/api/apex/sources/id/revisions/2');
});
it('routes only a selected local APEX session to its proxy',async()=>{
 vi.stubGlobal('window',{location:{search:'?apRuntime=apex'}});
 configureAPSession({mode:'local_simulation',actorId:'treasury',expired:()=>{}});
 const fetcher=vi.fn().mockResolvedValue(new Response('{}'));vi.stubGlobal('fetch',fetcher);
 await apProtectedFetch('/api/ap-system/cases');
 expect(fetcher.mock.calls[0]![0]).toBe('/api/apex/cases');
 expect(new Headers(fetcher.mock.calls[0]![1].headers).get('Authorization')).toBe('Bearer local:treasury');
});
it('never sends an existing sandbox token after the runtime selection changes',async()=>{
 vi.stubGlobal('window',{location:{search:''}});
 configureAPSession({mode:'auth0',token:async()=> 'sandbox-token',expired:()=>{}});
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 window.location.search='?apRuntime=apex';
 await expect(apProtectedFetch('/api/ap-system/cases')).rejects.toMatchObject({code:'session_changed'});
 expect(fetcher).not.toHaveBeenCalled();
});
