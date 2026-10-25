import type {ContactChangeInputs,ContactChangeOperation,SupplierContactView} from "./supplier-contact-contracts";
export type SupplierContactWorkspaceView=SupplierContactView&{controllerProposalAvailable:boolean};
export type SupplierContactOperations={view:()=>Promise<SupplierContactWorkspaceView>;execute:<K extends ContactChangeOperation>(operation:K,input:ContactChangeInputs[K])=>Promise<unknown>};
