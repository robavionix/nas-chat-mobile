"""Offline client isolation checks; no GUI or real chat account is required."""
import ast
import os
import sys
import tempfile
import unittest
import secrets
import hmac
import hashlib
import time
from collections import deque
from PIL import Image, ImageDraw
from http.cookies import SimpleCookie
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'mobile'))
from client_adapter import get_client
from push_service import PushService


class ClientTests(unittest.TestCase):
    def test_qq_offscreen_retina_window_does_not_capture_empty_rows(self):
        tree=ast.parse(Path('mobile/server.py').read_text(encoding='utf-8'))
        nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='qq_profile']
        scope={'QQ_SCALE':3}
        exec(compile(ast.Module(body=nodes,type_ignores=[]),'server.py','exec'),scope)
        class Display:
            def grab(self,*args):raise AssertionError('offscreen pixels must not be captured')
        box={'id':'QQ3','x':1620,'y':1410,'width':4200,'height':4200,'screenWidth':4200,'screenHeight':4200}
        self.assertIsNone(scope['qq_profile'](Display(),box))

    def test_default_and_invalid_client(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(get_client().key, 'wechat')
        with patch.dict(os.environ, {'CHAT_CLIENT': 'QQ'}):
            self.assertEqual(get_client().key, 'qq')
        with self.assertRaises(ValueError):
            get_client('unknown')

    def test_windows_are_isolated_and_dialogs_do_not_become_main(self):
        wechat, qq = get_client('wechat'), get_client('qq')
        w = {'class': 'QQ', 'name': 'QQ', 'override': False}
        self.assertTrue(qq.matches(w))
        self.assertFalse(wechat.matches(w))
        self.assertFalse(qq.matches(w | {'name': 'Image viewer'}))
        self.assertFalse(qq.matches(w | {'override': True}))
        w = {'class': 'wechat', 'name': '微信', 'override': False}
        self.assertTrue(wechat.matches(w))
        self.assertFalse(qq.matches(w))

    def test_qq_does_not_use_wechat_send_coordinates(self):
        source = ast.parse(Path('mobile/server.py').read_text(encoding='utf-8'))
        functions = [n for n in source.body if isinstance(n, ast.FunctionDef) and n.name in ('layout', 'validated_chat','qq_profile')]
        window = {'id': '1', 'class': 'QQ', 'name': 'QQ', 'override': False, 'types': set(),
                  'width': 1120, 'height': 900, 'x': 0, 'y': 0}
        class Display:
            width, height = 1800, 2800
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def windows(self): return [window]
            def grab(self,x,y,width,height): return Image.new('RGB',(width,height),'white')
        scope = {'X': Display, 'client': get_client('qq'), 'IGNORED_TYPES': set(),'qq_geometry_cache':{},'time':time,'QQ_SCALE':1}
        exec(compile(ast.Module(body=functions, type_ignores=[]), 'server.py', 'exec'), scope)
        current = scope['layout']()
        self.assertEqual(current['client'], 'qq')
        self.assertFalse(current['chatReady'])
        self.assertTrue(current['setupRequired'])
        self.assertFalse(scope['validated_chat'](current, {'window': '1', 'conversation': None}))

    def test_qq_uses_verified_separators_and_independent_capture_regions(self):
        tree = ast.parse(Path('mobile/server.py').read_text(encoding='utf-8'))
        names = ('qq_profile','pane_region','input_point','send_point','target_rect')
        functions = [n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names]
        scope = {'time':time,'qq_geometry_cache':{},'QQ_SCALE':1,'Image':Image}
        exec(compile(ast.Module(body=functions,type_ignores=[]),'server.py','exec'),scope)
        image = Image.new('RGB',(960,900),(245,245,245))
        draw = ImageDraw.Draw(image)
        draw.line((306,40,306,896),fill=(235,235,235))
        draw.line((308,689,955,689),fill=(235,235,235))
        draw.rectangle((858,852,935,884),fill=(0,153,255))
        class Display:
            def grab(self,x,y,width,height): return image.crop((x,y,x+width,y+height))
        current = {'id':'QQ','x':0,'y':0,'width':960,'height':900,'screenWidth':1800,'screenHeight':2800,
                   'popups':[],'compactList':True,'chatReady':True}
        profile = scope['qq_profile'](Display(),current)
        self.assertIsNotNone(profile)
        self.assertEqual(profile['list'],{'x':60,'y':40,'width':246,'height':856,'header':52})
        self.assertEqual(profile['chat'],{'x':308,'y':40,'width':648,'height':649,'header':56,'headerWidth':420,'headerRight':190,'fillViewport':True})
        current.update(panes={key:profile[key] for key in ('list','chat')},inputPoint=profile['inputPoint'],sendPoint=profile['sendPoint'])
        self.assertEqual(scope['input_point'](current),[633,769])
        self.assertEqual(scope['send_point'](current),[896,868])
        rect,key = scope['target_rect'](current,'main')
        self.assertEqual((rect,key),([60,40,246,856],'main:QQ:list'))
        current['compactList'] = False
        self.assertEqual(scope['target_rect'](current,'main'),([308,40,648,649],'main:QQ:chat'))
        # Before selecting a chat, the list still works but sending remains blocked.
        scope['qq_geometry_cache'].clear()
        draw.rectangle((858,852,935,884),fill='white')
        unopened = scope['qq_profile'](Display(),current)
        self.assertIsNotNone(unopened)
        self.assertFalse(unopened['editorReady'])
        self.assertNotIn('sendPoint',unopened)
        self.assertEqual(unopened['list'],profile['list'])
        # A completely unrelated image still cannot enable the phone layout.
        scope['qq_geometry_cache'].clear()
        draw.rectangle((0,0,959,899),fill='white')
        self.assertIsNone(scope['qq_profile'](Display(),current))

    def test_push_sources_are_isolated(self):
        with tempfile.TemporaryDirectory() as root:
            qq = PushService(root, client=get_client('qq'))
            wechat = PushService(root, client=get_client('wechat'))
            self.assertTrue(qq.accepts_notification('QQ'))
            self.assertTrue(qq.accepts_notification('com.tencent.qq'))
            self.assertFalse(qq.accepts_notification('WeChat'))
            self.assertFalse(wechat.accepts_notification('QQ'))
            self.assertTrue(wechat.accepts_notification('微信'))
            self.assertFalse(qq.accepts_notification('QQ browser'))

    def test_qq_three_times_dpi_measures_native_pixels(self):
        tree=ast.parse(Path('mobile/server.py').read_text(encoding='utf-8'))
        nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='qq_profile']
        scope={'time':time,'qq_geometry_cache':{},'QQ_SCALE':3,'Image':Image}
        exec(compile(ast.Module(body=nodes,type_ignores=[]),'server.py','exec'),scope)
        image=Image.new('RGB',(2880,2700),(245,245,245));draw=ImageDraw.Draw(image)
        draw.line((918,120,918,2688),fill=(235,235,235),width=3)
        # A message at the bottom must not hide the editor separator.
        draw.rectangle((954,2055,2300,2064),fill=(60,60,60))
        draw.line((924,2067,2865,2067),fill=(235,235,235),width=3)
        draw.rectangle((2574,2556,2805,2652),fill=(0,153,255))
        class Display:
            def grab(self,x,y,width,height):return image.crop((x,y,x+width,y+height))
        profile=scope['qq_profile'](Display(),{'id':'QQ3x','x':0,'y':0,'width':2880,'height':2700})
        self.assertTrue(profile['editorReady'])
        self.assertEqual(profile['list']['header'],156)
        self.assertLessEqual(abs(profile['list']['width']-738),2)
        self.assertEqual(profile['sendPoint'],[2688,2604])
        self.assertLessEqual(abs(profile['chat']['height']-1947),2)

    def test_qq_blank_loading_page_cannot_keep_previous_recipient(self):
        tree=ast.parse(Path('mobile/server.py').read_text(encoding='utf-8'))
        nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='inspect_qq']
        nav={'identity':'old chat','revision':1,'list':False}
        scope={'navigation':nav,'Image':Image,'title_identity':lambda image:'new chat'}
        exec(compile(ast.Module(body=nodes,type_ignores=[]),'server.py','exec'),scope)
        image=Image.new('RGB',(900,102),'white')
        class Display:
            def grab(self,*args):return image
        box={'titleRect':[1183,150,900,102],'editorReady':False}
        is_list,key=scope['inspect_qq'](Display(),box,False)
        self.assertTrue(is_list)
        self.assertIsNone(nav['identity'])
        ImageDraw.Draw(image).rectangle((20,20,160,80),fill='black')
        is_list,key=scope['inspect_qq'](Display(),box,False)
        self.assertFalse(is_list)
        self.assertEqual(nav['identity'],'new chat')
        # A dialog covering the header cannot change the recipient.
        image.paste('white',(0,0,900,102))
        scope['inspect_qq'](Display(),box,True)
        self.assertEqual(nav['identity'],'new chat')

    def test_qq_selected_row_distinguishes_hover_and_blank_at_high_dpi(self):
        tree=ast.parse(Path('mobile/server.py').read_text(encoding='utf-8'))
        nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ('qq_selected_row','pane_region')]
        scope={'Image':Image}
        exec(compile(ast.Module(body=nodes,type_ignores=[]),'server.py','exec'),scope)
        current={'uiScale':3,'panes':{'list':{'x':180,'width':949}}}
        class Display:
            def grab(self,x,y,w,h):return Image.new('RGB',(w,h),color)
        for color,selected in [((213,213,213),True),((232,232,232),False),((245,245,245),False),((0,153,255),False)]:
            with self.subTest(color=color):
                self.assertEqual(scope['qq_selected_row'](Display(),current,390),selected)

    def test_search_only_types_into_the_verified_qq_list_header(self):
        tree=ast.parse(Path('mobile/server.py').read_text(encoding='utf-8'))
        handler=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='Handler')
        method=next(n for n in handler.body if isinstance(n,ast.FunctionDef) and n.name=='search')
        current={'id':'QQ3','chatReady':True,'compactList':True,'popups':[],'conversation':'1:list'}
        calls=[]
        scope={'client':get_client('qq'),'QQ_SCALE':3,'layout':lambda:current,'qq_geometry_cache':{},'navigation':{},
               'pane_region':lambda *_:{'x':180,'y':120},'time':type('Clock',(),{'sleep':staticmethod(lambda *_:None)}),
               'native_click':lambda box,x,y:calls.append(('click',x,y)),
               'set_clipboard':lambda value:calls.append(('clipboard',value)),
               'run':lambda *args:calls.append(args)}
        exec(compile(ast.Module(body=[method],type_ignores=[]),'server.py','exec'),scope)
        receiver=type('Receiver',(),{'reply':lambda self,status,**data:status})()
        payload={'window':'QQ3','conversation':'1:list','query':'自己的测试会话'}
        self.assertEqual(scope['search'](receiver,payload),200)
        self.assertEqual(calls[0],('click',450,198))
        self.assertIn(('clipboard','自己的测试会话'),calls)
        calls.clear()
        for invalid in ({'window':'old'},{'conversation':'old'},{'query':'x'*101},{'query':'a\nb'}):
            self.assertIn(scope['search'](receiver,payload|invalid),(400,409))
            self.assertEqual(calls,[])
        for change in ({'compactList':False},{'popups':[{'id':'dialog'}]}):
            old=current.copy();current.update(change)
            self.assertEqual(scope['search'](receiver,payload),409)
            self.assertEqual(calls,[])
            current.clear();current.update(old)
        scope['client']=get_client('wechat')
        self.assertEqual(scope['search'](receiver,payload),409)
        self.assertEqual(calls,[])

    def test_search_result_is_clicked_even_when_a_selected_chat_lies_underneath(self):
        tree=ast.parse(Path('mobile/server.py').read_text(encoding='utf-8'))
        handler=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='Handler')
        method=next(n for n in handler.body if isinstance(n,ast.FunctionDef) and n.name=='tap')
        current={'id':'QQ3','client':'qq','mainWindow':True,'chatReady':True,'compactList':True,
                 'popups':[],'conversation':'1:list','y':0,'selectFromY':276}
        nav={'identity':'previous chat','revision':1,'list':True,'search':True};clicked=[]
        class Display:
            def __enter__(self):return self
            def __exit__(self,*args):pass
        def click(*args,**kwargs):clicked.append(args);nav['identity']='searched contact'
        def wait(done,*args,**kwargs):
            result=current|{'conversation':'2:list'}
            self.assertTrue(done(result));return result
        scope={'layout':lambda:current|{'compactList':nav['list']},'time':time,'X':Display,'navigation':nav,'debug':lambda *a,**k:None,'brief':lambda x:x,
               'pane_region':lambda *_:{'x':180,'y':120,'width':949,'height':4008},
               'row_signature':lambda *_:[0,100]*18,'qq_selected_row':lambda *_:True,
               'native_click':click,'wait_layout':wait,'fit_qq':lambda value:value}
        exec(compile(ast.Module(body=[method],type_ignores=[]),'server.py','exec'),scope)
        receiver=type('Receiver',(),{'reply':lambda self,status,**data:(status,data)})()
        status,data=scope['tap'](receiver,{'target':'main','window':'QQ3','conversation':'1:list','x':550,'y':500})
        self.assertEqual(status,200);self.assertEqual(len(clicked),1)
        self.assertEqual(nav['identity'],'searched contact');self.assertFalse(nav['list']);self.assertFalse(nav['search'])

    def test_same_host_cookies_do_not_replace_each_other(self):
        tree = ast.parse(Path('mobile/server.py').read_text(encoding='utf-8'))
        functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ('session_cookie', 'authenticated')]
        scope = dict(secrets=secrets, hmac=hmac, hashlib=hashlib, time=time, SimpleCookie=SimpleCookie,
                     SESSION_SECONDS=86400, session_key=secrets.token_bytes(32))
        exec(compile(ast.Module(body=functions, type_ignores=[]), 'server.py', 'exec'), scope)
        scope['SESSION_COOKIE']='__Host-nas_wechat'
        wechat=scope['session_cookie']().split(';',1)[0]
        scope['SESSION_COOKIE']='__Host-nas_qq'
        qq=scope['session_cookie']().split(';',1)[0]
        self.assertFalse(scope['authenticated']({'Cookie':wechat}))
        self.assertTrue(scope['authenticated']({'Cookie':wechat+'; '+qq}))
        scope['SESSION_COOKIE']='__Host-nas_wechat'
        self.assertTrue(scope['authenticated']({'Cookie':wechat+'; '+qq}))
        self.assertFalse(scope['authenticated']({'Cookie':qq}))


if __name__ == '__main__':
    unittest.main()
