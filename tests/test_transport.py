import ast, io, struct, zlib, random, time
from pathlib import Path

source=Path('mobile/server.py').read_text(encoding='utf-8')
tree=ast.parse(source)
selected=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in ('PhonePicture','websocket_frame','websocket_read','jpeg','encode_strip','picture_quality','confirm_sent','strip_runs')]
from PIL import Image
ns={'io':io,'struct':struct,'Image':Image,'BAND':64}
exec(compile(ast.Module(body=selected,type_ignores=[]),'tested-server','exec'),ns)

class ShortReader(io.BytesIO):
    def read(self,size=-1):
        return super().read(min(size,3))

def masked(data, opcode=1):
    frame=bytearray(ns['websocket_frame'](data,opcode))
    prefix=2 if len(data)<126 else 4 if len(data)<65536 else 10
    frame[1]|=128
    mask=b'\x12\x34\x56\x78'
    return bytes(frame[:prefix])+mask+bytes(x^mask[i%4] for i,x in enumerate(data))

for size in (0,1,125,126,300,4096):
    data=b'x'*size
    assert ns['websocket_read'](ShortReader(masked(data)))==(1,data)
assert ns['websocket_read'](io.BytesIO(ns['websocket_frame'](b'ack 1',1))) is None
assert ns['websocket_read'](io.BytesIO(masked(b'x'*4097))) is None
assert ns['websocket_read'](io.BytesIO(masked(b'ack 1')[:-1])) is None
assert ns['websocket_read'](io.BytesIO(masked(b'x'*126,9))) is None
height=3387
runs=ns['strip_runs'](range((height+63)//64),height,256)
assert all(0<size<=256 for top,size in runs)
assert [y for top,size in runs for y in range(top,top+size)]==list(range(height))
assert ns['strip_runs'](range((height+63)//64),height)==[[0,height]]

# Apply scroll moves and changed rows exactly as a client would, including overlapping segments.
random.seed(7)
rows=[random.randrange(10000000) if random.random()>.3 else 0 for _ in range(6000)]
phone=ns['PhonePicture'](1800);phone.rows=rows[2000:3800]
for offset in (1900,2100,2095,1700):
    latest=rows[offset:offset+1800]
    moves=phone.find_moves(latest);phone.move(moves)
    assert len(phone.rows)==1800
    for i,value in enumerate(latest):
        if value!=phone.rows[i]:phone.rows[i]=value
    assert phone.rows==latest

image=Image.effect_noise((654,800),35).convert('RGB')
sharp=ns['jpeg'](image);moving=ns['jpeg'](image,True);slow=ns['jpeg'](image,True,True)
assert Image.open(io.BytesIO(sharp)).width==654
assert Image.open(io.BytesIO(moving)).width==480
assert Image.open(io.BytesIO(slow)).width==360
assert len(slow)<len(moving)<len(sharp)
print('PASS fragmented TCP reads, bounded/masked controls, invalid/truncated frames, scroll moves, dynamic JPEG')
png,mime=ns['encode_strip'](image,quality='lossless')
decoded=Image.open(io.BytesIO(png));assert mime=='image/png' and decoded.tobytes()==image.tobytes()
clear,mime=ns['encode_strip'](image,True,True,'clear')
assert mime=='image/jpeg' and Image.open(io.BytesIO(clear)).width==image.width
assert ns['picture_quality']({'quality':['invalid']})=='clear'
print('PASS lossless pixel fidelity and full-resolution clear mode during motion')

class Clock:
    def __init__(self):self.now=0;self.sleeps=[]
    def monotonic(self):return self.now
    def sleep(self,value):self.now+=value;self.sleeps.append(value)
clock=Clock();ns['time']=clock;current={'id':'1','conversation':'chat:a'}
ns['layout']=lambda:current;ns['validated_chat']=lambda *args:True
ns['input_content']=lambda current:''
assert ns['confirm_sent'](current) and not clock.sleeps
ns['input_content']=lambda current:'pending'
assert not ns['confirm_sent'](current) and 3.5<=clock.now<3.6
ns['validated_chat']=lambda *args:False
ns['input_content']=lambda current:(_ for _ in ()).throw(AssertionError('must not touch another chat'))
assert not ns['confirm_sent'](current)
print('PASS prompt send acknowledgement, bounded confirmation and changed-chat guard')
