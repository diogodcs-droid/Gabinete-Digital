#!/bin/bash
set -e
cd "$(dirname "$0")"
python3 - <<'PY'
t=open('template.html',encoding='utf8').read()
css=open('style.css',encoding='utf8').read()
js=open('prompts.js',encoding='utf8').read()+"\n"+open('logic.js',encoding='utf8').read().split("\nif (typeof module")[0]+"\n"+open('app.js',encoding='utf8').read()
js=js.replace('</script','<\\/script')
t=t.replace('/*CSS*/',css).replace('/*JS*/',js)
open('gabinete-digital.html','w',encoding='utf8').write(t)
print(len(t))
PY
