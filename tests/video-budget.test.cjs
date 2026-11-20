const test = require('node:test');
const assert = require('node:assert/strict');
const VideoBudget = require('../src/ui/video-budget.js');
const full = {width:1920,height:1080,fps:60,bitrate:12_000_000};

test('confirmed bandwidth pressure reduces video cost within the chosen profile and recovery is gradual', () => {
  const budget = new VideoBudget();
  let timestamp = 0;
  const sample = (qualityLimitationReason,availableOutgoingBitrate) =>
    budget.sample({timestamp:++timestamp,qualityLimitationReason},{availableOutgoingBitrate});
  assert.equal(sample('bandwidth',420_000),false);
  assert.equal(sample('bandwidth',420_000),true);
  assert.deepEqual(budget.limit(full),{width:640,height:360,fps:15,bitrate:520_000});
  for (let i=0;i<7;i++) assert.equal(sample('bandwidth',2_400_000),false);
  assert.equal(sample('bandwidth',2_400_000),true);
  assert.equal(budget.limit(full).height,540);
  for (let i=0;i<16;i++) sample('none',undefined);
  assert.equal(budget.limit(full),full);
});

test('quiet desktops, a single loss report, missing stats and duplicate samples do not reduce quality', () => {
  const budget = new VideoBudget();
  assert.equal(budget.sample(null,null),false);
  const sample = {timestamp:1,qualityLimitationReason:'none'};
  const remote = {timestamp:1,fractionLost:0.15};
  assert.equal(budget.sample(sample,{},remote),false);
  assert.equal(budget.sample(sample,{},remote),false);
  for (let n=2;n<32;n++) budget.sample({...sample,timestamp:n}, {availableOutgoingBitrate:150_000}, remote);
  assert.equal(budget.limit(full),full);
});

test('successive high-loss reports can step down without an ICE bandwidth estimate', () => {
  const budget = new VideoBudget();
  for (let timestamp=1;timestamp<=2;timestamp++) {
    budget.sample({timestamp,qualityLimitationReason:'none'},null,{timestamp,fractionLost:0.08});
  }
  const smaller = {width:800,height:600,fps:20,bitrate:800_000};
  assert.deepEqual(budget.limit(smaller),smaller);
  assert.deepEqual(budget.limit(full),{...full,width:1280,height:720,fps:30,bitrate:2_800_000});
});

test('a busy low-bandwidth desktop scales down even when the encoder reports no quality limitation', () => {
  const budget = new VideoBudget();
  for (let n=0;n<3;n++) {
    budget.sample({id:'video',timestamp:1500*n,bytesSent:100_000*n,qualityLimitationReason:'none'},
      {availableOutgoingBitrate:600_000},null);
  }
  assert.equal(budget.limit(full).height,360);
});


test('persistent local packet queues reduce the send ceiling before loss or encoder alarms', () => {
  const budget = new VideoBudget();
  for (let n=0; n<3; n++) {
    budget.sample({id:'video', timestamp:n*1500, bytesSent:15_000*n, packetsSent:100*n,
      totalPacketSendDelay:15*n, qualityLimitationReason:'none'}, {availableOutgoingBitrate:600_000});
  }
  assert.equal(budget.limit(full).bitrate,520_000);
  for (let n=3; n<30; n++) {
    budget.sample({id:'video',timestamp:n*1500,bytesSent:30_000,packetsSent:200,totalPacketSendDelay:30,
      qualityLimitationReason:'none'}, {availableOutgoingBitrate:600_000});
  }
  assert.equal(budget.limit(full).height,360);
});
