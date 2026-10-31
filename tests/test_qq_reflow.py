"""Exercise native reflow and recapture, including group sidebar compensation."""
import ast
import sys
import time
import unittest
from pathlib import Path
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'mobile'))
from client_adapter import get_client


class ReflowTests(unittest.TestCase):
    def test_private_and_group_keep_full_message_column_at_readable_phone_size(self):
        source = ast.parse(Path('mobile/server.py').read_text(encoding='utf-8'))
        names = ('layout', 'qq_profile', 'qq_send_button', 'fit_qq')
        nodes = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in names]
        for scale in (1, 2, 3):
            for sidebar in (0, 184):
                with self.subTest(scale=scale, sidebar=sidebar):
                    window = {'id': '1', 'class': 'QQ', 'name': 'QQ', 'override': False, 'types': set(),
                              'width': 1200*scale, 'height': 1980*scale, 'x': 0, 'y': 0}
                    images = {}

                    class Display:
                        width, height = 1800*scale, 2000*scale
                        def __enter__(self): return self
                        def __exit__(self, *args): pass
                        def windows(self): return [window]
                        def unmaximize(self, wid): pass
                        def grab(self, x, y, width, height):
                            key = (window['width'], window['height'])
                            if key not in images:
                                w, h = key
                                right = w-sidebar*scale
                                # QQ can narrow its conversation column along
                                # with the window; phone list sizing must not.
                                split = min(376*scale, round(right*.38))
                                image = Image.new('RGB', key, (245, 245, 245)); draw = ImageDraw.Draw(image)
                                draw.line((split, 40*scale, split, h-4*scale), fill=(235,235,235), width=scale)
                                if sidebar:
                                    draw.line((right, 96*scale, right, h-4*scale), fill=(235,235,235), width=scale)
                                draw.line((split+2*scale, h-211*scale, right-scale, h-211*scale), fill=(235,235,235), width=scale)
                                draw.rectangle((right-102*scale, h-48*scale, right-25*scale, h-16*scale), fill=(0,153,255))
                                images.clear(); images[key] = image
                            return images[key].crop((x, y, x+width, y+height))

                    commands = []
                    def run(*args):
                        commands.append(args)
                        if args[1] == 'windowsize': window.update(width=int(args[3]), height=int(args[4]))
                        elif args[1] == 'windowmove': window.update(x=int(args[3]), y=int(args[4]))

                    scope = {'X':Display, 'client':get_client('qq'), 'IGNORED_TYPES':set(), 'Image':Image,
                             'QQ_SCALE':scale, 'qq_geometry_cache':{}, 'time':time, 'run':run,
                             'inspect_qq':lambda *_: (False, 'chat'), 'summary':lambda w:w,
                             'desktop_lease':{'clients':0}}
                    exec(compile(ast.Module(body=nodes, type_ignores=[]), 'server.py', 'exec'), scope)
                    scope['wait_layout'] = lambda *args, **kwargs: scope['layout']()
                    before = scope['layout'](); self.assertTrue(before['editorReady'])
                    after = scope['fit_qq'](before)
                    self.assertTrue(after['editorReady'])
                    self.assertEqual(after['width'], after['preferredWidth'])
                    chat, listing = after['panes']['chat'], after['panes']['list']
                    # Both variants leave the same readable message width. The
                    # entire bubble/avatar column fits, without a magnified crop.
                    self.assertTrue(540 < chat['width']/scale < 580)
                    self.assertAlmostEqual((after['width']-chat['x']-chat['width'])/scale, sidebar+4, delta=1)
                    self.assertLess(after['inputPoint'][0], chat['x']+chat['width'])
                    self.assertLess(after['sendPoint'][0], chat['x']+chat['width'])
                    self.assertGreater(after['inputPoint'][1], chat['y']+chat['height'])
                    # Actual native line/row measurements rendered into a
                    # typical iPhone width should resemble the WeChat reference.
                    glyph = (61/3)*scale*390/chat['width']
                    row = 80*scale*390/listing['width']*listing['density']
                    self.assertTrue(13.5 < glyph < 15, glyph)
                    self.assertTrue(64 < row < 70, row)
                    old_listing = before['panes']['list']
                    old_row = 80*scale*390/old_listing['width']*old_listing['density']
                    self.assertAlmostEqual(row, old_row, delta=.01)
                    self.assertFalse(any(cmd[1] == 'windowactivate' for cmd in commands))


if __name__ == '__main__':
    unittest.main()
