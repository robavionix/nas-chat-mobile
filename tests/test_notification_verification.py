import importlib.util
import io
import json
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from PIL import Image, ImageDraw

TASK=Path(__file__).parent
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'mobile'))
import notification_preview as preview

def tsv(words):
    return ('level\tconf\ttext\n'+''.join('5\t'+str(conf)+'\t'+text+'\n' for text,conf in words)).encode()

class VerifiedPreviewTests(unittest.TestCase):
    def test_a_single_wrong_character_cannot_hide_in_a_high_average_score(self):
        # This previously passed the mean confidence check despite one bad name
        # character. A title is not reliable if any word is uncertain.
        image=Image.new('RGB',(300,45),'white');image.putpixel((4,4),(0,0,0))
        response=SimpleNamespace(returncode=0,stdout=tsv([('非常清晰的联系人名字',99),('错',25)]))
        with patch.object(preview.subprocess,'run',return_value=response):
            self.assertNotEqual(preview.ocr_line(image,min_confidence=50),'')
            self.assertEqual(preview.verified_line(image,name=True),'')

    def test_conflicting_names_and_messages_are_not_published(self):
        for name,texts in [(True,['张三','张兰']),(False,['今天下午开会','今天下午开台']),
                           (True,['AB','A8']),(False,['明天8点','明天3点'])]:
            with self.subTest(name=name,texts=texts):
                with patch.object(preview,'ocr_line',side_effect=texts):
                    self.assertEqual(preview.verified_line(object(),name=name),'')

    def test_clear_agreement_preserves_original_text(self):
        for texts in [('测试联系人','测试联系人'),('你好，明天见。','你好，明天见。'),
                      ('Alice: hello','Alice: hello'),('[图片]','[图片]')]:
            with self.subTest(texts=texts):
                with patch.object(preview,'ocr_line',side_effect=texts):
                    self.assertEqual(preview.verified_line(object()),texts[0])

    def test_a_name_running_past_the_crop_is_not_misrepresented_as_complete(self):
        image=Image.new('RGB',(400,160),(244,244,244));draw=ImageDraw.Draw(image)
        draw.rectangle((76,16,260,30),fill=(24,24,24))
        draw.rectangle((76,46,200,60),fill=(153,153,153))
        # QQ's fixed name crop ends at x=314. A long name continues past it.
        draw.rectangle((320,16,350,30),fill=(24,24,24))
        rows=preview.list_rows(image,{'client':'qq','unit':1})
        self.assertTrue(rows[0]['name_truncated'])
        draw.rectangle((320,16,350,30),fill=(153,153,153))
        rows=preview.list_rows(image,{'client':'qq','unit':1})
        self.assertFalse(rows[0]['name_truncated'],'a pale timestamp alone is not a name continuation')

    def test_partial_bottom_row_does_not_break_all_notification_previews(self):
        image=Image.new('RGB',(300,100),(244,244,244));draw=ImageDraw.Draw(image)
        draw.rectangle((76,16,135,30),fill=(24,24,24))
        draw.rectangle((76,46,150,60),fill=(153,153,153))
        draw.rectangle((76,90,140,99),fill=(24,24,24))
        self.assertEqual(len(preview.list_rows(image,{'client':'qq','unit':1})),1)

    def test_whitespace_is_tolerated_but_case_and_punctuation_are_not_inferred(self):
        with patch.object(preview,'ocr_line',side_effect=['你 好！','你好！']):
            self.assertEqual(preview.verified_line(object()),'你 好！')
        for texts in [('AB','ab'),('不要，等','不要等'),('A B','AB!')]:
            with patch.object(preview,'ocr_line',side_effect=texts):
                self.assertEqual(preview.verified_line(object()),'')

    def ready_reader(self,recognizer):
        self.now=12.5
        row={'key':b'person','fingerprint':b'new','unread':True,'name':object(),'preview':object()}
        profile={'client':'wechat','window':'1'}
        reader=preview.MessagePreview(lambda **_:None,lambda:True,clock=lambda:self.now,recognizer=recognizer)
        reader.history.append((11,profile,[{'key':b'person','fingerprint':b'old','unread':True}]))
        reader.capture=lambda **_:(12.5,profile,[row])
        return reader

    def test_half_read_preview_never_leaks_a_guessed_name(self):
        for texts in [('AB',''),('','正文')]:
            iterator=iter(texts)
            reader=self.ready_reader(lambda image:next(iterator))
            self.assertIsNone(reader.resolve(11.8))

    def test_stable_complete_preview_and_cache_still_work(self):
        reads=[]
        reader=self.ready_reader(lambda image:reads.append(image) or ('朋友' if len(reads)==1 else '你好'))
        self.assertEqual(reader.resolve(11.8),('朋友','你好'))
        self.assertEqual(reader.resolve(11.8),('朋友','你好'))
        self.assertEqual(len(reads),2)

    def test_changing_conversation_or_revoked_preview_is_not_published(self):
        reader=self.ready_reader(lambda image:'正文')
        captures=0
        original=reader.capture
        def capture(**kwargs):
            nonlocal captures
            captures+=1
            stamp,profile,rows=original(**kwargs)
            return stamp,dict(profile,window='2') if captures>1 else profile,rows
        reader.capture=capture
        self.assertIsNone(reader.resolve(11.8))
        reader=self.ready_reader(lambda image:'正文');reader.enabled=lambda:False
        self.assertIsNone(reader.resolve(11.8))

if __name__=='__main__':unittest.main(verbosity=2)
