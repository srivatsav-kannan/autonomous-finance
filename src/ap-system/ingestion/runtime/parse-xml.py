"""Bounded UTF-8 XML syntax reader. No schema, DTD, entity or network resolution."""
import json,re,sys
from pathlib import Path
from xml.parsers import expat

MAX_BYTES=1024*1024
class Rejected(Exception): pass
nodes=[]; stack=[]; counters=[]; text_size=0
runtime={'python':sys.version.split()[0],'expat':expat.EXPAT_VERSION}
def reject(reason): raise Rejected(reason)
def start(name,attrs):
 if len(nodes)>=4096 or len(stack)>=32: reject('xml_structure_budget_exceeded')
 if len(attrs)>16 or any(len(v)>1024 for v in attrs.values()): reject('xml_attribute_budget_exceeded')
 if stack:
  count=counters[-1].get(name,0)+1;counters[-1][name]=count
  prefix=nodes[stack[-1]]['path']
 else: count=1;prefix=''
 qualified='Q{'+name.replace('}','}',1) if '}' in name else name
 path=prefix+'/'+qualified+'['+str(count)+']'
 i=len(nodes);nodes.append({'name':name,'path':path,'text':'','attrs':attrs,'children':[]})
 if stack:nodes[stack[-1]]['children'].append(i)
 stack.append(i);counters.append({})
def end(name):stack.pop();counters.pop()
def chars(value):
 global text_size
 text_size+=len(value)
 if text_size>MAX_BYTES:reject('xml_text_budget_exceeded')
 if stack:
  n=nodes[stack[-1]];n['text']+=value
  if len(n['text'])>65536:reject('xml_text_node_budget_exceeded')
try:
 data=Path(sys.argv[1]).read_bytes()
 if not data or len(data)>MAX_BYTES:reject('xml_byte_budget_exceeded')
 try:text=data.decode('utf-8-sig')
 except UnicodeDecodeError:reject('xml_utf8_required')
 if '\x00' in text:reject('xml_utf8_required')
 declaration=re.match(r'\s*<\?xml\s+[^?]*encoding\s*=\s*[\'"]([^\'"]+)',text,re.I)
 if declaration and declaration.group(1).lower() not in ('utf-8','utf8'):reject('xml_utf8_required')
 p=expat.ParserCreate(namespace_separator='}')
 p.XmlDeclHandler=lambda version,encoding,standalone:None if version=='1.0' and (encoding is None or encoding.lower() in ('utf-8','utf8')) else reject('xml_declaration_unsupported')
 p.StartElementHandler=start;p.EndElementHandler=end;p.CharacterDataHandler=chars
 p.StartDoctypeDeclHandler=lambda *args:reject('xml_dtd_forbidden')
 p.EntityDeclHandler=lambda *args:reject('xml_entity_forbidden')
 p.ExternalEntityRefHandler=lambda *args:reject('xml_external_entity_forbidden')
 p.ProcessingInstructionHandler=lambda *args:reject('xml_processing_instruction_unsupported')
 p.Parse(data,True)
 print(json.dumps({'nodes':nodes,'runtime':runtime,'failure':None},ensure_ascii=False))
except Rejected as error:print(json.dumps({'nodes':[],'runtime':runtime,'failure':str(error)}))
except (expat.ExpatError,ValueError):print(json.dumps({'nodes':[],'runtime':runtime,'failure':'xml_malformed'}))
