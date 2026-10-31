import ast
import time
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from PIL import Image, ImageDraw

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'mobile'))
from notification_preview import MessagePreview, list_rows, changed_unread


def listing(client='qq', unit=1, changes=(), unread=(0,), background=244):
    w, step, left, top = (300,80,76,16) if client=='qq' else (654,114,100,36)
    image=Image.new('RGB',(w,step*3), (background,)*3); draw=ImageDraw.Draw(image)
    for i in range(3):
        y=top+i*step
        draw.rectangle((left,y,left+50+i*12,y+13),fill=(24,)*3)
        draw.rectangle((left,y+30,left+50+(18 if i in changes else 0),y+43),fill=(153,)*3)
        if i in unread:
            rect=(w-23,y+31,w-13,y+41) if client=='qq' else (80,y-10,90,y)
            draw.ellipse(rect,fill=(250,65,55))
    if unit>1:image=image.resize((w*unit,step*3*unit),Image.Resampling.NEAREST)
    return image, {'client':client,'unit':unit,'window':'1','rect':(0,0,w*unit,step*3*unit)}


class PreviewTests(unittest.TestCase):
    def test_only_a_fresh_unread_changed_summary_is_eligible(self):
        for client in ('qq','wechat'):
            for unit in ((1,2,3) if client=='qq' else (1,)):
                with self.subTest(client=client,unit=unit):
                    before,profile=listing(client,unit)
                    after,_=listing(client,unit,changes=(0,))
                    old,new=list_rows(before,profile),list_rows(after,profile)
                    self.assertEqual(len(old),3)
                    self.assertIsNotNone(changed_unread(old,new))
                    self.assertIsNone(changed_unread(new,new),'existing unread messages never repeat')
                    read,_=listing(client,unit,changes=(0,),unread=())
                    self.assertIsNone(changed_unread(old,list_rows(read,profile)))
                    ambiguous,_=listing(client,unit,changes=(0,1),unread=(0,1))
                    self.assertIsNone(changed_unread(old,list_rows(ambiguous,profile)))
                    self.assertIsNone(changed_unread(old,list(reversed(old))),'reordering rows alone is not a new message')

    def test_ocr_runs_for_one_verified_row_only_and_is_cached_in_memory(self):
        self.now=10; self.frame=listing(); self.active=True; reads=[]
        reader=MessagePreview(lambda **_:self.frame,lambda:self.active,clock=lambda:self.now,
            recognizer=lambda image:reads.append(image.size) or ('Alice' if len(reads)%2 else '你好'))
        reader.poll();self.now=11;reader.poll()
        self.frame=listing(changes=(0,));self.now=12.5
        self.assertEqual(reader.resolve(11.8),('Alice','你好'))
        self.assertEqual(len(reads),2)
        self.assertEqual(reader.resolve(11.8),('Alice','你好'));self.assertEqual(len(reads),2)
        self.active=False;reader.poll();self.assertFalse(reader.history);self.assertFalse(reader.cache)
        self.assertIsNone(reader.resolve(11.8));self.assertEqual(len(reads),2)

    def test_no_baseline_hidden_list_changed_geometry_or_unstable_text_falls_back(self):
        self.now=10;self.frame=listing()
        reader=MessagePreview(lambda **_:self.frame,lambda:True,clock=lambda:self.now,recognizer=lambda image:'text')
        self.assertIsNone(reader.resolve(9.5),'startup cannot notify old unread messages')
        reader.poll();self.now=11;reader.poll();self.now=12.5
        image,profile=listing(changes=(0,));self.frame=(image,dict(profile,window='2'))
        self.assertIsNone(reader.resolve(11.8),'resized/switched windows need a new baseline')
        self.frame=(image,profile)
        def changing(image):
            self.frame=listing(changes=(0,),unread=())
            return 'text'
        reader.recognizer=changing
        self.assertIsNone(reader.resolve(11.9),'read or changing messages are not attributed after OCR')
        self.frame=None;reader.poll();self.assertFalse(reader.history)
        self.assertIsNone(reader.resolve(11.8))

    def test_green_selected_chat_can_supply_a_fresh_summary_without_an_unread_badge(self):
        def selected(changed):
            image,profile=listing('wechat',unread=())
            draw=ImageDraw.Draw(image);draw.rectangle((0,0,653,113),fill=(7,180,120))
            draw.rectangle((100,36,150,49),fill='white')
            draw.rectangle((100,66,150+(18 if changed else 0),79),fill='white')
            return list_rows(image,profile)
        old,new=selected(False),selected(True)
        row=changed_unread(old,new)
        self.assertIsNotNone(row)
        self.assertTrue(row['selected']);self.assertFalse(row['unread'])
        self.assertIsNone(changed_unread(new,new),'a selected chat alone cannot trigger content')

    def test_cached_capture_keeps_its_actual_observation_time(self):
        frame=listing()
        reader=MessagePreview(lambda **_:(*frame,10),lambda:True,clock=lambda:15)
        reader.poll()
        self.assertEqual(reader.history[-1][0],10,'reusing a cached frame cannot make old text appear fresh')
        self.assertIsNone(reader.resolve(14.5))

    def test_server_snapshot_never_navigates_and_skips_hidden_or_covered_lists(self):
        tree=ast.parse(Path('mobile/server.py').read_text(encoding='utf-8'))
        node=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='notification_snapshot')
        current={'id':'1','chatReady':True,'compactList':False,'x':0,'y':0,'width':760,'height':2740,'popups':[]}
        class Display:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def grab(self,*rect):return Image.new('RGB',rect[2:],'white')
        scope={'lock':threading.Lock(),'layout':lambda:current,'push_service':SimpleNamespace(client=SimpleNamespace(key='wechat')),'X':Display,'presence':SimpleNamespace(idle=lambda:False)}
        exec(compile(ast.Module(body=[node],type_ignores=[]),'server.py','exec'),scope)
        self.assertIsNone(scope['notification_snapshot']())
        current['compactList']=True
        value=scope['notification_snapshot']();self.assertEqual(value[0].width,654)
        current['popups']=[{'name':'settings'}]
        self.assertIsNone(scope['notification_snapshot']())

    def test_background_snapshot_restores_original_geometry_even_when_capture_fails(self):
        tree=ast.parse(Path('mobile/server.py').read_text(encoding='utf-8'))
        node=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='notification_snapshot')
        current={'id':'1','chatReady':True,'compactList':False,'x':0,'y':0,'width':760,'height':2740,
                 'screenWidth':1800,'split':104,'conversation':'chat-a','popups':[]}
        commands=[]
        class Display:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def attrs(self,wid):return SimpleNamespace(class_=2)
            def grab(self,*rect):raise OSError('capture failed')
        def run(*args):
            commands.append(args)
            return '99'
        scope={'lock':threading.Lock(),'layout':lambda:current,'push_service':SimpleNamespace(client=SimpleNamespace(key='wechat')),
            'X':Display,'presence':SimpleNamespace(idle=lambda:True),'run':run,'time':SimpleNamespace(sleep=lambda _:None,monotonic=time.monotonic),
            'split_cache':{},'detect_split':lambda display,box:752}
        exec(compile(ast.Module(body=[node],type_ignores=[]),'server.py','exec'),scope)
        self.assertIsNone(scope['notification_snapshot']())
        self.assertEqual(commands[-1],('xdotool','windowsize','1','760','2740'))
        self.assertFalse(any('click' in command or 'windowactivate' in command or 'windowfocus' in command for command in commands))
        self.assertTrue(scope['lock'].acquire(blocking=False));scope['lock'].release()


if __name__=='__main__':unittest.main()
