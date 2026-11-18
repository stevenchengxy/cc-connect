'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const NativeDisplayVideo = require('../src/ui/native-display-video.js');

function fixture(t,decode) {
  const operations = [];
  const track = {
    requestFrame() { operations.push('frame'); },
    stop() { operations.push('stop'); }
  };
  const stream = {getVideoTracks:() => [track]};
  const canvas = {
    getContext() { return {drawImage() { operations.push('draw'); }}; },
    captureStream(fps) { assert.equal(fps,0); return stream; }
  };
  const original = {document:global.document,createImageBitmap:global.createImageBitmap};
  global.document = {createElement:element => { assert.equal(element,'canvas'); return canvas; }};
  global.createImageBitmap = decode;
  t.after(() => { Object.assign(global,original); });
  return {operations,canvas,stream};
}

test('a selected display publishes a frame only after decoding the exact selected dimensions', async t => {
  const {operations,stream} = fixture(t,async blob => {
    assert.equal(blob.type,'image/jpeg');
    return {width:912,height:568,close() { operations.push('release'); }};
  });
  const video = new NativeDisplayVideo(912,568);
  assert.deepEqual(operations,[]);
  assert.equal(await video.draw(Uint8Array.of(1)),true);
  assert.equal(await video.first.promise,stream);
  video.refresh();
  video.close();
  assert.deepEqual(operations,['draw','frame','release','draw','frame','stop']);
});

test('an obsolete frame is discarded after stopping, including a decode already in progress', async t => {
  const decode = Promise.withResolvers();
  const {operations} = fixture(t,() => decode.promise);
  const video = new NativeDisplayVideo(640,480);
  const first = assert.rejects(video.first.promise);
  const drawing = video.draw(Uint8Array.of(1));
  await assert.rejects(video.draw(Uint8Array.of(2)),/native-picker-failed/);
  video.close();
  decode.resolve({width:640,height:480,close() { operations.push('release'); }});
  assert.equal(await drawing,false);
  await first;
  assert.deepEqual(operations,['stop','release']);
});

test('invalid dimensions, oversized data, and a changed display are rejected', async t => {
  const {operations} = fixture(t,async () => ({width:1280,height:720,close() { operations.push('release'); }}));
  assert.throws(() => new NativeDisplayVideo(1920,1200),/native-picker-failed/);
  const video = new NativeDisplayVideo(1080,1920);
  const first = assert.rejects(video.first.promise);
  await assert.rejects(video.draw(new Uint8Array(2 * 1024 * 1024 + 1)),/native-picker-failed/);
  await assert.rejects(video.draw(Uint8Array.of(1)),/native-picker-failed/);
  video.close();
  await first;
  assert.deepEqual(operations,['release','stop']);
});
