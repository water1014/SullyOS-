import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowsClockwise, Check, Copy, DownloadSimple, GearSix, ImageSquare,
  Images, MagicWand, Sparkle, Trash,
} from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import {
  generateGptImage, generateNaiImage,
  type GptImageConfig, type NaiImageConfig, type ImageEngine,
} from '../utils/imageGeneration';

const CONFIG_KEY = 'sully-image-studio:config:v1';
const ITEMS_KEY = 'sully-image-studio:items:v1';
const DEFAULT_CONFIG = {
  gpt: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-image-2.5-flare' },
  nai: { apiKey: '', model: 'nai-diffusion-5-full' },
};
type StudioConfig = { gpt: GptImageConfig; nai: NaiImageConfig };
type SavedImage = {
  id: string; blobId: string; engine: ImageEngine; prompt: string; negativePrompt: string;
  model: string; createdAt: number; mimeType: string;
};
type DisplayImage = SavedImage & { url: string };

const readConfig = (): StudioConfig => {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
    return {
      gpt: { ...DEFAULT_CONFIG.gpt, ...(saved?.gpt || {}) },
      nai: { ...DEFAULT_CONFIG.nai, ...(saved?.nai || {}) },
    };
  } catch { return DEFAULT_CONFIG; }
};
const readItems = (): SavedImage[] => {
  try {
    const value = JSON.parse(localStorage.getItem(ITEMS_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
};
const persistItems = (items: SavedImage[]) => localStorage.setItem(ITEMS_KEY, JSON.stringify(items));

const ImageStudioApp: React.FC = () => {
  const { closeApp, addToast } = useOS();
  const [tab, setTab] = useState<'create' | 'gallery' | 'settings'>('create');
  const [engine, setEngine] = useState<ImageEngine>('gpt');
  const [config, setConfig] = useState<StudioConfig>(readConfig);
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('low quality, worst quality, blurry, bad anatomy');
  const [gptSize, setGptSize] = useState('1024x1024');
  const [gptQuality, setGptQuality] = useState('high');
  const [naiSize, setNaiSize] = useState('832x1216');
  const [naiSteps, setNaiSteps] = useState(28);
  const [naiScale, setNaiScale] = useState(5);
  const [naiSampler, setNaiSampler] = useState('k_euler_ancestral');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [images, setImages] = useState<DisplayImage[]>([]);
  const imagesRef = useRef<DisplayImage[]>([]);
  const [selected, setSelected] = useState<DisplayImage | null>(null);

  useEffect(() => {
    let alive = true;
    const hydrate = async () => {
      const saved = readItems();
      const hydrated: DisplayImage[] = [];
      for (const item of saved) {
        const blob = await DB.getBlobAsset(item.blobId).catch(() => null);
        if (blob) hydrated.push({ ...item, url: URL.createObjectURL(blob) });
      }
      if (alive) setImages(hydrated.sort((a, b) => b.createdAt - a.createdAt));
      else hydrated.forEach(item => URL.revokeObjectURL(item.url));
    };
    void hydrate();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  }, [config]);

  useEffect(() => { imagesRef.current = images; }, [images]);
  useEffect(() => () => imagesRef.current.forEach(item => URL.revokeObjectURL(item.url)), []);

  const updateGpt = (updates: Partial<GptImageConfig>) =>
    setConfig(current => ({ ...current, gpt: { ...current.gpt, ...updates } }));
  const updateNai = (updates: Partial<NaiImageConfig>) =>
    setConfig(current => ({ ...current, nai: { ...current.nai, ...updates } }));

  const saveImage = useCallback(async (blob: Blob) => {
    const id = `studio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const blobId = `image-studio:${id}`;
    await DB.putBlobAsset(blobId, blob);
    const item: SavedImage = {
      id, blobId, engine, prompt: prompt.trim(), negativePrompt: engine === 'nai' ? negativePrompt.trim() : '',
      model: engine === 'gpt' ? config.gpt.model : config.nai.model,
      createdAt: Date.now(), mimeType: blob.type || 'image/png',
    };
    const next = [item, ...readItems()];
    persistItems(next);
    const display = { ...item, url: URL.createObjectURL(blob) };
    setImages(current => [display, ...current]);
    setSelected(display);
    setTab('gallery');
  }, [engine, prompt, negativePrompt, config]);

  const handleGenerate = async () => {
    if (generating) return;
    setGenerating(true);
    setError('');
    try {
      const blob = engine === 'gpt'
        ? await generateGptImage(config.gpt, prompt, { size: gptSize, quality: gptQuality })
        : await generateNaiImage(config.nai, prompt, negativePrompt, {
            width: Number(naiSize.split('x')[0]), height: Number(naiSize.split('x')[1]),
            steps: naiSteps, scale: naiScale, sampler: naiSampler,
          });
      await saveImage(blob);
      addToast('图片已生成并保存到我的画廊', 'success');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '生成失败，请稍后重试';
      setError(message);
      addToast(message.slice(0, 80), 'error');
    } finally {
      setGenerating(false);
    }
  };

  const deleteImage = async (item: DisplayImage) => {
    if (!window.confirm('确定删除这张作品吗？')) return;
    await DB.deleteBlobAsset(item.blobId).catch(() => undefined);
    const next = readItems().filter(saved => saved.id !== item.id);
    persistItems(next);
    setImages(current => current.filter(saved => saved.id !== item.id));
    if (selected?.id === item.id) setSelected(null);
    URL.revokeObjectURL(item.url);
  };

  const downloadImage = (item: DisplayImage) => {
    const anchor = document.createElement('a');
    anchor.href = item.url;
    anchor.download = `nuomi-${item.engine}-${new Date(item.createdAt).toISOString().slice(0, 10)}.png`;
    anchor.click();
  };

  const copyPrompt = async (value: string) => {
    try { await navigator.clipboard.writeText(value); addToast('提示词已复制', 'success'); }
    catch { addToast('复制失败，请长按文字手动复制', 'error'); }
  };

  const engineLabel = engine === 'gpt' ? 'GPT Image' : 'NovelAI';
  const configured = engine === 'gpt' ? !!config.gpt.apiKey.trim() : !!config.nai.apiKey.trim();

  return (
    <div className="sully-image-studio h-full w-full overflow-hidden flex flex-col text-slate-800">
      <style>{`
        .sully-image-studio{background:radial-gradient(ellipse at 10% 0%,rgba(186,230,253,.78),transparent 42%),linear-gradient(155deg,#f5faff 0%,#eaf3fb 48%,#f7f9fc 100%);--studio-ink:#20364b;--studio-muted:#8193a6;--studio-line:rgba(126,158,187,.22)}
        .sully-image-studio *{box-sizing:border-box}
        .sully-image-studio .glass{background:rgba(255,255,255,.66);border:1px solid rgba(255,255,255,.82);box-shadow:0 12px 34px rgba(57,91,125,.08),inset 0 1px rgba(255,255,255,.85);backdrop-filter:blur(22px)}
        .sully-image-studio .field{width:100%;border:1px solid var(--studio-line);background:rgba(255,255,255,.72);border-radius:14px;padding:12px 13px;color:#24384b;outline:none;font-size:13px}
        .sully-image-studio .field:focus{border-color:#8ab8dc;box-shadow:0 0 0 3px rgba(120,174,214,.14)}
        .sully-image-studio .tab{display:flex;align-items:center;justify-content:center;gap:7px;padding:10px 12px;border-radius:13px;font-size:12px;font-weight:700;color:#7d91a5}
        .sully-image-studio .tab.active{background:rgba(255,255,255,.88);color:#315b7e;box-shadow:0 4px 14px rgba(49,91,126,.09)}
        .sully-image-studio .primary{background:linear-gradient(135deg,#467da8,#6e9fc3);color:white;box-shadow:0 9px 22px rgba(62,115,157,.22)}
        .sully-image-studio .primary:disabled{opacity:.48;box-shadow:none}
        .sully-image-studio .soft{background:rgba(255,255,255,.72);border:1px solid var(--studio-line);color:#55718a}
        .sully-image-studio button{transition:transform .16s ease,background .16s ease}
        .sully-image-studio button:active{transform:scale(.98)}
        .sully-image-studio .studio-scroll{overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
        .sully-image-studio .art-tile{background:rgba(255,255,255,.72);border:1px solid rgba(255,255,255,.9);box-shadow:0 6px 18px rgba(44,77,107,.08)}
      `}</style>
      <header className="shrink-0 px-4 pt-3 pb-3">
        <div className="flex items-center justify-between mb-4">
          <button onClick={closeApp} className="soft w-9 h-9 rounded-full flex items-center justify-center" aria-label="返回"><ArrowLeft size={18}/></button>
          <div className="text-center">
            <div className="text-[10px] tracking-[.28em] text-sky-700/60 font-semibold">NUOMI CREATIVE LAB</div>
            <div className="text-[19px] font-semibold tracking-[.08em] text-slate-700">生图室</div>
          </div>
          <button onClick={() => setTab('settings')} className={`w-9 h-9 rounded-full flex items-center justify-center ${tab === 'settings' ? 'primary' : 'soft'}`} aria-label="设置"><GearSix size={18}/></button>
        </div>
        <div className="glass rounded-[18px] p-1.5 grid grid-cols-3 gap-1">
          <button className={`tab ${tab === 'create' ? 'active' : ''}`} onClick={() => setTab('create')}><MagicWand size={15}/>创作台</button>
          <button className={`tab ${tab === 'gallery' ? 'active' : ''}`} onClick={() => setTab('gallery')}><Images size={15}/>我的画廊 <span className="text-[10px] opacity-65">{images.length}</span></button>
          <button className={`tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}><GearSix size={15}/>引擎配置</button>
        </div>
      </header>

      {tab === 'create' && (
        <main className="studio-scroll flex-1 px-4 pb-6 space-y-4">
          <section className="glass rounded-[24px] p-4">
            <div className="flex items-center justify-between mb-3">
              <div><div className="text-[10px] tracking-[.2em] text-sky-700/55 font-bold">CHOOSE ENGINE</div><div className="text-sm font-semibold text-slate-700 mt-1">选择创作引擎</div></div>
              <Sparkle size={21} className="text-sky-500"/>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setEngine('gpt')} className={`rounded-2xl p-3 text-left border ${engine === 'gpt' ? 'bg-sky-50 border-sky-300 ring-2 ring-sky-100' : 'bg-white/55 border-white'}`}>
                <div className="flex items-center justify-between"><span className="text-sm font-bold text-slate-700">GPT 生图</span>{engine === 'gpt' && <Check size={15} className="text-sky-600"/>}</div>
                <div className="text-[10px] text-slate-500 mt-1">自然语言 · 精细画面</div>
              </button>
              <button onClick={() => setEngine('nai')} className={`rounded-2xl p-3 text-left border ${engine === 'nai' ? 'bg-sky-50 border-sky-300 ring-2 ring-sky-100' : 'bg-white/55 border-white'}`}>
                <div className="flex items-center justify-between"><span className="text-sm font-bold text-slate-700">NAI 生图</span>{engine === 'nai' && <Check size={15} className="text-sky-600"/>}</div>
                <div className="text-[10px] text-slate-500 mt-1">二次元 · 标签控制</div>
              </button>
            </div>
            <div className="flex items-center gap-2 mt-3 text-[10px] text-slate-500"><span className={`w-1.5 h-1.5 rounded-full ${configured ? 'bg-emerald-400' : 'bg-amber-400'}`}/>{configured ? `${engineLabel} 已填写 API Key` : `${engineLabel} 尚未配置密钥`}<button onClick={() => setTab('settings')} className="ml-auto text-sky-700 font-semibold">去配置 →</button></div>
          </section>

          <section className="glass rounded-[24px] p-4 space-y-3">
            <div className="flex items-center justify-between"><div><div className="text-[10px] tracking-[.2em] text-sky-700/55 font-bold">YOUR IMAGINATION</div><div className="text-sm font-semibold mt-1">描述你想要的画面</div></div><span className="text-[10px] text-slate-400">PROMPT</span></div>
            <textarea className="field min-h-[132px] resize-y leading-6" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={engine === 'gpt' ? '例如：雨后的玻璃花房，蓝色月光落在白色花瓣上，电影感构图……' : 'masterpiece, best quality, 1girl, ...'} />
            {engine === 'nai' && <>
              <div className="flex items-center justify-between"><label className="text-xs font-semibold text-slate-600">反向提示词</label><button onClick={() => copyPrompt(negativePrompt)} className="text-[10px] text-sky-700 flex items-center gap-1"><Copy size={12}/>复制</button></div>
              <textarea className="field min-h-[76px] resize-y leading-5" value={negativePrompt} onChange={event => setNegativePrompt(event.target.value)} placeholder="不希望出现在画面中的内容……"/>
            </>}
          </section>

          <section className="glass rounded-[24px] p-4 space-y-3">
            <div className="text-[10px] tracking-[.2em] text-sky-700/55 font-bold">GENERATION SETTINGS</div>
            {engine === 'gpt' ? <>
              <label className="block text-xs font-semibold text-slate-600">画面比例</label>
              <div className="grid grid-cols-3 gap-2">
                {[['1024x1024','1:1 方形'],['1536x1024','3:2 横向'],['1024x1536','2:3 竖向']].map(([value,label]) => <button key={value} onClick={() => setGptSize(value)} className={`rounded-xl py-2 text-[11px] border ${gptSize === value ? 'bg-sky-50 border-sky-300 text-sky-800' : 'bg-white/55 border-white text-slate-500'}`}>{label}</button>)}
              </div>
              <label className="block text-xs font-semibold text-slate-600">生成质量</label>
              <select className="field" value={gptQuality} onChange={event => setGptQuality(event.target.value)}><option value="low">快速预览 · Low</option><option value="medium">标准 · Medium</option><option value="high">高质量 · High</option></select>
              <p className="text-[10px] text-slate-400">当前模型：{config.gpt.model}</p>
            </> : <>
              <label className="block text-xs font-semibold text-slate-600">画面尺寸</label>
              <select className="field" value={naiSize} onChange={event => setNaiSize(event.target.value)}><option value="832x1216">竖向 832 × 1216</option><option value="1216x832">横向 1216 × 832</option><option value="1024x1024">方形 1024 × 1024</option><option value="768x1344">长竖幅 768 × 1344</option><option value="1344x768">长横幅 1344 × 768</option></select>
              <div><div className="flex justify-between text-xs font-semibold text-slate-600"><span>迭代步数 Steps</span><span>{naiSteps}</span></div><input className="w-full accent-sky-600 mt-2" type="range" min="10" max="50" value={naiSteps} onChange={event => setNaiSteps(Number(event.target.value))}/></div>
              <div><div className="flex justify-between text-xs font-semibold text-slate-600"><span>提示词引导 Scale</span><span>{naiScale.toFixed(1)}</span></div><input className="w-full accent-sky-600 mt-2" type="range" min="1" max="12" step=".5" value={naiScale} onChange={event => setNaiScale(Number(event.target.value))}/></div>
              <label className="block text-xs font-semibold text-slate-600">采样器</label>
              <select className="field" value={naiSampler} onChange={event => setNaiSampler(event.target.value)}><option value="k_euler_ancestral">Euler Ancestral</option><option value="k_euler">Euler</option><option value="k_dpmpp_2m">DPM++ 2M</option><option value="k_dpmpp_2s_ancestral">DPM++ 2S Ancestral</option><option value="k_heun">Heun</option></select>
              <p className="text-[10px] text-slate-400">当前模型：{config.nai.model}</p>
            </>}
          </section>

          {error && <div className="rounded-2xl border border-rose-200 bg-rose-50/90 p-3 text-xs text-rose-700 leading-5">{error}</div>}
          <button onClick={handleGenerate} disabled={generating || !configured || !prompt.trim()} className="primary w-full rounded-2xl py-4 flex items-center justify-center gap-2 text-sm font-bold">
            {generating ? <><ArrowsClockwise size={18} className="animate-spin"/>正在绘制，请稍候…</> : <><Sparkle size={18}/>开始生成</>}
          </button>
          <p className="text-center text-[10px] text-slate-400">生成费用由对应平台收取 · 作品只保存在本机设备</p>
        </main>
      )}

      {tab === 'gallery' && (
        <main className="studio-scroll flex-1 px-4 pb-6">
          {selected ? (
            <div className="space-y-3">
              <button onClick={() => setSelected(null)} className="soft rounded-full px-3 py-2 text-xs flex items-center gap-1"><ArrowLeft size={14}/>返回作品列表</button>
              <div className="glass rounded-[24px] p-2"><img src={selected.url} className="w-full max-h-[58vh] object-contain rounded-[18px]" alt="生成作品"/></div>
              <div className="glass rounded-[20px] p-4 space-y-2">
                <div className="flex items-center justify-between"><span className="text-xs font-bold text-slate-700">{selected.engine === 'gpt' ? 'GPT Image' : 'NovelAI'} · {selected.model}</span><span className="text-[10px] text-slate-400">{new Date(selected.createdAt).toLocaleString()}</span></div>
                <p className="text-xs leading-5 text-slate-600 whitespace-pre-wrap break-words">{selected.prompt}</p>
                <div className="flex gap-2 pt-1">
                  <button onClick={() => copyPrompt(selected.prompt)} className="soft flex-1 rounded-xl py-2.5 text-xs flex items-center justify-center gap-1"><Copy size={14}/>复制提示词</button>
                  <button onClick={() => downloadImage(selected)} className="soft flex-1 rounded-xl py-2.5 text-xs flex items-center justify-center gap-1"><DownloadSimple size={14}/>下载图片</button>
                  <button onClick={() => deleteImage(selected)} className="soft rounded-xl px-3 py-2.5 text-rose-500"><Trash size={14}/></button>
                </div>
              </div>
            </div>
          ) : images.length ? (
            <div className="grid grid-cols-2 gap-3">
              {images.map(item => <button key={item.id} onClick={() => setSelected(item)} className="art-tile rounded-[18px] p-1.5 text-left overflow-hidden"><img src={item.url} alt="生成作品" loading="lazy" className="w-full aspect-[3/4] object-cover rounded-[13px]"/><div className="px-1.5 py-2"><div className="text-[10px] font-semibold text-slate-600 truncate">{item.engine === 'gpt' ? 'GPT Image' : 'NovelAI'}</div><div className="text-[9px] text-slate-400 mt-1">{new Date(item.createdAt).toLocaleDateString()}</div></div></button>)}
            </div>
          ) : (
            <div className="glass rounded-[26px] min-h-[300px] flex flex-col items-center justify-center text-center p-7">
              <div className="w-16 h-16 rounded-[22px] bg-sky-100/80 flex items-center justify-center text-sky-600 mb-4"><ImageSquare size={30}/></div>
              <div className="text-sm font-semibold text-slate-700">这里还空着</div><p className="text-xs text-slate-400 leading-5 mt-2">第一张作品完成后，就会收藏在这里。</p>
              <button onClick={() => setTab('create')} className="primary rounded-full px-5 py-2.5 mt-5 text-xs font-semibold">去创作一张</button>
            </div>
          )}
        </main>
      )}

      {tab === 'settings' && (
        <main className="studio-scroll flex-1 px-4 pb-6 space-y-4">
          <section className="glass rounded-[24px] p-4 space-y-3">
            <div><div className="text-[10px] tracking-[.2em] text-sky-700/55 font-bold">ENGINE 01</div><div className="text-base font-semibold mt-1">GPT 生图接口</div></div>
            <label className="block text-xs font-semibold text-slate-600">API Base URL</label>
            <input className="field" value={config.gpt.baseUrl} onChange={event => updateGpt({baseUrl:event.target.value})} placeholder="https://api.openai.com/v1"/>
            <label className="block text-xs font-semibold text-slate-600">API Key</label>
            <input className="field" type="password" autoComplete="off" value={config.gpt.apiKey} onChange={event => updateGpt({apiKey:event.target.value})} placeholder="sk-..."/>
            <label className="block text-xs font-semibold text-slate-600">图片模型</label>
            <select className="field" value={config.gpt.model} onChange={event => updateGpt({model:event.target.value})}><option value="gpt-image-2.5-flare">gpt-image-2.5-flare</option><option value="gpt-image-2.5-sunburst">gpt-image-2.5-sunburst</option><option value="gpt-image-2">gpt-image-2</option><option value="gpt-image-1.5">gpt-image-1.5</option></select>
          </section>
          <section className="glass rounded-[24px] p-4 space-y-3">
            <div><div className="text-[10px] tracking-[.2em] text-sky-700/55 font-bold">ENGINE 02</div><div className="text-base font-semibold mt-1">NovelAI 生图接口</div></div>
            <label className="block text-xs font-semibold text-slate-600">Persistent API Token</label>
            <input className="field" type="password" autoComplete="off" value={config.nai.apiKey} onChange={event => updateNai({apiKey:event.target.value})} placeholder="pst-..."/>
            <label className="block text-xs font-semibold text-slate-600">图片模型</label>
            <select className="field" value={config.nai.model} onChange={event => updateNai({model:event.target.value})}><option value="nai-diffusion-5-full">NovelAI Diffusion V5 Full</option><option value="nai-diffusion-5-curated">NovelAI Diffusion V5 Curated</option><option value="nai-diffusion-4-5-full">NovelAI Diffusion V4.5 Full</option><option value="nai-diffusion-4-5-curated">NovelAI Diffusion V4.5 Curated</option></select>
            <p className="text-[10px] text-slate-400 leading-5">使用 NovelAI 的 Persistent API Token。密钥仅存于本机浏览器，不会写入作品记录。</p>
          </section>
          <div className="rounded-2xl bg-sky-50/80 border border-sky-100 p-3 text-[10px] text-sky-800 leading-5">提示：部分 API 中转站不开放图片生成接口；如果出现 CORS 或 404，需要使用支持 Images API 的服务地址。NAI 需要浏览器能直接访问 image.novelai.net。</div>
          <button onClick={() => { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); addToast('生图引擎配置已保存', 'success'); }} className="primary w-full rounded-2xl py-3 text-sm font-bold">保存配置</button>
        </main>
      )}
    </div>
  );
};

export default ImageStudioApp;
