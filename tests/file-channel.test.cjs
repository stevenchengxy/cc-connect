'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHash,randomBytes,randomUUID} = require('node:crypto');
const {setTimeout: delay} = require('node:timers/promises');
const FileChannel = require('../src/ui/file-channel.js');

function ledger(source) {
  const bytes = Buffer.from(source);
  let offset = 0;
  let received = [];
  return {
    reads:0, saves:0, committed:null, cancelled:[],
    async filePick() {
      offset = 0;
      return {id:randomUUID(),name:'example.bin',size:bytes.length};
    },
    async fileRead() {
      this.reads++;
      const block = bytes.subarray(offset,offset + 16384);
      offset += block.length;
      return block;
    },
    async fileSentDigest() { return createHash('sha256').update(bytes).digest('hex'); },
    async fileSave() { this.saves++; received = []; return true; },
    async fileWrite(_room,_id,block) { received.push(Buffer.from(block)); },
    async fileCommit(_room,_id,digest) {
      const saved = Buffer.concat(received);
      if (createHash('sha256').update(saved).digest('hex') !== digest) throw new Error('file-integrity');
      this.committed = saved;
      return true;
    },
    async fileCancel(_room,id) { this.cancelled.push(id); }
  };
}

function pair(bytes) {
  const sender = new FileChannel(ledger(bytes),'host',() => {});
  const receiver = new FileChannel(ledger('reply'),'viewer',() => {});
  function connection(peer) {
    return {label:FileChannel.label,ordered:true,maxRetransmits:null,maxPacketLifeTime:null,readyState:'open',bufferedAmount:0,
      send(packet) {
        const data = typeof packet === 'string' ? packet : Uint8Array.from(packet).buffer;
        setImmediate(() => peer.channel.onmessage?.({data}));
      }, close() { this.readyState = 'closed'; }
    };
  }
  sender.attach(connection(receiver));
  receiver.attach(connection(sender));
  return {sender,receiver};
}

async function until(condition) {
  for (let i=0;i<180 && !condition();i++) await delay(4);
  assert(condition(),'Expected transfer state was not reached');
}

test('no source is read until receiver accepts, then streaming credits permit a verified file larger than the send window', async () => {
  const bytes = randomBytes(1024 ** 2 + 11);
  const {sender,receiver} = pair(bytes);
  await sender.choose();
  await until(() => receiver.active?.phase === 'incoming');
  assert.equal(sender.api.reads,0);
  assert.equal(receiver.api.saves,0);
  await receiver.accept();
  await until(() => sender.result?.message === '文件已送达。');
  assert.deepEqual(receiver.api.committed,bytes);
  assert.equal(receiver.result.message,'文件已保存。');
});

test('empty files can be saved; declining the following offer never opens a save dialog or reads the sender', async () => {
  const {sender,receiver} = pair('');
  await sender.choose();
  await until(() => receiver.active?.phase === 'incoming');
  await receiver.accept();
  await until(() => sender.result?.message === '文件已送达。');
  assert.deepEqual(receiver.api.committed,Buffer.alloc(0));
  await sender.choose();
  await until(() => receiver.active?.phase === 'incoming');
  receiver.cancel();
  await until(() => sender.result?.message === '对方已拒绝接收。');
  assert.equal(receiver.api.saves,1);
  assert.equal(sender.api.reads,0);
});

test('cancel while data is queued discards the partial transfer and a subsequent file still succeeds', async () => {
  const {sender,receiver} = pair(randomBytes(2 * 1024 ** 2));
  const write = receiver.api.fileWrite.bind(receiver.api);
  let release;
  let started;
  const firstWrite = new Promise(resolve => { started = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  receiver.api.fileWrite = async (...args) => { started(); await waiting; await write(...args); };
  await sender.choose();
  await until(() => receiver.active?.phase === 'incoming');
  await receiver.accept();
  await firstWrite;
  const cancelled = receiver.active.id;
  receiver.cancel();
  await until(() => sender.result?.message === '文件传输已取消。');
  assert(receiver.api.cancelled.includes(cancelled));
  assert.equal(receiver.api.committed,null);
  release();
  await receiver.choose();
  await until(() => sender.active?.phase === 'incoming');
  await sender.accept();
  await until(() => receiver.result?.message === '文件已送达。');
  assert.deepEqual(sender.api.committed,Buffer.from('reply'));
});

test('unverified bytes are discarded and malformed offers never reach native file dialogs', async () => {
  const {sender,receiver} = pair('content');
  for (const name of ['../escaped','t\u202ex.exe','CON.txt']) {
    receiver.message({op:'offer',id:randomUUID(),name,size:20});
    assert.equal(receiver.active,null);
  }
  sender.api.fileSentDigest = async () => 'a'.repeat(64);
  await sender.choose();
  await until(() => receiver.active?.phase === 'incoming');
  await receiver.accept();
  await until(() => receiver.result?.message === '文件校验失败，请重新发送。');
  assert.equal(receiver.api.committed,null);
});
