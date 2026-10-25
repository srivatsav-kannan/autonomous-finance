/** Run after starting the dedicated 3260/3261 backend. Never reads another demo's config. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root=process.cwd();
const backend=JSON.parse(fs.readFileSync(path.join(root,'.convex/local/default/config.json'),'utf8'));
if(backend.ports.cloud!==3260||backend.ports.site!==3261)throw Error('Use this demo\'s dedicated backend on 3260/3261');
const instance=await fetch('http://127.0.0.1:3260/instance_name');
if(!instance.ok||await instance.text()!==backend.deploymentName)throw Error('Owned backend identity mismatch');
const configured=await fetch('http://127.0.0.1:3260/api/update_environment_variables',{method:'POST',headers:{Authorization:`Convex ${backend.adminKey}`,'Content-Type':'application/json'},body:JSON.stringify({changes:[{name:'AP_HUMAN_AUTH_ISSUER',value:'https://ap-demo.invalid'},{name:'AP_HUMAN_AUTH_AUDIENCE',value:'ap-b3-local'}]})});
if(!configured.ok)throw Error('Isolated backend configuration failed');
const dir=path.join(root,'var/guidance-demo');fs.mkdirSync(dir,{recursive:true,mode:0o700});
const file=path.join(dir,'config.json');
if(!fs.existsSync(file))fs.writeFileSync(file,JSON.stringify({localRoot:root,kernelAdminSecret:crypto.randomBytes(32).toString('hex'),runId:'ap97-b3-guidance-20261025-v1'}),{mode:0o600,flag:'wx'});
console.log('Dedicated demo configured. Wait for Convex functions ready, then start the guidance gateway.');
