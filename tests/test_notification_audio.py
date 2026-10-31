"""Synthetic audio only: no proprietary sounds, microphone or push endpoints."""
import io
import math
from pathlib import Path
import random
import struct
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'mobile'))
from notification_audio import ToneMatcher, wav_samples, qt_message_tone, AudioNotifications, owns_stream


def tone(rate=8000, frequency=640, seconds=.6):
    return [int(7000 * (1 - n / (rate * seconds) * .6) *
                (math.sin(2 * math.pi * (frequency * n / rate + 170 * (n / rate) ** 2))
                 + .35 * math.sin(2 * math.pi * 1.7 * frequency * n / rate)))
            for n in range(int(rate * seconds))]


def wav(values, rate=8000, channels=1):
    output = io.BytesIO()
    with wave.open(output, 'wb') as sound:
        sound.setparams((channels, 2, rate, 0, 'NONE', 'not compressed'))
        sound.writeframes(b''.join(struct.pack('<h', value) * channels for value in values))
    return output.getvalue()


class AudioTests(unittest.TestCase):
    def test_chunked_gain_shifted_and_repeated_tone(self):
        reference = tone()
        matcher = ToneMatcher(reference)
        samples = [0] * 123 + [int(value * .35) for value in reference[250:]] + [0] * 9000 + reference
        matches = 0
        for start in range(0, len(samples), 117):
            matches += matcher.feed(samples[start:start + 117])
        self.assertEqual(matches, 2)
        self.assertLessEqual(len(matcher.pending), 160)
        self.assertLessEqual(len(matcher.history), len(matcher.reference))

    def test_silence_noise_and_other_ringtone_do_not_notify(self):
        randomizer = random.Random(42)
        reference = tone()
        for samples in ([0] * 16000, tone(frequency=970), [randomizer.randint(-8000, 8000) for _ in range(16000)]):
            self.assertEqual(ToneMatcher(reference).feed(samples), 0)
        with self.assertRaises(ValueError):
            ToneMatcher([0] * 8000)

    def test_stereo_resampling_and_internal_silence(self):
        samples = tone(rate=48000)
        mono = wav_samples(wav(samples, 48000, 2))
        self.assertEqual(len(mono), 4800)
        mono[2000:2400] = [0] * 400
        self.assertEqual(ToneMatcher(mono).feed(mono), 1)

    def test_named_qt_resource_does_not_guess_first_wav(self):
        names = ['gui', 'xui', 'resupdate', 'multimedia', 'lock_closing.wav',
                 'lock_opening.wav', 'voip_phone_ending.wav', 'voip_phone_ringing.wav', 'wechat_notify.wav']
        table, name_offsets = bytearray(), {}
        for name in names:
            name_offsets[name] = len(table)
            table.extend(struct.pack('>HI', len(name), 0) + name.encode('utf-16-be'))
        data, nodes, expected = bytearray(), bytearray(), None
        for index, name in enumerate(names[4:]):
            raw = wav(tone(frequency=400 + index * 120))
            nodes.extend(struct.pack('>IHHHIQ', name_offsets[name], 0, 0, 1, len(data), 0))
            data.extend(struct.pack('>I', len(raw)) + raw)
            if name == 'wechat_notify.wav':
                expected = raw
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / 'client'
            executable.write_bytes(b'ELF' + nodes + table + data)
            self.assertEqual(qt_message_tone(executable), expected)
            broken = bytearray(executable.read_bytes())
            broken[3 + 10:3 + 14] = b'\xff\xff\xff\xff'
            executable.write_bytes(broken)
            with self.assertRaises(ValueError):
                qt_message_tone(executable)

    def test_unrelated_stream_and_spoofed_process_are_excluded(self):
        client = SimpleNamespace(process_names=('client',))
        self.assertFalse(owns_stream({'properties': {'application.process.binary': 'browser'}}, client))
        stream = {'properties': {'application.process.binary': 'client', 'application.process.id': '42'}}
        process = SimpleNamespace(stat=lambda: SimpleNamespace(st_uid=1000),
                                  joinpath=lambda name: SimpleNamespace(resolve=lambda **kwargs: SimpleNamespace(name='browser')))
        with patch('notification_audio.Path') as path, patch('notification_audio.os.getuid', return_value=1000, create=True):
            path.return_value.name = 'client'
            path.return_value.__truediv__.return_value = process
            self.assertFalse(owns_stream(stream, client))

    def test_capture_is_bound_to_exact_client_sink_and_revocation_stops_it(self):
        client = SimpleNamespace(process_names=('client',))
        enabled = [True]
        service = AudioNotifications(client, lambda: None, lambda: enabled[0])
        service.samples = tone()
        stream = {'index': 7, 'sink': 3}
        service.listing = lambda kind: [stream] if kind == 'sink-inputs' else [{'index': 3, 'monitor_source': 'output.monitor'}]
        with patch('notification_audio.owns_stream', return_value=True), patch('notification_audio.subprocess.Popen') as popen, patch('notification_audio.threading.Thread'):
            service.refresh()
            command = popen.call_args.args[0]
            self.assertIn('--monitor-stream=7', command)
            self.assertIn('--device=output.monitor', command)
            self.assertNotIn('@DEFAULT_SOURCE@', command)
            enabled[0] = False
            service.refresh()
            self.assertFalse(service.captures)


if __name__ == '__main__':
    unittest.main()
