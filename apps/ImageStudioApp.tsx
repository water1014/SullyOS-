import React, { useCallback, useEffect, useRef, useState } from 'react';
import JSZip from 'jszip';
import {
  ArrowLeft, ArrowsClockwise, Check, Copy, DownloadSimple, GearSix, ImageSquare,
  Images, MagicWand, Sparkle, Trash,
} from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import {
  generateGptImage, editGptImage, generateNaiImage,
  suggestNaiTags, getNaiQualityTags, type GptImageConfig, type NaiImageConfig, type ImageEngine,
} from '../utils/imageGeneration';

const CONFIG_KEY = 'sully-image-studio:config:v1';
const ITEMS_KEY = 'sully-image-studio:items:v1';
const TEMPLATES_KEY = 'sully-image-studio:nai-templates:v1';
const IMAGE_CATEGORIES = ['未分类', '人物', '场景', '头像', '壁纸', '灵感草稿', '其他'];
const DEFAULT_CONFIG = {
  gpt: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-image-2.5-flare' },
  nai: { apiKey: '', model: 'nai-diffusion-5-full' },
};
type StudioConfig = { gpt: GptImageConfig; nai: NaiImageConfig };
type SavedImage = {
  id: string; blobId: string; engine: ImageEngine; prompt: string; negativePrompt: string;
  model: string; createdAt: number; mimeType: string;
  note?: string; category?: string; favorite?: boolean;
};
type DisplayImage = SavedImage & { url: string };
type NaiPromptTemplate = { id: string; name: string; prompt: string; negativePrompt: string; createdAt: number };

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
const readTemplates = (): NaiPromptTemplate[] => {
  try {
    const value = JSON.parse(localStorage.getItem(TEMPLATES_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
};



type TagCategory = '主体' | '发型' | '眼睛' | '表情' | '服装' | '动作' | '构图' | '场景' | '画风' | '质量';
const NAI_TAGS: Record<TagCategory, string[]> = {
  '主体': ['1girl', '1boy', '2girls', '2boys', 'solo', 'duo', 'multiple girls', 'multiple boys', 'animal', 'cat', 'original'],
  '发型': ['long hair', 'short hair', 'very long hair', 'bob cut', 'ponytail', 'twintails', 'braided hair', 'messy hair', 'wavy hair', 'blunt bangs', 'ahoge'],
  '眼睛': ['blue eyes', 'brown eyes', 'green eyes', 'red eyes', 'golden eyes', 'heterochromia', 'closed eyes', 'looking at viewer'],
  '表情': ['smile', 'gentle smile', 'blush', 'open mouth', 'closed mouth', 'serious', 'shy', 'crying', 'laughing', 'wink'],
  '服装': ['dress', 'school uniform', 'sailor uniform', 'kimono', 'hanfu', 'hoodie', 'sweater', 'white shirt', 'lace dress', 'long sleeves', 'ribbon'],
  '动作': ['standing', 'sitting', 'lying', 'looking back', 'holding', 'walking', 'dancing', 'holding flower', 'holding book', 'hand on own cheek'],
  '构图': ['portrait', 'upper body', 'cowboy shot', 'full body', 'close-up', 'from above', 'from below', 'from behind', 'wide shot', 'dynamic angle', 'depth of field'],
  '场景': ['indoors', 'outdoors', 'flower field', 'garden', 'forest', 'bedroom', 'library', 'cafe', 'city', 'night sky', 'rain', 'sunset', 'moonlight'],
  '画风': ['anime coloring', 'watercolor (medium)', 'ink (medium)', 'pencil sketch', 'soft shading', 'painterly', 'visual novel cg', '3d (medium)', 'muted color', 'pastel colors', 'monochrome'],
  '质量': ['masterpiece', 'very aesthetic', 'best quality', 'amazing quality', 'high complexity', 'no text', 'absurdres'],
};
const TAG_CATEGORIES = Object.keys(NAI_TAGS) as TagCategory[];

const NAI_NEGATIVE_PACKS = [
  { name: '画质瑕疵', tags: ['low quality', 'worst quality', 'lowres', 'blurry', 'jpeg artifacts'] },
  { name: '人体结构', tags: ['bad anatomy', 'bad hands', 'malformed hands', 'extra fingers', 'missing fingers', 'extra limbs', 'fused fingers'] },
  { name: '画面干扰', tags: ['text', 'watermark', 'signature', 'logo', 'cropped', 'out of frame'] },
  { name: '人物瑕疵', tags: ['poorly drawn face', 'asymmetrical eyes', 'deformed', 'duplicate', 'mutation'] },
];

const ImageStudioApp: React.FC = () => {
  const { closeApp, addToast } = useOS();
  const [tab, setTab] = useState<'create' | 'gallery' | 'settings'>('create');
  const [engine, setEngine] = useState<ImageEngine>('gpt');
  const [config, setConfig] = useState<StudioConfig>(readConfig);
  const [prompt, setPrompt] = useState('');
  const [referenceImage, setReferenceImage] = useState<File | null>(null);
  const [referencePreview, setReferencePreview] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('low quality, worst quality, blurry, bad anatomy');
  const [activeTagCategory, setActiveTagCategory] = useState<TagCategory>('主体');
  const [tagSearch, setTagSearch] = useState('');
  const [tagSuggestions, setTagSuggestions] = useState<{ tag: string; count?: number; confidence?: number }[]>([]);
  const [suggestingTags, setSuggestingTags] = useState(false);
  const [naiTemplates, setNaiTemplates] = useState<NaiPromptTemplate[]>(readTemplates);
  const [templateName, setTemplateName] = useState('');
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
  const [galleryCategory, setGalleryCategory] = useState('全部');
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkCategory, setBulkCategory] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

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

  useEffect(() => {
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(naiTemplates));
  }, [naiTemplates]);

  useEffect(() => {
    if (!referenceImage) { setReferencePreview(''); return; }
    const url = URL.createObjectURL(referenceImage);
    setReferencePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [referenceImage]);

  useEffect(() => { imagesRef.current = images; }, [images]);
  useEffect(() => () => imagesRef.current.forEach(item => URL.revokeObjectURL(item.url)), []);

  const updateGpt = (updates: Partial<GptImageConfig>) =>
    setConfig(current => ({ ...current, gpt: { ...current.gpt, ...updates } }));
  const updateNai = (updates: Partial<NaiImageConfig>) =>
    setConfig(current => ({ ...current, nai: { ...current.nai, ...updates } }));

  const addNaiTag = (tag: string) => {
    const existing = prompt.split(',').map(value => value.trim()).filter(Boolean);
    if (existing.some(value => value.toLowerCase() === tag.toLowerCase())) return;
    const isSubject = NAI_TAGS['主体'].includes(tag);
    const next = isSubject ? [tag, ...existing] : [...existing, tag];
    setPrompt(next.join(', '));
  };
  const removeNaiTag = (tag: string) => {
    setPrompt(prompt.split(',').map(value => value.trim()).filter(value => value && value.toLowerCase() !== tag.toLowerCase()).join(', '));
  };
  const promptTags = prompt.split(',').map(value => value.trim()).filter(Boolean);

  const appendPromptTags = (tags: string[]) => {
    const existing = prompt.split(',').map(value => value.trim()).filter(Boolean);
    const seen = new Set(existing.map(value => value.toLowerCase()));
    const additions = tags.filter(tag => {
      const key = tag.trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    setPrompt([...existing, ...additions].join(', '));
  };

  const addNegativePack = (tags: string[]) => {
    const existing = negativePrompt.split(',').map(value => value.trim()).filter(Boolean);
    const seen = new Set(existing.map(value => value.toLowerCase()));
    const additions = tags.filter(tag => {
      const key = tag.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    setNegativePrompt([...existing, ...additions].join(', '));
  };

  const addNaiQualityPreset = (level: 'light' | 'standard') => {
    appendPromptTags(getNaiQualityTags(config.nai.model, level));
    addToast(level === 'light' ? '已追加轻量质量标签' : '已追加标准质量标签', 'success');
  };

  const saveNaiTemplate = () => {
    if (!prompt.trim()) { addToast('先写好提示词，再收藏模板', 'error'); return; }
    const name = templateName.trim() || '灵感模板 ' + (naiTemplates.length + 1);
    const template: NaiPromptTemplate = {
      id: 'template_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      name, prompt: prompt.trim(), negativePrompt: negativePrompt.trim(), createdAt: Date.now(),
    };
    setNaiTemplates(current => [template, ...current]);
    setTemplateName('');
    addToast('提示词模板已收藏', 'success');
  };

  const applyNaiTemplate = (template: NaiPromptTemplate) => {
    setPrompt(template.prompt);
    setNegativePrompt(template.negativePrompt);
    addToast('已载入「' + template.name + '」', 'success');
  };

  const deleteNaiTemplate = (id: string) => {
    setNaiTemplates(current => current.filter(template => template.id !== id));
  };
  const generateRandomIdea = () => {
    const pick = (items: string[]) => items[Math.floor(Math.random() * items.length)];
    const categories: TagCategory[] = ['主体', '发型', '眼睛', '表情', '服装', '动作', '构图', '场景', '画风'];
    const idea = categories.map(category => pick(NAI_TAGS[category]));
    idea.push(pick(['masterpiece', 'very aesthetic', 'best quality', 'no text']));
    appendPromptTags(idea);
    addToast('灵感已追加到提示词末尾', 'success');
  };

  const loadNaiSuggestions = async () => {
    if (suggestingTags) return;
    setSuggestingTags(true);
    try {
      const results = await suggestNaiTags(config.nai, tagSearch);
      setTagSuggestions(results.slice(0, 12));
      if (!results.length) addToast('暂时没有找到相关标签', 'success');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '标签建议获取失败';
      setError(message);
      addToast(message.slice(0, 80), 'error');
    } finally {
      setSuggestingTags(false);
    }
  };

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
        ? referenceImage
          ? await editGptImage(config.gpt, referenceImage, prompt, { size: gptSize, quality: gptQuality })
          : await generateGptImage(config.gpt, prompt, { size: gptSize, quality: gptQuality })
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

  const updateImageMetadata = (id: string, updates: Partial<Pick<SavedImage, 'note' | 'category' | 'favorite'>>) => {
    const next = readItems().map(item => item.id === id ? { ...item, ...updates } : item);
    persistItems(next);
    setImages(current => current.map(item => item.id === id ? { ...item, ...updates } : item));
    setSelected(current => current?.id === id ? { ...current, ...updates } : current);
  };

  const restoreImagePrompt = (item: DisplayImage) => {
    setEngine(item.engine);
    setPrompt(item.prompt);
    setNegativePrompt(item.negativePrompt || '');
    if (item.engine === 'gpt') updateGpt({ model: item.model });
    else updateNai({ model: item.model });
    setReferenceImage(null);
    setError('');
    setTab('create');
    addToast('已载入这张作品的提示词和模型', 'success');
  };

  const visibleImages = images.filter(item =>
    (galleryCategory === '全部' || (item.category || '未分类') === galleryCategory) &&
    (!showFavoritesOnly || !!item.favorite)
  );


  const toggleImageSelection = (id: string) => {
    setSelectedIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectVisibleImages = () => {
    setSelectedIds(current => {
      const next = new Set(current);
      const allSelected = visibleImages.length > 0 && visibleImages.every(item => next.has(item.id));
      visibleImages.forEach(item => allSelected ? next.delete(item.id) : next.add(item.id));
      return next;
    });
  };

  const exportSelectedImages = async () => {
    const selectedItems = images.filter(item => selectedIds.has(item.id));
    if (!selectedItems.length || bulkBusy) return;
    setBulkBusy(true);
    try {
      const zip = new JSZip();
      const manifest: Record<string, unknown>[] = [];
      for (let index = 0; index < selectedItems.length; index += 1) {
        const item = selectedItems[index];
        const blob = await DB.getBlobAsset(item.blobId);
        if (!blob) continue;
        const extension = item.mimeType === 'image/webp' ? 'webp' : item.mimeType === 'image/jpeg' ? 'jpg' : 'png';
        const filename = String(index + 1).padStart(3, '0') + '-' + item.engine + '-' + item.id + '.' + extension;
        zip.file('images/' + filename, blob);
        manifest.push({
          filename: 'images/' + filename, engine: item.engine, model: item.model,
          prompt: item.prompt, negativePrompt: item.negativePrompt, note: item.note || '',
          category: item.category || '未分类', favorite: !!item.favorite,
          createdAt: item.createdAt, mimeType: item.mimeType,
        });
      }
      if (!manifest.length) throw new Error('没有找到可导出的图片文件');
      zip.file('作品清单.json', JSON.stringify({
        format: 'SullyOS Image Studio Backup', version: 1,
        exportedAt: new Date().toISOString(), items: manifest,
      }, null, 2));
      const archive = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 4 } });
      const url = URL.createObjectURL(archive);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = '糯米机-生图室备份-' + new Date().toISOString().slice(0, 10) + '.zip';
      anchor.click();
      URL.revokeObjectURL(url);
      addToast('已打包导出 ' + manifest.length + ' 张作品', 'success');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '备份导出失败';
      addToast(message, 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  const applyBulkCategory = () => {
    if (!bulkCategory || selectedIds.size === 0) return;
    const next = readItems().map(item => selectedIds.has(item.id) ? { ...item, category: bulkCategory } : item);
    persistItems(next);
    setImages(current => current.map(item => selectedIds.has(item.id) ? { ...item, category: bulkCategory } : item));
    setSelected(current => current && selectedIds.has(current.id) ? { ...current, category: bulkCategory } : current);
    addToast('已为 ' + selectedIds.size + ' 张作品设置分类', 'success');
    setBulkCategory('');
  };

  const deleteSelectedImages = async () => {
    const targets = images.filter(item => selectedIds.has(item.id));
    if (!targets.length || bulkBusy || !window.confirm('确定删除选中的 ' + targets.length + ' 张作品吗？此操作无法撤销。')) return;
    setBulkBusy(true);
    try {
      await Promise.all(targets.map(item => DB.deleteBlobAsset(item.blobId).catch(() => undefined)));
      const removed = new Set(targets.map(item => item.id));
      persistItems(readItems().filter(item => !removed.has(item.id)));
      setImages(current => current.filter(item => !removed.has(item.id)));
      setSelected(current => current && removed.has(current.id) ? null : current);
      targets.forEach(item => URL.revokeObjectURL(item.url));
      setSelectedIds(new Set());
      addToast('已删除 ' + targets.length + ' 张作品', 'success');
    } finally {
      setBulkBusy(false);
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
    const extension = item.mimeType === 'image/webp' ? 'webp' : item.mimeType === 'image/jpeg' ? 'jpg' : 'png';
    anchor.download = `nuomi-${item.engine}-${new Date(item.createdAt).toISOString().slice(0, 10)}.${extension}`;
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
            <textarea className="field min-h-[132px] resize-y leading-6" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={engine === 'gpt' ? (referenceImage ? '描述你希望如何修改这张参考图……' : '例如：雨后的玻璃花房，蓝色月光落在白色花瓣上，电影感构图……') : 'masterpiece, best quality, 1girl, ...'} />
            {engine === 'gpt' && (
              <div className="rounded-2xl border border-dashed border-sky-200 bg-sky-50/55 p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div><div className="text-xs font-semibold text-slate-700">参考图编辑 <span className="font-normal text-slate-400">· 可选</span></div><p className="text-[10px] text-slate-400 mt-1">上传图片后，GPT 会按上方描述修改它</p></div>
                  {referenceImage && <button type="button" onClick={() => setReferenceImage(null)} className="text-[10px] text-rose-500 font-semibold">移除图片</button>}
                </div>
                {referencePreview ? (
                  <div className="flex items-center gap-3">
                    <img src={referencePreview} alt="参考图预览" className="w-20 h-20 rounded-xl object-cover border border-white shadow-sm"/>
                    <div className="min-w-0"><div className="text-xs text-slate-600 truncate">{referenceImage?.name}</div><div className="text-[10px] text-slate-400 mt-1">{((referenceImage?.size || 0) / 1024 / 1024).toFixed(1)} MB</div></div>
                  </div>
                ) : (
                  <label className="flex items-center justify-center gap-2 rounded-xl bg-white/75 border border-white py-3 text-xs font-semibold text-sky-700 cursor-pointer">
                    <ImageSquare size={16}/>选择一张参考图片
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={event => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      if (file.size > 20 * 1024 * 1024) { setError('参考图片不能超过 20 MB'); event.target.value = ''; return; }
                      setError('');
                      setReferenceImage(file);
                      event.target.value = '';
                    }}/>
                  </label>
                )}
              </div>
            )}
            {engine === 'nai' && <>
              <div className="rounded-2xl border border-sky-100 bg-white/55 p-3 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div><div className="text-xs font-semibold text-slate-700">标签灵感库</div><p className="text-[10px] text-slate-400 mt-1">点选标签加入提示词，重复标签会自动跳过</p></div>
                  <button type="button" onClick={() => setPrompt('')} className="text-[10px] text-slate-400">清空提示词</button>
                </div>
                <div className="flex gap-1.5 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
                  {TAG_CATEGORIES.map(category => <button key={category} type="button" onClick={() => setActiveTagCategory(category)} className={`shrink-0 rounded-full px-3 py-1.5 text-[10px] font-semibold ${activeTagCategory === category ? 'bg-sky-600 text-white' : 'bg-white/80 text-slate-500 border border-slate-100'}`}>{category}</button>)}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {NAI_TAGS[activeTagCategory].map(tag => {
                    const added = promptTags.some(value => value.toLowerCase() === tag.toLowerCase());
                    return <button key={tag} type="button" onClick={() => added ? removeNaiTag(tag) : addNaiTag(tag)} className={`rounded-lg px-2.5 py-1.5 text-[10px] border ${added ? 'bg-sky-100 border-sky-200 text-sky-800' : 'bg-white/75 border-white text-slate-600'}`}>{added ? '✓ ' : '+ '}{tag}</button>;
                  })}
                </div>
                {promptTags.length > 0 && <div className="border-t border-sky-100 pt-2"><div className="text-[10px] text-slate-400 mb-2">已加入 · {promptTags.length}</div><div className="flex flex-wrap gap-1.5">{promptTags.map((tag, index) => <button key={`${tag}-${index}`} type="button" onClick={() => removeNaiTag(tag)} className="rounded-lg bg-sky-50 text-sky-800 px-2 py-1 text-[10px]">{tag} ×</button>)}</div></div>}
                <div className="border-t border-sky-100 pt-3 space-y-2">
                  <div className="flex items-center justify-between gap-2"><div><div className="text-xs font-semibold text-slate-700">官方标签联想</div><p className="text-[10px] text-slate-400 mt-1">连接 NovelAI 标签库，按当前模型推荐</p></div><span className="text-[9px] text-sky-700">FREE</span></div>
                  <div className="flex gap-2">
                    <input className="field min-w-0 flex-1" value={tagSearch} onChange={event => setTagSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void loadNaiSuggestions(); }} placeholder="输入标签片段，例如 blue hair"/>
                    <button type="button" disabled={suggestingTags || !tagSearch.trim()} onClick={() => void loadNaiSuggestions()} className="primary rounded-xl px-3 text-[11px] font-semibold disabled:opacity-50">{suggestingTags ? '查询中' : '联想'}</button>
                  </div>
                  {tagSuggestions.length > 0 && <div className="flex flex-wrap gap-1.5">{tagSuggestions.map(item => <button key={item.tag} type="button" onClick={() => addNaiTag(item.tag)} className="rounded-lg border border-sky-100 bg-sky-50/80 px-2.5 py-1.5 text-[10px] text-sky-800">＋ {item.tag}</button>)}</div>}
                </div>
                <div className="border-t border-sky-100 pt-3 space-y-2">
                  <div className="text-xs font-semibold text-slate-700">模型专属质量标签</div>
                  <p className="text-[10px] text-slate-400">按当前模型追加推荐组合，不会覆盖已有内容</p>
                  {config.nai.model.startsWith("nai-diffusion-5") ? <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => addNaiQualityPreset("light")} className="soft rounded-xl py-2 text-[11px] font-semibold">＋ 轻量质量</button>
                    <button type="button" onClick={() => addNaiQualityPreset("standard")} className="soft rounded-xl py-2 text-[11px] font-semibold">＋ 标准质量</button>
                  </div> : <button type="button" onClick={() => addNaiQualityPreset("standard")} className="soft w-full rounded-xl py-2 text-[11px] font-semibold">＋ 追加当前模型官方质量组合</button>}
                </div>
                <button type="button" onClick={generateRandomIdea} className="w-full soft rounded-xl py-2.5 text-xs font-semibold flex items-center justify-center gap-2"><Sparkle size={14}/>随机灵感组合 <span className="text-[10px] font-normal opacity-65">· 只追加，不覆盖原提示词</span></button>
                <div className="border-t border-sky-100 pt-3 space-y-2">
                  <div className="flex items-center justify-between"><div className="text-xs font-semibold text-slate-700">我的提示词模板</div><span className="text-[10px] text-slate-400">{naiTemplates.length} 个已收藏</span></div>
                  <div className="flex gap-2">
                    <input className="field min-w-0 flex-1" value={templateName} onChange={event => setTemplateName(event.target.value)} placeholder="给这组提示词起个名字"/>
                    <button type="button" onClick={saveNaiTemplate} disabled={!prompt.trim()} className="primary rounded-xl px-3 text-[11px] font-semibold disabled:opacity-50">收藏</button>
                  </div>
                  {naiTemplates.length > 0 ? <div className="space-y-1.5">{naiTemplates.map(template => <div key={template.id} className="flex items-center gap-2 rounded-xl bg-white/70 border border-sky-50 px-3 py-2">
                    <button type="button" onClick={() => applyNaiTemplate(template)} className="min-w-0 flex-1 text-left"><div className="text-[11px] font-semibold text-slate-700 truncate">{template.name}</div><div className="text-[9px] text-slate-400 truncate mt-0.5">{template.prompt}</div></button>
                    <button type="button" onClick={() => deleteNaiTemplate(template.id)} className="text-[10px] text-rose-400 px-1.5 py-1">删除</button>
                  </div>)}</div> : <p className="text-[10px] text-slate-400">收藏后的模板会保存在本机，可以随时载入。</p>}
                </div>
              </div>
              <div className="flex items-center justify-between"><label className="text-xs font-semibold text-slate-600">反向提示词</label><button onClick={() => copyPrompt(negativePrompt)} className="text-[10px] text-sky-700 flex items-center gap-1"><Copy size={12}/>复制</button></div>
              <textarea className="field min-h-[76px] resize-y leading-5" value={negativePrompt} onChange={event => setNegativePrompt(event.target.value)} placeholder="不希望出现在画面中的内容……"/>
              <div className="space-y-2">
                <div className="text-[10px] font-semibold text-slate-500">负面标签快捷包 · 点击追加</div>
                <div className="flex flex-wrap gap-1.5">{NAI_NEGATIVE_PACKS.map(pack => <button key={pack.name} type="button" onClick={() => addNegativePack(pack.tags)} className="rounded-lg border border-rose-100 bg-rose-50/70 text-rose-700 px-2.5 py-1.5 text-[10px]">＋ {pack.name}</button>)}</div>
              </div>
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
            {generating ? <><ArrowsClockwise size={18} className="animate-spin"/>{referenceImage ? '正在编辑参考图…' : '正在绘制，请稍候…'}</> : <><Sparkle size={18}/>{referenceImage && engine === 'gpt' ? '开始编辑图片' : '开始生成'}</>}
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
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-semibold text-slate-600">作品分类</label>
                  <select className="field max-w-[170px] py-2" value={selected.category || '未分类'} onChange={event => updateImageMetadata(selected.id, { category: event.target.value })}>{IMAGE_CATEGORIES.map(category => <option key={category} value={category}>{category}</option>)}</select>
                </div>
                <label className="block text-xs font-semibold text-slate-600">作品备注</label>
                <textarea className="field min-h-[70px] resize-y" value={selected.note || ''} onChange={event => updateImageMetadata(selected.id, { note: event.target.value })} placeholder="记录创作想法、修改方向或灵感来源……"/>
                <div className="flex items-center justify-between"><label className="text-xs font-semibold text-slate-600">正向提示词</label><button onClick={() => copyPrompt(selected.prompt)} className="text-[10px] text-sky-700">复制</button></div>
                <p className="text-xs leading-5 text-slate-600 whitespace-pre-wrap break-words rounded-xl bg-white/55 p-3">{selected.prompt}</p>
                {selected.negativePrompt && <>
                  <div className="flex items-center justify-between"><label className="text-xs font-semibold text-slate-600">反向提示词</label><button onClick={() => copyPrompt(selected.negativePrompt)} className="text-[10px] text-sky-700">复制</button></div>
                  <p className="text-xs leading-5 text-slate-500 whitespace-pre-wrap break-words rounded-xl bg-white/45 p-3">{selected.negativePrompt}</p>
                </>}
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button onClick={() => restoreImagePrompt(selected)} className="primary rounded-xl py-2.5 text-xs font-semibold">载入提示词继续创作</button>
                  <button onClick={() => updateImageMetadata(selected.id, { favorite: !selected.favorite })} className="soft rounded-xl py-2.5 text-xs">{selected.favorite ? '★ 已收藏' : '☆ 收藏作品'}</button>
                  <button onClick={() => downloadImage(selected)} className="soft rounded-xl py-2.5 text-xs flex items-center justify-center gap-1"><DownloadSimple size={14}/>下载图片</button>
                  <button onClick={() => deleteImage(selected)} className="soft rounded-xl py-2.5 text-rose-500 flex items-center justify-center gap-1"><Trash size={14}/>删除作品</button>
                </div>
              </div>
            </div>
          ) : images.length ? (
            <>

              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="text-[11px] text-slate-500">共 {images.length} 张作品</div>
                <button onClick={() => { setSelectionMode(value => !value); setSelectedIds(new Set()); }} className={selectionMode ? 'primary rounded-full px-3 py-2 text-[10px] font-semibold' : 'soft rounded-full px-3 py-2 text-[10px] font-semibold'}>{selectionMode ? '退出多选' : '批量管理'}</button>
              </div>
              {selectionMode && <div className="glass rounded-2xl p-3 mb-3 space-y-2">
                <div className="flex items-center justify-between"><span className="text-xs font-semibold text-slate-700">已选择 {selectedIds.size} 张</span><button onClick={selectVisibleImages} className="text-[10px] text-sky-700 font-semibold">全选当前筛选</button></div>
                <div className="grid grid-cols-2 gap-2">
                  <button disabled={!selectedIds.size || bulkBusy} onClick={() => void exportSelectedImages()} className="primary rounded-xl py-2.5 text-[11px] font-semibold disabled:opacity-50">{bulkBusy ? '处理中…' : '打包导出 ZIP'}</button>
                  <button disabled={!selectedIds.size || bulkBusy} onClick={() => void deleteSelectedImages()} className="soft rounded-xl py-2.5 text-[11px] font-semibold text-rose-600 disabled:opacity-50">批量删除</button>
                </div>
                <div className="flex gap-2">
                  <select className="field min-w-0 flex-1 py-2" value={bulkCategory} onChange={event => setBulkCategory(event.target.value)}><option value="">批量设置分类…</option>{IMAGE_CATEGORIES.map(category => <option key={category} value={category}>{category}</option>)}</select>
                  <button disabled={!selectedIds.size || !bulkCategory} onClick={applyBulkCategory} className="soft rounded-xl px-3 text-[10px] font-semibold disabled:opacity-50">应用</button>
                </div>
              </div>}
              <div className="flex gap-2 overflow-x-auto pb-2" style={{ scrollbarWidth: 'none' }}>
                {['全部', ...IMAGE_CATEGORIES].map(category => <button key={category} onClick={() => setGalleryCategory(category)} className={galleryCategory === category ? 'shrink-0 rounded-full px-3 py-2 text-[10px] font-semibold primary' : 'shrink-0 rounded-full px-3 py-2 text-[10px] font-semibold soft'}>{category}</button>)}
                <button onClick={() => setShowFavoritesOnly(value => !value)} className={showFavoritesOnly ? 'shrink-0 rounded-full px-3 py-2 text-[10px] font-semibold primary' : 'shrink-0 rounded-full px-3 py-2 text-[10px] font-semibold soft'}>{showFavoritesOnly ? '★ 仅收藏' : '☆ 收藏'}</button>
              </div>
              {visibleImages.length ? <div className="grid grid-cols-2 gap-3">
                {visibleImages.map(item => <div key={item.id} className={selectionMode && selectedIds.has(item.id) ? 'art-tile rounded-[18px] p-1.5 relative ring-2 ring-sky-400' : 'art-tile rounded-[18px] p-1.5 relative'}>
                  <button onClick={() => selectionMode ? toggleImageSelection(item.id) : setSelected(item)} className="w-full text-left relative"><img src={item.url} alt="生成作品" loading="lazy" className="w-full aspect-[3/4] object-cover rounded-[13px]"/>{item.favorite && <span className="absolute top-2 right-2 rounded-full bg-white/90 px-2 py-1 text-[10px] text-amber-600">★</span>}{selectionMode && <span className={selectedIds.has(item.id) ? 'absolute top-2 left-2 w-6 h-6 rounded-full border-2 flex items-center justify-center text-xs bg-sky-600 border-sky-600 text-white' : 'absolute top-2 left-2 w-6 h-6 rounded-full border-2 flex items-center justify-center text-xs bg-white/90 border-white text-transparent'}>✓</span>}<div className="px-1.5 py-2"><div className="text-[10px] font-semibold text-slate-600 truncate">{item.engine === 'gpt' ? 'GPT Image' : 'NovelAI'} · {item.category || '未分类'}</div><div className="text-[9px] text-slate-400 mt-1">{new Date(item.createdAt).toLocaleDateString()}</div>{item.note && <div className="text-[9px] text-slate-500 mt-1 truncate">{item.note}</div>}</div></button>
                </div>)}
              </div> : <div className="glass rounded-2xl p-6 text-center text-xs text-slate-400">这个筛选条件下还没有作品。</div>}
            </>
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
            <p className="text-[10px] text-slate-400 leading-5">GPT API Key 保存在当前设备浏览器的本地存储中，不会上传到糯米机服务器。请勿在公共设备上保存密钥。</p>
          </section>
          <section className="glass rounded-[24px] p-4 space-y-3">
            <div><div className="text-[10px] tracking-[.2em] text-sky-700/55 font-bold">ENGINE 02</div><div className="text-base font-semibold mt-1">NovelAI 生图接口</div></div>
            <label className="block text-xs font-semibold text-slate-600">Persistent API Token</label>
            <input className="field" type="password" autoComplete="off" value={config.nai.apiKey} onChange={event => updateNai({apiKey:event.target.value})} placeholder="pst-..."/>
            <label className="block text-xs font-semibold text-slate-600">图片模型</label>
            <select className="field" value={config.nai.model} onChange={event => updateNai({model:event.target.value})}><option value="nai-diffusion-5-full">NovelAI Diffusion V5 Full</option><option value="nai-diffusion-5-curated">NovelAI Diffusion V5 Curated</option><option value="nai-diffusion-4-5-full">NovelAI Diffusion V4.5 Full</option><option value="nai-diffusion-4-5-curated">NovelAI Diffusion V4.5 Curated</option></select>
            <p className="text-[10px] text-slate-400 leading-5">使用 NovelAI 的 Persistent API Token。密钥保存在当前设备浏览器本地存储中，不会写入作品记录；请勿在公共设备上保存密钥。</p>
          </section>
          <div className="rounded-2xl bg-sky-50/80 border border-sky-100 p-3 text-[10px] text-sky-800 leading-5">提示：部分 API 中转站不开放图片生成接口；如果出现 CORS 或 404，需要使用支持 Images API 的服务地址。NAI 需要浏览器能直接访问 image.novelai.net。</div>
          <button onClick={() => { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); addToast('生图引擎配置已保存', 'success'); }} className="primary w-full rounded-2xl py-3 text-sm font-bold">保存配置</button>
        </main>
      )}
    </div>
  );
};

export default ImageStudioApp;
