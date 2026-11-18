import service from './worker/index.js';

const adminHeaders = {
  'Cache-Control':'no-store',
  'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'X-Frame-Options':'DENY',
  'X-Robots-Tag':'noindex'
};
export default {
  ...service,
  fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    const item = Object.hasOwn(assets,path === '/admin/' ? '/admin' : path) && assets[path === '/admin/' ? '/admin' : path];
    if (!item) return service.fetch(request,env,ctx);
    if (!['GET','HEAD'].includes(request.method)) return new Response(null,{status:405,headers:{Allow:'GET, HEAD'}});
    return new Response(request.method === 'HEAD' ? null : item[1], {headers:{...adminHeaders,'Content-Type':item[0]+'; charset=utf-8'}});
  }
};
