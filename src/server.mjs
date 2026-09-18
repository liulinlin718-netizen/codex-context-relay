import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {ROOT} from './paths.mjs';
import {dispatch,closeBridge} from './service.mjs';

export async function startServer({port=6400,quiet=false}={}) {
  if (!Number.isInteger(port)||port<6400||port>6409) throw new Error('Port must be 6400–6409.');
  const token=randomBytes(24).toString('hex');
  const origin=`http://127.0.0.1:${port}`;
  const staticFiles={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/draft-store.js':['draft-store.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const reply=(status,value)=>{if (!res.destroyed){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}};
    if (req.headers.host!==`127.0.0.1:${port}`) return reply(403,{error:{code:'HOST_REJECTED',message:'Use the loopback URL printed at startup.'}});
    let route;
    try { route=new URL(req.url,origin).pathname; }
    catch { return reply(400,{error:{code:'INVALID_URL',message:'Malformed request URL.'}}); }
    if (req.method==='GET'&&route==='/bootstrap') return reply(200,{token});
    if (req.method==='GET'&&staticFiles[route]) {
      const [file,type]=staticFiles[route];res.writeHead(200,{'Content-Type':type});return res.end(fs.readFileSync(path.join(ROOT,'web',file)));
    }
    if (req.method!=='POST'||route!=='/api') return reply(404,{error:{code:'NOT_FOUND',message:'Not found'}});
    if(req.headers['x-relay-token']!==token||(req.headers.origin&&req.headers.origin!==origin)) return reply(403,{error:{code:'ORIGIN_REJECTED',message:'Invalid local session or origin.'}});
    const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    try {
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>24*1024*1024)throw Object.assign(new Error('Request exceeds 24 MiB'),{code:'INPUT_TOO_LARGE'});chunks.push(chunk);}
      const body=Buffer.concat(chunks).toString('utf8');
      const {action,data}=JSON.parse(body);const result=await dispatch(action,data,{signal:controller.signal});reply(200,result);
    } catch(e){reply(400,{error:{code:e.code||'REQUEST_FAILED',message:e.message}});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  if(!quiet)process.stderr.write(`Context Relay: ${origin}\nStorage: ${ROOT}\\.runtime\n`);
  return {url:origin,server,close:async()=>{await closeBridge();await new Promise(resolve=>server.close(resolve));}};
}
