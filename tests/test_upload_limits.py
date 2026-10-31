import ast
import re
import unittest
from pathlib import Path
from urllib.parse import unquote


class UploadLimitsTest(unittest.TestCase):
    def test_auth_subrequest_and_upload_limits_survive_generation(self):
        script=Path('mobile-init/50-mobile').read_text(encoding='utf-8')
        code=script.split("<<'PY'\n",1)[1].split('\nPY\n',1)[0]
        original='server {\n  listen 3000;\n  location / { proxy_pass http://upstream; }\n}\nserver {\n  listen 3001 ssl;\n  location / { proxy_pass http://upstream; }\n}\n'
        state={'source':original}

        class File:
            def __init__(self,path):
                self.path=path
            def read_text(self):
                return state['source']
            def write_text(self,text):
                state['source']=text
            def is_dir(self):
                return False

        tree=ast.parse(code)
        tree.body=[node for node in tree.body if not isinstance(node,ast.ImportFrom)]
        ns={'Path':File}
        exec(compile(tree,'generated-nginx','exec'),ns)
        first=state['source']
        exec(compile(tree,'generated-nginx','exec'),ns)
        self.assertEqual(first,state['source'],'startup configuration updates are idempotent')
        for location in ('/_mobile_auth','/mobile-api/upload'):
            blocks=re.findall(r'location = '+re.escape(location)+r' \{(.*?)\}',first,re.S)
            self.assertEqual(len(blocks),2)
            self.assertTrue(all('client_max_body_size 100m;' in block for block in blocks))
        self.assertIn('proxy_pass_request_body off;',first)
        self.assertIn('private, max-age=0, must-revalidate',first)

    def test_small_file_is_not_rejected_as_oversize_and_empty_is_clear(self):
        tree=ast.parse(Path('mobile/server.py').read_text(encoding='utf-8'))
        upload=next(node for node in ast.walk(tree) if isinstance(node,ast.FunctionDef) and node.name=='upload')
        ns={'unquote':unquote,'re':re,'MAX_UPLOAD':95*1024*1024}
        exec(compile(ast.Module(body=[upload],type_ignores=[]),'upload-limits','exec'),ns)

        class Request:
            def __init__(self,length):
                self.headers={'Content-Length':str(length),'X-Request-Id':'invalid'}
            def reply(self,status,**value):
                return status,value

        status,error=ns['upload'](Request(1_100_000))
        self.assertEqual(status,400,'invalid id is reached after accepting a 1 MB size; no native send occurs')
        self.assertNotIn('95MB',error['error'])
        status,error=ns['upload'](Request(0))
        self.assertEqual(status,400)
        self.assertNotIn('95MB',error['error'])
        self.assertEqual(ns['upload'](Request(96*1024*1024))[0],413)


if __name__=='__main__':
    unittest.main()
