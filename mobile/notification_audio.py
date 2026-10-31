"""Recognise the installed client's message tone, in its own playback stream.

No microphone, mixed desktop audio, message database or audio files are recorded.
Only a bounded sequence of spectral features is retained in memory. Reference
sounds are read from the user's installed client, never bundled with this app.
"""
import array
from collections import deque
import io
import json
import math
import mmap
import os
from pathlib import Path
import re
import selectors
import shutil
import struct
import subprocess
import sys
import threading
import time
import wave

RATE, FRAME, HOP = 8000, 160, 80
COEFFICIENTS = tuple(2 * math.cos(2 * math.pi * hz / RATE) for hz in range(50, 3501, 50))
WINDOW = tuple(.5 - .5 * math.cos(2 * math.pi * n / (FRAME - 1)) for n in range(FRAME))


def pcm16(raw):
    values = array.array('h', raw)
    if sys.byteorder != 'little':
        values.byteswap()
    return values


def wav_samples(raw):
    with wave.open(io.BytesIO(raw)) as sound:
        channels, rate = sound.getnchannels(), sound.getframerate()
        count = sound.getnframes()
        if (sound.getsampwidth() != 2 or channels not in (1, 2)
                or not 8000 <= rate <= 96000 or not .15 <= count / rate <= 2):
            raise ValueError('Unsupported message tone')
        values = pcm16(sound.readframes(count))
    mono = [sum(values[n:n + channels]) / channels for n in range(0, len(values), channels)]
    # Anti-alias before downsampling. Simply dropping/interpolating samples can
    # fold a high-frequency component of the QQ tone into a different audible
    # band, unlike PulseAudio's filtered live stream.
    result, kernels = [], {}
    cutoff, radius = min(.45, RATE * .45 / rate), 48
    for n in range(int(len(mono) * RATE / rate)):
        position = n * rate / RATE
        index, fraction = int(position), position % 1
        phase = round(fraction, 6)
        if phase not in kernels:
            weights = []
            for offset in range(-radius + 1, radius + 1):
                distance = offset - fraction
                sinc = 2 * cutoff if abs(distance) < 1e-9 else math.sin(2 * math.pi * cutoff * distance) / (math.pi * distance)
                weights.append(sinc * .5 * (1 + math.cos(math.pi * distance / radius)))
            total = sum(weights)
            kernels[phase] = [value / total for value in weights]
        result.append(sum(mono[index + offset] * weight
                          for offset, weight in zip(range(-radius + 1, radius + 1), kernels[phase])
                          if 0 <= index + offset < len(mono)))
    return result


def feature(samples):
    energy = sum(value * value for value in samples) / FRAME
    if energy < 16:
        return None
    windowed = [value * weight for value, weight in zip(samples, WINDOW)]
    powers = []
    for coefficient in COEFFICIENTS:
        first = second = 0.
        for value in windowed:
            current = value + coefficient * first - second
            second, first = first, current
        powers.append(max(0., first * first + second * second - coefficient * first * second))
    # Integrate overlapping frequency bands instead of sparse spectral points.
    # This makes short, multi-part tones insensitive to the resampler's phase.
    powers = [math.sqrt(sum(powers[max(0, n - 1):n + 4])) for n in range(0, len(powers), 3)]
    norm = math.sqrt(sum(value * value for value in powers))
    return tuple(value / norm for value in powers) if norm else None


def similarity(a, b):
    if a is None or b is None:
        return 1. if a is None and b is None else 0.
    return sum(x * y for x, y in zip(a, b))


class ToneMatcher:
    def __init__(self, samples):
        windows = [samples[n:n + FRAME] for n in range(0, len(samples) - FRAME + 1, HOP)]
        energies = [sum(value * value for value in window) / FRAME for window in windows]
        threshold = max(16, max(energies, default=0) * .0025)
        frames = [feature(window) if energy >= threshold else None for window, energy in zip(windows, energies)]
        while frames and frames[0] is None:
            frames.pop(0)
        while frames and frames[-1] is None:
            frames.pop()
        if sum(item is not None for item in frames) < 15:
            raise ValueError('Message tone too short')
        # Discard at most 120 ms at the beginning: subscribing to a newly
        # created playback stream can miss its first few audio buffers.
        self.reference = frames[min(12, len(frames) // 4):-3]
        self.history = deque(maxlen=len(self.reference))
        self.pending = []
        self.cooldown = 0

    def feed(self, samples):
        self.pending.extend(samples)
        matches = 0
        while len(self.pending) >= FRAME:
            current = feature(self.pending[:FRAME])
            del self.pending[:HOP]
            self.history.append(current)
            self.cooldown = max(0, self.cooldown - 1)
            if (self.cooldown or len(self.history) != len(self.reference)
                    or max(similarity(current, item) for item in self.reference[-3:]) < .8):
                continue
            history = list(self.history)
            # PulseAudio's resampler can move a boundary by a few milliseconds,
            # especially where a tone fades into silence. Allow one feature
            # frame of local timing tolerance, retaining the full tone sequence.
            scores = [max(similarity(a, b) for a in history[max(0, i - 1):i + 2])
                      for i, b in enumerate(self.reference) if b is not None]
            if sum(scores) / len(scores) >= .95 and sum(value >= .9 for value in scores) >= len(scores) * .9:
                matches += 1
                self.cooldown = 90
                self.history.clear()
        return matches


def qt_message_tone(executable):
    """Resolve the *named* Qt resource through its table, never guess a WAV.

    Require five resource offsets to agree on the same Qt data table before
    selecting wechat_notify.wav. A changed/unknown format fails closed.
    """
    names = ('lock_closing.wav', 'lock_opening.wav', 'voip_phone_ending.wav',
             'voip_phone_ringing.wav', 'wechat_notify.wav')
    with open(executable, 'rb') as handle:
        with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as data:
            anchor = data.find('multimedia'.encode('utf-16-be'))
            if anchor < 0:
                raise ValueError('Qt message resource not found')
            # These Qt resources begin with the gui name entry, followed by
            # xui/resupdate/multimedia. Offsets and executable architecture vary.
            base = data.rfind('gui'.encode('utf-16-be'), max(0, anchor - 512), anchor) - 6
            if base < 0 or data[base:base + 2] != b'\0\3':
                raise ValueError('Unknown Qt resource name table')
            offsets = {}
            for name in names:
                position = data.find(name.encode('utf-16-be'), base, base + 4096) - 6
                if position < base:
                    raise ValueError('Incomplete Qt resource table')
                node = struct.pack('>I', position - base) + b'\0\0\0\0\0\1'
                tree = data.find(node, max(0, base - 1000000), base)
                if tree < 0 or data.find(node, tree + 1, base) >= 0:
                    raise ValueError('Ambiguous Qt resource node')
                offsets[name] = int.from_bytes(data[tree + 10:tree + 14], 'big')
            position = 0
            candidates = []
            while True:
                position = data.find(b'RIFF', position + 1)
                if position < 0:
                    break
                if position < 4 or data[position + 8:position + 12] != b'WAVE':
                    continue
                length = int.from_bytes(data[position + 4:position + 8], 'little') + 8
                if not 44 <= length <= 4000000 or int.from_bytes(data[position - 4:position], 'big') != length:
                    continue
                candidate = position - 4 - offsets[names[0]]
                valid = True
                for offset in offsets.values():
                    p = candidate + offset
                    size = int.from_bytes(data[p:p + 4], 'big') if p >= 0 else 0
                    if (not 44 <= size <= 4000000 or p + size + 4 > len(data)
                            or data[p + 4:p + 8] != b'RIFF' or data[p + 12:p + 16] != b'WAVE'
                            or int.from_bytes(data[p + 8:p + 12], 'little') + 8 != size):
                        valid = False
                        break
                if valid:
                    candidates.append(candidate)
            if len(candidates) != 1:
                raise ValueError('Qt resource data table not verified')
            position = candidates[0] + offsets['wechat_notify.wav']
            size = int.from_bytes(data[position:position + 4], 'big')
            return data[position + 4:position + 4 + size]


def installed_tone_bytes(client):
    if client.key == 'qq':
        for filename in ('/opt/QQ/resources/app/resource/msg.wav', '/opt/qq/resources/app/resource/msg.wav'):
            if Path(filename).is_file():
                return Path(filename).read_bytes()
    else:
        for filename in ('/opt/weixin/opt/wechat/wechat', '/opt/wechat/wechat', '/opt/WeChat/wechat'):
            if Path(filename).is_file():
                return qt_message_tone(filename)
    raise ValueError('Installed message tone unavailable')


def installed_tone(client):
    return wav_samples(installed_tone_bytes(client))


def pulse_reference(raw):
    """Render the installed reference in a temporary, isolated virtual sink.

    The server's resampler is used for both reference and detection. In
    particular its short 48 kHz tones need not match a different FIR exactly.
    This sound is never routed to the actual desktop or a physical speaker.
    """
    with wave.open(io.BytesIO(raw)) as sound:
        channels, rate, width = sound.getnchannels(), sound.getframerate(), sound.getsampwidth()
        if width != 2 or channels not in (1, 2) or not .15 <= sound.getnframes() / rate <= 2:
            raise ValueError('Unsupported message tone')
        pcm = sound.readframes(sound.getnframes())
    name = 'nas_message_reference_' + str(os.getpid())
    environment = dict(os.environ, LC_ALL='C')
    module = subprocess.run(['pactl', 'load-module', 'module-null-sink', 'sink_name=' + name,
                             'rate=44100', 'channels=2'], capture_output=True, timeout=3, check=True,
                            env=environment).stdout.strip().decode('ascii')
    if not module.isdigit():
        raise ValueError('Reference sink unavailable')
    recording = playback = None
    try:
        recording = subprocess.Popen(['parec', '--device=' + name + '.monitor', '--raw',
                                      '--format=s16le', '--rate=8000', '--channels=1', '--latency-msec=20'],
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0, env=environment)
        time.sleep(.1)
        playback = subprocess.Popen(['pacat', '--playback', '--device=' + name, '--raw',
                                     '--format=s16le', '--rate=' + str(rate), '--channels=' + str(channels),
                                     '--latency-msec=20'], stdin=subprocess.PIPE,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=environment)
        def write():
            try:
                playback.communicate(pcm, timeout=4)
            except (OSError, subprocess.SubprocessError):
                AudioNotifications.stop_process(playback)
        threading.Thread(target=write, daemon=True).start()
        result, deadline, finished = bytearray(), time.monotonic() + 4, None
        with selectors.DefaultSelector() as selector:
            selector.register(recording.stdout, selectors.EVENT_READ)
            while time.monotonic() < deadline and len(result) < RATE * 2 * 4:
                for _, _ in selector.select(timeout=.05):
                    chunk = os.read(recording.stdout.fileno(), 8192)
                    if not chunk:
                        raise ValueError('Reference capture ended')
                    result.extend(chunk)
                if playback.poll() is not None:
                    finished = finished or time.monotonic()
                    if time.monotonic() - finished > .15:
                        break
        if playback.poll() != 0:
            raise ValueError('Reference playback failed')
        samples = list(pcm16(result[:len(result) - len(result) % 2]))
        ToneMatcher(samples)  # Reject a missing/silent reference before starting.
        return samples
    finally:
        for process in (playback, recording):
            if process is not None:
                AudioNotifications.stop_process(process)
        if recording is not None:
            recording.stdout.close()
        subprocess.run(['pactl', 'unload-module', module], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=3, env=environment)


def owns_stream(stream, client):
    properties = stream.get('properties', {})
    binary = Path(str(properties.get('application.process.binary', ''))).name.casefold()
    pid = str(properties.get('application.process.id', ''))
    if binary not in client.process_names or not pid.isdigit():
        return False
    try:
        process = Path('/proc') / pid
        return process.stat().st_uid == os.getuid() and process.joinpath('exe').resolve(strict=True).name.casefold() in client.process_names
    except OSError:
        return False


class AudioNotifications:
    def __init__(self, client, callback, enabled=lambda: True):
        self.client, self.callback, self.enabled = client, callback, enabled
        self.state = 'starting'
        self.samples = None
        self.captures = {}
        self.clock_process = None
        self.lock = threading.RLock()
        self.environment = dict(os.environ, LC_ALL='C')

    def listing(self, kind):
        result = subprocess.run(['pactl', '-f', 'json', 'list', kind], env=self.environment,
                                capture_output=True, timeout=3, check=True)
        return json.loads(result.stdout)

    @staticmethod
    def stop_process(process):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=1)

    @staticmethod
    def silent_clock(process):
        try:
            while process.poll() is None:
                process.stdin.write(b'\0' * 320)
                process.stdin.flush()
        except (OSError, ValueError):
            pass
        finally:
            try:
                process.stdin.close()
            except OSError:
                pass

    def capture(self, identity, process):
        try:
            matcher = ToneMatcher(self.samples)
            while True:
                raw = process.stdout.read(HOP * 2)
                if not raw:
                    break
                if matcher.feed(pcm16(raw[:len(raw) - len(raw) % 2])):
                    self.callback()
        except (OSError, ValueError):
            pass
        finally:
            self.stop_process(process)
            process.stdout.close()
            with self.lock:
                if self.captures.get(identity) is process:
                    self.captures.pop(identity, None)

    def refresh(self):
        enabled = self.enabled()
        if not enabled and self.clock_process is not None:
            self.stop_process(self.clock_process)
            self.clock_process = None
        if enabled and (self.clock_process is None or self.clock_process.poll() is not None):
            # A null sink otherwise renders short sounds in large idle batches,
            # before a new stream's isolated monitor can attach. Silent playback
            # keeps ONLY the container's virtual output clock at low latency.
            # This generates silence; it never records mixed audio or a microphone.
            # A pipe also ensures the child exits when the backend exits.
            output = next((item for item in self.listing('sinks')
                           if item.get('name') == 'output' and item.get('driver') == 'module-null-sink.c'), None)
            if output:
                self.clock_process = subprocess.Popen(['pacat', '--playback', '--device=output', '--raw',
                    '--format=s16le', '--rate=8000', '--channels=1', '--latency-msec=20'],
                    stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=self.environment)
                threading.Thread(target=self.silent_clock, args=(self.clock_process,), daemon=True).start()
        streams = self.listing('sink-inputs') if enabled else []
        wanted = {item['index']: item for item in streams if owns_stream(item, self.client)}
        with self.lock:
            for identity, process in list(self.captures.items()):
                if identity not in wanted:
                    self.stop_process(process)
                    self.captures.pop(identity, None)
            missing = [item for identity, item in wanted.items() if identity not in self.captures]
            if not missing:
                return
            sinks = {item['index']: item.get('monitor_source') for item in self.listing('sinks')}
            for item in missing:
                monitor = sinks.get(item.get('sink'))
                if len(self.captures) >= 4 or not isinstance(monitor, str):
                    continue
                process = subprocess.Popen(['parec', '--device=' + monitor, '--monitor-stream=' + str(item['index']),
                                            '--raw', '--format=s16le', '--rate=8000', '--channels=1', '--latency-msec=20'],
                                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=self.environment)
                self.captures[item['index']] = process
                threading.Thread(target=self.capture, args=(item['index'], process), daemon=True).start()

    def monitor(self):
        command = ['stdbuf', '-oL', 'pactl', 'subscribe'] if shutil.which('stdbuf') else ['pactl', 'subscribe']
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   env=self.environment, bufsize=0)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                self.refresh()
                self.state = 'connected'
                checked = time.monotonic()
                pending = b''
                while process.poll() is None:
                    for _, _ in selector.select(timeout=1):
                        raw = os.read(process.stdout.fileno(), 8192)
                        if not raw:
                            return
                        pending += raw
                        lines = pending.split(b'\n')
                        pending = lines.pop()
                        if any(re.search(rb"on sink-input #\d+", line) for line in lines):
                            self.refresh()
                    if time.monotonic() - checked >= 5:
                        # Recovers a dropped event and follows subscription revocation.
                        self.refresh()
                        checked = time.monotonic()
        finally:
            self.stop_process(process)
            process.stdout.close()
            with self.lock:
                for capture in list(self.captures.values()):
                    self.stop_process(capture)
                self.captures.clear()
            if self.clock_process is not None:
                self.stop_process(self.clock_process)
                self.clock_process = None

    def watch(self):
        while True:
            try:
                if not self.enabled():
                    self.state = 'waiting'
                    time.sleep(5)
                    continue
                if not all(shutil.which(name) for name in ('pactl', 'parec', 'pacat')):
                    raise ValueError('PulseAudio tools unavailable')
                self.samples = pulse_reference(installed_tone_bytes(self.client))
                self.monitor()
                self.state = 'waiting'
            except (OSError, ValueError, subprocess.SubprocessError, KeyError, TypeError):
                self.state = 'unavailable'
            time.sleep(8)

    def start(self):
        threading.Thread(target=self.watch, daemon=True).start()
