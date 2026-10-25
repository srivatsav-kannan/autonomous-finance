// Independent mounted UI harness. Synthetic data and deferred API only, no backend or provider.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {APCostCorrection,type CostReview} from '../../console/src/APCostCorrection';
import {apSystemApi} from '../../console/src/apSystemApi';
import type {BusinessPolicy} from '../../src/ap-system/domain-contracts';
import type {CostState} from '../../src/ap-system/cost-contracts';
type Deferred={id:string;signal?:AbortSignal;resolve:(value:CostState)=>void};
const deferred:Deferred[]=[];
apSystemApi.costState=(id,signal)=>new Promise(resolve=>deferred.push({id,signal,resolve}));
Object.assign(window,{v6Deferred:deferred});
const policy={accounts:[{account:'5000',treatment:'expense'},{account:'1200',treatment:'inventory'}]} as BusinessPolicy;
function Harness(){
 const [id,setId]=useState('A'),[context,setContext]=useState('first'),[review,setReview]=useState<CostReview>();
 return <><button onClick={()=>{setId('B');setContext('second');}}>Switch original</button><button onClick={()=>setContext('revised')}>Revise parent context</button><output data-testid="ready">{String(review?.context===context&&review.ready)}</output><APCostCorrection originalEntryId={id} context={context} policy={policy} sources={[{name:'Independent source',sourceId:'evidence',revision:1,sha256:'e'.repeat(64)}]} busy={false} onChange={setReview}/></>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
