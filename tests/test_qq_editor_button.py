"""A send-button caption must not hide a ready private/group chat editor."""
import ast
import unittest
from pathlib import Path


class Pixels:
    def __init__(self, scale, pattern, width):
        self.scale, self.pattern, self.width = scale, pattern, width

    def getpixel(self, point):
        x, y = (value/self.scale for value in point)
        centre = (self.width-1)/self.scale/2
        if self.pattern == 'caption':
            return (255,255,255) if centre-8 <= x <= centre+8 and y < 6 else (0,153,255)
        if self.pattern == 'plain': return (0,153,255)
        if self.pattern == 'empty-editor': return (201,226,255)
        if self.pattern == 'single': return (0,153,255) if (x,y) == (centre,0) else (245,245,245)
        if self.pattern == 'one-sided': return (0,153,255) if x < 3 else (245,245,245)
        if self.pattern == 'round-icon':
            return (0,153,255) if (x-centre)**2+(y-4)**2 < 12**2 else (245,245,245)
        return (245,245,245)


class Display:
    def __init__(self, scale, pattern): self.scale, self.pattern = scale, pattern
    def grab(self, x, y, width, height): return Pixels(self.scale, self.pattern, width)


class EditorButtonTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = Path('mobile/server.py').read_text(encoding='utf-8')
        node = next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name == 'qq_send_button')
        namespace = {}
        exec(compile(ast.Module(body=[node],type_ignores=[]),'editor-button','exec'),namespace)
        cls.recognize = staticmethod(namespace['qq_send_button'])

    def test_white_caption_and_empty_editor_at_all_supported_dpis(self):
        for scale in (1,2,3):
            for pattern in ('caption','plain','empty-editor'):
                with self.subTest(scale=scale,pattern=pattern):
                    self.assertTrue(self.recognize(Display(scale,pattern),[800,1000],scale))

    def test_blue_icons_and_incomplete_edges_are_not_editors(self):
        for scale in (1,2,3):
            for pattern in ('blank','single','one-sided','round-icon'):
                with self.subTest(scale=scale,pattern=pattern):
                    self.assertFalse(self.recognize(Display(scale,pattern),[800,1000],scale))


if __name__ == '__main__': unittest.main()
