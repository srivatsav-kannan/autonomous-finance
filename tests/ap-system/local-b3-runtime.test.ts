import {expect,it} from "vitest";
import {assertLocalB3Deployment,localB3Actors} from "../../src/ap-system/local-b3-runtime";
it("refuses every existing I1 and external backend before any local identity or environment write",()=>{
 for(const cloud of [3250,3252,3240])expect(()=>assertLocalB3Deployment({ports:{cloud,site:cloud+1},adminKey:"test-only"})).toThrow();
 expect(()=>assertLocalB3Deployment({ports:{cloud:3254,site:3253},adminKey:"test-only"})).toThrow();
 expect(assertLocalB3Deployment({ports:{cloud:3254,site:3255},adminKey:"test-only"}).ports).toEqual({cloud:3254,site:3255});
 expect(new Set(localB3Actors.map(a=>a.subject)).size).toBe(7);expect(localB3Actors.every(a=>a.name.startsWith("Simulated "))).toBe(true);
});
