"""Bounded original-image inspection/rendering for OCR; never edits the original."""
import json,sys
from PIL import Image
Image.MAX_IMAGE_PIXELS=40_000_000
image=Image.open(sys.argv[2]);count=getattr(image,'n_frames',1)
if count>20:raise ValueError('image_page_budget_exceeded')
frames=[]
for i in range(count):
 image.seek(i);w,h=image.size
 if w*h>40_000_000 or w>10000 or h>10000:raise ValueError('image_pixel_budget_exceeded')
 orientation=image.getexif().get(274,1)
 frames.append({'page':i+1,'width':w,'height':h,'rotation':0 if orientation==1 else -1,'units':'pixel'})
if sys.argv[1]=='inspect':print(json.dumps({'count':count,'frames':frames}))
else:
 page=int(sys.argv[3]);image.seek(page-1)
 if frames[page-1]['rotation']!=0:raise ValueError('unsupported_source_rotation')
 image.convert('RGB').save(sys.argv[4],format='PNG')
 print(json.dumps(frames[page-1]))
