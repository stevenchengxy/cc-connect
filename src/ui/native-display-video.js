'use strict';

// A local native picker produces one JPEG at a time. The canvas track is the
// only object passed to WebRTC. Diagnostics do not instantiate this class.
class NativeDisplayVideo {
  constructor(width,height) {
    if (![width,height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 1920) ||
        Math.min(width,height) > 1080) throw new Error('native-picker-failed');
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.context = this.canvas.getContext('2d',{alpha:false});
    if (!this.context) throw new Error('native-picker-failed');
    this.stream = this.canvas.captureStream(0);
    this.track = this.stream.getVideoTracks()[0];
    this.first = Promise.withResolvers();
    this.closed = false;
    this.decoding = false;
  }

  async draw(bytes) {
    if (this.closed) return false;
    if (this.decoding || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 2 * 1024 * 1024) {
      throw new Error('native-picker-failed');
    }
    this.decoding = true;
    let image;
    try {
      image = await createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));
      if (this.closed) return false;
      if (image.width !== this.canvas.width || image.height !== this.canvas.height) throw new Error('native-picker-failed');
      this.context.drawImage(image,0,0);
      this.track.requestFrame();
      this.first.resolve(this.stream);
      return true;
    } finally {
      image?.close();
      this.decoding = false;
    }
  }

  refresh() {
    // Make the first frame available to a newly connected peer even when
    // the selected display is static and the OS has no new frame to send.
    if (this.closed) return;
    this.context.drawImage(this.canvas,0,0);
    this.track.requestFrame();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.first.reject(new Error('本机屏幕共享已停止。'));
    this.track.stop();
    this.canvas.width = this.canvas.height = 1;
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = NativeDisplayVideo;
else window.NativeDisplayVideo = NativeDisplayVideo;
