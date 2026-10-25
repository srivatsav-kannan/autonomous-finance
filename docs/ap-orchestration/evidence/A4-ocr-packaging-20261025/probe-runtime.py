from pathlib import Path
import subprocess, sys
b=Path(__file__).resolve().parent
d=['/opt/homebrew/bin/docker','--host','unix:///Users/junjiexiong/.colima/default/docker.sock']
checks=[('host',['uname','-a']),('colima-version',['/opt/homebrew/bin/colima','version']),('colima-status',['/opt/homebrew/bin/colima','status']),('contexts-before-build',['/opt/homebrew/bin/docker','context','ls','--format','json']),('docker-version',d+['version','--format','json']),('docker-info',d+['info','--format','{{json .OSType}} {{json .Architecture}} {{json .OperatingSystem}} {{json .KernelVersion}}']),('containers-before',d+['ps','-a','--no-trunc','--format','{{.ID}} {{.Image}} {{.Status}}']),('buildx-version',d+['buildx','version'])]
for name,argv in checks:
 subprocess.run([sys.executable,str(b/'capture.py'),name,'30',*argv],check=False)
