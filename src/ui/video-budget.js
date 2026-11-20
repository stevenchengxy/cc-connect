'use strict';

// Limit encoded frame size, cadence and bursts while a link is under pressure.
const videoLevels = [
  {width:640, height:360, fps:15, bitrate:520_000},
  {width:960, height:540, fps:20, bitrate:1_250_000},
  {width:1280, height:720, fps:30, bitrate:2_800_000}
];

class VideoBudget {
  constructor() {
    this.level = videoLevels.length;
    this.weakSamples = 0;
    this.healthySamples = 0;
  }

  sample(video, pair, remote) {
    if (!video || !Number.isFinite(video.timestamp) || this.previous?.timestamp === video.timestamp) return false;
    const previous = this.previous;
    this.previous = {timestamp:video.timestamp, bytes:video.bytesSent, id:video.id,
      packets:video.packetsSent, sendDelay:video.totalPacketSendDelay};
    const sameStream = previous && previous.id === video.id && video.timestamp > previous.timestamp;
    const packets = sameStream ? video.packetsSent - previous.packets : 0;
    const queued = packets >= 10 && (video.totalPacketSendDelay - previous.sendDelay) / packets >= 0.12;
    const available = pair?.availableOutgoingBitrate;
    const hasEstimate = Number.isFinite(available) && available > 0;
    const sentBitrate = sameStream
      ? 8000 * (video.bytesSent - previous.bytes) / (video.timestamp - previous.timestamp) : 0;
    const recentReport = remote && remote.timestamp !== this.remoteTimestamp;
    const loss = recentReport && remote.fractionLost >= 0.05;
    if (remote) this.remoteTimestamp = remote.timestamp;
    const constrained = video.qualityLimitationReason === 'bandwidth' || loss ||
      (hasEstimate && sentBitrate >= available * 0.75);
    let requested = videoLevels.length;
    // After a downgrade, let the bandwidth estimate recover before raising
    // resolution again. A static desktop can briefly look uncongested.
    if (constrained || queued || (this.level < videoLevels.length && hasEstimate)) {
      requested = hasEstimate ? [650_000, 1_600_000, 3_500_000].filter(bps => available >= bps).length
        : Math.max(0, this.level - 1);
      if (loss || queued) requested = Math.min(requested, Math.max(0, this.level - 1));
    }
    this.weakSamples = requested < this.level ? this.weakSamples + 1 : 0;
    this.healthySamples = requested > this.level ? this.healthySamples + 1 : 0;
    let target = this.level;
    if (this.weakSamples >= 2) target = requested;
    if (this.healthySamples >= 8) target = this.level + 1;
    if (target === this.level) return false;
    this.level = target;
    this.weakSamples = this.healthySamples = 0;
    return true;
  }

  limit(profile) {
    const tier = videoLevels[this.level];
    if (!tier) return profile;
    return {...profile, width:Math.min(profile.width,tier.width),
      height:Math.min(profile.height,tier.height), fps:Math.min(profile.fps,tier.fps),
      bitrate:Math.min(profile.bitrate,tier.bitrate)};
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = VideoBudget;
else window.CCVideoBudget = VideoBudget;
