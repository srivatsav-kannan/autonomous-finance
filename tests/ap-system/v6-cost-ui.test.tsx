import {expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {APSystemBusiness} from '../../console/src/APSystemBusiness';
import {apUIFixture} from '../ap-system-ui.fixture';
it('offers an explicit credit posting date because a corrected cost reversal cannot predate its cost history',()=>{
 const detail=apUIFixture();detail.candidate!.kind='credit_note';detail.domain={policyVersion:'v6-policy',supplierId:detail.candidate!.supplierId,supplierRevision:1,approvalId:null,approvalHash:null,approvalStatus:'not_proposed',route:[],stage:0,stageStartedAt:null,votes:[],acceptance:null,credit:null,creditLinks:[],recognizedCents:0,appliedCreditCents:0,availableSupplierCreditCents:0,cashSettledCents:0};
 const html=renderToStaticMarkup(<APSystemBusiness detail={detail} cases={[detail]} busy={false} onBusy={()=>{}} onChanged={()=>{}} onOpenCase={()=>{}}/>);
 expect(html).toContain('Propose a linked supplier credit');expect(html).toContain('type="date"');
});
