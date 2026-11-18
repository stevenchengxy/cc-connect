'use strict';

(() => {
  const LABEL = 'cc-connect-files-v1';
  const CHUNK = 16 * 1024;
  const WINDOW = 16 * CHUNK;
  const HEADER = 40; // ASCII UUID and unsigned byte offset.
  const MAX_SIZE = 1024 ** 3;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const HASH = /^[0-9a-f]{64}$/;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', {fatal:true});
  const messages = {
    'file-too-large':'单个文件最大为 1 GiB。',
    'file-integrity':'文件校验失败，请重新发送。',
    'file-destination':'无法保存文件，请检查所选位置和可用空间。',
    'file-busy':'另一个文件正在传输。',
    'file-unavailable':'无法读取文件，请重新选择。'
  };
  function validOffer(m) {
    return typeof m.name === 'string' && m.name.length > 0 && encoder.encode(m.name).length <= 220 &&
      !/[\\/:*?"<>|\p{Cc}\p{Cf}]/u.test(m.name) && !/^\.|[. ]$/.test(m.name) &&
      !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(m.name) &&
      Number.isSafeInteger(m.size) && m.size >= 0 && m.size <= MAX_SIZE;
  }

  class FileChannel {
    constructor(api, roomId, update) {
      this.api = api;
      this.roomId = roomId;
      this.update = update;
      this.active = null;
      this.channel = null;
      this.closed = false;
      this.result = null;
    }

    attach(channel) {
      if (this.closed || this.channel || channel.label !== LABEL || !channel.ordered ||
          channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
        channel.close();
        return;
      }
      this.channel = channel;
      channel.binaryType = 'arraybuffer';
      channel.bufferedAmountLowThreshold = WINDOW / 2;
      channel.onopen = () => this.update(this);
      channel.onbufferedamountlow = () => this.pump(this.active);
      channel.onclose = channel.onerror = () => this.close();
      channel.onmessage = ({data}) => {
        try {
          if (typeof data === 'string') {
            if (data.length > 2048) throw new Error();
            this.message(JSON.parse(data));
          } else {
            this.receiveBytes(data);
          }
        } catch { this.close(); }
      };
      this.update(this);
    }

    get ready() { return !this.closed && this.channel?.readyState === 'open'; }

    send(message) {
      if (!this.ready) return false;
      try { this.channel.send(JSON.stringify(message)); return true; }
      catch { this.close(); return false; }
    }

    async choose() {
      if (!this.ready || this.active) return;
      const file = this.active = {phase:'picking',direction:'send',offset:0,confirmed:0};
      this.result = null;
      this.update(this);
      try {
        const info = await this.api.filePick(this.roomId);
        if (this.active !== file) {
          if (info?.id) await this.api.fileCancel(this.roomId, info.id).catch(() => {});
          return;
        }
        if (!info) return this.done(file);
        Object.assign(file, info);
        if (!UUID.test(file.id) || !validOffer(file)) throw new Error('file-unavailable');
        file.phase = 'offered';
        this.send({op:'offer',id:file.id,name:file.name,size:file.size});
        this.update(this);
      } catch (error) { this.fail(file,error); }
    }

    async accept() {
      const file = this.active;
      if (file?.phase !== 'incoming') return;
      file.phase = 'saving';
      this.update(this);
      try {
        const saved = await this.api.fileSave(this.roomId,{id:file.id,name:file.name,size:file.size});
        if (this.active !== file) return;
        if (!saved) return this.cancel();
        file.phase = 'receiving';
        file.writes = Promise.resolve();
        file.received = 0;
        this.update(this);
        this.send({op:'accept',id:file.id});
      } catch (error) { this.fail(file,error); }
    }

    message(m) {
      if (!m || !UUID.test(m.id)) throw new Error();
      const file = this.active;
      if (m.op === 'offer') {
        if (!validOffer(m)) { this.send({op:'decline',id:m.id}); return; }
        if (file) { this.send({op:'busy',id:m.id}); return; }
        this.active = {id:m.id,name:m.name,size:m.size,phase:'incoming',direction:'receive',offset:0};
        this.result = null;
        this.update(this);
        return;
      }
      if (!file || file.id !== m.id) return; // An earlier transfer may have just been cancelled.
      if (m.op === 'cancel' || m.op === 'decline' || m.op === 'busy') {
        if (file.phase !== 'committing') this.done(file,m.op === 'busy' ? messages['file-busy'] :
          m.op === 'decline' ? '对方已拒绝接收。' : '文件传输已取消。');
        return;
      }
      if (m.op === 'accept' && file.phase === 'offered') {
        file.phase = 'sending';
        this.update(this);
        this.pump(file);
      } else if (m.op === 'ack' && file.direction === 'send' &&
          (file.phase === 'sending' || file.phase === 'confirming')) {
        if (!Number.isSafeInteger(m.offset) || m.offset < file.confirmed || m.offset > file.offset) throw new Error();
        file.confirmed = m.offset;
        this.update(this);
        this.pump(file);
      } else if (m.op === 'end' && file.phase === 'receiving') {
        if (file.received !== file.size || !HASH.test(m.hash)) return this.fail(file,new Error('file-integrity'));
        file.phase = 'committing';
        this.update(this);
        void this.commit(file,m.hash);
      } else if (m.op === 'ok' && file.phase === 'confirming') {
        this.done(file,'文件已送达。');
      } else throw new Error();
    }

    async pump(file) {
      if (!file || file.phase !== 'sending' || file.pumping || this.active !== file) return;
      file.pumping = true;
      try {
        // Receiver credits bound both SCTP buffering and outstanding disk writes.
        while (this.active === file && file.offset < file.size &&
               file.offset - file.confirmed < WINDOW && this.channel.bufferedAmount < WINDOW) {
          const bytes = await this.api.fileRead(this.roomId,file.id);
          if (this.active !== file) return;
          if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > CHUNK ||
              file.offset + bytes.length > file.size) throw new Error('file-unavailable');
          const packet = new Uint8Array(HEADER + bytes.length);
          packet.set(encoder.encode(file.id));
          new DataView(packet.buffer).setUint32(36,file.offset);
          packet.set(bytes,HEADER);
          this.channel.send(packet);
          file.offset += bytes.length;
        }
        if (this.active !== file || file.offset !== file.size) return;
        const hash = await this.api.fileSentDigest(this.roomId,file.id);
        if (this.active !== file) return;
        if (!HASH.test(hash)) throw new Error('file-integrity');
        file.phase = 'confirming';
        this.send({op:'end',id:file.id,hash});
        this.update(this);
      } catch (error) { this.fail(file,error); }
      finally { file.pumping = false; }
    }

    receiveBytes(packet) {
      if (!(packet instanceof ArrayBuffer) || packet.byteLength <= HEADER || packet.byteLength > HEADER + CHUNK) throw new Error();
      const id = decoder.decode(new Uint8Array(packet,0,36));
      const file = this.active;
      if (!UUID.test(id)) throw new Error();
      if (!file || file.id !== id) return;
      if (file.phase !== 'receiving') throw new Error();
      const offset = new DataView(packet).getUint32(36);
      const bytes = new Uint8Array(packet,HEADER);
      if (offset !== file.received || offset + bytes.length > file.size ||
          offset + bytes.length - file.offset > WINDOW + CHUNK) throw new Error();
      file.received += bytes.length;
      file.writes = file.writes.then(async () => {
        if (this.active !== file) return;
        await this.api.fileWrite(this.roomId,id,bytes);
        if (this.active !== file) return;
        file.offset += bytes.length;
        if (file.offset - (file.lastAck || 0) >= WINDOW / 2 || file.offset === file.size) {
          file.lastAck = file.offset;
          this.send({op:'ack',id,offset:file.offset});
          this.update(this);
        }
      }).catch(error => this.fail(file,error));
    }

    async commit(file,hash) {
      try {
        await file.writes;
        if (this.active !== file) return;
        await this.api.fileCommit(this.roomId,file.id,hash);
        if (this.active !== file) return;
        this.send({op:'ok',id:file.id});
        this.done(file,'文件已保存。');
      } catch (error) { this.fail(file,error); }
    }

    fail(file,error) {
      if (this.active !== file) return;
      if (file.id) this.send({op:'cancel',id:file.id});
      this.done(file,messages[error?.message] || '文件传输失败，请重试。');
    }

    cancel() {
      const file = this.active;
      if (!file || ['confirming','committing'].includes(file.phase)) return;
      if (file.id) this.send({op:['incoming','saving'].includes(file.phase) ? 'decline' : 'cancel',id:file.id});
      this.done(file,'文件传输已取消。');
    }

    done(file,message) {
      if (this.active !== file) return;
      this.active = null;
      if (file.id) void this.api.fileCancel(this.roomId,file.id).catch(() => {});
      this.result = message ? {message,name:file.name} : null;
      this.update(this);
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      if (this.active) this.done(this.active,'文件传输已中断。');
      if (this.channel) {
        this.channel.onopen = this.channel.onmessage = this.channel.onbufferedamountlow = null;
        this.channel.onclose = this.channel.onerror = null;
        this.channel.close();
      }
      this.update(this);
    }
  }
  FileChannel.label = LABEL;
  if (typeof module !== 'undefined' && module.exports) module.exports = FileChannel;
  else window.CCFileChannel = FileChannel;
})();
