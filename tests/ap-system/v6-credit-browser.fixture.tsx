import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {APSystemCorrections} from '../../console/src/APSystemCorrections';
import {apSystemApi} from '../../console/src/apSystemApi';
const fixture=(window as any).v6Data,deferred:any[]=[],posts:any[]=[];
Object.assign(window,{v6Deferred:deferred,v6Posts:posts});
apSystemApi.corrections=async()=>fixture.view;
apSystemApi.creditApplication=(_case,id,signal)=>new Promise(resolve=>deferred.push({id,signal,resolve}));
apSystemApi.proposeCorrection=async input=>{posts.push(input);return{};};
apSystemApi.payment=async()=>{throw Error('Unexpected payment read in zero-cash credit review');};
function Harness(){const[detail,setDetail]=useState(fixture.detail);return <><button onClick={()=>setDetail({...detail,snapshotHash:'f'.repeat(64)})}>Revise case snapshot</button><APSystemCorrections detail={detail} busy={false} onBusy={()=>{}} onChanged={()=>{}}/></>;}
createRoot(document.getElementById('root')!).render(<Harness/>);
