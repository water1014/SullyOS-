import {it,expect,vi} from 'vitest';
import {loadHomeEmotion} from './homeEmotionLoader';
import {configureOpenCodeGoNativeTransport} from './openCodeGoTransport';
vi.mock('./db',()=>({DB:{getAssetRaw:async()=>null,saveAssetRaw:vi.fn(async()=>{})}}));
it('local-only emotion behavior does not request a model, including dedicated emotion API',async()=>{const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);try{const char:any={id:'c',scheduleFeatureEnabled:true,emotionConfig:{enabled:true,api:{baseUrl:'emotion',model:'m'}},activeBuffs:[{label:'高兴',intensity:3}]};expect(await loadHomeEmotion(char,{baseUrl:'main',model:'m'} as any,new AbortController().signal,true)).toBeUndefined();expect(fetcher).not.toHaveBeenCalled();}finally{vi.unstubAllGlobals();}});

it('uses shared OpenCode Go transport and retries explicit prefill capacity refusal',async()=>{
 vi.useFakeTimers();
 const transport=vi.fn()
  .mockResolvedValueOnce(new Response(JSON.stringify({error:{message:'[prefill_cap_refused] the cell is at capacity; retry shortly (after 5 s)'}}),{status:429,headers:{'content-type':'application/json'}}))
  .mockResolvedValueOnce(new Response(JSON.stringify({choices:[{message:{content:'{"energy":0.2,"approach":0.4,"interaction":0.3}'}}]}),{status:200,headers:{'content-type':'application/json'}}));
 configureOpenCodeGoNativeTransport(true,transport);
 try{
  const char:any={id:'emotion-go',name:'宋祁',scheduleFeatureEnabled:true,emotionConfig:{enabled:true},activeBuffs:[{label:'高兴',intensity:3}]};
  const pending=loadHomeEmotion(char,{baseUrl:'https://opencode.ai/zen/go',apiKey:'go-token',model:'deepseek-v4.1-flash'} as any,new AbortController().signal);
  await vi.runAllTimersAsync();
  await expect(pending).resolves.toMatchObject({value:{energy:0.2,approach:0.4,interaction:0.3}});
  expect(transport).toHaveBeenCalledTimes(2);
  const headers=new Headers(transport.mock.calls[0][1]?.headers);
  expect(headers.get('authorization')).toBe('Bearer go-token');
  expect(headers.get('x-opencode-session')).toMatch(/^sullyos-home-emotion-/);
 }finally{
  vi.useRealTimers();
  configureOpenCodeGoNativeTransport(false);
 }
});
