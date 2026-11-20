const digits = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "niner"];
const spellDigits = value => [...value].map(n => digits[Number(n)]).join(" ");

function radioText(message) {
  return message.replace(/Runway (\d{2})(?:\/(\d{2}))?/gi, (_, a, b) =>
    "runway " + spellDigits(a) + (b ? ", " + spellDigits(b) : ""))
    .replace(/\b(1\d{2})\.(\d{1,3})\b/g, (_, a, b) => spellDigits(a) + " point " + spellDigits(b))
    .replace(/\bKVEL\b/g, "Vernal").replace(/\bCTAF\b/g, "see taff");
}

// Audio runs on the device clock. Simulation speed never enters the audio graph.
export class GameSound {
  constructor(status) {
    this.status = status;
    this.level = .6;
    this.role = "armchair";
    this.voices = this.effects = this.room = false;
    this.buffers = new Map();
    this.pending = [];
    this.current = null;
    this.lastCue = -1;
  }

  async unlock() {
    if (!this.ctx) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) throw new Error("Audio playback is unavailable in this browser.");
      this.ctx = new Context();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.level;
      this.master.connect(this.ctx.destination);
      this.roomGain = this.ctx.createGain();
      this.roomGain.gain.value = 0;
      this.roomGain.connect(this.master);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  async buffer(name) {
    if (!this.buffers.has(name)) {
      const loading = fetch(`assets/audio/${name}.mp3`).then(response => {
        if (!response.ok) throw new Error("The sound file could not be loaded.");
        return response.arrayBuffer();
      }).then(bytes => this.ctx.decodeAudioData(bytes)).catch(error => {
        this.buffers.delete(name);
        throw error;
      });
      this.buffers.set(name, loading);
    }
    return this.buffers.get(name);
  }

  mix() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.level, now, .035);
    const roomLevel = this.role === "tsa" ? .56 : .28;
    this.roomGain.gain.setTargetAtTime(this.room ? roomLevel * (this.current ? .25 : 1) : 0, now, .16);
  }

  async setRoom(enabled) {
    this.room = enabled;
    this.mix();
    if (!enabled) {
      setTimeout(() => {
        if (!this.room && this.roomSource) {
          this.roomSource.stop();
          this.roomSource.disconnect();
          this.roomSource = null;
        }
      }, 800);
      return;
    }
    try {
      await this.unlock();
      const buffer = await this.buffer("gate-room");
      if (!this.room) return;
      if (this.roomSource) { this.mix(); return; }
      this.roomSource = this.ctx.createBufferSource();
      this.roomSource.buffer = buffer;
      this.roomSource.loop = true;
      this.roomSource.connect(this.roomGain);
      this.roomSource.start();
      this.mix();
    } catch (error) { this.status(error.message); }
  }

  cue(kind = "desk") {
    if (!this.effects || this.ctx?.state !== "running") return;
    const now = this.ctx.currentTime;
    if (now - this.lastCue < .65) return;
    this.lastCue = now;
    const notes = { desk: [370, 494], radio: [440], guard: [330, 440], weather: [392, 523] };
    for (const [index, hz] of notes[kind].entries()) {
      const at = now + index * .095;
      const tone = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      tone.frequency.value = hz;
      gain.gain.setValueAtTime(.0001, at);
      gain.gain.exponentialRampToValueAtTime(.042, at + .022);
      gain.gain.exponentialRampToValueAtTime(.0001, at + .23);
      tone.connect(gain).connect(this.master);
      tone.onended = () => { tone.disconnect(); gain.disconnect(); };
      tone.start(at);
      tone.stop(at + .24);
    }
  }

  receive(call) {
    this.cue(call.isGuard ? "guard" : call.freq === "135.225" ? "weather" : "radio");
    if (!this.voices || call.logOnly) return;
    if (!this.current) { this.startVoice(call); return; }
    if (call.isGuard) this.pending.unshift(call);
    else this.pending.push(call);
    // Keep a busy frequency current. Every transmission also has a written copy.
    if (this.pending.length > 3) {
      const routine = this.pending.findIndex(item => !item.isGuard);
      this.pending.splice(routine < 0 ? this.pending.length - 1 : routine, 1);
    }
  }

  stopVoice() {
    this.pending = [];
    const current = this.current;
    this.current = null;
    if (current?.source) current.source.stop();
    if (current?.utterance) window.speechSynthesis.cancel();
    this.mix();
    this.status("");
  }

  preview(voiceClip, sender) {
    this.stopVoice();
    this.startVoice({ voiceClip, sender });
  }

  async startVoice(call) {
    const token = {};
    this.current = token;
    this.mix();
    this.status("On air · " + call.sender);
    const finish = (message = "") => {
      if (this.current !== token) return;
      this.current = null;
      this.mix();
      this.status(message);
      if (this.pending.length) this.startVoice(this.pending.shift());
    };
    try {
      if (call.voiceClip) {
        await this.unlock();
        const buffer = await this.buffer(call.voiceClip);
        if (this.current !== token) return;
        const source = this.ctx.createBufferSource();
        token.source = source;
        source.buffer = buffer;
        source.playbackRate.value = 1;
        source.connect(this.master);
        source.onended = () => { source.disconnect(); finish(); };
        source.start();
        return;
      }
      const speech = window.speechSynthesis;
      const voices = speech?.getVoices().filter(voice => /^en\b/i.test(voice.lang)) || [];
      if (!voices.length) {
        finish("Scripted calls and weather are available. This device has no English voice for other calls.");
        return;
      }
      const utterance = new SpeechSynthesisUtterance(radioText(call.message));
      token.utterance = utterance;
      utterance.voice = voices.find(v => /natural|enhanced|premium|neural/i.test(v.name)) ||
        voices.find(v => v.lang === "en-US") || voices[0];
      utterance.rate = 1;
      utterance.volume = this.level;
      utterance.onend = () => finish();
      utterance.onerror = () => finish("Device voice unavailable. The call is in the transcript.");
      speech.speak(utterance);
    } catch (error) { finish(error.message || "Audio playback is unavailable."); }
  }
}
