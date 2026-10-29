"""Rebuild icons from the commit-pinned Google Material Symbols TTF.
Requires fonttools==4.61.1 and brotli. Pass the source TTF path; its digest is checked.
The source URL and output hashes are recorded in public/fonts/provenance.json.
"""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools import subset
import json,hashlib,fontTools,sys
root=Path(__file__).resolve().parents[1];
source=Path(sys.argv[1]);
expected='77ff1c20896afc6f1abf7d57fc408234dfd021ab050b63e0442e71d6c9f0d6b8';
assert hashlib.sha256(source.read_bytes()).hexdigest()==expected, 'Unexpected source TTF';
p=root/'public/fonts/provenance.json';m=json.loads(p.read_text())
names=sorted(set(m['materialSymbols']['requestedIconNames'])|{'settings','visibility','upload_file'})
f=TTFont(source,recalcTimestamp=False)
real=[n for n in names if n in f.getGlyphOrder()]
options=subset.Options();options.layout_closure=False;options.glyph_names=True
sub=subset.Subsetter(options=options);sub.populate(glyphs=real,text=''.join(names));sub.subset(f)
f=instantiateVariableFont(f,{'opsz':20,'wght':400,'FILL':0,'GRAD':0},inplace=True)
f.flavor='woff2';f.save(root/'public/fonts/material-symbols-outlined-local-subset.woff2')
# Independently verify every requested real ligature survived subsetting.
f=TTFont(root/'public/fonts/material-symbols-outlined-local-subset.woff2');cmap=f.getBestCmap();ligatures={}
for lookup in f['GSUB'].table.LookupList.Lookup:
 for table in lookup.SubTable:
  table=getattr(table,'ExtSubTable',table)
  for first,values in getattr(table,'ligatures',{}).items():
   for lig in values: ligatures[(first,*lig.Component)]=lig.LigGlyph
for name in real:
 assert ligatures.get(tuple(cmap[ord(c)] for c in name))==name, name
asset=next(a for a in m['assets'] if a['family']=='Material Symbols Outlined')
old=root/'public'/asset['path'].lstrip('/')
if old.name != 'material-symbols-outlined-local-subset.woff2': old.unlink()
asset.update(path='/fonts/material-symbols-outlined-local-subset.woff2',sourceUrl='https://raw.githubusercontent.com/google/material-design-icons/49d4db35df873165d6bd6ba09b063c7dafbac2f4/variablefont/MaterialSymbolsOutlined%5BFILL,GRAD,opsz,wght%5D.ttf')
b=(root/'public'/asset['path'].lstrip('/')).read_bytes();asset.update(sha256=hashlib.sha256(b).hexdigest(),bytes=len(b))
m['materialSymbols']['requestedIconNames']=names
m['materialSymbols']['inventoryDescription']='Source-scanner inventory; locally built from the commit-pinned official TTF. Every supported name has a verified GSUB ligature in the output. Non-icon fallback text is recorded separately.'
m['materialSymbols']['localBuild']={'sourceSha256':hashlib.sha256(Path(source).read_bytes()).hexdigest(),'fontToolsVersion':fontTools.__version__,'verifiedLigatures':real,'nonIconText':[n for n in names if n not in real]}
m['materialSymbols'].pop('priorGevSubsetSha256',None)
m['purpose']='Self-host GEV typography and an expanded official icon subset for disconnected startup.'
css=root/'public/fonts/gev-fonts.css';css.write_text(css.read_text().replace('material-symbols-outlined-v377-subset.woff2','material-symbols-outlined-local-subset.woff2'))
m['stylesheet']['sha256']=hashlib.sha256(css.read_bytes()).hexdigest();m['fontBytes']=sum(a['bytes'] for a in m['assets']);p.write_text(json.dumps(m,indent=2)+'\n')
print('Verified',len(real),'icon ligatures;',len(b),'bytes')
