import ast
import threading
import time
import unittest
from pathlib import Path

TREE = ast.parse(Path('mobile/server.py').read_text(encoding='utf-8'))


class Client:
    label = 'QQ'


class DragTest(unittest.TestCase):
    """Mouse drags in the computer view: scrollbars, sliders and text selection on the native client."""

    def setUp(self):
        self.commands = []
        self.window = {'id': '7', 'x': 0, 'y': 0, 'width': 1000, 'height': 800, 'screenWidth': 1200, 'screenHeight': 900,
                       'popups': [], 'client': 'wechat'}
        nodes = [n for n in ast.walk(TREE) if isinstance(n, ast.FunctionDef) and n.name in ('drag', 'release_drag')]
        self.assertEqual(len(nodes), 2)
        self.ns = {'lock': threading.Lock(), 'drag_state': {'down': False, 'timer': None},
                   'desktop_lease': {'clients': 1}, 'layout': lambda: self.window, 'threading': threading, 'time': time,
                   'run': lambda *a: self.commands.append(a) or '', 'last_click': {}, 'client': Client(), 'QQ_SCALE': 3}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), 'drag', 'exec'), self.ns)

    def call(self, **payload):
        class Request:
            def reply(_, status, **value):
                return status, value
        return self.ns['drag'](Request(), payload)[0]

    def test_press_move_release_reaches_the_native_client(self):
        self.assertEqual(self.call(action='down', x=990, y=400), 200)
        self.assertEqual(self.call(action='move', x=990, y=600), 200)
        self.assertEqual(self.call(action='up', x=990, y=650), 200)
        self.assertEqual(self.commands, [
            ('xdotool', 'windowactivate', '--sync', '7'),
            ('xdotool', 'mousemove', '990', '400', 'mousedown', '1'),
            ('xdotool', 'mousemove', '990', '600'),
            ('xdotool', 'mousemove', '990', '650', 'mouseup', '1')])
        self.assertFalse(self.ns['drag_state']['down'])
        self.assertIsNone(self.ns['drag_state']['timer'])

    def test_moves_outside_keep_dragging_but_stay_on_screen(self):
        self.call(action='down', x=500, y=400)
        self.call(action='move', x=5000, y=-40)
        self.assertEqual(self.commands[-1], ('xdotool', 'mousemove', '1199', '0'))
        self.call(action='up', x=500, y=400)

    def test_drags_start_only_inside_the_window_and_never_on_its_buttons(self):
        self.assertEqual(self.call(action='down', x=1100, y=400), 400)
        self.assertEqual(self.call(action='down', x=950, y=10), 400, 'title-bar buttons stay unavailable')
        self.assertEqual(self.call(action='move', x=10, y=10), 409, 'no move without a press')
        self.assertEqual(self.call(action='down', x='1', y=2), 400)
        self.assertEqual(self.call(action='spin', x=1, y=2), 400)
        self.ns['desktop_lease']['clients'] = 0
        self.assertEqual(self.call(action='down', x=500, y=400), 409, 'phones do not drag the shared desktop')
        self.assertEqual(self.commands, [])

    def test_a_vanished_page_does_not_leave_the_button_held(self):
        self.call(action='down', x=500, y=400)
        timer = self.ns['drag_state']['timer']
        self.assertIsNotNone(timer)
        timer.cancel()
        self.ns['release_drag']()
        self.assertEqual(self.commands[-1], ('xdotool', 'mouseup', '1'))
        self.assertFalse(self.ns['drag_state']['down'])
        self.assertEqual(self.call(action='move', x=500, y=500), 409)

    def test_a_new_press_releases_a_stale_one_first(self):
        self.call(action='down', x=500, y=400)
        self.call(action='down', x=600, y=400)
        self.assertIn(('xdotool', 'mouseup', '1'), self.commands)
        self.ns['drag_state']['timer'].cancel()

    def test_route_is_registered_under_the_desktop_lock(self):
        source = Path('mobile/server.py').read_text(encoding='utf-8')
        self.assertIn("'/drag': self.drag", source)


if __name__ == '__main__':
    unittest.main()
