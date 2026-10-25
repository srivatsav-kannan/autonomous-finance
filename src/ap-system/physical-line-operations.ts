import type {PhysicalLineView,PhysicalLineInputs} from "./physical-line-contracts";
export type PhysicalLineWorkspaceView=PhysicalLineView&{controllerProposalAvailable:boolean};
export type PhysicalLineOperation=keyof PhysicalLineInputs;
export type PhysicalLineOperations={view:(caseId?:string)=>Promise<PhysicalLineWorkspaceView>;execute:<K extends PhysicalLineOperation>(operation:K,input:PhysicalLineInputs[K])=>Promise<unknown>};
