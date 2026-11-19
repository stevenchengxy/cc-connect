'use strict';

class RemoteInput {
  static label = 'cc-connect-motion-v1';

  constructor(control, apply, canReceive) {
    this.control = control;
    this.apply = apply;
    this.canReceive = canReceive;
    this.motion = null;
    this.sentSequence = 0;
    this.sentBoundary = 0;
    this.appliedSequence = 0;
    this.appliedBoundary = 0;
    this.pending = null;
  }

  attach(channel) {
    if (this.motion || channel.label !== RemoteInput.label || channel.ordered ||
        channel.maxRetransmits !== 0 || channel.maxPacketLifeTime !== null) {
      channel.close();
      return;
    }
    this.motion = channel;
    channel.onmessage = ({data}) => {
      if (typeof data !== 'string' || data.length > 512) return;
      try {
        const packet = JSON.parse(data);
        if (packet?.kind === 'move') this.receive(packet, true);
      } catch { /* Ignore malformed samples. */ }
    };
  }

  write(channel, payload) {
    if (channel?.readyState !== 'open') return false;
    try { channel.send(JSON.stringify(payload)); return true; }
    catch { return false; }
  }

  send(payload) {
    clearTimeout(this.settle);
    if (payload.kind !== 'move') {
      if (payload.kind === 'key' && this.lastSample) this.write(this.control, this.lastSample);
      this.lastSample = null;
      const boundary = this.sentBoundary + 1;
      if (!this.write(this.control, {...payload, boundary})) return false;
      this.sentBoundary = boundary;
      return true;
    }
    const sample = {...payload, sequence:++this.sentSequence, boundary:this.sentBoundary};
    const fast = this.motion?.readyState === 'open';
    const channel = fast ? this.motion : this.control;
    // Old peers retain reliable movement. Coalesce when their queue fills.
    const sent = channel?.bufferedAmount < 1200 && this.write(channel, sample);
    this.lastSample = null;
    if (fast || !sent) {
      // A stationary cursor still reaches its final position if the last sample was lost.
      this.lastSample = sample;
      this.settle = setTimeout(() => {
        this.lastSample = null;
        this.write(this.control, sample);
      }, 120);
    }
    return Boolean(sent);
  }

  receive(payload, fromMotion = false) {
    if (!this.canReceive()) return;
    const {kind, boundary, sequence} = payload;
    if (boundary === undefined && !fromMotion) {
      this.apply(payload); // A peer using the original ordered input protocol.
      return;
    }
    if (!Number.isSafeInteger(boundary) || boundary < this.appliedBoundary) return;
    if (kind === 'move') {
      if (!Number.isSafeInteger(sequence) || sequence <= this.appliedSequence ||
          ![payload.x, payload.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) return;
      if (boundary > this.appliedBoundary) {
        // A drag sample may outrun its button-down. Keep only the freshest future position.
        if (!this.pending || this.pending.sequence < sequence) this.pending = payload;
        return;
      }
      this.appliedSequence = sequence;
      this.apply(payload);
    } else if (!fromMotion && boundary > this.appliedBoundary) {
      this.appliedBoundary = boundary;
      this.apply(payload);
      const pending = this.pending;
      if (pending && pending.boundary <= boundary) {
        this.pending = null;
        this.receive(pending, true);
      }
    }
  }

  close() {
    clearTimeout(this.settle);
    this.lastSample = null;
    this.pending = null;
    if (this.motion) {
      this.motion.onmessage = null;
      this.motion.close();
    }
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = RemoteInput;
else window.CCRemoteInput = RemoteInput;
