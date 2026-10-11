import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { installStableFetchTransport, loopbackProbeFetch } from "../src/fetch-transport.mjs";
import { openPort } from "./port-pool.mjs";

class FakeAgent {
  constructor() { this.kind = "direct"; }
  dispatch(options, handler) { handler.selected(this.kind,options); return true; }
  async close() { this.closed = true; }
  async destroy(error) { this.destroyed = true; this.error = error; }
}
class FakeProxyAgent extends FakeAgent { constructor() { super(); this.kind = "proxy"; } }
function fakeTransport(AgentClass = FakeAgent, EnvHttpProxyAgentClass = FakeProxyAgent) {
  return installStableFetchTransport({AgentClass,EnvHttpProxyAgentClass,setDispatcher:()=>{},
    environment:{NODE_USE_ENV_PROXY:"1",HTTP_PROXY:"http://proxy.invalid"},execArgv:[]});
}

test("mandatory bypass recognizes only canonical localhost and literal loopback addresses", async () => {
  const dispatcher = fakeTransport();
  for (const [origin,expected] of [
    ["http://LOCALHOST:8024","direct"],["http://127.0.0.1","direct"],["http://127.15.255.254","direct"],
    ["http://[::1]","direct"],["http://[0:0:0:0:0:0:0:1]","direct"],
    ["http://localhost.example","proxy"],["http://localhost.","proxy"],["http://127.example","proxy"],
    ["http://192.168.0.1","proxy"],["http://10.0.0.1","proxy"],["http://[::ffff:127.0.0.1]","proxy"],
    ["https://provider.invalid","proxy"],
  ]) {
    const options = {origin,method:"POST",path:"/v1/responses",headers:{authorization:"fixture"},body:"private fixture"};
    let kind;
    assert.equal(dispatcher.dispatch(options,{selected(value,received) { kind = value; assert.equal(received,options); }}),true);
    assert.equal(kind,expected,origin);
  }
  await dispatcher.close(); assert.equal(dispatcher.closed,true);
  assert.throws(()=>loopbackProbeFetch("http://provider.invalid"),/loopback origin/u);
});

test("both owned pools close or destroy even when one cleanup fails", async () => {
  for (const method of ["close","destroy"]) for (const callback of [false,true]) {
    const agents = [], failure = new Error("fixture cleanup failure"), abort = new Error("fixture cancellation");
    class Direct extends FakeAgent {
      constructor() { super(); agents.push(this); }
      async close() { await super.close(); throw failure; }
      async destroy(error) { await super.destroy(error); throw failure; }
    }
    class Proxy extends FakeProxyAgent { constructor() { super(); agents.push(this); } }
    const dispatcher = fakeTransport(Direct,Proxy);
    if (callback) {
      const result = await new Promise(resolve => method === "close" ? dispatcher.close(resolve) : dispatcher.destroy(abort,resolve));
      assert.equal(result,failure);
    } else await assert.rejects(method === "close" ? dispatcher.close() : dispatcher.destroy(abort),error=>error === failure);
    assert.ok(agents.every(agent=>method === "close" ? agent.closed : agent.destroyed));
    if (method === "destroy") assert.ok(agents.every(agent=>agent.error === abort));
  }
});

test("actual fetch and health keep private authorization and bodies direct while external proxy and NO_PROXY work", async () => {
  const originRequests = [], proxyRequests = [], sockets = new Set();
  const origin = http.createServer(async (request,response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    originRequests.push({path:request.url,auth:request.headers.authorization,body:Buffer.concat(chunks).toString()});
    response.end(JSON.stringify({service:"fixture"}));
  });
  const proxy = http.createServer(async (request,response) => {
    proxyRequests.push({path:request.url,auth:request.headers.authorization});
    const target = new URL(request.url), chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const forward = http.request({host:"127.0.0.1",port:target.port,path:target.pathname,method:request.method,headers:request.headers},upstream=> {
      response.writeHead(upstream.statusCode,upstream.headers); upstream.pipe(response);
    });
    forward.on("error",error=>response.destroy(error)); forward.end(Buffer.concat(chunks));
  });
  proxy.on("connect",(request,downstream,head)=> {
    proxyRequests.push({path:request.url});
    const target = new URL(`http://${request.url}`);
    const upstream = net.connect(Number(target.port),"127.0.0.1",()=> {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      downstream.pipe(upstream); upstream.pipe(downstream);
    });
    sockets.add(upstream); upstream.on("error",()=>downstream.destroy()); downstream.on("error",()=>upstream.destroy());
  });
  for (const server of [origin,proxy]) {
    server.on("connection",socket=> { sockets.add(socket); socket.on("close",()=>sockets.delete(socket)); });
    const port = await openPort();
    await new Promise((resolve,reject)=> { server.once("error",reject); server.listen(port,"127.0.0.1",resolve); });
  }
  const names = ["http_proxy","https_proxy","HTTP_PROXY","HTTPS_PROXY","no_proxy","NO_PROXY","NODE_USE_ENV_PROXY"];
  const previous = Object.fromEntries(names.map(name=>[name,process.env[name]])), priorDispatcher = getGlobalDispatcher();
  const lookup = (_hostname,options,callback)=> options.all ? callback(null,[{address:"127.0.0.1",family:4}]) : callback(null,"127.0.0.1",4);
  class Direct extends Agent { constructor(options) { super({...options,connect:{lookup}}); } }
  class External extends EnvHttpProxyAgent { constructor(options) { super({...options,connect:{lookup}}); } }
  let dispatcher;
  try {
    for (const name of names) delete process.env[name];
    process.env.NODE_USE_ENV_PROXY = "1";
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.address().port}`;
    process.env.NO_PROXY = "";
    dispatcher = installStableFetchTransport({AgentClass:Direct,EnvHttpProxyAgentClass:External});
    const local = `http://127.0.0.1:${origin.address().port}`;
    for (const path of ["/v1/responses","/v1/responses/compact","/v1/chat/completions"]) {
      const response = await fetch(local + path,{method:"POST",headers:{authorization:"Bearer PRIVATE_FIXTURE"},body:"private fixture body",signal:AbortSignal.timeout(3000)});
      assert.equal(response.status,200); await response.arrayBuffer();
    }
    const health = await loopbackProbeFetch(local + "/health/liveliness",{headers:{authorization:"Bearer PRIVATE_FIXTURE"},signal:AbortSignal.timeout(3000)});
    assert.equal(health.status,200); await health.arrayBuffer();
    assert.equal(proxyRequests.length,0);
    assert.equal(originRequests.length,4);
    assert.ok(originRequests.every(request=>request.auth === "Bearer PRIVATE_FIXTURE"));
    assert.ok(originRequests.slice(0,3).every(request=>request.body === "private fixture body"));

    const external = `http://provider.invalid:${origin.address().port}/responses`;
    let response = await fetch(external,{signal:AbortSignal.timeout(3000)}); await response.arrayBuffer();
    assert.equal(proxyRequests.length,1,"ordinary external traffic still uses the configured proxy");
    assert.equal(proxyRequests[0].auth,undefined);
    process.env.no_proxy = "provider.invalid";
    response = await fetch(external,{signal:AbortSignal.timeout(3000)}); await response.arrayBuffer();
    assert.equal(proxyRequests.length,1,"existing lowercase external no_proxy is honored dynamically");
    process.env.no_proxy = "";
    response = await fetch(external,{signal:AbortSignal.timeout(3000)}); await response.arrayBuffer();
    assert.equal(proxyRequests.length,2,"removing external no_proxy restores proxy selection");
    assert.equal(originRequests.length,7);
  } finally {
    setGlobalDispatcher(priorDispatcher);
    await dispatcher?.destroy();
    for (const [name,value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    for (const socket of sockets) socket.destroy();
    for (const server of [origin,proxy]) await new Promise(resolve=>server.close(resolve));
  }
});
