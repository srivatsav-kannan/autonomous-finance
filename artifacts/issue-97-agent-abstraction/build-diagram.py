"""Build an editable Excalidraw architecture diagram; no raster image editing."""
import json
from pathlib import Path

ROOT = Path(__file__).parent
elements = []
by_id = {}
seq = 0
INK = '#23342c'
MUTED = '#53675a'
GREEN = '#2f6b4f'
BLUE = '#4263a3'
AMBER = '#a86421'

def base(kind, x, y, w, h, *, stroke=INK, fill='transparent', group=None):
    global seq
    seq += 1
    e = dict(id=f'ap-architecture-{seq:03}', type=kind, x=x, y=y, width=w, height=h,
             angle=0, strokeColor=stroke, backgroundColor=fill, fillStyle='solid',
             strokeWidth=2, strokeStyle='solid', roughness=1, opacity=100,
             groupIds=[group] if group else [], frameId=None, roundness=None,
             seed=7000+seq*103, version=1, versionNonce=9000+seq*107,
             isDeleted=False, boundElements=None, updated=1792893600000,
             created=1792893600000, link=None, locked=False)
    elements.append(e)
    by_id[e['id']] = e
    return e

def text(x, y, w, value, size=24, color=INK, group=None, family=2):
    h = len(value.split('\n')) * size * 1.3
    e = base('text', x, y, w, h, stroke=color, group=group)
    e.update(text=value, originalText=value, fontSize=size, fontFamily=family,
             textAlign='left', verticalAlign='top', containerId=None,
             autoResize=False, lineHeight=1.3, baseline=size)
    return e

def box(x,y,w,h,title,body,tag,fill,stroke,body_size=22):
    group=f'group-{seq+1}'
    r=base('rectangle',x,y,w,h,stroke=stroke,fill=fill,group=group)
    r['roundness']={'type':3}
    text(x+24,y+19,w-48,tag,18,stroke,group)
    text(x+24,y+51,w-48,title,29,INK,group,1)
    text(x+24,y+101,w-48,body,body_size,MUTED,group)
    return r

def arrow(points, color=MUTED, dashed=False, start=None, end=None):
    x,y=points[0]
    rel=[[px-x,py-y] for px,py in points]
    e=base('arrow',x,y,max(p[0] for p in rel)-min(p[0] for p in rel),
           max(p[1] for p in rel)-min(p[1] for p in rel),stroke=color)
    e.update(points=rel,lastCommittedPoint=None,startBinding=None,endBinding=None,
             startArrowhead=None,endArrowhead='arrow',elbowed=False)
    if dashed: e['strokeStyle']='dashed'
    for key,shape in [('startBinding',start),('endBinding',end)]:
        if shape:
            e[key]={'elementId':shape['id'],'focus':0,'gap':10}
            shape['boundElements']=(shape['boundElements'] or [])+[{'id':e['id'],'type':'arrow'}]
    return e

# Title and compact authority legend.
text(90,45,1770,'Autonomous AP — shared capabilities, one connected case',43,INK,family=1)
text(93,110,1940,'The agent chooses a useful next step. The backend enforces authority. Workers record observed outcomes.',24,MUTED)
text(95,165,440,'A  AGENT TOOLS',18,BLUE)
text(600,165,440,'H  HUMAN DECISIONS',18,AMBER)
text(1135,165,650,'S  TRUSTED SERVICE OPERATIONS',18,GREEN)

events=box(90,235,360,245,'Case events','Invoice or receipt arrives\nApproval or due date\nBank observation','1  TRIGGERS','#f1f3f0',MUTED)
worker=box(570,235,430,245,'Durable case worker','Own task + wake conditions\nLease, retry, wait, escalate\nResume from saved records','2  ORCHESTRATION','#e5f1e8',GREEN)
agent=box(1120,235,420,245,'Agent reasoning','Inspect evidence\nChoose permitted next action\nPrepare proposal + explanation','3  A · REASONING','#e7eefb',BLUE)
tools=box(1640,235,430,245,'Scoped tool registry','get_case / read_source / check_case\nprepare_bill_decision\nprepare_payment\nprepare_evidence_request\nrequest_payment_check','4  A · TYPED INTERFACE','#e7eefb',BLUE,20)
arrow([(460,355),(560,355)],start=events,end=worker)
arrow([(1010,355),(1110,355)],start=worker,end=agent)
arrow([(1550,355),(1630,355)],BLUE,start=agent,end=tools)
text(476,316,90,'wake',18,MUTED)
text(1020,316,90,'context',18,MUTED)
text(1565,316,70,'call',18,BLUE)

human=box(90,610,360,255,'Case UI + decisions','Inspect the same evidence\nReview exact proposals\nPayment release stays human','H · AUTHENTICATED REVIEW','#fff1d7',AMBER)
kernel=base('rectangle',570,610,1500,255,stroke=GREEN,fill='#e3efe5',group='shared-domain')
kernel['roundness']={'type':3}
text(600,630,1390,'5  SHARED AP OPERATIONS + ENFORCED RULES',19,GREEN,'shared-domain')
text(600,670,1400,'The same domain functions serve the UI and agent',32,INK,'shared-domain',1)
text(600,733,320,'Scope + roles\nSeparate authorities',23,INK,'shared-domain')
text(970,733,330,'Evidence + versions\nBusiness prerequisites',23,INK,'shared-domain')
text(1340,733,330,'Amounts + allocations\nAtomic reservations',23,INK,'shared-domain')
text(1710,733,330,'Replay + audit\nOriginal operation ID',23,INK,'shared-domain')
text(600,824,1400,'Return operation status + business state + record IDs + evidence + blockers + next allowed actions.',20,MUTED,'shared-domain')
arrow([(460,737),(560,737)],AMBER,start=human,end=kernel)
text(465,679,100,'exact\ndecision',17,AMBER)
arrow([(1855,490),(1855,600)],BLUE,start=tools)
text(1872,528,200,'validated call',19,BLUE)
text(588,557,1030,'Permissions, versions and amounts are checked in code on every action.',20,GREEN)

records=box(90,1000,680,245,'Persistent case records','Sources + evidence revisions · bills + allocations\nDecisions + policy versions · commands + audit\nPayment status and accounting status stay distinct','6  SHARED STATE','#f1f3f0',MUTED)
services=box(920,1000,510,245,'Trusted service workers','Consume authorized durable jobs\nParse / message / submit / observe / post\nSaved requests + fenced attempts','7  S · EXECUTION','#e5f1e8',GREEN)
external=box(1590,1000,480,245,'Systems and providers','Document + messaging providers\nBank · internal ledger · selected ERP\nVerify results before reporting success','8  EFFECTS + EVIDENCE','#f1f3f0',MUTED)
arrow([(705,875),(705,990)],GREEN,end=records)
text(501,921,190,'persist state',19,GREEN)
arrow([(1175,875),(1175,990)],GREEN,end=services)
text(1192,921,220,'authorized job',19,GREEN)
arrow([(1440,1122),(1580,1122)],GREEN,start=services,end=external)
text(1469,1084,110,'effect',19,GREEN)
# Observations loop through persistent facts; the event loop wakes saved work.
arrow([(1830,1255),(1830,1330),(430,1330),(430,1255)],MUTED,dashed=True)
text(890,1291,720,'observed results / callbacks → update the same case',21,MUTED)
arrow([(80,1122),(30,1122),(30,355),(80,355)],MUTED,dashed=True)

# Three concrete consequences of the abstraction.
text(90,1410,1930,'WHAT THESE BOUNDARIES MEAN',19,MUTED)
box(90,1465,615,205,'Review complete ≠ payment released','Agent policy review can finish while the\npayment still awaits human authorization.','AUTHORITY','#fff1d7',AMBER)
box(770,1465,620,205,'Unknown outcome → original payment','Retain the request, key and reservations.\nObserve and recover; do not create a replacement.','RECOVERY','#e7eefb',BLUE)
box(1455,1465,615,205,'Bank settled → repair accounting','A missing journal triggers posting repair.\nIt does not send money or expense the bill again.','ACCOUNTING','#e5f1e8',GREEN)
footer=text(90,1730,1960,'Proposed architecture · Issue #97 · Capabilities stay disabled until their permission, failure and acceptance gates pass.',21,MUTED)
footer['link']='https://github.com/srivatsav-kannan/autonomous-finance/issues/97#issuecomment-6396801545'

scene={'type':'excalidraw','version':2,'source':'https://excalidraw.com',
       'elements':elements,'appState':{'viewBackgroundColor':'#ffffff','gridSize':None,
         'name':'AP agent capability abstraction','theme':'light','zoom':{'value':0.5}},'files':{}}
target=ROOT/'ap-agent-abstraction.excalidraw'
target.write_text(json.dumps(scene,indent=2)+'\n')
print(f'{target}: {len(elements)} editable elements')
