const test = require('node:test');
const assert = require('node:assert/strict');
const RemoteInput = require('../src/ui/remote-input.js');

function link() {
  return {readyState:'open',bufferedAmount:0,packets:[],
    send(data) { this.packets.push(JSON.parse(data)); },
    close() { this.readyState = 'closed'; }};
}
function motion() {
  return Object.assign(link(), {label:RemoteInput.label,ordered:false,maxRetransmits:0,maxPacketLifeTime:null});
}
const move = x => ({kind:'move',x,y:0.5});
const button = down => ({kind:'button',button:0,down,x:0.4,y:0.5});

test('loss, duplication and reordering keep drag/button/reset boundaries and the final pointer position', async () => {
  const control = link(), fast = motion(), applied = [];
  const sender = new RemoteInput(control, () => {}, () => false);
  const receiver = new RemoteInput(link(), p => applied.push(p), () => true);
  sender.attach(fast);
  sender.send(move(0.1));
  sender.send(button(true));
  sender.send(move(0.2));
  sender.send(move(0.3));
  receiver.receive(fast.packets[2], true);
  receiver.receive(fast.packets[1], true);
  assert.deepEqual(applied, []);
  receiver.receive(control.packets[0]);
  receiver.receive(fast.packets[0], true);
  assert.deepEqual(applied.map(p => [p.kind,p.x]), [['button',0.4],['move',0.3]]);
  sender.send(button(false));
  receiver.receive(control.packets[1]);
  sender.send(move(0.7)); // Deliberately lose this update on the motion channel.
  await new Promise(resolve => setTimeout(resolve,160));
  assert.equal(control.packets.length, 3);
  receiver.receive(control.packets[2]);
  receiver.receive(fast.packets.at(-1), true);
  assert.deepEqual(applied.slice(2).map(p => [p.kind,p.x]), [['button',0.4],['move',0.7]]);
  sender.send({kind:'reset'});
  receiver.receive(control.packets.at(-1));
  receiver.receive(fast.packets[2], true);
  assert.equal(applied.at(-1).kind, 'reset');
  sender.close(); receiver.close();
});

test('fall back to the ordered channel with old peers or closed motion; keys preserve pointer position', () => {
  const control = link(), fast = motion(), applied = [];
  const input = new RemoteInput(control, p => applied.push(p), () => true);
  input.send(move(0.1));
  assert.equal(control.packets.length,1);
  input.receive(move(0.7)); // Original peer without ordering metadata.
  assert.equal(applied.at(-1).x,0.7);
  input.attach(fast);
  input.send(move(0.2));
  input.send({kind:'key',code:'ShiftLeft',down:true});
  assert.deepEqual(control.packets.map(p => p.kind), ['move','move','key']);
  fast.close();
  input.send(move(0.3));
  assert.equal(control.packets.at(-1).x,0.3);
  input.close();
});

test('congested motion drops samples while clicks stay reliable; permission gates even future samples', () => {
  const control = link(), fast = motion(), applied = [];
  let authorized = false;
  const input = new RemoteInput(control, p => applied.push(p.kind), () => authorized);
  input.attach(fast);
  fast.bufferedAmount = 2000;
  assert.equal(input.send(move(0.4)), false);
  assert.equal(input.send(button(true)), true);
  assert.equal(fast.packets.length, 0);
  assert.equal(control.packets.length, 1);
  fast.onmessage({data:JSON.stringify({...move(0.8),boundary:1,sequence:2})});
  authorized = true;
  input.receive(control.packets[0]);
  fast.onmessage({data:JSON.stringify({...button(false),boundary:2})});
  assert.deepEqual(applied, ['button']);
  input.close();
});
