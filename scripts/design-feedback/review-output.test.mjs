import { describe, it, expect } from 'vitest';
import { validateReview } from './review-output.mjs';
const receipt={evidenceId:'bundle-1',images:[{captureId:'view-1',sha256:'image-1'}]};
const finding={captureId:'view-1',imageSha256:'image-1',region:'composer',observation:'Long path is clipped',impact:'The target cannot be identified',severity:'medium',remedy:'Allow wrapping',uncertainty:'Screenshot does not establish keyboard behavior'};
const review={evidenceId:'bundle-1',summary:'Inspect the composer path',findings:[finding]};
describe('evidence-bound reviewer output',()=>{
 it('accepts structured findings and a valid no-findings review',()=>{expect(validateReview(JSON.stringify(review),receipt)).toEqual(review);expect(validateReview(JSON.stringify({...review,findings:[]}),receipt).findings).toEqual([]);});
 it('rejects a different evidence bundle or image hash',()=>{expect(()=>validateReview(JSON.stringify({...review,evidenceId:'other'}),receipt)).toThrow();expect(()=>validateReview(JSON.stringify({...review,findings:[{...finding,imageSha256:'other'}]}),receipt)).toThrow('unoffered');});
 it('rejects an unoffered capture and unsupported severity',()=>{for(const change of [{captureId:'other'},{severity:'perfect'}])expect(()=>validateReview(JSON.stringify({...review,findings:[{...finding,...change}]}),receipt)).toThrow();});
 it('does not silently repair malformed output or missing uncertainty',()=>{expect(()=>validateReview('```json\n{}\n```',receipt)).toThrow();expect(()=>validateReview(JSON.stringify({...review,findings:[{...finding,uncertainty:''}]}),receipt)).toThrow('uncertainty');});
});
