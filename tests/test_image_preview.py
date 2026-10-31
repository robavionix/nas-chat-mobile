import ast
import unittest
from pathlib import Path
from types import SimpleNamespace


class ImagePreviewTest(unittest.TestCase):
    def setup_tap(self):
        tree=ast.parse(Path('mobile/server.py').read_text(encoding='utf-8'))
        method=next(node for node in ast.walk(tree) if isinstance(node,ast.FunctionDef) and node.name=='tap')
        current={'client':'qq','chatReady':True,'compactList':False,'mainWindow':True,'id':'1','conversation':'friend','popups':[]}
        clicks=[]
        ns={'time':SimpleNamespace(monotonic=lambda:100,sleep=lambda value:None),'layout':lambda:current,
            'debug':lambda *args,**kwargs:None,'brief':lambda value:None,
            'pane_region':lambda *args:{'x':1000,'y':120,'width':1700,'height':5000,'header':168},
            'navigation':{'identity':'friend'},'native_click':lambda *args,**kwargs:clicks.append(kwargs),
            'wait_layout':lambda *args,**kwargs:current}
        exec(compile(ast.Module(body=[method],type_ignores=[]),'image-preview','exec'),ns)
        handler=SimpleNamespace(reply=lambda status,**value:(status,value))
        payload={'x':1500,'y':1000,'button':1,'clickCount':2,'target':'main','window':'1','conversation':'friend'}
        return ns['tap'],handler,payload,current,clicks

    def test_real_double_click_is_limited_to_chat_body(self):
        tap,handler,payload,current,clicks=self.setup_tap()
        self.assertEqual(tap(handler,payload)[0],200)
        self.assertEqual(len(clicks),2)
        self.assertTrue(all(not click['guard'] for click in clicks))
        self.assertFalse(clicks[1]['activate'],'second click stays in the already-focused client')

    def test_header_list_other_clients_and_changed_chat_are_rejected(self):
        for change in ({'y':150},{'conversation':'other'},{'clickCount':True},{'clickCount':3}):
            tap,handler,payload,current,clicks=self.setup_tap()
            payload.update(change)
            self.assertIn(tap(handler,payload)[0],(400,409));self.assertEqual(clicks,[])
        for change in ({'client':'wechat'},{'compactList':True},{'popups':[{'id':'popup'}]}):
            tap,handler,payload,current,clicks=self.setup_tap()
            current.update(change)
            self.assertEqual(tap(handler,payload)[0],400);self.assertEqual(clicks,[])

    def test_single_click_keeps_existing_guard(self):
        tap,handler,payload,current,clicks=self.setup_tap()
        payload.pop('clickCount')
        self.assertEqual(tap(handler,payload)[0],200)
        self.assertEqual(len(clicks),1);self.assertTrue(clicks[0]['guard'])


if __name__=='__main__':
    unittest.main()
