import ast
import ctypes
import io
import json
import struct
import sys
import threading
import unittest
import zlib
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'mobile'))
from screen_activity import ScreenActivity
from PIL import Image


class ScreenActivityTest(unittest.TestCase):
    def test_unavailable_extension_keeps_polling(self):
        def missing(name):
            raise OSError('minimal X server')
        with ScreenActivity(threading.Lock(), loader=missing) as activity:
            self.assertTrue(activity.changed())

    def test_quiet_damage_and_safety_capture(self):
        now = [100]
        activity = ScreenActivity(threading.Lock(), clock=lambda: now[0])
        activity.display, activity.damage, activity.event_type = 1, 2, 101
        events, subtracts = [], []

        class X:
            def XPending(self, display):
                return len(events)

            def XNextEvent(self, display, pointer):
                ctypes.cast(pointer, ctypes.POINTER(ctypes.c_int))[0] = events.pop(0)

            def XFlush(self, display):
                pass

        class Extension:
            def XDamageSubtract(self, *args):
                subtracts.append(args)

        activity.x, activity.ext = X(), Extension()
        activity.captured()
        self.assertFalse(activity.changed())
        events.extend([5, 101, 101])
        self.assertTrue(activity.changed())
        self.assertEqual(len(subtracts), 1, 'a damage burst is acknowledged once')
        activity.captured()
        now[0] += 1.99
        self.assertFalse(activity.changed())
        now[0] += .02
        self.assertTrue(activity.changed(), 'direct renderers still get bounded fallback capture')

    def test_idle_capture_and_immediate_damage(self):
        source = Path('mobile/server.py').read_text(encoding='utf-8')
        tree = ast.parse(source)
        method = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == 'capture_frames')
        # An unexpected error is a failure, not a simulated reconnect loop.
        for handler in ast.walk(method):
            if isinstance(handler, ast.ExceptHandler) and isinstance(handler.type, ast.Name) and handler.type.id == 'Exception':
                handler.body = [ast.copy_location(ast.Raise(), handler)]
        phone = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'PhonePicture')
        runs = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'strip_runs')
        now, grabs, packets = [100.0], [], []

        class Finished(BaseException):
            pass

        class Clock:
            def monotonic(self):
                return now[0]

            def sleep(self, seconds):
                now[0] += seconds
                if now[0] > 106:
                    raise Finished()

        class Display:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def raw(self, *args):
                grabs.append(now[0])
                pixel = b'\x88\x88\x88\xff' if now[0] < 103 else b'\x99\x99\x99\xff'
                return pixel * 16 * 16, 16, 16, 64

        class Activity:
            captured_at = 0
            event = False

            def changed(self):
                if now[0] >= 103 and not self.event:
                    self.event = True
                    return True
                return now[0] - self.captured_at >= 2

            def captured(self):
                self.captured_at = now[0]

        layout = {'id': '1', 'conversation': 'same', 'popups': []}
        ns = {'time': Clock(), 'json': json, 'struct': struct, 'zlib': zlib, 'Image': Image, 'defaultdict': defaultdict,
              'X': Display, 'layout': lambda: layout, 'target_rect': lambda *args: ([0, 0, 16, 16], 'main'),
              'qq_capture_matches': lambda *args: True, 'qq_geometry_cache': {}, 'BAND': 64, 'EDGE': 8, 'QQ_SCALE': 1,
              'encode_strip': lambda *args, **kwargs: (b'image', 'image/jpeg')}
        exec(compile(ast.Module(body=[phone, runs, method], type_ignores=[]), 'capture-test', 'exec'), ns)
        with self.assertRaises(Finished):
            ns['capture_frames'](None, packets.append, lambda: True, lambda: len(packets) + 1, lambda: .1, 'clear', Activity())
        self.assertLess(len(grabs), 13, 'quiet streams no longer scrape the screen four times per second')
        self.assertTrue(any(103 <= stamp < 103.2 for stamp in grabs), 'new damage bypasses the safety polling delay')
        self.assertGreaterEqual(len(packets), 3, 'initial, changed and final sharp pixels are delivered')


if __name__ == '__main__':
    unittest.main()
