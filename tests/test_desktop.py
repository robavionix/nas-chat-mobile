"""Offline checks for the computer view and home-network stream tokens; no GUI or chat account is required."""
import ast
import hashlib
import hmac
import secrets
import threading
import time
import unittest
from pathlib import Path

SOURCE = ast.parse(Path('mobile/server.py').read_text(encoding='utf-8'))


def load(names, scope):
    nodes = [n for n in SOURCE.body if isinstance(n, ast.FunctionDef) and n.name in names]
    assert {n.name for n in nodes} == set(names), names
    exec(compile(ast.Module(body=nodes, type_ignores=[]), 'server.py', 'exec'), scope)
    return scope


def method(name):
    handler = next(n for n in SOURCE.body if isinstance(n, ast.ClassDef) and n.name == 'Handler')
    return next(n for n in handler.body if isinstance(n, ast.FunctionDef) and n.name == name)


class StreamTokenTests(unittest.TestCase):
    def setUp(self):
        self.scope = load(('stream_token', 'stream_token_valid'), {'time': time, 'secrets': secrets, 'hmac': hmac, 'hashlib': hashlib,
                                                                    'session_key': b'k' * 32, 'STREAM_TOKEN_SECONDS': 120})

    def test_fresh_token_is_accepted_and_tampering_is_not(self):
        token = self.scope['stream_token']()
        self.assertTrue(self.scope['stream_token_valid'](token))
        kind, expiry, nonce, signature = token.split('.')
        self.assertFalse(self.scope['stream_token_valid']('.'.join((kind, str(int(expiry) + 999), nonce, signature))))
        self.assertFalse(self.scope['stream_token_valid']('stream.1.2'))
        self.assertFalse(self.scope['stream_token_valid'](None))

    def test_expiry_only_limits_opening_and_signing_out_everywhere_revokes(self):
        self.scope['STREAM_TOKEN_SECONDS'] = -1
        token = self.scope['stream_token']()
        self.assertFalse(self.scope['stream_token_valid'](token))
        self.assertTrue(self.scope['stream_token_valid'](token, False), 'an open stream outlives the opening window')
        self.scope['session_key'] = b'r' * 32
        self.assertFalse(self.scope['stream_token_valid'](token, False), 'a new session key ends token streams')


class DesktopGeometryTests(unittest.TestCase):
    def test_wechat_widens_and_qq_turns_landscape_at_its_scale(self):
        scope = load(('desktop_geometry',), {'QQ_SCALE': 3})
        wechat = {'client': 'wechat', 'screenWidth': 1800, 'screenHeight': 2800}
        self.assertEqual(scope['desktop_geometry'](wechat, .625), (1800, 1125))
        self.assertEqual(scope['desktop_geometry'](wechat, .3), (1800, 800), 'a very wide browser keeps a usable height')
        self.assertEqual(scope['desktop_geometry'](wechat, 3), (1800, 2740), 'never taller than the screen allows')
        qq = {'client': 'qq', 'screenWidth': 4200, 'screenHeight': 6000}
        self.assertEqual(scope['desktop_geometry'](qq, .6), (4050, 2430))
        self.assertEqual(scope['desktop_geometry'](qq, .4), (4050, 2100))

    def test_capture_covers_the_window_and_what_is_open_over_it(self):
        scope = load(('target_rect',), {})
        current = {'id': '7', 'x': 0, 'y': 0, 'width': 1800, 'height': 1100, 'screenWidth': 1800, 'screenHeight': 2800, 'popups': []}
        self.assertEqual(scope['target_rect'](current, 'desktop'), ([0, 0, 1800, 1100], 'desktop:7'))
        current['popups'] = [{'x': 1700, 'y': 900, 'width': 400, 'height': 400}]
        self.assertEqual(scope['target_rect'](current, 'desktop')[0], [0, 0, 1800, 1300], 'clipped to the screen')


class PopupFitTests(unittest.TestCase):
    def test_spilling_viewers_shrink_onto_the_window_and_small_dialogs_only_move(self):
        calls = []

        class Display:
            def __enter__(self): return self
            def __exit__(self, *args): pass

        class Clock:
            @staticmethod
            def sleep(_): pass

        scope = load(('fit_desktop_popups',), {'lock': threading.Lock(), 'time': Clock, 'X': Display, 'subprocess': __import__('subprocess'),
                                               'run': lambda *a: calls.append(a), 'clear_window_state': lambda d, wid: calls.append(('clear', wid))})
        current = {'x': 0, 'y': 0, 'width': 4050, 'height': 2430, 'popups': [
            {'id': 'viewer', 'kind': 'window', 'x': 0, 'y': 0, 'width': 4200, 'height': 6000},
            {'id': 'dialog', 'kind': 'dialog', 'x': 1800, 'y': 2800, 'width': 900, 'height': 600},
            {'id': 'inside', 'kind': 'dialog', 'x': 100, 'y': 100, 'width': 500, 'height': 400},
            {'id': 'menu', 'kind': 'menu', 'x': 3900, 'y': 2300, 'width': 600, 'height': 900}]}
        fitted = set()
        self.assertTrue(scope['fit_desktop_popups'](current, fitted))
        self.assertEqual(calls, [('clear', 'viewer'), ('xdotool', 'windowsize', 'viewer', '4050', '2430'),
                                 ('xdotool', 'windowmove', 'viewer', '0', '0'), ('xdotool', 'windowmove', 'dialog', '1575', '915')])
        calls.clear()
        self.assertFalse(scope['fit_desktop_popups'](current, fitted), 'each window is fitted once')
        self.assertEqual(calls, [])


class DesktopTapTests(unittest.TestCase):
    def tap(self, current, x, y, clicks=1, leased=1):
        replies, clicked = [], []

        class Client:
            label = 'QQ'

        scope = {'desktop_lease': {'clients': leased}, 'QQ_SCALE': 3, 'client': Client, 'clipboard_text': lambda: None,
                 'run': lambda *a: None, 'native_click': lambda *a, **k: clicked.append(a[1:3]), 'time': time,
                 'wait_layout': lambda *a, **k: current, 'debug': lambda *a, **k: None, 'brief': lambda c: None}
        exec(compile(ast.Module(body=[method('desktop_tap')], type_ignores=[]), 'server.py', 'exec'), scope)

        class Handler:
            def reply(self, status, **value):
                replies.append((status, value.get('error')))
        scope['desktop_tap'](Handler(), current, x, y, 1, clicks, time.monotonic())
        return replies[0], clicked

    def test_window_buttons_outside_points_and_bad_counts_are_refused(self):
        qq = {'client': 'qq', 'x': 0, 'y': 0, 'width': 4050, 'height': 2430, 'popups': [], 'conversation': '1:a'}
        self.assertEqual(self.tap(qq, 4000, 30)[0][0], 400)
        self.assertEqual(self.tap(qq, 4100, 300)[0][0], 400)
        self.assertEqual(self.tap(qq, 900, 900, clicks=3)[0][0], 400)
        self.assertEqual(self.tap(qq, 900, 900, leased=0)[0][0], 409)
        reply, clicked = self.tap(qq, 900, 900, clicks=2)
        self.assertEqual(reply[0], 200)
        self.assertEqual(clicked, [(900, 900), (900, 900)], 'a double click reaches the client as two quick clicks')

    def test_a_popup_over_the_title_bar_can_still_be_closed(self):
        viewer = {'id': 'v', 'kind': 'window', 'x': 0, 'y': 0, 'width': 4050, 'height': 2430}
        qq = {'client': 'qq', 'x': 0, 'y': 0, 'width': 4050, 'height': 2430, 'popups': [viewer], 'conversation': '1:a'}
        reply, clicked = self.tap(qq, 4000, 30)
        self.assertEqual(reply[0], 200)
        self.assertEqual(clicked, [(4000, 30)])


if __name__ == '__main__':
    unittest.main()
