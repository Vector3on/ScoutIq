// Contract scaffold only. Bind to loopback; never execute captured source.
import http from 'node:http';
import fs from 'node:fs';
const routes = JSON.parse(fs.readFileSync(new URL('./contracts.json', import.meta.url)));
export function routeMatches(pattern, pathname) {
  const a=pattern.split('/'),b=pathname.split('/');
  return a.length===b.length && a.every((v,i)=>v===b[i] || /^:[\w]+$/.test(v) || /^\{[^}]+\}$/.test(v));
}
export function respond(method, pathname) {
  const known=routes.some(r=>r.method===method && routeMatches(r.path,pathname));
  return {status:known?501:404, body:{mock:true, implemented:false, message:known?'Contract known; behavior unimplemented':'No captured contract'}};
}
if(process.argv[1] && new URL(import.meta.url).pathname===process.argv[1]) {
  http.createServer((req,res)=>{const r=respond(req.method,new URL(req.url,'http://localhost').pathname);res.writeHead(r.status,{'content-type':'application/json'});res.end(JSON.stringify(r.body));}).listen(Number(process.env.PORT||8788),'127.0.0.1');
}
