'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { AdminConsole, requestKind } = require('../src/admin-console.cjs')

const origin = 'https://admin.example'
const mainFrame = { url: origin + '/admin#desktop=en' }
const contents = { id: 21, mainFrame, isDestroyed: () => false }
function classify(path, overrides = {}) {
  return requestKind({ webContentsId: contents.id, frame: mainFrame, method: 'GET', resourceType: 'xhr',
    url: new URL(path, origin).href, initiatorOrigin: origin, ...overrides }, contents, origin)
}

test('admin session authenticates only the management APIs from its own main frame', () => {
  const id = '00000000-0000-4000-a000-000000000001'
  for (const [method, path] of [['GET','/v1/auth/me'],['GET','/v1/admin/accounts?status=pending'],
    ['GET','/v1/admin/usage?accountId='+id],['PATCH','/v1/admin/accounts/'+id],['POST','/v1/admin/invites'],
    ['POST','/v1/admin/accounts/'+id+'/revoke-sessions'],['PATCH','/v1/admin/quotas/global'],['PATCH','/v1/admin/quotas/'+id]]) {
    assert.equal(classify(path,{method}), 'api')
  }
  assert.equal(classify('/admin',{resourceType:'mainFrame'}),'page')
  assert.equal(classify('/admin/base.css',{resourceType:'stylesheet'}),'asset')
  for (const options of [{frame:null},{frame:{...mainFrame}},{initiatorOrigin:'https://elsewhere.test'},
    {resourceType:'mainFrame'},{resourceType:'subFrame'},{webContentsId:22},{method:'POST'}]) {
    assert.equal(classify('/v1/auth/me',options),null)
  }
  for (const path of ['https://elsewhere.test/v1/auth/me','/v1/auth/logout','/v1/auth/login','/v1/auth/me?other=1',
    '/v1/admin/usage/other','/v1/admin/accounts?redirect=1','/v1/admin/accounts/%2F','/admin/app.js']) assert.equal(classify(path),null)
})

test('opening or retaining the console requires the same approved admin identity', async () => {
  const account = {state:{role:'member'}, approvedToken:'a', requireApproved:async () => 'a'}
  const admin = new AdminConsole({account,origin})
  await assert.rejects(admin.open({isDestroyed:()=>false},'zh-CN'),/管理员/)
  account.state.role='admin'
  let closed = false
  admin.window = {destroy:()=>{closed=true}}
  admin.token='a'
  admin.checkIdentity(); assert.equal(closed,false)
  account.approvedToken='b'
  admin.checkIdentity(); assert.equal(closed,true)
})
