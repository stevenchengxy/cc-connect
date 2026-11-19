'use strict';

// Resolution and frame-rate ceilings. The encoder retains control of bitrate
// so its own congestion controller can still probe for newly available bandwidth.
const videoLevels = [
  {width:640, height:360, fps:15},
  {width:960, height:540, fps:20},
  {width:1280, height:720, fps:30}
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
    this.previous = {timestamp:video.timestamp, bytes:video.bytesSent, id:video.id};
    const available = pair?.availableOutgoingBitrate;
    const hasEstimate = Number.isFinite(available) && available > 0;
    const sentBitrate = previous && previous.id === video.id && video.timestamp > previous.timestamp
      ? 8000 * (video.bytesSent - previous.bytes) / (video.timestamp - previous.timestamp) : 0;
    const recentReport = remote && remote.timestamp !== this.remoteTimestamp;
    const loss = recentReport && remote.fractionLost >= 0.05;
    if (remote) this.remoteTimestamp = remote.timestamp;
    const constrained = video.qualityLimitationReason === 'bandwidth' || loss ||
      (hasEstimate && sentBitrate >= available * 0.75);
    let requested = videoLevels.length;
    if (constrained) {
      requested = hasEstimate ? [650_000, 1_600_000, 3_500_000].filter(bps => available >= bps).length
        : Math.max(0, this.level - 1);
      if (loss) requested = Math.min(requested, Math.max(0, this.level - 1));
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
      height:Math.min(profile.height,tier.height), fps:Math.min(profile.fps,tier.fps)};
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = VideoBudget;
else window.CCVideoBudget = VideoBudget;
