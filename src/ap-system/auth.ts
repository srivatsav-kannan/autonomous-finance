import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { z } from "zod";
import { APHttpError, type APExternalAuthentication, type APWorkspaceService } from "./server";

const identitySchema=z.object({tokenIdentifier:z.string().min(1),issuer:z.string().url(),subject:z.string().min(1)});
export type APAuth0Config={issuer:string;domain:string;clientId:string;approvedSubject?:string};
export function parseAPAuth0Config(env:Record<string,string|undefined>):APAuth0Config {
 const raw=env.AP_HUMAN_AUTH_ISSUER, clientId=env.AP_HUMAN_AUTH_AUDIENCE;
 if(!raw || !clientId?.trim())throw new Error("Set AP_HUMAN_AUTH_ISSUER and AP_HUMAN_AUTH_AUDIENCE for the Auth0 SPA application.");
 const url=new URL(raw);
 if(url.protocol!=="https:" || !url.hostname.endsWith(".auth0.com") || url.port || url.username || url.password || url.search || url.hash || url.pathname!=="/")throw new Error("Use the HTTPS Auth0 development tenant issuer, including its trailing slash.");
 const issuer=url.origin+"/";
 if(raw!==issuer)throw new Error("AP_HUMAN_AUTH_ISSUER must exactly match the Auth0 issuer including its trailing slash.");
 const approvedSubject=env.AP_HUMAN_SUBJECT?.trim() || undefined;
 if(approvedSubject && !approvedSubject.startsWith(issuer+"|"))throw new Error("AP_HUMAN_SUBJECT must be the approved issuer|subject tokenIdentifier from this tenant.");
 return {issuer,domain:url.hostname,clientId:clientId.trim(),approvedSubject};
}
/** Convex verifies signature, issuer, audience and expiry before whoami can run.
 * Each request owns its client; there is no shared human token or admin impersonation. */
export function createAPExternalAuthentication(options:{config:APAuth0Config;convexUrl:string;service:(human:ConvexHttpClient)=>APWorkspaceService;authorize:(human:ConvexHttpClient)=>Promise<void>;clientFactory?:(url:string)=>ConvexHttpClient}):APExternalAuthentication {
 return {
  publicConfig:{mode:"auth0",domain:options.config.domain,clientId:options.config.clientId},
  async authenticate(token){
   const human=(options.clientFactory??(url=>new ConvexHttpClient(url)))(options.convexUrl);
   human.setAuth(token);
   let identity:z.infer<typeof identitySchema>;
   try{identity=identitySchema.parse(await human.query(makeFunctionReference<"query">("apIdentity:whoami"),{}));}
   catch{human.clearAuth();throw new APHttpError("authentication_required",401,"Your sign-in is invalid or expired. Sign in again.");}
   if(identity.issuer!==options.config.issuer || identity.tokenIdentifier!==`${identity.issuer}|${identity.subject}`){human.clearAuth();throw new APHttpError("authentication_required",401,"This identity does not belong to the configured issuer.");}
   let approved=!!options.config.approvedSubject && identity.tokenIdentifier===options.config.approvedSubject;
   if(approved){try{await options.authorize(human);}catch{approved=false;}}
   return {subject:identity.tokenIdentifier,issuer:identity.issuer,approved,service:options.service(human)};
  },
 };
}
